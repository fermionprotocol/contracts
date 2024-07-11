import { BigNumberish, id } from "ethers";
import fs from "fs";
import hre, { ethers, network } from "hardhat";
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

/**
 * Deploy a contract, either using CREATE or CREATE3
 *
 * @param contractName - name of the contract to deploy
 * @param create3 - CREATE3 deployment configuration (factory address and salt)
 * @param constructorArgs - constructor arguments
 * @param constructorArgsTypes - constructor argument types
 */
export async function deployContract(
  contractName: string,
  create3: { address: string; salt: string } | null,
  constructorArgs: any[] = [],
  constructorArgsTypes: string[] = [],
) {
  const contractFactory = await ethers.getContractFactory(contractName);

  if (create3) {
    //Deploy using CREATE3
    const salt = id(create3.salt + contractName);
    const byteCode = contractFactory.bytecode;
    let creationData = salt + byteCode.slice(2);
    if (constructorArgs.length > 0) {
      const abiCoder = new hre.ethers.AbiCoder();
      const encodedConstructorArgs = abiCoder.encode(constructorArgsTypes, constructorArgs);
      creationData += encodedConstructorArgs.slice(2);
    }

    const [deployer] = await hre.ethers.getSigners();

    const transaction = {
      to: create3.address,
      data: creationData,
    };

    // get the contract address. If it exists, it cannot be deployed again
    let contractAddress: string;
    try {
      contractAddress = await deployer.call(transaction);
    } catch (e) {
      console.log(`${contractName} cannot be deployed.`);
      process.exit(1);
    }

    // deploy the contract
    const tx = await deployer.sendTransaction(transaction);
    await tx.wait();
    const contract = await ethers.getContractAt(contractName, contractAddress);

    return contract;
  }

  // Deploy using CREATE
  const contract = await contractFactory.deploy(...constructorArgs);
  await contract.waitForDeployment();

  return contract;
}
