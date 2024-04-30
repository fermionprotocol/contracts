import { ethers } from "hardhat";
import { deployDiamond, deployFacets, prepareFacetCuts, makeDiamondCut } from "../../scripts/deploy";
import { getStateModifyingFunctionsHashes } from "./metaTransaction";
import { initBosonProtocolFixture } from "./boson-protocol";

// We define a fixture to reuse the same setup in every test.
// We use loadFixture to run this setup once, snapshot that state,
// and reset Hardhat Network to that snapshot in every test.
export async function deployFermionProtocolFixture(defaultSigner: any) {
  const { bosonProtocolAddress } = await initBosonProtocolFixture();

  const { diamondAddress, initializationFacet } = await deployDiamond(bosonProtocolAddress);

  const facetNames = ["EntityFacet", "MetaTransactionFacet"];
  const constructorArgs = { MetaTransactionFacet: [diamondAddress] };
  const facets = await deployFacets(facetNames, constructorArgs);

  // Init other facets, using the initialization facet
  // Prepare init call
  const init = {
    MetaTransactionFacet: [await getStateModifyingFunctionsHashes(facetNames)],
  };
  const initAddresses = await Promise.all(Object.keys(init).map((facetName) => facets[facetName].getAddress()));
  const initCalldatas = Object.keys(init).map((facetName) =>
    facets[facetName].interface.encodeFunctionData("init", init[facetName]),
  );
  const functionCall = initializationFacet.interface.encodeFunctionData("initialize", [
    ethers.encodeBytes32String("test"),
    initAddresses,
    initCalldatas,
    [],
    [],
  ]);

  await makeDiamondCut(
    diamondAddress,
    await prepareFacetCuts(Object.values(facets)),
    await initializationFacet.getAddress(),
    functionCall,
  );

  const fermionErrors = await ethers.getContractAt("FermionErrors", diamondAddress);

  const wallets = await ethers.getSigners();
  defaultSigner = wallets[1];

  facetNames.push("InitializationFacet");
  facets["InitializationFacet"] = initializationFacet;

  const implementationAddresses = {};
  for (const facetName of facetNames) {
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
