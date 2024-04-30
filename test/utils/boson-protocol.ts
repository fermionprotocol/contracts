import fs from "fs";
import { ethers } from "hardhat";
import hre from "hardhat";
import { subtask } from "hardhat/config";
import path from "path";
import { glob } from "glob";
import { TASK_COMPILE_SOLIDITY_GET_SOURCE_PATHS } from "hardhat/builtin-tasks/task-names";

import protocolConfig from "@bosonprotocol/boson-protocol-contracts/scripts/config/protocol-parameters.js";
import Role from "@bosonprotocol/boson-protocol-contracts/scripts/domain/Role.js";

import { deployFacets, prepareFacetCuts, makeDiamondCut } from "../../scripts/deploy";

const { getContractFactory } = ethers;

let bosonProtocolAddress: string;

// Deploys WETH, Boson Protocol Diamond, Boson Price Discovery, Boson Voucher Implementation, Boson Voucher Beacon Client
export async function initBosonProtocolFixture() {
  await setBosonContractsCompilationFolder();

  const [admin] = await ethers.getSigners();

  // Deploy WETH
  const wethFactory = await getContractFactory("WETH9");
  const weth = await wethFactory.deploy();
  await weth.waitForDeployment();

  // Deploy the access controller
  const accessControllerFactory = await getContractFactory("AccessController");
  const accessController = await accessControllerFactory.deploy(admin.address);

  await accessController.grantRole(Role.UPGRADER, admin.address);

  // Deploy Boson Protocol Diamond default facets
  const defaultFacetNames = ["DiamondCutFacet", "DiamondLoupeFacet", "ERC165Facet"];
  // The `facetCuts` variable is the FacetCut[] that contains the functions to add during diamond deployment
  const defaultFacets = await deployFacets(defaultFacetNames);
  const facetCuts = await prepareFacetCuts(Object.values(defaultFacets), ["init", "initialize"]);

  const bosonDiamondFactory = await ethers.getContractFactory("ProtocolDiamond");
  const bosonDiamond = await bosonDiamondFactory.deploy(await accessController.getAddress(), facetCuts, []);
  bosonProtocolAddress = await bosonDiamond.getAddress();

  // Deploy the clients
  // Deploy Boson Price Discovery Client
  const bosonPriceDiscoveryFactory = await getContractFactory("BosonPriceDiscovery");
  const bosonPriceDiscovery = await bosonPriceDiscoveryFactory.deploy(await weth.getAddress(), bosonProtocolAddress);
  await bosonPriceDiscovery.waitForDeployment();

  // Deploy Boson Voucher Implementation
  const BosonVoucher = await getContractFactory("BosonVoucher");
  const bosonVoucher = await BosonVoucher.deploy(ethers.ZeroAddress);

  // Deploy Boson Voucher Beacon Client
  const ClientBeacon = await getContractFactory("BosonClientBeacon");
  const clientBeacon = await ClientBeacon.deploy(bosonProtocolAddress, await bosonVoucher.getAddress());

  // Deploy only the facets, necessary for the Fermion Protocol
  const facetNames = [
    "SellerHandlerFacet",
    "BuyerHandlerFacet",
    "AgentHandlerFacet",
    "DisputeResolverHandlerFacet",
    "ExchangeHandlerFacet",
    "OfferHandlerFacet",
    "FundsHandlerFacet",
    "AccountHandlerFacet",
    "ProtocolInitializationHandlerFacet",
    "ConfigHandlerFacet",
    "PriceDiscoveryHandlerFacet",
  ];
  const constructorArgs = { ExchangeHandlerFacet: [1], PriceDiscoveryHandlerFacet: [await weth.getAddress()] };
  const facets = await deployFacets(facetNames, constructorArgs);
  const initializationFacet = facets["ProtocolInitializationHandlerFacet"];

  // Prepare init call
  const configHandlerInit = getConfigHandlerInitArgs();
  configHandlerInit[0].priceDiscovery = await bosonPriceDiscovery.getAddress();
  configHandlerInit[0].voucherBeacon = await clientBeacon.getAddress();
  const init = {
    ConfigHandlerFacet: configHandlerInit,
  };
  const initAddresses = await Promise.all(Object.keys(init).map((facetName) => facets[facetName].getAddress()));
  const initCalldatas = Object.keys(init).map((facetName) =>
    facets[facetName].interface.encodeFunctionData("initialize", init[facetName]),
  );
  const functionCall = initializationFacet.interface.encodeFunctionData("initialize", [
    ethers.encodeBytes32String("test"),
    initAddresses,
    initCalldatas,
    false,
    "0x",
    [],
    [],
  ]);

  await makeDiamondCut(
    bosonProtocolAddress,
    await prepareFacetCuts(Object.values(facets), ["init", "initialize"]),
    await initializationFacet.getAddress(),
    functionCall,
  );

  await resetCompilationFolder();

  return { bosonProtocolAddress, weth };
}

// Load Boson handler ABI creates contract instant and attach it to the Boson protocol address
// If Boson protocol is not initialized yet, it will be initialized
export async function getBosonHandler(handlerName: string) {
  if (!bosonProtocolAddress) {
    ({ bosonProtocolAddress } = await initBosonProtocolFixture());
  }

  const { abi: facetABI } = JSON.parse(
    fs.readFileSync(
      `node_modules/@bosonprotocol/boson-protocol-contracts/addresses/abis/sepolia/test/interfaces/handlers/${handlerName}.sol/${handlerName}.json`,
      "utf8",
    ),
  );

  const facet = await ethers.getContractAt(facetABI, bosonProtocolAddress);

  return facet;
}

// Set the Boson Protocol contracts compilation folder to the Boson Protocol contracts and compiles them.
// Used to avoid artifacts clashes.
async function setBosonContractsCompilationFolder() {
  subtask(TASK_COMPILE_SOLIDITY_GET_SOURCE_PATHS, async (_, { config }) => {
    const bosonProtocolContractsBase = path.join(
      config.paths.root,
      "contracts",
      "external",
      "boson-protocol-contracts",
    );

    const bosonProtocolContracts = await glob([
      path.join(bosonProtocolContractsBase, "access", "**", "*.sol").replace(/\\/g, "/"), // Windows support
      path.join(bosonProtocolContractsBase, "diamond", "**", "*.sol").replace(/\\/g, "/"), // Windows support
      path.join(bosonProtocolContractsBase, "protocol", "**", "*.sol").replace(/\\/g, "/"), // Windows support
      path.join(bosonProtocolContractsBase, "mock", "WETH9.sol").replace(/\\/g, "/"), // Windows support
    ]);

    return [...bosonProtocolContracts].map(path.normalize);
  });

  await recompileContracts();
}

// Reset the compilation folder to the Fermion Protocol contracts and compiles them.
// Used to avoid artifacts clashes.
async function resetCompilationFolder() {
  subtask(TASK_COMPILE_SOLIDITY_GET_SOURCE_PATHS, async (_, { config }) => {
    const contracts_path = path.join(config.paths.root, "contracts", "**", "*.sol");
    const contracts = await glob(contracts_path.replace(/\\/g, "/"), {
      ignore: [path.join(contracts_path, "external", "**", "*.sol").replace(/\\/g, "/")],
    });

    return [...contracts].map(path.normalize);
  });

  await recompileContracts();
}

function getConfigHandlerInitArgs() {
  const network = "hardhat";
  return [
    {
      token: protocolConfig.TOKEN[network],
      treasury: protocolConfig.TREASURY[network],
      voucherBeacon: protocolConfig.BEACON[network],
      beaconProxy: protocolConfig.BEACON_PROXY[network],
      priceDiscovery: protocolConfig.PRICE_DISCOVERY[network],
    },
    protocolConfig.limits,
    protocolConfig.fees,
  ];
}

async function recompileContracts() {
  await hre.run("clean");

  // Right after compilation, Hardhat sometimes wrongly reports missing artifacts.
  // Ignore this error, but throw any other error.
  try {
    await hre.run("compile");
  } catch (e) {
    if (e?.message.includes("HH700: Artifact for contract") && e?.message.includes("not found")) {
      return;
    }
    throw e;
  }
}
