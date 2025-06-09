/* eslint-disable @typescript-eslint/no-unused-vars */
import * as hre from "hardhat";
import { cpSync } from "fs";
import { resolve } from "path";
import {
  deployFermionProtocolFixture,
  deployMockTokens
} from "../test/utils/common";
import { Contract } from "ethers";
import shelljs from "shelljs";

async function main() {
  // const bosonProtocol = "0x0";
  // await deployDiamond(bosonProtocol);
  const defaultSigner = (await hre.ethers.getSigners())[1];
  const { bosonProtocolAddress } =
    await deployFermionProtocolFixture(defaultSigner);

  // deploy an ERC20 contract
  const [erc20] = await deployMockTokens(["ERC20"]);
  console.log(`ERC20 deployed at ${await erc20.getAddress()}`);

  // NOTE: DO NOT SET THE BOSON FLAT FEE UNTIL THE BOSON CONTRACTS ARE UPGRADED POST v2.4.1
  // AS IT CAUSES ISSUES WITH PRICE DISCOVERY OFFERS (INCL FERMION OFFERS)
  // set Boson Protocol flat fee to a non zero value
  // const bosonProtocolFlatFee = "1000000000000000"; // = 0.001
  const bosonProtocolFlatFee = "0";
  const deployer = (await hre.ethers.getSigners())[0];
  const bosonConfigHandler = new Contract(
    bosonProtocolAddress,
    `[{
      "inputs": [
        {
          "internalType": "uint256",
          "name": "_protocolFeeFlatBoson",
          "type": "uint256"
        }
      ],
      "name": "setProtocolFeeFlatBoson",
      "outputs": [],
      "stateMutability": "nonpayable",
      "type": "function"
    },{
      "inputs": [],
      "name": "getPriceDiscoveryAddress",
      "outputs": [
        {
          "internalType": "address",
          "name": "",
          "type": "address"
        }
      ],
      "stateMutability": "view",
      "type": "function"
    },{
      "inputs": [],
      "name": "getTokenAddress",
      "outputs": [
        {
          "internalType": "address payable",
          "name": "",
          "type": "address"
        }
      ],
      "stateMutability": "view",
      "type": "function"
    }]`,
    deployer
  );
  const tokenAddress = await bosonConfigHandler.getTokenAddress();
  console.log("tokenAddress", tokenAddress);
  const priceDiscoveryClient =
    await bosonConfigHandler.getPriceDiscoveryAddress();
  console.log("priceDiscoveryClient", priceDiscoveryClient);
  const tx =
    await bosonConfigHandler.setProtocolFeeFlatBoson(bosonProtocolFlatFee);
  await tx.wait();
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
