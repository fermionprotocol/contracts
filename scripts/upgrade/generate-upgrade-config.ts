import hre from "hardhat";
import shell from "shelljs";
import fs from "fs";
import path from "path";
import type { HardhatRuntimeEnvironment } from "hardhat/types";
import { getSelectors } from "../libraries/diamond";

const prefix = "contracts/";
const sources = ["diamond", "protocol/facets", "protocol/clients", "protocol/bases", "protocol/libs"];

async function getContractSelectors(contractName: string): Promise<Record<string, string>> {
  const contract = await hre.ethers.getContractFactory(contractName);
  const selectors = await getSelectors(contract);
  return selectors.reduce(
    (acc, selector) => {
      const func = contract.interface.getFunction(selector);
      if (func) {
        acc[selector] = func.format();
      }
      return acc;
    },
    {} as Record<string, string>,
  );
}

async function getBytecodes(version: string): Promise<Record<string, string>> {
  const bytecodes: Record<string, string> = {};
  const cwd = process.cwd();

  try {
    // Update compiler settings
    for (const compiler of hre.config.solidity.compilers) {
      compiler.settings["metadata"] = { bytecodeHash: "none", appendCBOR: false };
    }

    // Checkout the version's contracts
    shell.exec(`rm -rf contracts`);
    shell.exec(`git checkout ${version} contracts`);

    // Install dependencies and compile
    shell.exec("yarn install");
    await hre.run("clean");
    try {
      await hre.run("compile");
    } catch {
      // Ignore compilation errors as they might be expected
    }

    // Get all contract names using Hardhat's artifacts API
    const contractNames = await hre.artifacts.getAllFullyQualifiedNames();

    for (const contractName of contractNames) {
      const [source, name] = contractName.split(":");

      // Skip contracts that are not in the source folders
      if (!sources.some((s) => source.startsWith(`${prefix}${s}`))) continue;

      // Skip test files
      if (source.includes("/test/")) continue;

      // Skip interfaces and abstract contracts
      if (source.includes("/interfaces/") || name.startsWith("I") || name.startsWith("Interface")) continue;

      try {
        const artifact = await hre.artifacts.readArtifact(name);
        if (artifact.bytecode && artifact.bytecode !== "0x") {
          bytecodes[name] = artifact.bytecode;
        }
      } catch {
        // Ignore errors for missing artifacts
      }
    }
  } finally {
    // Restore original contracts
    process.chdir(cwd);
    shell.exec("git checkout HEAD contracts");
    shell.exec("git reset HEAD contracts");
  }

  return bytecodes;
}

async function generateUpgradeConfig(
  hre: HardhatRuntimeEnvironment,
  currentVersion: string,
  newVersion: string = "HEAD",
  version: string,
) {
  try {
    const referenceBytecodes = await getBytecodes(currentVersion);
    const targetBytecodes = await getBytecodes(newVersion);

    const overlappingContracts = Object.keys(referenceBytecodes).filter((contract) => contract in targetBytecodes);
    const removedContracts = Object.keys(referenceBytecodes).filter((contract) => !(contract in targetBytecodes));
    const newContracts = Object.keys(targetBytecodes).filter((contract) => !(contract in referenceBytecodes));
    const changedContracts = overlappingContracts.filter(
      (contract) => referenceBytecodes[contract] !== targetBytecodes[contract],
    );

    // Get selectors for all facets
    const facetSelectors: Record<string, Record<string, string>> = {};
    const allFacets = [...new Set([...overlappingContracts, ...newContracts])]
      .filter((contract) => contract.endsWith("Facet"))
      .filter((contract) => !contract.includes("/test/") && !contract.includes("Mock")); // Ignore test contracts

    for (const facet of allFacets) {
      try {
        facetSelectors[facet] = await getContractSelectors(facet);
      } catch (error) {
        console.warn(`Warning: Could not get selectors for ${facet}:`, error);
      }
    }

    // Detect constructor arguments for facets
    const constructorArgs: Record<string, string[]> = {};
    for (const facet of allFacets) {
      try {
        const factory = await hre.ethers.getContractFactory(facet);
        const fragment = factory.interface.deploy;
        if (fragment && fragment.inputs.length > 0) {
          const args = fragment.inputs.map((input) => {
            // Check if the input type is an address
            if (input.type === "address") {
              // Check if the input name contains "boson" or "protocol"
              if (input.name.toLowerCase().includes("boson")) {
                return "$BOSON_PROTOCOL_ADDRESS";
              } else if (input.name.toLowerCase().includes("protocol")) {
                return "$FERMION_PROTOCOL_ADDRESS";
              }
            }
            return "0x0000000000000000000000000000000000000000"; // Default to zero address for other address types
          });
          constructorArgs[facet] = args;
          console.log(`\nDetected constructor arguments for ${facet}:`);
          console.log(`  Arguments: ${args.join(", ")}`);
        }
      } catch (error) {
        console.warn(`Warning: Could not get constructor arguments for ${facet}:`, error);
      }
    }

    // Detect selector collisions
    const selectorCollisions: Record<string, string[]> = {};
    const selectorToFacet: Record<string, string> = {};

    // First pass: build selector to facet mapping
    for (const [facet, selectors] of Object.entries(facetSelectors)) {
      for (const selector of Object.keys(selectors)) {
        if (selector in selectorToFacet) {
          if (!selectorCollisions[selector]) {
            selectorCollisions[selector] = [selectorToFacet[selector]];
          }
          selectorCollisions[selector].push(facet);
        } else {
          selectorToFacet[selector] = facet;
        }
      }
    }

    // Generate skipSelectors configuration
    const skipSelectors: Record<string, string[]> = {};
    for (const [selector, facets] of Object.entries(selectorCollisions)) {
      // Keep the selector in the first facet, skip in others
      const [keepFacet, ...skipFacets] = facets;
      for (const facet of skipFacets) {
        if (!skipSelectors[facet]) {
          skipSelectors[facet] = [];
        }
        skipSelectors[facet].push(selector);
      }
      console.log(`\nSelector collision detected for ${selector}:`);
      console.log(`  Keeping in: ${keepFacet}`);
      console.log(`  Skipping in: ${skipFacets.join(", ")}`);
    }

    // Check if any selectors from new facets already exist in the diamond
    const existingSelectors = new Set<string>();
    for (const [facet, selectors] of Object.entries(facetSelectors)) {
      // Only consider non-test facets that exist in the current version
      if (facet in referenceBytecodes && !facet.includes("/test/") && !facet.includes("Mock")) {
        Object.keys(selectors).forEach((selector) => existingSelectors.add(selector));
      }
    }

    // Move facets from 'add' to 'replace' if they have existing selectors
    const addFacets = newContracts.filter(
      (contract) => contract.endsWith("Facet") && !contract.includes("/test/") && !contract.includes("Mock"),
    );
    const replaceFacets = changedContracts.filter(
      (contract) => contract.endsWith("Facet") && !contract.includes("/test/") && !contract.includes("Mock"),
    );

    for (const facet of [...addFacets]) {
      if (facetSelectors[facet]) {
        const hasExistingSelectors = Object.keys(facetSelectors[facet]).some((selector) =>
          existingSelectors.has(selector),
        );
        if (hasExistingSelectors) {
          // Move facet from add to replace
          addFacets.splice(addFacets.indexOf(facet), 1);
          if (!replaceFacets.includes(facet)) {
            replaceFacets.push(facet);
          }
          console.log(`\nMoving ${facet} from 'add' to 'replace' as it has existing selectors`);
        }
      }
    }

    const upgradeConfig = {
      description: `Upgrade to version ${version}`,
      facets: {
        add: addFacets,
        replace: replaceFacets,
        remove: removedContracts.filter((contract) => contract.endsWith("Facet")),
        skipSelectors,
        constructorArgs,
      },
    };

    const configDir = path.join(process.cwd(), "scripts", "config", "upgrades");
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    fs.writeFileSync(path.join(configDir, `${version}.json`), JSON.stringify(upgradeConfig, null, 2));

    console.log("\nContract Changes Summary:");
    if (changedContracts.length > 0) console.log("Changed contracts:", changedContracts);
    if (removedContracts.length > 0) console.log("Removed contracts:", removedContracts);
    if (newContracts.length > 0) console.log("New contracts:", newContracts);
    if (changedContracts.length === 0 && removedContracts.length === 0 && newContracts.length === 0) {
      console.log("No contract changes detected");
    }

    if (Object.keys(selectorCollisions).length > 0) {
      console.log("\nSelector Collisions Summary:");
      console.log("The following selectors have been automatically handled in the upgrade config:");
      for (const [selector, facets] of Object.entries(selectorCollisions)) {
        console.log(`\n${selector}:`);
        console.log(`  Keeping in: ${facets[0]}`);
        console.log(`  Skipping in: ${facets.slice(1).join(", ")}`);
      }
    }
  } catch (error) {
    console.error("Error generating upgrade config:", error);
    throw error;
  }
}

export { generateUpgradeConfig };
