import { readContracts, writeContracts } from "./libraries/utils";
import { checkRole } from "./libraries/utils";
import { setupDryRun } from "./dry-run";
import fs from "fs";
import path from "path";
import hre from "hardhat";

interface FacetConfig {
  version: string;
  description: string;
  facets: {
    add: string[];
    remove: string[];
    skipSelectors: Record<string, string[]>;
  };
  initializationData?: string;
}

enum FacetCutAction {
  Add = 0,
  Replace = 1,
  Remove = 2,
}

export async function upgradeFacets(env: string, version: string, dryRun: boolean = false) {
  const { ethers } = hre;

  console.log(`🚀 Starting Protocol Upgrade to Version ${version}`);
  console.log(`📅 ${new Date().toLocaleString()}`);

  try {
    let balanceBefore: bigint = 0n;
    const getBalance: () => Promise<bigint> = async () => 0n;
    const originalEnv = env;

    // Get original chain ID before network change
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

    // Load upgrade config
    let config: FacetConfig | undefined;
    const configPath = path.join(__dirname, "config", "upgrades", `${version}.json`);
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, "utf8")) as FacetConfig;
      console.log(`📋 Upgrade description: ${config.description}`);
    } else {
      console.log(`ℹ️  No upgrade config found for version ${version}, will only execute hooks if available`);
    }

    // Load and execute pre-upgrade hook if it exists
    let preUpgrade, postUpgrade;
    try {
      const hookPath = path.join(__dirname, "upgrade-hooks", `${version}.ts`);
      if (fs.existsSync(hookPath)) {
        ({ preUpgrade, postUpgrade } = await import(hookPath));
        if (preUpgrade) {
          console.log("\n⚙️  Executing pre-upgrade hook...");
          await preUpgrade(protocolAddress, Number(originalChainId), originalEnv, dryRun);
          console.log("✅ Pre-upgrade hook completed");
        }
      }
    } catch (error) {
      console.log("ℹ️  No upgrade hooks found or error executing them:", error);
    }

    // Execute facet updates only if config exists
    if (config) {
      const diamondCutFacet = await ethers.getContractAt("DiamondCutFacet", protocolAddress);
      const diamondLoupe = await ethers.getContractAt("DiamondLoupeFacet", protocolAddress);
      const initializationFacet = await ethers.getContractAt("InitializationFacet", protocolAddress);

      // Deploy new facets
      console.log("\n🔨 Deploying new facets...");
      for (const facetName of config.facets.add) {
        console.log(`\n📦 Deploying ${facetName}...`);
        const Facet = await ethers.getContractFactory(facetName);
        const facetContract = await Facet.deploy();
        await facetContract.waitForDeployment();
        const facetAddress = await facetContract.getAddress();
        console.log(`✅ ${facetName} deployed at: ${facetAddress}`);

        // Get selectors and prepare facet cut
        const selectors = await diamondLoupe.facetFunctionSelectors(facetAddress);
        console.log(`📝 Adding ${selectors.length} function selectors`);

        // facet initialization is handled separately
        const tx = await diamondCutFacet.diamondCut(
          [[facetAddress, FacetCutAction.Add, selectors]],
          ethers.ZeroAddress,
          "0x",
        );
        await tx.wait();
        console.log(`✅ ${facetName} facet cut completed`);
      }

      if (config.facets.remove.length > 0) {
        console.log("\n🗑️  Removing facets...");
        for (const facetName of config.facets.remove) {
          console.log(`\n📦 Removing ${facetName}...`);
          const oldFacet = contracts.find((c: any) => c.name === facetName);
          if (oldFacet) {
            const selectors = await diamondLoupe.facetFunctionSelectors(oldFacet.address);
            console.log(`📝 Removing ${selectors.length} function selectors`);
            const tx = await diamondCutFacet.diamondCut(
              [[ethers.ZeroAddress, FacetCutAction.Remove, selectors]],
              ethers.ZeroAddress,
              "0x",
            );
            await tx.wait();
            console.log(`✅ ${facetName} removed successfully`);
          }
        }
      }

      if (config.initializationData && config.initializationData !== "0x") {
        console.log("\n⚙️  Executing initialization...");
        const tx = await diamondCutFacet.diamondCut([], initializationFacet.address, config.initializationData);
        await tx.wait();
        console.log("✅ Initialization completed");
      }
    }

    // Execute post-upgrade hook if it exists
    if (postUpgrade) {
      console.log("\n⚙️  Executing post-upgrade hook...");
      await postUpgrade(protocolAddress);
      console.log("✅ Post-upgrade hook completed");
    }

    // Update version in contracts file
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
