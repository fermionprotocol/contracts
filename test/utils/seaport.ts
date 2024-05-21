import { ethers } from "hardhat";
import { resetCompilationFolder, setCompilationFolder } from "./common";

const { getContractFactory } = ethers;

// Deploys WETH, Boson Protocol Diamond, Boson Price Discovery, Boson Voucher Implementation, Boson Voucher Beacon Client
export async function initSeaportFixture() {
  await setSeaportCompilationFolder();

  const conduitControllerFactory = await getContractFactory("ConduitController");
  const conduitController = await conduitControllerFactory.deploy();
  await conduitController.waitForDeployment();

  // Deploy Seaport
  const seaportFactory = await getContractFactory("Seaport");
  const seaport = await seaportFactory.deploy(await conduitController.getAddress());
  await seaport.waitForDeployment();

  await resetCompilationFolder();

  return { seaportAddress: await seaport.getAddress() };
}

// Set the Seaport contracts compilation folder to the Boson Protocol contracts and compiles them.
// Used to avoid artifacts clashes.
async function setSeaportCompilationFolder() {
  const contracts = [["Seaport.sol"], ["conduit", "*.sol"]];

  return setCompilationFolder("seaport", contracts);
}
