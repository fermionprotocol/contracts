import * as hre from "hardhat";
import { Contract } from "ethers";

export async function setBosonConfig(bosonProtocolAddress: string, config: { bosonProtocolFlatFee: string }) {
  if (config.bosonProtocolFlatFee !== undefined) {
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
      }]`,
      deployer
    );
    const tx =
      await bosonConfigHandler.setProtocolFeeFlatBoson(config.bosonProtocolFlatFee);
    await tx.wait();
  }
}