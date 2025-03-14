import fs from "fs";
import hre, { ethers, network } from "hardhat";
import { FacetCutAction, getSelectors } from "./libraries/diamond";
import { getStateModifyingFunctionsHashes } from "./libraries/metaTransaction";
import { writeContracts, readContracts, checkDeployerAddress, deployContract } from "./libraries/utils";
import { vars } from "hardhat/config";

import { initBosonProtocolFixture, getBosonHandler } from "./../test/utils/boson-protocol";
import { initSeaportFixture } from "./../test/utils/seaport";
import { BaseContract, Contract, ZeroAddress } from "ethers";
import fermionConfig from "./../fermion.config";

const version = "1.0.1";
let deploymentData: any[] = [];

export async function deploySuite(env: string = "", modules: string[] = [], create3: boolean = false) {
  if (create3) {
    if (!vars.has(`CREATE3_ADDRESS`)) {
      throw Error(
        `CREATE3_ADDRESS not found in configuration variables. Use 'npx hardhat vars set CREATE3_ADDRESS' to set it or 'npx hardhat vars setup' to list all the configuration variables used by this project.`,
      );
    }

    const create3Address = vars.get("CREATE3_ADDRESS");
    const code = await ethers.provider.getCode(create3Address);
    if (code === "0x") {
      console.log("CREATE3 factory contract is not deployed on this network.");
      process.exit(1);
    }
  }

  const allModules = modules.length === 0 || network.name === "hardhat" || network.name === "localhost";

  const deployerAddress = (await ethers.getSigners())[0].address;

  // if deploying with hardhat, first deploy the boson protocol
  let bosonProtocolAddress: string, bosonPriceDiscoveryAddress: string, bosonTokenAddress: string;
  let seaportAddress: string, seaportContract: Contract;
  let wrappedNativeAddress: string;
  const isForking = hre.config.networks["hardhat"].forking;
  const networkName = isForking ? isForking.originalChain.name : network.name;
  const { seaportConfig, wrappedNative, strictAuthorizedTransferSecurityRegistry } =
    fermionConfig.externalContracts[networkName];
  if ((network.name === "hardhat" && !isForking) || network.name === "localhost") {
    let weth: BaseContract;
    ({ bosonProtocolAddress, bosonPriceDiscoveryAddress, bosonTokenAddress, weth } =
      await initBosonProtocolFixture(false));
    ({ seaportAddress, seaportContract } = await initSeaportFixture());
    seaportConfig.seaport = seaportAddress;
    wrappedNativeAddress = await weth.getAddress();
  } else {
    if (isForking) {
      // At least one tx is needed for fork to work properly
      const [deployer] = await ethers.getSigners();
      await deployer.sendTransaction({ to: deployer.address });
    }

    checkDeployerAddress(network.name);

    // Get boson protocol address
    const { chainId } = isForking ? isForking.originalChain : await ethers.provider.getNetwork();

    const bosonNetworkName = networkName == "ethereum" ? "mainnet" : networkName.toLowerCase();
    const { contracts: bosonContracts } = JSON.parse(
      fs.readFileSync(
        `node_modules/@bosonprotocol/boson-protocol-contracts/addresses/${chainId}-${bosonNetworkName}-${env.replace("-dry-run", "")}.json`,
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

    wrappedNativeAddress = wrappedNative;
  }
  console.log(`Deploying to network: ${network.name} (env: ${env}) with deployer: ${deployerAddress}`);
  console.log(`Boson Protocol address: ${bosonProtocolAddress}`);
  console.log(`Seaport address: ${seaportAddress}`);

  const externalContracts = {
    bosonProtocolAddress,
    bosonPriceDiscoveryAddress,
    bosonTokenAddress,
    seaportConfig,
    wrappedNativeAddress,
  };

  // deploy wrapper implementation
  let wrapperImplementationAddress: string;
  if (allModules || modules.includes("fnft")) {
    const seaportWrapperConstructorArgs = [bosonPriceDiscoveryAddress, seaportConfig];
    const FermionSeaportWrapper = await ethers.getContractFactory("SeaportWrapper");
    const fermionSeaportWrapper = await FermionSeaportWrapper.deploy(...seaportWrapperConstructorArgs);
    const FermionFNFTPriceManager = await ethers.getContractFactory("FermionFNFTPriceManager");
    const fermionFNFTPriceManager = await FermionFNFTPriceManager.deploy();
    const FermionFractionsMint = await ethers.getContractFactory("FermionFractionsMint");
    const fermionFractionsMint = await FermionFractionsMint.deploy(bosonPriceDiscoveryAddress);
    const FermionBuyoutAuction = await ethers.getContractFactory("FermionBuyoutAuction");
    const fermionBuyoutAuction = await FermionBuyoutAuction.deploy(bosonPriceDiscoveryAddress);

    deploymentComplete("SeaportWrapper", await fermionSeaportWrapper.getAddress(), seaportWrapperConstructorArgs, true);
    deploymentComplete("FermionFNFTPriceManager", await fermionFNFTPriceManager.getAddress(), [], true);
    deploymentComplete(
      "FermionFractionsMint",
      await fermionFractionsMint.getAddress(),
      [bosonPriceDiscoveryAddress],
      true,
    );
    deploymentComplete(
      "FermionBuyoutAuction",
      await fermionBuyoutAuction.getAddress(),
      [bosonPriceDiscoveryAddress],
      true,
    );

    const fermionFNFTConstructorArgs = [
      bosonPriceDiscoveryAddress,
      await fermionSeaportWrapper.getAddress(),
      strictAuthorizedTransferSecurityRegistry,
      wrappedNativeAddress,
      await fermionFractionsMint.getAddress(),
      await fermionFNFTPriceManager.getAddress(),
      await fermionBuyoutAuction.getAddress(),
    ];
    const FermionFNFT = await ethers.getContractFactory("FermionFNFT");
    const fermionWrapper = await FermionFNFT.deploy(...fermionFNFTConstructorArgs);
    await fermionWrapper.waitForDeployment();
    wrapperImplementationAddress = await fermionWrapper.getAddress();

    deploymentComplete("FermionFNFT", wrapperImplementationAddress, fermionFNFTConstructorArgs, true);
    await writeContracts(deploymentData, env, version, externalContracts);
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
      create3,
    ));
    await writeContracts(deploymentData, env, version, externalContracts);
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
    "ConfigFacet",
    "EntityFacet",
    "MetaTransactionFacet",
    "OfferFacet",
    "VerificationFacet",
    "CustodyFacet",
    "FundsFacet",
    "PauseFacet",
    "CustodyVaultFacet",
    "PriceOracleRegistryFacet",
    "RoyaltiesFacet",
  ];
  let facets = {};

  if (allModules || modules.includes("facets")) {
    const nonce = 1n;
    const nonceHex = ethers.toBeArray(nonce);
    const input_arr = [diamondAddress, nonceHex];
    const rlp_encoded = ethers.encodeRlp(input_arr);
    const contract_address_long = ethers.keccak256(rlp_encoded);
    const fermionFNFTBeaconAdress = "0x" + contract_address_long.substring(26); //Trim the first 24 characters.
    const { chainId } = await ethers.provider.getNetwork();
    const { bytecode: beaconProxyBytecode } = await ethers.getContractFactory("BeaconProxy");
    const abiCoder = new ethers.AbiCoder();
    const expectedfermionFNFTBeaconProxy = ethers.getCreate2Address(
      diamondAddress,
      ethers.solidityPackedKeccak256(["uint256"], [chainId]),
      ethers.solidityPackedKeccak256(
        ["bytes", "bytes"],
        [beaconProxyBytecode, abiCoder.encode(["address", "bytes"], [fermionFNFTBeaconAdress, "0x"])],
      ),
    );
    const cloneCode = `0x363d3d373d3d3d363d73${expectedfermionFNFTBeaconProxy.slice(2)}5af43d82803e903d91602b57fd5bf3`; // https://eips.ethereum.org/EIPS/eip-1167
    const fnftCodeHash = ethers.keccak256(cloneCode);

    const constructorArgs = {
      MetaTransactionFacet: [diamondAddress],
      OfferFacet: [bosonProtocolAddress, fnftCodeHash],
      VerificationFacet: [bosonProtocolAddress, fnftCodeHash, diamondAddress],
      CustodyFacet: [fnftCodeHash],
      CustodyVaultFacet: [fnftCodeHash],
      FundsFacet: [fnftCodeHash],
    };
    facets = await deployFacets(facetNames, constructorArgs, true);
    await writeContracts(deploymentData, env, version, externalContracts);
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
      MetaTransactionFacet: [await getStateModifyingFunctionsHashes([...facetNames, "FermionFNFT"])],
      ConfigFacet: [
        fermionConfig.protocolParameters.treasury,
        fermionConfig.protocolParameters.protocolFeePercentage,
        fermionConfig.protocolParameters.maxRoyaltyPercentage,
        fermionConfig.protocolParameters.maxVerificationTimeout,
        fermionConfig.protocolParameters.defaultVerificationTimeout,
        fermionConfig.protocolParameters.openSeaFeePercentage,
      ],
      OfferFacet: [],
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

    await accessController.renounceRole(ethers.id("UPGRADER"), deployerAddress);

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

export async function deployDiamond(
  bosonProtocolAddress: string,
  wrapperImplementationAddress: string,
  create3: boolean = false,
) {
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
    init: await initializationFacet.getAddress(),
    initCalldata: initializeBosonSeller,
  };

  // deploy Diamond
  const diamondArgsTypes = [
    "tuple(address facetAddress, uint8 action, bytes4[] functionSelectors)[] _diamondCut",
    "tuple(address init, bytes initCalldata) _args",
  ];
  const diamond = await deployContract(
    "Diamond",
    create3 ? { address: vars.get("CREATE3_ADDRESS"), salt: vars.get("CREATE3_SALT", "Fermion_default_salt") } : null,
    [facetCuts, diamondArgs],
    diamondArgsTypes,
  );

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
  // ToDo: calculate interfaceId?
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
