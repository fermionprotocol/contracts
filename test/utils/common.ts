import { ethers } from "hardhat";
import { deploySuite } from "../../scripts/deploy";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

// We define a fixture to reuse the same setup in every test.
// We use loadFixture to run this setup once, snapshot that state,
// and reset Hardhat Network to that snapshot in every test.
// Use the same deployment script that is used in the deploy-suite task
export async function deployFermionProtocolFixture(defaultSigner: HardhatEthersSigner) {
  const { diamondAddress, facets, bosonProtocolAddress } = await deploySuite();

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
  };
}
