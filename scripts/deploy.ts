import fs from "fs";
import { ethers, network } from "hardhat";
import { vars } from "hardhat/config";
import { FacetCutAction, getSelectors } from "./libraries/diamond";
import { getStateModifyingFunctionsHashes } from "./libraries/metaTransaction";
import { writeContracts, readContracts } from "./libraries/utils";

import { initBosonProtocolFixture } from "./../test/utils/boson-protocol";

const version = "0.0.1";
let deploymentData: any[] = [];

export async function deploySuite(env: string = "", modules: string[] = []) {
  const allModules = modules.length === 0 || network.name === "hardhat" || network.name === "localhost";

  // if deploying with hardhat, first deploy the boson protocol
  let bosonProtocolAddress: string;
  if (network.name === "hardhat" || network.name === "localhost") {
    ({ bosonProtocolAddress } = await initBosonProtocolFixture());
  } else {
    // Check if the deployer key is set
    const NETWORK = network.name.toUpperCase();
    if (!vars.has(`DEPLOYER_KEY_${NETWORK}`)) {
      throw Error(
        `DEPLOYER_KEY_${NETWORK} not found in configuration variables. Use 'npx hardhat vars set DEPLOYER_KEY_${NETWORK}' to set it or 'npx hardhat vars setup' to list all the configuration variables used by this project.`,
      );
    }

    // Get boson protocol address
    const { chainId } = await ethers.provider.getNetwork();
    const { contracts: bosonContracts } = JSON.parse(
      fs.readFileSync(
        `node_modules/@bosonprotocol/boson-protocol-contracts/addresses/${chainId}-${network.name.toLowerCase()}-${env}.json`,
        "utf8",
      ),
    );

    bosonProtocolAddress = bosonContracts.find((contract) => contract.name === "ProtocolDiamond")?.address;
  }
  const deployerAddress = (await ethers.getSigners())[0].address;
  console.log(`Deploying to network: ${network.name} (env: ${env}) with deployer: ${deployerAddress}`);
  console.log(`Boson Protocol address: ${bosonProtocolAddress}`);

  // deploy wrapper implementation
  let wrapperImplementationAddress: string;
  if (allModules || modules.includes("wrapper")) {
    const constructorArgs = [
      ethers.ZeroAddress,
      ethers.ZeroAddress,
      ethers.ZeroAddress,
      ethers.ZeroAddress,
      "0",
      ethers.ZeroAddress,
      ethers.ZeroHash,
      bosonProtocolAddress, // dummy value
    ]; // ToDo: get correct values

    const FermionWrapper = await ethers.getContractFactory("FermionWrapper");
    const fermionWrapper = await FermionWrapper.deploy(...constructorArgs);
    await fermionWrapper.waitForDeployment();
    wrapperImplementationAddress = await fermionWrapper.getAddress();

    deploymentComplete("FermionWrapper", wrapperImplementationAddress, constructorArgs, true);
  } else {
    deploymentData = await getDeploymentData(env);
    wrapperImplementationAddress = deploymentData.find((contract) => contract.name === "FermionWrapper")?.address;

    if (!wrapperImplementationAddress) {
      throw Error("Fermion wrapper implementation not found in contracts file");
    }
  }

  // deploy diamond
  let diamondAddress, initializationFacet;
  if (allModules || modules.includes("diamond")) {
    ({ diamondAddress, initializationFacet } = await deployDiamond(bosonProtocolAddress, wrapperImplementationAddress));
    //  setEnvironmentData()
    await writeContracts(deploymentData, env, version);
  } else {
    // get the diamond address and initialization from contracts file
    deploymentData = await getDeploymentData(env);

    diamondAddress = deploymentData.find((contract) => contract.name === "FermionDiamond")?.address;
    const initializationFacetAddress = deploymentData.find(
      (contract) => contract.name === "InitializationFacet",
    )?.address;

    if (!diamondAddress || !initializationFacetAddress) {
      throw Error("Diamond address or initialization facet not found in contracts file");
    }

    initializationFacet = await ethers.getContractAt("InitializationFacet", initializationFacetAddress);
  }

  // deploy facets
  const facetNames = ["EntityFacet", "MetaTransactionFacet", "OfferFacet"];
  let facets = {};

  if (allModules || modules.includes("facets")) {
    const constructorArgs = { MetaTransactionFacet: [diamondAddress], OfferFacet: [bosonProtocolAddress] };
    facets = await deployFacets(facetNames, constructorArgs, true);
    await writeContracts(deploymentData, env, version);
  } else if (modules.includes("initialize")) {
    // get the facets from from contracts file
    deploymentData = await getDeploymentData(env);

    for (const facetName of facetNames) {
      const faceAddress = deploymentData.find((contract) => contract.name === facetName)?.address;

      if (!faceAddress) {
        throw Error(`${facetName} address not found in contracts file`);
      }

      facets[facetName] = await ethers.getContractAt(facetName, faceAddress);
    }
  }

  // initialize facets
  if (allModules || modules.includes("initialize")) {
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
      ethers.encodeBytes32String(version),
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

    facets["InitializationFacet"] = initializationFacet;
  }

  return { diamondAddress, facets, bosonProtocolAddress };
}

export async function deployDiamond(bosonProtocolAddress: string, wrapperImplementationAddress: string) {
  const accounts = await ethers.getSigners();
  const contractOwner = accounts[0];

  // Deploy facets and set the `facetCuts` variable
  console.log("");
  console.log("Deploying facets");
  const FacetNames = ["DiamondCutFacet", "DiamondLoupeFacet", "OwnershipFacet", "InitializationFacet"];
  // The `facetCuts` variable is the FacetCut[] that contains the functions to add during diamond deployment
  const facets = await deployFacets(FacetNames, {}, true);
  const facetCuts = await prepareFacetCuts(Object.values(facets), ["init", "initialize", "initializeDiamond"]);

  // Creating a function call
  // This call gets executed during deployment. For upgrades, "initialize" is called.
  // It is executed with delegatecall on the DiamondInit address.
  const initializationFacet = facets["InitializationFacet"];
  const initializeBosonSeller = initializationFacet.interface.encodeFunctionData("initializeDiamond", [
    bosonProtocolAddress,
    wrapperImplementationAddress,
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
  deploymentComplete("FermionDiamond", await diamond.getAddress(), [facetCuts, diamondArgs], true);

  // returning the address of the diamond and the initialization contract
  return { diamondAddress: await diamond.getAddress(), initializationFacet };
}

export async function deployFacets(facetNames: string[], constructorArgs: object = {}, save: boolean = false) {
  const facets: object = {};
  for (const facetName of facetNames) {
    const Facet = await ethers.getContractFactory(facetName);
    const ca: string[] = constructorArgs[facetName] || [];
    const facet = await Facet.deploy(...ca);
    await facet.waitForDeployment();
    deploymentComplete(facetName, await facet.getAddress(), ca, save);
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

function deploymentComplete(name: string, address: string, args: string[], save: boolean = false) {
  if (save) deploymentData.push({ name, address, args });
  console.log(`✅ ${name} deployed to: ${address}`);
}

async function getDeploymentData(env: string) {
  if (deploymentData.length === 0) {
    const contractsFile = await readContracts(env);
    deploymentData = contractsFile.contracts;
  }
  return deploymentData;
}
