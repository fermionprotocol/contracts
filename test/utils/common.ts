import fs from "fs";
import { ethers } from "hardhat";
import { deployDiamond, deployFacets, prepareFacetCuts, makeDiamondCut } from "../../scripts/deploy";
import { getStateModifyingFunctionsHashes } from "./metaTransaction";
import { initBosonProtocolFixture } from "./boson-protocol";

let bosonProtocolAddress: string;

// We define a fixture to reuse the same setup in every test.
// We use loadFixture to run this setup once, snapshot that state,
// and reset Hardhat Network to that snapshot in every test.
export async function deployFermionProtocolFixture(defaultSigner: any) {
  ({ bosonProtocolAddress } = await initBosonProtocolFixture());

  const diamondAddress = await deployDiamond();
  const facetNames = ["EntityFacet", "MetaTransactionFacet"];
  const constructorArgs = { MetaTransactionFacet: [diamondAddress] };
  const initFacet = await deployFacets(["InitializationFacet"]);
  const facets = await deployFacets(facetNames, constructorArgs);

  // Initialize Boson seller and buyer
  // ToDo: make this part of "deployDiamond" function
  const initializationFacet = initFacet["InitializationFacet"];
  const initializeBosonSeller = initializationFacet.interface.encodeFunctionData("initializeBosonSellerAndBuyer", [
    bosonProtocolAddress,
  ]);

  await makeDiamondCut(
    diamondAddress,
    await prepareFacetCuts(Object.values(initFacet), ["initializeBosonSellerAndBuyer", "initialize"]),
    await initializationFacet.getAddress(),
    initializeBosonSeller,
  );

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
  facets["InitializationFacet"] = initFacet["InitializationFacet"];

  const implementationAddresses = {};
  for (const facetName of facetNames) {
    implementationAddresses[facetName] = await facets[facetName].getAddress();
    facets[facetName] = facets[facetName].connect(defaultSigner).attach(diamondAddress);
  }

  return { diamondAddress, facets, implementationAddresses, fermionErrors, wallets, defaultSigner };
}

// Load Boson handler ABI creates contract instant and attach it to the Boson protocol address
// If Boson protocol is not initialized yet, it will be initialized
export async function getBosonHandler(handlerName: string) {
  if (!bosonProtocolAddress) {
    ({ bosonProtocolAddress } = await initBosonProtocolFixture());
  }

  const { abi: facetABI } = JSON.parse(
    fs.readFileSync(`test/utils/boson-protocol-artifacts/abis/${handlerName}.sol/${handlerName}.json`, "utf8"),
  );

  const facet = await ethers.getContractAt(facetABI, bosonProtocolAddress);

  return facet;
}
