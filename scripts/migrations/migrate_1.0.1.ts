import shell from "shelljs";

import hre from "hardhat";
import { readContracts } from "../libraries/utils";
import { getStateModifyingFunctionsHashes } from "../libraries/metaTransaction";
import { upgradeFacets } from "../upgrade-facets";

const { getContractAt } = hre.ethers;

const tag = "HEAD";

const config = {
  addOrUpgrade: [
    "ConfigFacet",
    "CustodyFacet",
    "CustodyVaultFacet",
    "EntityFacet",
    "FundsFacet",
    "MetaTransactionFacet",
    "OfferFacet",
    "PauseFacet",
    "VerificationFacet",
  ],
  remove: [],
  skipSelectors: {},
  constructorArgs: {},
  facetsToInit: {},
  initializationData: "0x",
};

export async function migrate(env: string = "") {
  console.log(`Migration ${tag} started`);
  try {
    // shell.exec(`git reset @{u}`);
    // const statusOutput = shell.exec("git status -s -uno scripts");

    // if (statusOutput.stdout) {
    //   throw new Error("Local changes found. Please stash them before upgrading");
    // }

    const contractsFile = await readContracts(env);
    if (contractsFile?.protocolVersion != "1.0.0-rc.4") {
      throw new Error("Current contract version must be 1.0.0-rc.4");
    }

    // Checking old version contracts to get selectors to remove
    console.log("Checking out contracts on version 1.0.0");
    shell.exec(`rm -rf contracts/protocol`);
    shell.exec(`git checkout v1.0.0 contracts`);

    // console.log("Compiling old contracts");
    await hre.run("clean");
    await hre.run("compile");

    const contracts = contractsFile?.contracts;

    // Get addresses of currently deployed contracts
    const protocolAddress = contracts.find((c) => c.name === "FermionDiamond")?.address;

    const selectorsToRemove = await getStateModifyingFunctionsHashes(config.addOrUpgrade);

    console.log(`Checking out contracts on version ${tag}`);
    shell.exec(`rm -rf contracts/protocol`);
    shell.exec(`git checkout ${tag} contracts package.json yarn.lock`);

    console.log("Installing dependencies");
    shell.exec(`yarn`);

    console.log("Compiling contracts");
    await hre.run("clean");
    await hre.run("compile");

    console.log("Executing upgrade facets script");

    const { bosonProtocolAddress } = contractsFile?.externalAddresses;

    config.constructorArgs = {
      MetaTransactionFacet: [protocolAddress],
      OfferFacet: [bosonProtocolAddress],
      VerificationFacet: [bosonProtocolAddress],
    };

    await upgradeFacets(env, config, tag.replace("v", ""));

    const selectorsToAdd = await getStateModifyingFunctionsHashes(config.addOrUpgrade);

    const metaTransactionHandlerFacet = await getContractAt("MetaTransactionFacet", protocolAddress);

    console.log("Removing selectors", selectorsToRemove.join(","));
    await metaTransactionHandlerFacet.setAllowlistedFunctions(selectorsToRemove, false);
    console.log("Adding selectors", selectorsToAdd.join(","));
    await metaTransactionHandlerFacet.setAllowlistedFunctions(selectorsToAdd, true);

    shell.exec(`git checkout HEAD`);
    console.log(`Migration ${tag} completed`);
  } catch (e) {
    console.error(e);
    shell.exec(`git checkout HEAD`);
    throw `Migration failed with: ${e}`;
  }
}
