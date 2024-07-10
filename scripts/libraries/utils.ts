import { BigNumberish } from "ethers";
import fs from "fs";
import { ethers, network } from "hardhat";
import { vars } from "hardhat/config";

const addressesDirPath = __dirname + `/../../addresses`;

export async function writeContracts(contracts: any[], env: string | undefined, version: string) {
  if (!fs.existsSync(addressesDirPath)) {
    fs.mkdirSync(addressesDirPath);
  }
  const { chainId } = await ethers.provider.getNetwork();
  const networkName = network.name;

  const path = getAddressesFilePath(chainId, networkName, env);
  fs.writeFileSync(
    path,
    JSON.stringify(
      {
        chainId: Number(chainId),
        network: networkName,
        env: env,
        protocolVersion: version,
        contracts,
      },
      null,
      2,
    ),
    "utf-8",
  );

  return path;
}

export function getAddressesFilePath(chainId: BigNumberish, network: string, env: string | undefined) {
  return `${addressesDirPath}/${chainId}${network ? `-${network.toLowerCase()}` : ""}${env ? `-${env}` : ""}.json`;
}

export async function readContracts(env: string | undefined) {
  const { chainId } = await ethers.provider.getNetwork();
  const networkName = network.name;
  return JSON.parse(fs.readFileSync(getAddressesFilePath(chainId, networkName, env), "utf-8"));
}

export function checkDeployerAddress(networkName: string) {
  // Check if the deployer key is set
  const NETWORK = networkName.toUpperCase();
  if (!vars.has(`DEPLOYER_KEY_${NETWORK}`)) {
    throw Error(
      `DEPLOYER_KEY_${NETWORK} not found in configuration variables. Use 'npx hardhat vars set DEPLOYER_KEY_${NETWORK}' to set it or 'npx hardhat vars setup' to list all the configuration variables used by this project.`,
    );
  }
}
