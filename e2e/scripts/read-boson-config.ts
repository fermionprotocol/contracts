import * as hre from "hardhat";
import { Contract } from "ethers";

export async function readBosonConfig(bosonProtocolAddress: string): Promise<{ tokenAddress: string, priceDiscoveryClient: string }> {
  const deployer = (await hre.ethers.getSigners())[0];
  const bosonConfigHandler = new Contract(
    bosonProtocolAddress,
    `[{
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
  const priceDiscoveryClient =
    await bosonConfigHandler.getPriceDiscoveryAddress();
  return {
    tokenAddress,
    priceDiscoveryClient
  };
}
