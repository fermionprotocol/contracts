import hre from "hardhat";
const { ZeroAddress, getSigners, getContractAt, getContractFactory } = hre.ethers;
const network = hre.network.name;

import { readContracts, writeContracts, checkRole } from "./libraries/utils";

/**
 * Upgrades clients
 *
 * Prerequisite:
 * - Admin must have UPGRADER role.
 *
 */
export async function upgradeClients(env, version) {
  // Bail now if hardhat network, unless the upgrade is tested
  if (network === "hardhat" && env !== "upgrade-test" && !env.includes("dry-run")) process.exit();

  const contractsFile = await readContracts(env);
  let { contracts } = contractsFile;
  const { externalAddresses } = contractsFile;

  const divider = "-".repeat(80);
  console.log(`${divider}\nFermion Protocol Client Upgrader\n${divider}`);
  console.log(`⛓  Network: ${network}\n📅 ${new Date()}`);

  const adminAddress = (await getSigners())[0].address;

  // If admin address is unspecified, exit the process
  if (adminAddress == ZeroAddress || !adminAddress) {
    console.log("Admin address must not be zero address");
    process.exit(1);
  }

  console.log(divider);

  // Get addresses of currently deployed Beacon contract
  const protocolAddress = contracts.find((c: any) => c.name === "FermionDiamond")?.address;
  if (!protocolAddress) {
    console.error(`Protocol address not found in contracts file for ${env}`);
    process.exit(1);
  }

  // Validate that admin has UPGRADER role
  checkRole(contracts, "UPGRADER", adminAddress);

  // Deploy Protocol Client implementation contracts
  console.log(`\n📋 Deploying new logic contract`);

  const bosonPriceDiscoveryAddress = externalAddresses.bosonPriceDiscoveryAddress;
  const seaportWrapperConstructorArgs = [bosonPriceDiscoveryAddress, externalAddresses.seaportConfig];
  const FermionSeaportWrapper = await getContractFactory("SeaportWrapper");
  const fermionSeaportWrapper = await FermionSeaportWrapper.deploy(...seaportWrapperConstructorArgs);

  const fermionFNFTConstructorArgs = [
    bosonPriceDiscoveryAddress,
    await fermionSeaportWrapper.getAddress(),
    externalAddresses.wrappedNativeAddress,
  ];
  const FermionFNFTFactory = await getContractFactory("FermionFNFT");
  const fermionFNFT = await FermionFNFTFactory.deploy(...fermionFNFTConstructorArgs);
  await fermionFNFT.waitForDeployment();
  const fnftImplementationAddress = await fermionFNFT.getAddress();

  // Update implementation address on beacon contract
  console.log(`\n📋 Updating implementation address on beacon`);
  const configFacet = await getContractAt("ConfigFacet", protocolAddress);
  await configFacet.setFNFTImplementationAddress(fnftImplementationAddress);

  // Remove old entry from contracts
  contracts = contracts.filter((i) => i.name !== "FermionFNFT");
  contracts.push({ name: "FermionFNFT", address: fnftImplementationAddress, args: fermionFNFTConstructorArgs });

  const contractsPath = await writeContracts(contracts, env, version, contractsFile.externalAddresses);
  console.log(divider);
  console.log(`✅ Contracts written to ${contractsPath}`);
  console.log(divider);

  console.log(`\n📋 Client upgraded.`);
  console.log("\n");
}
