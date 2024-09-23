import shell from "shelljs";
import { readContracts } from "../libraries/utils.js";
import hre from "hardhat";
const { provider, getContractAt } = hre.ethers;
const network = hre.network.name;
import { getStateModifyingFunctionsHashes } from "../libraries/metaTransaction";
const tag = "HEAD";

const config = {
  addOrUpgrade: [
    "AccountHandlerFacet",
    "SellerHandlerFacet",
    "DisputeResolverHandlerFacet",
    "OrchestrationHandlerFacet1",
    "ProtocolInitializationHandlerFacet",
  ],
  remove: [],
  skipSelectors: {},
  constructorArgs: {},
  facetsToInit: {
    AccountHandlerFacet: { init: [] },
    OrchestrationHandlerFacet1: { init: [] },
  },
  initializationData: "0x",
};

export async function migrate(env: string) {
  console.log(`Migration ${tag} started`);
  try {
    console.log("Removing any local changes before upgrading");
    shell.exec(`git reset @{u}`);
    const statusOutput = shell.exec("git status -s -uno scripts");

    if (statusOutput.stdout) {
      throw new Error("Local changes found. Please stash them before upgrading");
    }

    // Checking old version contracts to get selectors to remove
    console.log("Checking out contracts on version 1.0.0");
    shell.exec(`rm -rf contracts/*`);
    shell.exec(`git checkout v1.0.0 contracts`);

    console.log("Compiling old contracts");
    await hre.run("clean");

    await hre.run("compile");

    const { chainId } = await provider.getNetwork();
    const contractsFile = readContracts(chainId, network, env);

    if (contractsFile?.protocolVersion != "1.0.0-rc.4") {
      throw new Error("Current contract version must be 1.0.0-rc.4");
    }

    const contracts = contractsFile?.contracts;

    // Get addresses of currently deployed contracts
    const protocolAddress = contracts.find((c) => c.name === "ProtocolDiamond")?.address;

    const selectorsToRemove = await getStateModifyingFunctionsHashes(
      ["SellerHandlerFacet", "OrchestrationHandlerFacet1"],
      undefined,
      ["createSeller", "updateSeller"],
    );

    console.log(`Checking out contracts on version ${tag}`);
    shell.exec(`rm -rf contracts/*`);
    shell.exec(`git checkout ${tag} contracts package.json package-lock.json`);

    console.log("Installing dependencies");
    shell.exec(`yarn`);

    console.log("Compiling contracts");
    await hre.run("clean");
    await hre.run("compile");

    console.log("Executing upgrade facets script");
    await hre.run("upgrade-facets", {
      env,
      facetConfig: JSON.stringify(config),
      newVersion: tag.replace("v", ""),
    });

    const selectorsToAdd = await getStateModifyingFunctionsHashes(
      ["SellerHandlerFacet", "OrchestrationHandlerFacet1"],
      undefined,
      ["createSeller", "updateSeller"],
    );

    const metaTransactionHandlerFacet = await getContractAt("MetaTransactionsHandlerFacet", protocolAddress);

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
