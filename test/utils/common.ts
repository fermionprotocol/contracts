import { deployDiamond, deployFacets, prepareFacetCuts, makeDiamondCut } from "../../scripts/deploy";

// We define a fixture to reuse the same setup in every test.
// We use loadFixture to run this setup once, snapshot that state,
// and reset Hardhat Network to that snapshot in every test.
export async function deployFermionProtocolFixture() {
  const diamondAddress = await deployDiamond();
  const facetNames = ["EntityFacet", "MetaTransactionFacet"];
  const constructorArgs = { MetaTransactionFacet: [diamondAddress] };
  const facets = await deployFacets(facetNames, constructorArgs);

  await makeDiamondCut(diamondAddress, await prepareFacetCuts(Object.values(facets)));

  return { diamondAddress, facets };
}
