import { ethers } from "hardhat";
import {
  deployFacets,
  makeDiamondCut
} from "../../scripts/deploy";
import { getSelectors, FacetCutAction } from "../../scripts/libraries/diamond";

export async function deployBosonMetaTransactionFacet(bosonProtocolAddress: string) {
  const diamondLoupeFacet = await ethers.getContractAt(
    "DiamondLoupeFacet",
    bosonProtocolAddress
  );
  const facetsBefore = await diamondLoupeFacet.facets();

  const MetaTransactionsHandlerFacet = await ethers.getContractFactory("MetaTransactionsHandlerFacet");
  let selectors = 
    getSelectors(MetaTransactionsHandlerFacet)
    .remove(["init", "initialize"]);
  const allSelectors = facetsBefore.flatMap((facet) => facet[1]);
  selectors = selectors.filter((sel) => !allSelectors.includes(sel));
  if (selectors.length === 0) {
    console.log("MetaTransactionsHandlerFacet already deployed and registered in Boson Protocol");
    return;
  }
  // List all the functions the metaTransaction facet should allow
  const allowedFunctions = [
    "createSeller((uint256,address,address,address,address,bool,string),(uint256,uint8),(string,uint256,bytes32))"
  ];
  const metaTransactionsHandlerFacetInitArgs = allowedFunctions.map((smf) =>
    ethers.keccak256(ethers.toUtf8Bytes(smf))
  );
  const facets = await deployFacets(["MetaTransactionsHandlerFacet"], {});
  const metaTxFacet = facets["MetaTransactionsHandlerFacet"];
  const metaTxFacetAddress = await metaTxFacet.getAddress();
  const functionCall = metaTxFacet.interface.encodeFunctionData("initialize", [
    metaTransactionsHandlerFacetInitArgs
  ]);
  await makeDiamondCut(
    bosonProtocolAddress,
    [{
      facetAddress: metaTxFacetAddress,
      action: FacetCutAction.Add,
      functionSelectors: selectors
    }],
    metaTxFacetAddress,
    functionCall
  );
}
