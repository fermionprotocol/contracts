import fs from "fs";
import { ethers, network } from "hardhat";
import { vars } from "hardhat/config";
import { FacetCutAction, getSelectors } from "./libraries/diamond";
import { getStateModifyingFunctionsHashes } from "./libraries/metaTransaction";
import { writeContracts, readContracts } from "./libraries/utils";

import { initBosonProtocolFixture, getBosonHandler } from "./../test/utils/boson-protocol";
import { initSeaportFixture } from "./../test/utils/seaport";
import { Contract, ZeroAddress } from "ethers";
import fermionConfig from "./../fermion.config";

const version = "0.0.1";
let deploymentData: any[] = [];

export async function deploySuite(env: string = "", modules: string[] = []) {
  const allModules = modules.length === 0 || network.name === "hardhat" || network.name === "localhost";

  // if deploying with hardhat, first deploy the boson protocol
  let bosonProtocolAddress: string, bosonPriceDiscoveryAddress: string, bosonTokenAddress: string;
  let seaportAddress: string, seaportContract: Contract;
  const seaportConfig = fermionConfig.seaport[network.name];
  if (network.name === "hardhat" || network.name === "localhost") {
    ({ bosonProtocolAddress, bosonPriceDiscoveryAddress, bosonTokenAddress } = await initBosonProtocolFixture(false));
    ({ seaportAddress, seaportContract } = await initSeaportFixture());
    seaportConfig.seaport = seaportAddress;
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

    // Boson addresses
    bosonProtocolAddress = bosonContracts.find((contract) => contract.name === "ProtocolDiamond")?.address;
    bosonPriceDiscoveryAddress = bosonContracts.find(
      (contract) => contract.name === "BosonPriceDiscoveryClient",
    )?.address;
    const bosonConfigHandler = await getBosonHandler("IBosonConfigHandler", bosonProtocolAddress);
    bosonTokenAddress = await bosonConfigHandler.getTokenAddress();

    if (!bosonProtocolAddress || !bosonPriceDiscoveryAddress || !bosonTokenAddress) {
      throw Error(`One or more addresses missing:
      bosonProtocolAddress: ${bosonProtocolAddress}
      bosonPriceDiscoveryAddress:${bosonPriceDiscoveryAddress}
      bosonTokenAddress:${bosonTokenAddress}`);
    }

    seaportAddress = seaportConfig.seaport;
    if (!seaportAddress || seaportAddress === ZeroAddress) {
      throw Error("Seaport address not found in fermion config");
    }
  }
  const deployerAddress = (await ethers.getSigners())[0].address;
  console.log(`Deploying to network: ${network.name} (env: ${env}) with deployer: ${deployerAddress}`);
  console.log(`Boson Protocol address: ${bosonProtocolAddress}`);
  console.log(`Seaport address: ${seaportAddress}`);

  // deploy wrapper implementation
  let wrapperImplementationAddress: string;
  if (allModules || modules.includes("wrapper")) {
    const constructorArgs = [bosonPriceDiscoveryAddress, seaportConfig];

    const FermionFNFT = await ethers.getContractFactory("FermionFNFT");
    const fermionWrapper = await FermionFNFT.deploy(...constructorArgs);
    await fermionWrapper.waitForDeployment();
    wrapperImplementationAddress = await fermionWrapper.getAddress();

    deploymentComplete("FermionFNFT", wrapperImplementationAddress, constructorArgs, true);
  } else {
    deploymentData = await getDeploymentData(env);
    wrapperImplementationAddress = deploymentData.find((contract) => contract.name === "FermionFNFT")?.address;

    if (!wrapperImplementationAddress) {
      throw Error("Fermion wrapper implementation not found in contracts file");
    }
  }

  // deploy diamond
  let diamondAddress, initializationFacet, accessController;
  if (allModules || modules.includes("diamond")) {
    ({ diamondAddress, initializationFacet, accessController } = await deployDiamond(
      bosonProtocolAddress,
      wrapperImplementationAddress,
    ));
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
    accessController = await ethers.getContractAt("AccessController", diamondAddress);
  }

  // deploy facets
  const facetNames = [
    "EntityFacet",
    "MetaTransactionFacet",
    "OfferFacet",
    "VerificationFacet",
    "CustodyFacet",
    "FundsFacet",
    "PauseFacet",
  ];
  let facets = {};

  if (allModules || modules.includes("facets")) {
    const constructorArgs = {
      MetaTransactionFacet: [diamondAddress],
      OfferFacet: [bosonProtocolAddress],
      VerificationFacet: [bosonProtocolAddress],
    };
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
    // grant upgrader role
    await accessController.grantRole(ethers.id("UPGRADER"), deployerAddress);

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
    facets["AccessController"] = accessController;
  }

  return {
    diamondAddress,
    facets,
    bosonProtocolAddress,
    wrapperImplementationAddress,
    seaportAddress,
    seaportContract,
    bosonTokenAddress,
  };
}

export async function deployDiamond(bosonProtocolAddress: string, wrapperImplementationAddress: string) {
  const accounts = await ethers.getSigners();
  const contractOwner = accounts[0];

  // Deploy facets and set the `facetCuts` variable
  console.log("");
  console.log("Deploying facets");
  const FacetNames = ["DiamondCutFacet", "DiamondLoupeFacet", "AccessController", "InitializationFacet"];
  // The `facetCuts` variable is the FacetCut[] that contains the functions to add during diamond deployment
  const facets = await deployFacets(FacetNames, {}, true);
  const facetCuts = await prepareFacetCuts(Object.values(facets), ["init", "initialize", "initializeDiamond"]);
  facetCuts[2].functionSelectors = facetCuts[2].functionSelectors.remove(["supportsInterface"]);
  console.log(facetCuts);

  const accessController = facets["AccessController"];

  // Creating a function call
  // This call gets executed during deployment. For upgrades, "initialize" is called.
  // It is executed with delegatecall on the DiamondInit address.
  const initializationFacet = facets["InitializationFacet"];
  const initializeBosonSeller = initializationFacet.interface.encodeFunctionData("initializeDiamond", [
    await accessController.getAddress(),
    contractOwner.address,
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
  const diamondAddress = await diamond.getAddress();
  return { diamondAddress, initializationFacet, accessController: accessController.attach(diamondAddress) };
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

function deploymentComplete(name: string, address: string, args: any[], save: boolean = false) {
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
