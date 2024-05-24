import fs from "fs";
import { ethers } from "hardhat";
import { resetCompilationFolder, setCompilationFolder } from "./common";

import protocolConfig from "@bosonprotocol/boson-protocol-contracts/scripts/config/protocol-parameters.js";
import Role from "@bosonprotocol/boson-protocol-contracts/scripts/domain/Role.js";

import { deployFacets, prepareFacetCuts, makeDiamondCut } from "../../scripts/deploy";

const { getContractFactory } = ethers;

let bosonProtocolAddress: string;

// Deploys WETH, Boson Protocol Diamond, Boson Price Discovery, Boson Voucher Implementation, Boson Voucher Beacon Client
export async function initBosonProtocolFixture(resetAfter: boolean = true) {
  await setBosonContractsCompilationFolder();

  const [admin] = await ethers.getSigners();

  // Deploy WETH
  const wethFactory = await getContractFactory("WETH9");
  const weth = await wethFactory.deploy();
  await weth.waitForDeployment();

  // Deploy mock boson token
  const bosonTokenFactory = await getContractFactory("Foreign20");
  const bosonToken = await bosonTokenFactory.deploy();
  await bosonToken.waitForDeployment();
  const bosonTokenAddress = await bosonToken.getAddress();

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

  await accessController.grantRole(Role.PROTOCOL, bosonProtocolAddress);

  // Deploy the clients
  // Deploy Boson Price Discovery Client
  const bosonPriceDiscoveryFactory = await getContractFactory("BosonPriceDiscovery");
  const bosonPriceDiscovery = await bosonPriceDiscoveryFactory.deploy(await weth.getAddress(), bosonProtocolAddress);
  await bosonPriceDiscovery.waitForDeployment();
  const bosonPriceDiscoveryAddress = await bosonPriceDiscovery.getAddress();

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
  configHandlerInit[0].priceDiscovery = bosonPriceDiscoveryAddress;
  configHandlerInit[0].voucherBeacon = await clientBeacon.getAddress();
  configHandlerInit[0].token = bosonTokenAddress;
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

  if (resetAfter) await resetCompilationFolder();

  return { bosonProtocolAddress, weth, bosonPriceDiscoveryAddress, bosonTokenAddress };
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

export async function getBosonVoucher(address: string) {
  const { abi: facetABI } = JSON.parse(
    fs.readFileSync(
      `node_modules/@bosonprotocol/boson-protocol-contracts/addresses/abis/sepolia/test/interfaces/clients/IBosonVoucher.sol/IBosonVoucher.json`,
      "utf8",
    ),
  );

  const facet = await ethers.getContractAt(facetABI, address);

  return facet;
}

// Set the Boson Protocol contracts compilation folder to the Boson Protocol contracts and compiles them.
// Used to avoid artifacts clashes.
async function setBosonContractsCompilationFolder() {
  const contracts = [
    ["access", "**", "*.sol"],
    ["diamond", "**", "*.sol"],
    ["protocol", "**", "*.sol"],
    ["mock", "WETH9.sol"],
    ["mock", "Foreign20.sol"],
  ];

  return setCompilationFolder("boson-protocol-contracts", contracts);
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

export function getBosonProtocolFees() {
  return protocolConfig.fees;
}
