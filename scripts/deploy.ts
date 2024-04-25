import { ethers } from "hardhat";
import { FacetCutAction, getSelectors } from "./libraries/diamond";

export async function deployDiamond() {
  const accounts = await ethers.getSigners();
  const contractOwner = accounts[0];

  // Deploy DiamondInit
  // DiamondInit provides a function that is called when the diamond is upgraded or deployed to initialize state variables
  // Read about how the diamondCut function works in the EIP2535 Diamonds standard
  const DiamondInit = await ethers.getContractFactory("DiamondInit");
  const diamondInit = await DiamondInit.deploy();
  await diamondInit.waitForDeployment();
  console.log("DiamondInit deployed:", await diamondInit.getAddress());

  // Deploy facets and set the `facetCuts` variable
  console.log("");
  console.log("Deploying facets");
  const FacetNames = ["DiamondCutFacet", "DiamondLoupeFacet", "OwnershipFacet"];
  // The `facetCuts` variable is the FacetCut[] that contains the functions to add during diamond deployment
  const facetCuts = await prepareFacetCuts(Object.values(await deployFacets(FacetNames)));

  // Creating a function call
  // This call gets executed during deployment and can also be executed in upgrades
  // It is executed with delegatecall on the DiamondInit address.
  const functionCall = diamondInit.interface.encodeFunctionData("init");

  // Setting arguments that will be used in the diamond constructor
  const diamondArgs = {
    owner: contractOwner.address,
    init: await diamondInit.getAddress(),
    initCalldata: functionCall,
  };

  // deploy Diamond
  const Diamond = await ethers.getContractFactory("Diamond");
  const diamond = await Diamond.deploy(facetCuts, diamondArgs);
  await diamond.waitForDeployment();
  console.log();
  console.log("Diamond deployed:", await diamond.getAddress());

  // returning the address of the diamond
  return await diamond.getAddress();
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
}
