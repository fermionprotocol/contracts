import fs from "fs";
import { ethers } from "hardhat";

const { provider, parseUnits, toBeHex } = ethers;

// Mimic the actual deployed Boson protocol contracts by setting their bytecodes to corresponding addresses
export async function initBosonProtocolFixture() {
  

  // Load the deployed bytecodes
  const deployedByteCodes = JSON.parse(fs.readFileSync("test/utils/boson-protocol-artifacts/deployedByteCodes.json", "utf8"));
  for (const contract of deployedByteCodes) {
    const { address, code } = contract;
    await provider.send("hardhat_setCode", [address, code]);
  }

  const bosonProtocolAddress = deployedByteCodes.find((contract) => contract.name === "ProtocolDiamond").address;
  const accessControllerAddress = deployedByteCodes.find((contract) => contract.name === "AccessController").address;
  const voucherBeaconAddress = deployedByteCodes.find((contract) => contract.name === "BosonVoucher Beacon").address;

  const initData = JSON.parse(fs.readFileSync("test/utils/boson-protocol-artifacts/storageInit.json", "utf8"));
  
  // Populate the access control state
  for (const [pointer, value] of Object.entries(initData.accessControllInitialState)) {
    await setStorage(accessControllerAddress, pointer, value);
  }

  // Populate the diamond state
  for (const [pointer, value] of Object.entries(initData.protocolDiamondInitialState)) {
    await setStorage(bosonProtocolAddress, pointer, value);
  }

    // Populate the voucher beacon state
    for (const [pointer, value] of Object.entries(initData.voucherBeaconInitialState)) {
        await setStorage(voucherBeaconAddress, pointer, value);
      }

  // Populate the diamond state
  const adminAddress = "0x2a91A0148EE62fA638bE38C7eE05c29a3e568dD8";
  await provider.send(
    "hardhat_impersonateAccount",
     [adminAddress],
  );
  await provider.send("hardhat_setBalance", [
    adminAddress,
    toBeHex(parseUnits("100", "ether")),
  ]);
  const adminWallet = await ethers.getSigner(adminAddress);
  
  // grant upgrader role
  await adminWallet.sendTransaction({to: accessControllerAddress, data: initData.grantUpgraderRole});

  // make a diamond cut, register the facets
  await adminWallet.sendTransaction({to: bosonProtocolAddress, data: initData.diamondCut});

  // set voucher beacon
  await adminWallet.sendTransaction({to: bosonProtocolAddress, data: initData.setVoucherBeacon});

  await provider.send(
    "hardhat_stopImpersonatingAccount",
    [adminAddress],
  );

  return { bosonProtocolAddress };
}

async function setStorage(address: string, pointer: string, value: string) {
    await provider.send("hardhat_setStorageAt", [
        address,
        pointer,
        value,
      ]);
}


