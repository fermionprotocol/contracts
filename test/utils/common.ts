import { ethers } from "hardhat";
import { deploySuite } from "../../scripts/deploy";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { BigNumberish, Contract, Interface, toBeHex } from "ethers";

// We define a fixture to reuse the same setup in every test.
// We use loadFixture to run this setup once, snapshot that state,
// and reset Hardhat Network to that snapshot in every test.
// Use the same deployment script that is used in the deploy-suite task
export async function deployFermionProtocolFixture(defaultSigner: HardhatEthersSigner) {
  const { diamondAddress, facets, bosonProtocolAddress, wrapperImplementationAddress } = await deploySuite();

  const fermionErrors = await ethers.getContractAt("FermionErrors", diamondAddress);

  const wallets = await ethers.getSigners();
  defaultSigner = wallets[1];

  const implementationAddresses = {};
  for (const facetName of Object.keys(facets)) {
    implementationAddresses[facetName] = await facets[facetName].getAddress();
    facets[facetName] = facets[facetName].connect(defaultSigner).attach(diamondAddress);
  }

  return {
    diamondAddress,
    facets,
    implementationAddresses,
    fermionErrors,
    wallets,
    defaultSigner,
    bosonProtocolAddress,
    wrapperImplementationAddress,
  };
}

export async function deployMockTokens(tokenList: string[]) {
  const tokens: Contract[] = [];
  for (const tokenType of tokenList) {
    const Token = await ethers.getContractFactory(`Mock${tokenType}`);
    tokens.push(await Token.deploy());
  }

  return tokens;
}

export function deriveTokenId(offerId: BigNumberish, exchangeId: BigNumberish) {
  return (BigInt(offerId) << 128n) | BigInt(exchangeId);
}

export function getInterfaceID(contractInterface: Interface, inheritedInterfaces: string[] = []) {
  let interfaceID = 0n;
  const functions = contractInterface.fragments;
  for (const fn of functions) {
    if (fn.type === "function") {
      interfaceID = interfaceID ^ BigInt(fn.selector);
    }
  }

  for (const inheritedInterface of inheritedInterfaces) {
    interfaceID = interfaceID ^ BigInt(inheritedInterface);
  }

  return toBeHex(interfaceID, 4);
}
