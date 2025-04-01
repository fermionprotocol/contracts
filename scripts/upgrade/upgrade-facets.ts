import { readContracts, writeContracts } from "../libraries/utils";
import { checkRole } from "../libraries/utils";
import { setupDryRun } from "../dry-run";
import fs from "fs";
import path from "path";
import hre from "hardhat";
import { getSelectors, removeSelectors } from "../libraries/diamond";
import readline from "readline";

interface FacetConfig {
  version: string;
  description: string;
  facets: {
    add: string[];
    replace: string[];
    remove: string[];
    skipSelectors?: Record<string, string[]>;
    constructorArgs?: Record<string, any[]>;
    initializeData?: Record<string, any[]>;
  };
  initializationData?: string;
}

enum FacetCutAction {
  Add = 0,
  Replace = 1,
  Remove = 2,
}

interface DeployedFacet {
  name: string;
  contract: any;
  cut: [string, FacetCutAction, string[]][];
  initialize?: string;
  constructorArgs: any[];
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

export async function upgradeFacets(env: string, version: string, dryRun: boolean = false) {
  const { ethers } = hre;

  console.log(`🚀 Starting Protocol Upgrade to Version ${version}`);
  console.log(`📅 ${new Date().toLocaleString()}`);

  try {
    let balanceBefore: bigint = 0n;
    const getBalance: () => Promise<bigint> = async () => 0n;
    const originalEnv = env;
    const originalNetwork = await ethers.provider.getNetwork();
    const originalChainId = originalNetwork.chainId;

    if (dryRun) {
      ({ env, deployerBalance: balanceBefore } = await setupDryRun(env));
      console.log("🧪 Running in DRY-RUN mode");
    }

    const contractsFile = await readContracts(env);
    const contracts = contractsFile?.contracts;

    if (contractsFile?.protocolVersion === version && !dryRun) {
      throw new Error(`Protocol is already at version ${version}`);
    }

    const signer = (await ethers.getSigners())[0].address;
    checkRole(contracts, "UPGRADER", signer);

    const protocolAddress = contracts.find((c: any) => c.name === "FermionDiamond")?.address;
    if (!protocolAddress) {
      throw new Error("Protocol address not found");
    }
    console.log(`📝 Protocol address: ${protocolAddress}`);

    const configPath = path.join(__dirname, "..", "config", "upgrades", `${version}.json`);
    const config: FacetConfig | undefined = fs.existsSync(configPath)
      ? JSON.parse(fs.readFileSync(configPath, "utf8"))
      : undefined;

    if (config) {
      console.log(`📋 Upgrade description: ${config.description}`);
    } else {
      console.log(`ℹ️  No upgrade config found for version ${version}, will only execute hooks if available`);
    }

    await executePreUpgradeHook(version, protocolAddress, originalChainId, originalEnv, dryRun);

    if (config) {
      await executeFacetUpdates(config, protocolAddress, contracts, contractsFile);
    }

    await executePostUpgradeHook(version, protocolAddress);

    const initializationFacet = await ethers.getContractAt("InitializationFacet", protocolAddress);
    const newVersion = (await initializationFacet.getVersion()).replace(/\0/g, "");
    console.log(`\n📋 New protocol version: ${newVersion}`);

    const contractsPath = await writeContracts(contracts, env, newVersion);
    console.log(`✅ Contracts written to ${contractsPath}`);

    if (dryRun) {
      const balanceAfter = await getBalance();
      const etherSpent = balanceBefore - balanceAfter;
      console.log(`\n💰 Gas spent: ${ethers.formatEther(etherSpent)} ETH`);
    }

    console.log("\n🎉 Upgrade completed successfully!");
  } catch (error) {
    console.error("\n❌ Upgrade failed:", error);
    throw error;
  }
}

// Internal functions below
async function getUserResponse(question: string, validResponses: string[]): Promise<string> {
  console.error(question);
  const answer = await new Promise<string>((resolve) => {
    rl.question("", resolve);
  });
  if (validResponses.includes(answer)) {
    return answer;
  } else {
    console.error("Invalid response!");
    return getUserResponse(question, validResponses);
  }
}

async function deployAndPrepareNewFacet(
  facetName: string,
  config: FacetConfig,
  contracts: any[],
  contractsFile: any,
): Promise<DeployedFacet | null> {
  console.log(`\n📦 Deploying ${facetName}...`);
  const Facet = await hre.ethers.getContractFactory(facetName);
  const functionSelectors = await getSelectors(Facet);

  if (functionSelectors.length === 0) {
    console.log(`⚠️  Skipping ${facetName} as it has no function selectors`);
    return null;
  }

  const skipSelectors = config.facets.skipSelectors?.[facetName] ?? [];
  const filteredSelectors = removeSelectors(functionSelectors, skipSelectors);

  if (filteredSelectors.length === 0) {
    console.log(`⚠️  Skipping ${facetName} as all its selectors are in skip list`);
    return null;
  }

  const constructorArgs = await prepareConstructorArgs(facetName, config, contracts, contractsFile);
  const facetContract = await Facet.deploy(...constructorArgs);
  await facetContract.waitForDeployment();
  const facetAddress = await facetContract.getAddress();
  console.log(`✅ ${facetName} deployed at: ${facetAddress}`);

  const initializeData = await prepareInitializeData(facetContract, config, facetName);

  return {
    name: facetName,
    contract: facetContract,
    cut: [[facetAddress, FacetCutAction.Add, filteredSelectors]],
    initialize: initializeData !== "0x" ? initializeData : undefined,
    constructorArgs,
  };
}

async function prepareConstructorArgs(
  facetName: string,
  config: FacetConfig,
  contracts: any[],
  contractsFile: any,
): Promise<any[]> {
  let constructorArgs = config.facets.constructorArgs?.[facetName] ?? [];

  constructorArgs = constructorArgs.map((arg) => {
    if (arg === "$FERMION_PROTOCOL_ADDRESS") {
      const fermionProtocol = contracts.find((c) => c.name === "FermionDiamond");
      if (!fermionProtocol) {
        throw new Error(`Cannot deploy ${facetName}: FermionDiamond address not found in contracts file.`);
      }
      return fermionProtocol.address;
    }
    if (arg === "$BOSON_PROTOCOL_ADDRESS") {
      const bosonProtocolAddress = contractsFile.externalAddresses?.bosonProtocolAddress;
      if (!bosonProtocolAddress) {
        throw new Error(`Cannot deploy ${facetName}: BosonDiamond address not found in externalAddresses.`);
      }
      return bosonProtocolAddress;
    }
    return arg;
  });

  if (constructorArgs.length > 0) {
    console.log(`📝 Constructor arguments for ${facetName}:`, constructorArgs);
  }

  return constructorArgs;
}

async function prepareInitializeData(facetContract: any, config: FacetConfig, facetName: string): Promise<string> {
  if (!config.facets.initializeData?.[facetName]) {
    return "0x";
  }
  const initArgs = config.facets.initializeData[facetName];
  return facetContract.interface.encodeFunctionData("initialize", initArgs);
}

async function prepareFacetRemoval(
  facetName: string,
  oldAddress: string,
  config: FacetConfig,
): Promise<[string, FacetCutAction, string[]] | null> {
  console.log(`\n📦 Preparing removal of ${facetName}...`);
  const oldFacetContract = await hre.ethers.getContractAt(facetName, oldAddress);
  const functionSelectors = await getSelectors(oldFacetContract);

  if (functionSelectors.length === 0) {
    console.log(`⚠️  Skipping ${facetName} removal as it has no function selectors`);
    return null;
  }

  const skipSelectors = config.facets.skipSelectors?.[facetName] ?? [];
  const filteredSelectors = removeSelectors(functionSelectors, skipSelectors);

  if (filteredSelectors.length === 0) {
    console.log(`⚠️  Skipping ${facetName} removal as all its selectors are in skip list`);
    return null;
  }

  return [hre.ethers.ZeroAddress, FacetCutAction.Remove, filteredSelectors];
}

async function handleSelectorCollision(
  selectorToAdd: string,
  existingFacetAddress: string,
  newFacet: DeployedFacet,
  skipAll: boolean,
  replaceAll: boolean,
): Promise<{ shouldReplace: boolean; shouldSkip: boolean; skipAll: boolean; replaceAll: boolean }> {
  const functionName = newFacet.contract.interface.getFunction(selectorToAdd)?.format() || "Unknown function";

  console.log(`⚠️  Selector ${selectorToAdd} (${functionName}) is already registered:`);
  console.log(`   Existing facet: ${existingFacetAddress}`);
  console.log(`   New facet: ${await newFacet.contract.getAddress()}`);

  if (skipAll || replaceAll) {
    return { shouldReplace: replaceAll, shouldSkip: skipAll, skipAll, replaceAll };
  }

  const prompt = `Do you want to (r)eplace or (s)kip it?\nUse (r)eplace or (s)kip for current selector, (R)eplace or (S)kip for all remaining selectors in this facet. `;
  const answer = await getUserResponse(prompt, ["r", "s", "R", "S"]);

  if (answer === "R") {
    replaceAll = true;
  } else if (answer === "S") {
    skipAll = true;
  }

  return {
    shouldReplace: answer === "R" || answer === "r",
    shouldSkip: answer === "S" || answer === "s",
    skipAll,
    replaceAll,
  };
}

async function executeDiamondCut(
  diamondCutFacet: any,
  cuts: [string, FacetCutAction, string[]][],
  initFacetAddress: string,
  initializationData: string,
  facetContracts: Map<string, any>,
) {
  console.log("\n💎 Executing diamond cut...");
  console.log(`📝 Total cuts to execute: ${cuts.length}`);

  for (const [address, action, selectors] of cuts) {
    const functionNames = await Promise.all(
      selectors.map(async (selector) => {
        try {
          // Try to get function name from the facet contract
          const facetContract = facetContracts.get(address.toLowerCase());
          if (facetContract) {
            const functionName = facetContract.interface.getFunction(selector)?.format();
            if (functionName) return functionName;
          }
          return "Unknown function";
        } catch {
          return "Unknown function";
        }
      }),
    );

    console.log(
      `  ${action === FacetCutAction.Add ? "Add" : action === FacetCutAction.Remove ? "Remove" : "Replace"} ${selectors.length} selectors ${action === FacetCutAction.Remove ? "from" : "to"} ${address}`,
    );
    console.log("    Functions:");
    functionNames.forEach((name, i) => {
      console.log(`      - ${name} (${selectors[i]})`);
    });
  }

  const tx = await diamondCutFacet.diamondCut(cuts, initFacetAddress, initializationData);
  await tx.wait();
  console.log("✅ Diamond cut completed successfully");
}

async function executePreUpgradeHook(
  version: string,
  protocolAddress: string,
  originalChainId: bigint,
  originalEnv: string,
  dryRun: boolean,
) {
  try {
    const hookPath = path.join(__dirname, "upgrade-hooks", `${version}.ts`);
    if (fs.existsSync(hookPath)) {
      const { preUpgrade } = await import(hookPath);
      if (preUpgrade) {
        console.log("\n⚙️  Executing pre-upgrade hook...");
        await preUpgrade(protocolAddress, Number(originalChainId), originalEnv, dryRun);
        console.log("✅ Pre-upgrade hook completed");
      }
    }
  } catch {
    console.log("ℹ️  No upgrade hooks found or error executing them");
  }
}

async function executePostUpgradeHook(version: string, protocolAddress: string) {
  try {
    const hookPath = path.join(__dirname, "upgrade-hooks", `${version}.ts`);
    if (fs.existsSync(hookPath)) {
      const { postUpgrade } = await import(hookPath);
      if (postUpgrade) {
        console.log("\n⚙️  Executing post-upgrade hook...");
        await postUpgrade(protocolAddress);
        console.log("✅ Post-upgrade hook completed");
      }
    }
  } catch {
    console.log("ℹ️  No upgrade hooks found or error executing them");
  }
}

async function executeFacetUpdates(config: FacetConfig, protocolAddress: string, contracts: any[], contractsFile: any) {
  const diamondCutFacet = await hre.ethers.getContractAt("DiamondCutFacet", protocolAddress);
  const initializationFacet = await hre.ethers.getContractAt("InitializationFacet", protocolAddress);
  const initFacetAddress = await initializationFacet.getAddress();

  if (!initFacetAddress) {
    throw new Error("InitializationFacet address is null");
  }
  console.log(`📝 InitializationFacet address: ${initFacetAddress}`);

  const allFacetsToDeploy = [...config.facets.add, ...config.facets.replace];
  const deployedFacets = await Promise.all(
    allFacetsToDeploy.map((facetName) => deployAndPrepareNewFacet(facetName, config, contracts, contractsFile)),
  );

  const facetCuts = await Promise.all(
    config.facets.remove.map((facetName) => {
      const oldFacet = contracts.find((c: any) => c.name === facetName);
      return oldFacet ? prepareFacetRemoval(facetName, oldFacet.address, config) : null;
    }),
  );

  const validDeployedFacets = deployedFacets.filter((f): f is DeployedFacet => f !== null);
  const validFacetCuts = facetCuts.filter((c): c is [string, FacetCutAction, string[]] => c !== null);

  const diamondLoupe = await hre.ethers.getContractAt("DiamondLoupeFacet", protocolAddress);
  const removedSelectors: string[][] = [];
  let mutableContracts = [...contracts];

  // Create a map of facet addresses to their contracts
  const facetContracts = new Map<string, any>();
  for (const facet of validDeployedFacets) {
    const address = await facet.contract.getAddress();
    facetContracts.set(address.toLowerCase(), facet.contract);
  }

  for (const facetToRemove of config.facets.remove) {
    const oldFacet = mutableContracts.find((c: any) => c.name === facetToRemove);
    if (!oldFacet) continue;

    const registeredSelectors = [...(await diamondLoupe.facetFunctionSelectors(oldFacet.address))];
    if (registeredSelectors.length === 0) continue;

    mutableContracts = mutableContracts.filter((c: any) => c.name !== facetToRemove);
    removedSelectors.push(registeredSelectors);
    validFacetCuts.push([hre.ethers.ZeroAddress, FacetCutAction.Remove, registeredSelectors]);
  }

  for (const [index, newFacet] of validDeployedFacets.entries()) {
    const oldFacet = mutableContracts.find((c: any) => c.name === newFacet.name);
    const registeredSelectors = oldFacet ? [...(await diamondLoupe.facetFunctionSelectors(oldFacet.address))] : [];

    mutableContracts = mutableContracts.filter((c: any) => c.name !== newFacet.name);

    const newSelectors = await getSelectors(newFacet.contract);

    let selectorsToReplace = registeredSelectors.filter((value: string) => newSelectors.includes(value));
    let selectorsToRemove = registeredSelectors.filter((value: string) => !selectorsToReplace.includes(value));
    let selectorsToAdd = newSelectors.filter((value: string) => !selectorsToReplace.includes(value));

    let selectorsToSkip = [...(config.facets.skipSelectors?.[newFacet.name] ?? [])];
    selectorsToReplace = removeSelectors(selectorsToReplace, selectorsToSkip);
    selectorsToRemove = removeSelectors(selectorsToRemove, selectorsToSkip);
    selectorsToAdd = removeSelectors(selectorsToAdd, selectorsToSkip);

    let skipAll = false;
    let replaceAll = false;

    for (const selectorToAdd of [...selectorsToAdd]) {
      if (removedSelectors.flat().includes(selectorToAdd)) continue;

      const existingFacetAddress = await diamondLoupe.facetAddress(selectorToAdd);
      if (existingFacetAddress !== hre.ethers.ZeroAddress) {
        const {
          shouldReplace,
          shouldSkip,
          skipAll: newSkipAll,
          replaceAll: newReplaceAll,
        } = await handleSelectorCollision(selectorToAdd, existingFacetAddress, newFacet, skipAll, replaceAll);

        skipAll = newSkipAll;
        replaceAll = newReplaceAll;

        if (shouldReplace) {
          selectorsToReplace = [...selectorsToReplace, selectorToAdd];
        } else if (shouldSkip) {
          selectorsToSkip = [...selectorsToSkip, selectorToAdd];
        }
        selectorsToAdd = selectorsToAdd.filter((s) => s !== selectorToAdd);
      }
    }

    const newFacetAddress = await newFacet.contract.getAddress();
    validDeployedFacets[index].cut = [];

    if (selectorsToAdd.length > 0) {
      validDeployedFacets[index].cut.push([newFacetAddress, FacetCutAction.Add, selectorsToAdd]);
    }
    if (selectorsToReplace.length > 0) {
      validDeployedFacets[index].cut.push([newFacetAddress, FacetCutAction.Replace, selectorsToReplace]);
    }
    if (selectorsToRemove.length > 0) {
      validDeployedFacets[index].cut.push([hre.ethers.ZeroAddress, FacetCutAction.Remove, selectorsToRemove]);
    }
  }

  const allCuts = [...validFacetCuts, ...validDeployedFacets.flatMap((facet) => facet.cut)];

  const consolidatedCuts = new Map<string, [string, FacetCutAction, string[]]>();
  for (const [address, action, selectors] of allCuts) {
    const key = `${address}-${action}`;
    if (consolidatedCuts.has(key)) {
      const existing = consolidatedCuts.get(key)!;
      existing[2] = [...new Set([...existing[2], ...selectors])];
    } else {
      consolidatedCuts.set(key, [address, action, selectors]);
    }
  }

  const finalCuts = Array.from(consolidatedCuts.values());

  if (finalCuts.length > 0) {
    await executeDiamondCut(
      diamondCutFacet,
      finalCuts,
      initFacetAddress,
      config.initializationData || "0x",
      facetContracts,
    );
  } else {
    console.log("ℹ️  No facet cuts to execute");
  }
}
