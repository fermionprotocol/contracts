import { ethers } from "hardhat";
import { deployDiamond, deployFacets, prepareFacetCuts, makeDiamondCut } from "../../scripts/deploy";
import { getStateModifyingFunctionsHashes } from "./metaTransaction";

// We define a fixture to reuse the same setup in every test.
// We use loadFixture to run this setup once, snapshot that state,
// and reset Hardhat Network to that snapshot in every test.
export async function deployFermionProtocolFixture(defaultSigner: any) {
  const diamondAddress = await deployDiamond();
  const facetNames = ["EntityFacet", "MetaTransactionFacet"];
  const constructorArgs = { MetaTransactionFacet: [diamondAddress] };
  const facets = await deployFacets(facetNames, constructorArgs);

  // Deploy multiInit facet
  // N.B. This is a temporary solution until we add protocol initialization facet
  const DiamondMutiInit = await ethers.getContractFactory("DiamondMultiInit");
  const diamondMutiInit = await DiamondMutiInit.deploy();
  await diamondMutiInit.waitForDeployment();

  // Prepare init call
  const init = {
    MetaTransactionFacet: [await getStateModifyingFunctionsHashes(facetNames)],
  };
  const initAddresses = await Promise.all(Object.keys(init).map((facetName) => facets[facetName].getAddress()));
  const initCalldatas = Object.keys(init).map((facetName) =>
    facets[facetName].interface.encodeFunctionData("init", init[facetName]),
  );
  const functionCall = diamondMutiInit.interface.encodeFunctionData("multiInit", [initAddresses, initCalldatas]);

  await makeDiamondCut(
    diamondAddress,
    await prepareFacetCuts(Object.values(facets)),
    await diamondMutiInit.getAddress(),
    functionCall,
  );

  const fermionErrors = await ethers.getContractAt("FermionErrors", diamondAddress);

  const wallets = await ethers.getSigners();
  defaultSigner = wallets[1];

  for (const facetName of facetNames) {
    facets[facetName] = facets[facetName].connect(defaultSigner).attach(diamondAddress);
  }

  return { diamondAddress, facets, fermionErrors, wallets, defaultSigner };
}
