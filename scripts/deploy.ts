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
  const facetCuts = [];
  for (const FacetName of FacetNames) {
    const Facet = await ethers.getContractFactory(FacetName);
    const facet = await Facet.deploy();
    await facet.waitForDeployment();
    console.log(`${FacetName} deployed: ${await facet.getAddress()}`);
    facetCuts.push({
      facetAddress: await facet.getAddress(),
      action: FacetCutAction.Add,
      functionSelectors: getSelectors(facet),
    });
  }

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

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
deployDiamond().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
