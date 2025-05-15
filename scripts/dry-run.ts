import shell from "shelljs";
import hre from "hardhat";
import { getAddressesFilePath, checkDeployerAddress } from "./libraries/utils";

const { ethers } = hre;
const { getSigners, parseEther, getContractAt } = hre.ethers;
const networkName = hre.network.name;

export async function setupDryRun(env: string, adminAddress: string = "", isTest: boolean = false) {
  let forkedEnv = env;

  console.warn("This is a dry run. No actual upgrade will be performed");
  const { chainId: forkedChainId } = await ethers.provider.getNetwork();

  forkedEnv = env;

  let deployerBalance = await getBalance();
  // const blockNumber = await ethers.provider.getBlockNumber();

  // if deployerBalance is 0, set it to 100 ether
  if (deployerBalance == 0n) deployerBalance = parseEther("100", "ether");

  // change network to hardhat with forking enabled
  hre.config.networks["hardhat"].forking = {
    url: hre.config.networks[networkName].url,
    enabled: true,
    // blockNumber: "0x" + blockNumber.toString(16), // if performance is too slow, try commenting this line out
    originalChain: {
      chainId: forkedChainId,
      name: networkName,
    },
  };

  if (!isTest) checkDeployerAddress(networkName);
  hre.config.networks["hardhat"].accounts = [
    { privateKey: hre.config.networks[networkName].accounts[0], balance: deployerBalance.toString() },
  ];
  hre.config.networks["hardhat"].gasPrice = Number((await ethers.provider.getFeeData()).gasPrice);
  hre.config.networks["hardhat"].initialBaseFeePerGas = Number(
    (await ethers.provider.getBlock("latest")).baseFeePerGas,
  );

  await hre.changeNetwork("hardhat");

  env = `${env}-dry-run`;

  const { chainId } = await ethers.provider.getNetwork();
  if (chainId.toString() != "31337") process.exit(1); // make sure network is hardhat

  // Send a small transaction to initialize the fork
  const signer = (await getSigners())[0];
  await signer.sendTransaction({ to: signer.address, value: 0 });

  // copy addresses file
  shell.cp(getAddressesFilePath(forkedChainId, networkName, forkedEnv), getAddressesFilePath(chainId, "hardhat", env));

  const deployerAddress = (await getSigners())[0].address;
  if (adminAddress != "") {
    // Relevant only for upgrades if admin address is provided

    console.log("Sending 1 ether to the admin");
    const deployer = await ethers.getSigner(deployerAddress);
    await deployer.sendTransaction({ to: adminAddress, value: parseEther("1", "ether") });
    deployerBalance -= parseEther("1", "ether");

    await hre.network.provider.request({
      method: "hardhat_impersonateAccount",
      params: [adminAddress],
    });

    const admin = await ethers.getSigner(adminAddress);

    // give roles to deployer
    const contractsFile = await readContracts(env);
    const deploymentData = contractsFile.contracts;
    const diamondAddress = deploymentData.find((contract) => contract.name === "FermionDiamond")?.address;
    const accessController = await getContractAt("AccessController", diamondAddress, admin);

    console.log("Granting roles to upgrader");
    await accessController.grantRole(ethers.id("ADMIN"), deployerAddress);
    await accessController.grantRole(ethers.id("PAUSER"), deployerAddress);
    await accessController.grantRole(ethers.id("UPGRADER"), deployerAddress);
  }

  return { env, deployerBalance };
}

export async function getBalance() {
  const upgraderAddress = (await getSigners())[0].address;
  const upgraderBalance = await ethers.provider.getBalance(upgraderAddress);
  return upgraderBalance;
}

// methods to change network and get provider
// copied from "hardhat-change-network" (https://www.npmjs.com/package/hardhat-change-network)
// and adapted to work with new hardhat version
const providers = {};
hre.getProvider = async function getProvider(name) {
  if (!providers[name]) {
    const { createProvider } = await import("hardhat/internal/core/providers/construction");
    // providers[name] = construction_1.createProvider(name, this.config.networks[name], this.config.paths, this.artifacts);
    providers[name] = await createProvider(this.config, name, this.artifacts);
  }
  return providers[name];
};
hre.changeNetwork = async function changeNetwork(newNetwork: string) {
  if (!this.config.networks[newNetwork]) {
    throw new Error(`changeNetwork: Couldn't find network '${newNetwork}'`);
  }
  if (!providers[this.network.name]) {
    providers[this.network.name] = this.network.provider;
  }
  this.network.name = newNetwork;
  this.network.config = this.config.networks[newNetwork];
  this.network.provider = await this.getProvider(newNetwork);
  if (this.ethers) {
    const { HardhatEthersProvider } = await import("@nomicfoundation/hardhat-ethers/internal/hardhat-ethers-provider");
    this.ethers.provider = new HardhatEthersProvider(this.network.provider, newNetwork);
  }
};
