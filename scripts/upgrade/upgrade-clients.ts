import { readContracts, writeContracts } from "../libraries/utils";
import { checkRole } from "../libraries/utils";
import { setupDryRun, getBalance } from "../dry-run";
import fs from "fs";
import path from "path";
import hre from "hardhat";
import fermionConfig from "../../fermion.config";
import { deploymentComplete, getDeploymentData, deploymentData } from "../deploy";

interface ClientConfig {
  version: string;
  description: string;
  clients: {
    fermionFNFT: string[];
  };
}

async function deployDependencies(protocolAddress: string, bosonPriceDiscoveryAddress: string, seaportConfig: any) {
  console.log("\n📦 Deploying dependencies...");

  const SeaportWrapper = await hre.ethers.getContractFactory("SeaportWrapper");
  const seaportWrapper = await SeaportWrapper.deploy(bosonPriceDiscoveryAddress, protocolAddress, seaportConfig);
  await seaportWrapper.waitForDeployment();
  const seaportWrapperAddress = await seaportWrapper.getAddress();
  deploymentComplete(
    "SeaportWrapper",
    seaportWrapperAddress,
    [bosonPriceDiscoveryAddress, protocolAddress, seaportConfig],
    true,
  );

  const FermionFractionsERC20 = await hre.ethers.getContractFactory("FermionFractionsERC20");
  const fermionFractionsERC20 = await FermionFractionsERC20.deploy(protocolAddress);
  await fermionFractionsERC20.waitForDeployment();
  const fermionFractionsERC20Address = await fermionFractionsERC20.getAddress();
  deploymentComplete("FermionFractionsERC20", fermionFractionsERC20Address, [protocolAddress], true);

  const FermionFractionsMint = await hre.ethers.getContractFactory("FermionFractionsMint");
  const fermionFractionsMint = await FermionFractionsMint.deploy(
    bosonPriceDiscoveryAddress,
    protocolAddress,
    fermionFractionsERC20Address,
  );
  await fermionFractionsMint.waitForDeployment();
  const fermionFractionsMintAddress = await fermionFractionsMint.getAddress();
  deploymentComplete(
    "FermionFractionsMint",
    fermionFractionsMintAddress,
    [bosonPriceDiscoveryAddress, protocolAddress, fermionFractionsERC20Address],
    true,
  );

  const FermionFNFTPriceManager = await hre.ethers.getContractFactory("FermionFNFTPriceManager");
  const fermionFNFTPriceManager = await FermionFNFTPriceManager.deploy(protocolAddress);
  await fermionFNFTPriceManager.waitForDeployment();
  const fermionFNFTPriceManagerAddress = await fermionFNFTPriceManager.getAddress();
  deploymentComplete("FermionFNFTPriceManager", fermionFNFTPriceManagerAddress, [protocolAddress], true);

  const FermionBuyoutAuction = await hre.ethers.getContractFactory("FermionBuyoutAuction");
  const fermionBuyoutAuction = await FermionBuyoutAuction.deploy(bosonPriceDiscoveryAddress, protocolAddress);
  await fermionBuyoutAuction.waitForDeployment();
  const fermionBuyoutAuctionAddress = await fermionBuyoutAuction.getAddress();
  deploymentComplete(
    "FermionBuyoutAuction",
    fermionBuyoutAuctionAddress,
    [bosonPriceDiscoveryAddress, protocolAddress],
    true,
  );

  return {
    seaportWrapperAddress,
    fermionFractionsERC20Address,
    fermionFractionsMintAddress,
    fermionFNFTPriceManagerAddress,
    fermionBuyoutAuctionAddress,
  };
}

export async function upgradeClients(env: string, targetVersion: string, dryRun: boolean = false) {
  const { ethers } = hre;
  let balanceBefore: bigint = 0n;
  const originalNetworkName = hre.network.name;
  let currentEnv = env;

  if (dryRun) {
    ({ env: currentEnv, deployerBalance: balanceBefore } = await setupDryRun(env));
  }

  const contractsFile = await readContracts(currentEnv);
  if (!contractsFile) {
    throw new Error("Failed to read contracts file");
  }

  if (contractsFile.protocolVersion === targetVersion && !dryRun) {
    throw new Error(`Protocol is already at version ${targetVersion}`);
  }

  const signer = (await ethers.getSigners())[0].address;
  checkRole(contractsFile.contracts, "ADMIN", signer);

  const protocolAddress = contractsFile.contracts.find((c: any) => c.name === "FermionDiamond")?.address;
  if (!protocolAddress) {
    throw new Error("Protocol address not found in contracts file");
  }

  // Initialize deployment data with existing contracts
  await getDeploymentData(currentEnv);

  const configPath = path.join(__dirname, "..", "config", "upgrades", `${targetVersion}.json`);
  const config: ClientConfig | undefined = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, "utf8"))
    : undefined;

  if (!config) {
    throw new Error(`No upgrade config found for version ${targetVersion}`);
  }

  const bosonPriceDiscoveryAddress = contractsFile.externalAddresses?.bosonPriceDiscoveryAddress;
  const wrappedNativeAddress = contractsFile.externalAddresses?.wrappedNativeAddress;

  const networkConfig = fermionConfig.externalContracts[originalNetworkName];
  if (!networkConfig) {
    throw new Error(`No configuration found for network ${originalNetworkName} in fermion.config.ts`);
  }

  const { seaportConfig, strictAuthorizedTransferSecurityRegistry } = networkConfig;

  if (!bosonPriceDiscoveryAddress) {
    throw new Error("Boson Price Discovery address not found in external addresses");
  }
  if (!wrappedNativeAddress) {
    throw new Error("Wrapped Native address not found in external addresses");
  }
  if (!seaportConfig) {
    throw new Error("Seaport configuration not found in network config");
  }

  const dependencies = await deployDependencies(protocolAddress, bosonPriceDiscoveryAddress, seaportConfig);

  console.log("\n📦 Deploying FermionFNFT...");
  const FermionFNFT = await hre.ethers.getContractFactory("FermionFNFT");
  const fermionFNFT = await FermionFNFT.deploy(
    bosonPriceDiscoveryAddress,
    protocolAddress,
    dependencies.seaportWrapperAddress,
    strictAuthorizedTransferSecurityRegistry,
    wrappedNativeAddress,
    dependencies.fermionFractionsMintAddress,
    dependencies.fermionFNFTPriceManagerAddress,
    dependencies.fermionBuyoutAuctionAddress,
  );
  await fermionFNFT.waitForDeployment();
  const fermionFNFTAddress = await fermionFNFT.getAddress();
  console.log(`✅ FermionFNFT deployed at: ${fermionFNFTAddress}`);

  console.log("\n⚙️  Updating FermionFNFT implementation in diamond...");
  const configFacet = await ethers.getContractAt("ConfigFacet", protocolAddress);
  await configFacet.setFNFTImplementationAddress(fermionFNFTAddress);
  console.log("✅ FermionFNFT implementation updated");

  // Write the updated contracts to file
  await writeContracts(deploymentData, currentEnv, targetVersion);

  if (dryRun) {
    const balanceAfter = await getBalance();
    const etherSpent = balanceBefore - balanceAfter;
    console.log(`\n💰 Gas spent: ${ethers.formatEther(etherSpent)} ETH`);
  }
}
