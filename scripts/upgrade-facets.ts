import fs from "fs";
import hre from "hardhat";

import { getInterfaceID } from "./../test/utils/common";

import { readContracts, writeContracts, checkRole } from "./libraries/utils";
import { FacetCutAction, getSelectors, removeSelectors } from "./libraries/diamond";
import packageFile from "../package.json";
import { deployFacets, makeDiamondCut } from "./deploy";
import readline from "readline";
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const { ZeroAddress, getContractAt, getSigners, getContractFactory, encodeBytes32String } = hre.ethers;
const network = hre.network.name;

/**
 * Upgrades or removes existing facets, or adds new facets.
 *
 * Prerequisite:
 * - Admin must have UPGRADER role.
 *
 */
export async function upgradeFacets(env: string = "", facets, version: string = "") {
  // Bail now if hardhat network, unless the upgrade is tested
  if (network === "hardhat" && env !== "upgrade-test" && !env.includes("dry-run")) process.exit();

  // const { chainId } = await provider.getNetwork();
  const contractsFile = await readContracts(env);
  let { contracts } = contractsFile;
  // const interfaceIds = await getInterfaceIds(false);
  // const interfaceIdFromFacetName = (facetName) => interfaceIds[interfaceImplementers[facetName]];

  const divider = "-".repeat(80);
  console.log(`${divider}\nFermion Protocol Diamond Upgrader\n${divider}`);
  console.log(`⛓  Network: ${network}\n📅 ${new Date()}`);

  // Check that version and
  if (version == contractsFile.protocolVersion && env !== "upgrade-test") {
    const answer = await getUserResponse("Protocol version has already been deployed. Proceed anyway? (y/n) ", [
      "y",
      "yes",
      "n",
      "no",
    ]);
    switch (answer.toLowerCase()) {
      case "y":
      case "yes":
        break;
      case "n":
      case "no":
      default:
        process.exit(1);
    }
  }

  const adminAddress = (await getSigners())[0].address;

  // If admin address is unspecified, exit the process
  if (adminAddress == ZeroAddress || !adminAddress) {
    console.log("Admin address must not be zero address");
    process.exit(1);
  }

  // Get list of accounts managed by node
  console.log(divider);

  // Get addresses of currently deployed contracts
  const protocolAddress = contracts.find((c: any) => c.name === "FermionDiamond")?.address;
  const initializationFacetAddress = contracts.find((c: any) => c.name === "InitializationFacet")?.address;

  if (!protocolAddress || !initializationFacetAddress) {
    console.error(`Protocol address or InitializationFacet address not found in contracts file for ${env}`);
    process.exit(1);
  }

  // Check if admin has UPGRADER role
  checkRole(contracts, "UPGRADER", adminAddress);

  // Deploy new facets
  const deployedFacets = await deployFacets(facets.addOrUpgrade, facets.constructorArgs, true);

  // Cast Diamond to DiamondCutFacet, DiamondLoupeFacet and IERC165Extended
  const diamondCutFacet = await getContractAt("DiamondCutFacet", protocolAddress);
  const diamondLoupe = await getContractAt("DiamondLoupeFacet", protocolAddress);

  const facetCutRemove = [];
  const interfacesToRemove = {},
    interfacesToAdd = {};
  const removedSelectors = []; // global list of selectors to be removed

  // Remove facets
  for (const facetToRemove of facets.remove) {
    // Get currently registered selectors
    const oldFacet = contracts.find((i: any) => i.name === facetToRemove);

    // Facet does not exist, skip next steps
    if (!oldFacet) continue;

    // Remove old entry from contracts
    contracts = contracts.filter((i: any) => i.name !== facetToRemove);

    // All selectors must be removed
    const selectorsToRemove = await diamondLoupe.facetFunctionSelectors(oldFacet.address); // all selectors must be removed
    removedSelectors.push(selectorsToRemove); // add to global list

    // Removing the selectors
    facetCutRemove.push([ZeroAddress, FacetCutAction.Remove, selectorsToRemove]);

    // Remove support for old interface
    if (!oldFacet.interfaceId) {
      console.log(
        `Could not find interface id for old facet ${oldFacet.name}.\nYou might need to remove its interfaceId from "supportsInterface" manually.`,
      );
    } else {
      // Remove from smart contract
      interfacesToRemove[facetToRemove] = oldFacet.interfaceId;

      // Check if interface was shared across other facets and update contracts info
      contracts = contracts.map((entry) => {
        if (entry.interfaceId == oldFacet.interfaceId) {
          entry.interfaceId = "";
        }
        return entry;
      });
    }
  }

  const facetCuts = [];
  // Manage new or upgraded facets
  for (const [facetName, newFacet] of Object.entries(deployedFacets)) {
    // Get currently registered selectors
    const oldFacet = contracts.find((i: any) => i.name === facetName);
    let registeredSelectors;

    if (oldFacet) {
      // Facet already exists and is only upgraded
      registeredSelectors = await diamondLoupe.facetFunctionSelectors(oldFacet.address);
    } else {
      // Facet is new
      registeredSelectors = [];
    }

    // Remove old entry from contracts
    // contracts = contracts.filter((i: any) => i.name !== facetName);
    console.log(`\n📋 Facet: ${facetName}`);
    console.log(registeredSelectors);

    // Get new selectors from compiled contract
    const { selectors, signatureToNameMapping } = getSelectors(newFacet, true);
    let newSelectors = selectors;

    // Initialize selectors should not be added
    const facetFactory = await getContractFactory(facetName);
    const { selector } = facetFactory.interface.getFunction("init") || {};
    if (selector) newSelectors = newSelectors.remove([selector]);

    // Determine actions to be made
    let selectorsToReplace = registeredSelectors.filter((value) => newSelectors.includes(value));
    let selectorsToRemove = registeredSelectors.filter((value) => !selectorsToReplace.includes(value)); // unique old selectors
    let selectorsToAdd = newSelectors.filter((value) => !selectorsToReplace.includes(value)); // unique new selectors

    // Skip selectors if set in config
    const selectorsToSkip = facets.skipSelectors[facetName] ? facets.skipSelectors[facetName] : [];
    selectorsToReplace = removeSelectors(selectorsToReplace, selectorsToSkip);

    selectorsToRemove = removeSelectors(selectorsToRemove, selectorsToSkip);

    selectorsToAdd = removeSelectors(selectorsToAdd, selectorsToSkip);

    // Check if selectors that are being added are not registered yet on some other facet
    // If collision is found, user must choose to either (s)kip it or (r)eplace it.
    let skipAll, replaceAll;

    for (const selectorToAdd of selectorsToAdd) {
      if (removedSelectors.flat().includes(selectorToAdd)) continue; // skip if selector is already marked for removal from another facet

      const existingFacetAddress = await diamondLoupe.facetAddress(selectorToAdd);
      if (existingFacetAddress != ZeroAddress) {
        // Selector exist on some other facet
        const selectorName = signatureToNameMapping[selectorToAdd];
        let answer;
        if (!(skipAll || replaceAll)) {
          const prompt = `Selector ${selectorName} is already registered on facet ${existingFacetAddress}. Do you want to (r)eplace or (s)kip it?\nUse "R" os "S" to apply the same choice to all remaining selectors in this facet. `;
          answer = await getUserResponse(prompt, ["r", "s", "R", "S"]);
          if (answer == "R") {
            replaceAll = true;
          } else if (answer == "S") {
            skipAll = true;
          }
        }
        if (replaceAll || answer == "r") {
          // User chose to replace
          selectorsToReplace.push(selectorToAdd);
        } else {
          // User chose to skip
          selectorsToSkip.push(selectorName);
        }
        // In any case, remove it from selectorsToAdd
        selectorsToAdd = removeSelectors(selectorsToAdd, [selectorName]);
      }
    }

    const newFacetAddress = await newFacet.getAddress();

    if (selectorsToAdd.length > 0) {
      facetCuts.push([newFacetAddress, FacetCutAction.Add, [...selectorsToAdd]]);
    }
    if (selectorsToReplace.length > 0) {
      facetCuts.push([newFacetAddress, FacetCutAction.Replace, [...selectorsToReplace]]);
    }
    if (selectorsToRemove.length > 0) {
      facetCuts.push([ZeroAddress, FacetCutAction.Remove, [...selectorsToRemove]]);
    }

    const newFacetInterfaceId = getInterfaceID(newFacet.interface);

    console.log(oldFacet.name, selectorsToAdd.length, selectorsToRemove.length);
    if (oldFacet && (selectorsToAdd.length > 0 || selectorsToRemove.length > 0)) {
      if (!oldFacet.interfaceId) {
        console.log(
          `Could not find interface id for old facet ${oldFacet.name}.\nYou might need to remove its interfaceId from "supportsInterface" manually.`,
        );
      } else {
        if (oldFacet.interfaceId == newFacetInterfaceId) {
          // This can happen if interface is shared across facets and interface was updated already
          continue;
        }

        interfacesToRemove[facetName] = oldFacet.interfaceId;

        // Check if interface was shared across other facets and update contracts info
        contracts = contracts.map((entry) => {
          if (entry.interfaceId == oldFacet.interfaceId) {
            entry.interfaceId = newFacetInterfaceId;
          }
          return entry;
        });
      }

      const erc165 = await getContractAt("IERC165", protocolAddress);
      const support = await erc165.supportsInterface(newFacetInterfaceId);
      if (!support) {
        interfacesToAdd[facetName] = newFacetInterfaceId;
      }
    }
  }

  // Get ProtocolInitializationHandlerFacet from deployedFacets when added/replaced in this upgrade or get it from contracts if already deployed
  let protocolInitializationFacet = await getInitializationFacet(deployedFacets, contracts);

  const facetsToInitAddresses = await Promise.all(
    Object.keys(facets.facetsToInit).map((facetName: string) => deployedFacets[facetName].getAddress()),
  );

  const initializeCalldata = protocolInitializationFacet.interface.encodeFunctionData("initialize", [
    encodeBytes32String(version),
    facetsToInitAddresses,
    Object.values(facets.facetsToInit),
    Object.values(interfacesToAdd),
    Object.values(interfacesToRemove),
  ]);

  await makeDiamondCut(
    await diamondCutFacet.getAddress(),
    facetCuts,
    await protocolInitializationFacet.getAddress(),
    initializeCalldata,
  );

  // Logs
  // for (const facet of deployedFacets) {
  //   console.log(`\n📋 Facet: ${facet.name}`);

  //   // let { cut } = facet;
  //   // cut = cut.map((c) => {
  //   //   const facetCut = FacetCut.fromStruct(c);
  //   //   return facetCut.toObject();
  //   // });

  //   logFacetCut(cut, signatureToNameMapping);
  // }

  console.log(`\n💀 Removed facets:\n\t${facets.remove.join("\n\t")}`);

  Object.keys(interfacesToAdd).length &&
    console.log(
      `📋 Added interfaces:\n\t${Object.entries(interfacesToAdd)
        .map((v) => `${v[1]} (${v[0]})`)
        .join("\n\t")}`,
    );
  Object.keys(interfacesToRemove).length &&
    console.log(
      `💀 Removed interfaces:\n\t${Object.entries(interfacesToRemove)
        .map((v) => `${v[1]} (${v[0]})`)
        .join("\n\t")}`,
    );

  console.log(divider);

  // Cast diamond to ProtocolInitializationHandlerFacet
  protocolInitializationFacet = await getContractAt("InitializationFacet", protocolAddress);
  const newVersion = (await protocolInitializationFacet.getVersion()).replace(/\0/g, "");

  console.log(`\n📋 New version: ${newVersion}`);

  const contractsPath = await writeContracts(contracts, env, newVersion, contractsFile.externalAddresses);
  console.log(divider);
  console.log(`✅ Contracts written to ${contractsPath}`);
  console.log(divider);

  console.log(`\n📋 Diamond upgraded.`);
  console.log("\n");

  if (env == "prod") {
    packageFile.version = newVersion;

    fs.writeFileSync("../package.json", JSON.stringify(packageFile, null, 2));
  }
}

async function getUserResponse(question: string, validResponses: string[]) {
  console.error(question);
  const answer: string = await new Promise((resolve) => {
    rl.question("", resolve);
  });
  if (validResponses.includes(answer)) {
    return answer;
  } else {
    console.error("Invalid response!");
    return await getUserResponse(question, validResponses);
  }
}

const getInitializationFacet = async (deployedFacets, contracts) => {
  const protocolInitializationName = "InitializationFacet";
  const protocolInitializationDeployed = deployedFacets[protocolInitializationName];

  if (protocolInitializationDeployed) return protocolInitializationDeployed;

  const protocolInitializationFacet = await getContractAt(
    protocolInitializationName,
    contracts.find((i) => i.name == protocolInitializationName).address,
  );

  if (!protocolInitializationFacet) {
    console.error("Could not find ProtocolInitializationHandlerFacet");
    process.exit(1);
  }

  return protocolInitializationFacet;
};

// const logFacetCut = (cut, functionNamesToSelector) => {
//   for (const action in FacetCutAction) {
//     cut
//       .filter((c) => c.action == FacetCutAction[action])
//       .forEach((c) => {
//         console.log(
//           `💎 ${action} selectors:\n\t${c.functionSelectors
//             .map((selector) => `${functionNamesToSelector[selector]}: ${selector}`)
//             .join("\n\t")}`,
//         );
//       });
//   }
// };
