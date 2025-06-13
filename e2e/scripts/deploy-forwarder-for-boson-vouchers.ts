import { ethers } from "hardhat";

export async function deployForwarderForBosonVouchers(bosonProtocolAddress: string) {
  const MockForwarder = await ethers.getContractFactory("MockForwarder");
  const forwarder = await MockForwarder.deploy();
  console.log("Redeploy another BosonVoucher implementation contract with forwarder set");
  const BosonVoucher = await ethers.getContractFactory("BosonVoucher");
  const bosonVoucher = await BosonVoucher.deploy(await forwarder.getAddress());
  const bosonConfigHandler = await ethers.getContractAt("ConfigHandlerFacet", bosonProtocolAddress);
  const clientBeaconAddress = await bosonConfigHandler.getVoucherBeaconAddress();
  const clientBeacon = await ethers.getContractAt("BosonClientBeacon", clientBeaconAddress);
  const tx = await clientBeacon.setImplementation(await bosonVoucher.getAddress());
  const receipt = await tx.wait();
  if (!receipt.status) {
    throw Error(`ClientBeacon upgrade failed: ${tx.hash}`);
  }
  console.log("ClientBeacon upgraded");
  console.log("Effective Forwarder:", await forwarder.getAddress());
}
