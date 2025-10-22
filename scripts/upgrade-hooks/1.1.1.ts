import { encodeBytes32String } from "ethers";
import hre from "hardhat";
import { readContracts } from "../libraries/utils";
import { FacetConfig } from "../upgrade/upgrade-facets";
const { ethers } = hre;

// Function to get the InitializationFacet address based on chainId and env
export async function getInitializationFacetAddress(chainId: number, env: string): Promise<string> {
  const addressData = await readContracts(env);
  const initializationFacet = addressData.contracts.find((contract: any) => contract.name === "InitializationFacet");

  if (!initializationFacet) {
    throw new Error(`InitializationFacet not found in addresses file for chainId ${chainId} and env ${env}`);
  }

  return initializationFacet.address;
}

/**
 * Perform pre-upgrade tasks, including deploying the BackfillingV1_1_0 contract,
 * preparing initialization data, and making the diamond cut.
 */
export async function preUpgrade(
  protocolAddress: string,
  chainId: number,
  env: string,
  version: string,
  config: FacetConfig | undefined,
  isDryRun: boolean = false,
) {
  const versionBytes = encodeBytes32String(version);
  // Use the correct environment name based on whether we're in dry-run mode
  const envForContracts = isDryRun ? `${env}-dry-run` : env;
  const initializationFacetImplAddress = await getInitializationFacetAddress(chainId, envForContracts);
  console.log(`InitializationFacet implementation address: ${initializationFacetImplAddress}`);

  const addresses: string[] = [];
  const calldata: string[] = [];
  const interfacesToAdd: string[] = [];
  const interfacesToRemove: string[] = [];

  // Get the initialization facet to encode the calldata properly
  const initializationFacet = await ethers.getContractAt("InitializationFacet", protocolAddress);
  const initCalldata = initializationFacet.interface.encodeFunctionData("initialize", [
    versionBytes,
    addresses,
    calldata,
    interfacesToAdd,
    interfacesToRemove,
  ]);

  config.initializationAddress = initializationFacetImplAddress;
  config.initializationData = initCalldata;
}

/**
 * Perform post-upgrade tasks, including verification of the upgrade.
 */
export async function postUpgrade(protocolAddress: string) {
  console.log("Verifying upgrade...");
  const initializationFacet = await ethers.getContractAt("InitializationFacet", protocolAddress);
  const version = await initializationFacet.getVersion();
  console.log(`Verified version: ${version.replace(/\0/g, "")}`);
}
