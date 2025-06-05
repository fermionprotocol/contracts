import hre from "hardhat";
import shell from "shelljs";
import fs from "fs";
import path from "path";
import type { HardhatRuntimeEnvironment } from "hardhat/types";
import { getSelectors } from "../libraries/diamond";
import { getFunctionSignatureDetails, RESTRICTED_METATX_FUNCTIONS } from "../libraries/metaTransaction";

const prefix = "contracts/";
const sources = ["diamond", "protocol/facets", "protocol/clients", "protocol/bases", "protocol/libs"];

function isContractRelevantForAllowlist(name: string): boolean {
  return (
    (name.endsWith("Facet") && name !== "ConfigFacet" && name !== "PauseFacet") ||
    name === "FermionFNFT" ||
    name === "FermionFractionsERC20"
  );
}

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

interface FunctionSignatureDetail {
  name: string;
  hash: string;
}

async function getBytecodes(
  version: string,
): Promise<Record<string, { bytecode: string; functionSignatures: FunctionSignatureDetail[] }>> {
  const bytecodes: Record<string, { bytecode: string; functionSignatures: FunctionSignatureDetail[] }> = {};
  const cwd = process.cwd();

  try {
    // Update compiler settings
    for (const compiler of hre.config.solidity.compilers) {
      compiler.settings["metadata"] = { bytecodeHash: "none", appendCBOR: false };
    }

    // Checkout the version's contracts
    shell.exec(`rm -rf contracts`);
    const checkoutResult = shell.exec(`git checkout ${version} contracts`, { silent: true });
    if (checkoutResult.code !== 0) {
      throw new Error(`Version ${version} does not exist in the repository`);
    }

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
          let functionSignatures: FunctionSignatureDetail[] = [];
          if (isContractRelevantForAllowlist(name)) {
            try {
              functionSignatures = await getFunctionSignatureDetails([name], RESTRICTED_METATX_FUNCTIONS);
            } catch (e) {
              console.warn(`Warning: Could not get function signature details for ${name} in version ${version}:`, e);
            }
          }
          bytecodes[name] = { bytecode: artifact.bytecode, functionSignatures };
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
      (contract) => referenceBytecodes[contract].bytecode !== targetBytecodes[contract].bytecode,
    );

    // Get selectors for all facets (this part remains for general facet selector information, not specific to allowlist)
    const facetSelectors: Record<string, Record<string, string>> = {};
    const allFacetsForSelectorInfo = [...new Set([...overlappingContracts, ...newContracts])]
      .filter((contract) => contract.endsWith("Facet")) // Original facet filter for this specific purpose
      .filter((contract) => !contract.includes("/test/") && !contract.includes("Mock"));

    for (const facet of allFacetsForSelectorInfo) {
      try {
        facetSelectors[facet] = await getContractSelectors(facet);
      } catch (error) {
        console.warn(`Warning: Could not get selectors for ${facet}:`, error);
      }
    }

    // Detect constructor arguments for facets
    const constructorArgs: Record<string, string[]> = {};
    for (const facet of allFacetsForSelectorInfo) {
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
        }
      } catch (error) {
        console.warn(`Warning: Could not get constructor arguments for ${facet}:`, error);
      }
    }

    const relevantNewContracts = newContracts.filter(
      (contract) =>
        isContractRelevantForAllowlist(contract) && !contract.includes("/test/") && !contract.includes("Mock"),
    );

    const metaTxAllowlistAddFromNew = relevantNewContracts.flatMap((contractName) => {
      const details = targetBytecodes[contractName]?.functionSignatures || [];
      return details.map((detail) => ({ facetName: contractName, functionName: detail.name, hash: detail.hash }));
    });

    const relevantRemovedContracts = removedContracts.filter((contract) => isContractRelevantForAllowlist(contract)); // No need to filter for /test/ or /Mock/ here as they are already gone

    const metaTxAllowlistRemoveFromOld = relevantRemovedContracts.flatMap((contractName) => {
      const details = referenceBytecodes[contractName]?.functionSignatures || [];
      return details.map((detail) => ({ facetName: contractName, functionName: detail.name, hash: detail.hash }));
    });

    // Process changed relevant contracts for added/removed functions
    const relevantChangedContracts = changedContracts.filter(
      (contract) =>
        isContractRelevantForAllowlist(contract) && !contract.includes("/test/") && !contract.includes("Mock"),
    );

    let metaTxAllowlistAddFromChanged: { facetName: string; functionName: string; hash: string }[] = [];
    let metaTxAllowlistRemoveFromChanged: { facetName: string; functionName: string; hash: string }[] = [];

    for (const contractName of relevantChangedContracts) {
      // Changed variable name from facetName to contractName for generality
      const oldFunctionSignatures = referenceBytecodes[contractName]?.functionSignatures || [];
      const newFunctionSignatures = targetBytecodes[contractName]?.functionSignatures || [];

      const oldHashes = new Set(oldFunctionSignatures.map((sig) => sig.hash));
      const newHashes = new Set(newFunctionSignatures.map((sig) => sig.hash));

      const addedFunctionsInContract = newFunctionSignatures.filter((sig) => !oldHashes.has(sig.hash));
      const removedFunctionsInContract = oldFunctionSignatures.filter((sig) => !newHashes.has(sig.hash));

      if (addedFunctionsInContract.length > 0) {
        metaTxAllowlistAddFromChanged = metaTxAllowlistAddFromChanged.concat(
          addedFunctionsInContract.map((detail) => ({
            facetName: contractName,
            functionName: detail.name,
            hash: detail.hash,
          })),
        );
      }

      if (removedFunctionsInContract.length > 0) {
        metaTxAllowlistRemoveFromChanged = metaTxAllowlistRemoveFromChanged.concat(
          removedFunctionsInContract.map((detail) => ({
            facetName: contractName,
            functionName: detail.name,
            hash: detail.hash,
          })),
        );
      }
    }

    const finalMetaTxAllowlistAdd = [...metaTxAllowlistAddFromNew, ...metaTxAllowlistAddFromChanged];
    const finalMetaTxAllowlistRemove = [...metaTxAllowlistRemoveFromOld, ...metaTxAllowlistRemoveFromChanged];

    const upgradeConfig = {
      description: `Upgrade to version ${version}`,
      facets: {
        add: newContracts.filter(
          (contract) => contract.endsWith("Facet") && !contract.includes("/test/") && !contract.includes("Mock"),
        ),
        replace: changedContracts.filter(
          (contract) => contract.endsWith("Facet") && !contract.includes("/test/") && !contract.includes("Mock"),
        ),
        remove: removedContracts.filter((contract) => contract.endsWith("Facet")),
        constructorArgs,
      },
      clients: {
        fermionFNFT: [
          ...changedContracts.filter((contract) => {
            const artifact = hre.artifacts.readArtifactSync(contract);
            return (
              artifact.sourceName.includes("/protocol/clients/") &&
              !artifact.sourceName.includes("/protocol/clients/oracle/") &&
              artifact.bytecode !== "0x"
            );
          }),
          ...newContracts.filter((contract) => {
            const artifact = hre.artifacts.readArtifactSync(contract);
            return (
              artifact.sourceName.includes("/protocol/clients/") &&
              !artifact.sourceName.includes("/protocol/clients/oracle/") &&
              artifact.bytecode !== "0x"
            );
          }),
        ],
      },
      metaTxAllowlist: {
        add: finalMetaTxAllowlistAdd,
        remove: finalMetaTxAllowlistRemove,
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
  } catch (error) {
    console.error("Error generating upgrade config:", error);
    throw error;
  }
}

export { generateUpgradeConfig };
