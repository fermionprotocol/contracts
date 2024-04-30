import { ethers } from "hardhat";
import { FacetCutAction, getSelectors } from "./libraries/diamond";

export async function deployDiamond(bosonProtocolAddress: string) {
  const accounts = await ethers.getSigners();
  const contractOwner = accounts[0];

  // Deploy facets and set the `facetCuts` variable
  console.log("");
  console.log("Deploying facets");
  const FacetNames = ["DiamondCutFacet", "DiamondLoupeFacet", "OwnershipFacet", "InitializationFacet"];
  // The `facetCuts` variable is the FacetCut[] that contains the functions to add during diamond deployment
  const facets = await deployFacets(FacetNames);
  const facetCuts = await prepareFacetCuts(Object.values(facets), ["init", "initialize", "initializeDiamond"]);

  // Creating a function call
  // This call gets executed during deployment. For upgrades, "initialize" is called.
  // It is executed with delegatecall on the DiamondInit address.
  const initializationFacet = facets["InitializationFacet"];
  const initializeBosonSeller = initializationFacet.interface.encodeFunctionData("initializeDiamond", [
    bosonProtocolAddress,
  ]);

  // Setting arguments that will be used in the diamond constructor
  const diamondArgs = {
    owner: contractOwner.address,
    init: await initializationFacet.getAddress(),
    initCalldata: initializeBosonSeller,
  };

  // deploy Diamond
  const Diamond = await ethers.getContractFactory("Diamond");
  const diamond = await Diamond.deploy(facetCuts, diamondArgs);
  await diamond.waitForDeployment();
  console.log();
  console.log("Diamond deployed:", await diamond.getAddress());

  // returning the address of the diamond and the initialization contract
  return { diamondAddress: await diamond.getAddress(), initializationFacet };
}

export async function deployFacets(facetNames: string[], constructorArgs: object = {}) {
  const facets: object = {};
  for (const facetName of facetNames) {
    const Facet = await ethers.getContractFactory(facetName);
    const ca: string[] = constructorArgs[facetName] || [];
    const facet = await Facet.deploy(...ca);
    await facet.waitForDeployment();
    console.log(`${facetName} deployed: ${await facet.getAddress()}`);
    facets[facetName] = facet;
  }

  return facets;
}

export async function prepareFacetCuts(facets, omitSelectors = []) {
  const facetCuts: object[] = [];
  for (const facet of facets) {
    facetCuts.push({
      facetAddress: await facet.getAddress(),
      action: FacetCutAction.Add,
      functionSelectors: getSelectors(facet).remove(omitSelectors),
    });
  }
  return facetCuts;
}

export async function makeDiamondCut(diamondAddress, facetCuts, initAddress = ethers.ZeroAddress, initData = "0x") {
  const diamondCutFacet = await ethers.getContractAt("DiamondCutFacet", diamondAddress);
  const tx = await diamondCutFacet.diamondCut(facetCuts, initAddress, initData);
  const receipt = await tx.wait();
  if (!receipt.status) {
    throw Error(`Diamond upgrade failed: ${tx.hash}`);
  }
  console.log("Diamond cut executed");
  return tx;
}
