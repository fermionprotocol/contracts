import { ethers } from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/src/signers";
const { getContractFactory, id, isHexString, provider, randomBytes, toBeHex } = ethers;

export const RESTRICTED_METATX_FUNCTIONS = [
  "adjustVotesOnTransfer(address)",
  "burn(uint256)",
  "burn(address,uint256)",
  "cancelFixedPriceOrders((address,address,(uint8,address,uint256,uint256,uint256)[],(uint8,address,uint256,uint256,uint256,address)[],uint8,uint256,uint256,bytes32,uint256,bytes32,uint256)[])",
  "getTransferValidationFunction()",
  "listFixedPriceOrders(uint256,uint256[],uint256[],(address[],uint256[]),address)",
  "mintAdditionalFractions(uint256)",
  "pushToNextTokenState(uint256,uint8)",
  "transferOwnership(address)",
  "unwrapFixedPriced(uint256,address)",
  "unwrapToSelf(uint256,address,uint256)",
  "wrap(uint256,uint256,address)",
  "diamondCut((address,uint8,bytes4[])[],address,bytes)",
  "grantRole(bytes32,address)",
  "renounceRole(bytes32,address)",
  "revokeRole(bytes32,address)",
  "setDefaultVerificationTimeout(uint256)",
  "setFNFTImplementationAddress(address)",
  "setMaxRoyaltyPercentage(uint16)",
  "setMaxVerificationTimeout(uint256)",
  "setOpenSeaFeePercentage(uint16)",
  "setProtocolFeePercentage(uint16)",
  "setProtocolFeeTable(address,uint256[],uint16[])",
  "setTreasuryAddress(address)",
  "setAllowlistedFunctions(bytes32[],bool)",
  "collectRoyalties(uint256,uint256)",
  "withdrawProtocolFees(address[],uint256[])",
  "pause(uint8[])",
  "unpause(uint8[])",
  "addItemToCustodianOfferVault(uint256,uint256,uint256)",
  "removeItemFromCustodianOfferVault(uint256,uint256)",
  "repayDebt(uint256,uint256)",
  "setupCustodianOfferVault(uint256,uint256,(uint256,uint256,uint256,uint256),uint256)",
  "addPriceOracle(address,bytes32)",
  "removePriceOracle(address)",
  "finalizeOpenSeaAuction(uint256,((address,address,(uint8,address,uint256,uint256,uint256)[],(uint8,address,uint256,uint256,uint256,address)[],uint8,uint256,uint256,bytes32,uint256,bytes32,uint256),uint120,uint120,bytes,bytes))",
  "wrapOpenSea()",
  "mint(address,uint256)",
  "startAuctionInternal(uint256)",
  "transferFractionsFrom(address,address,uint256)",
  "renounceOwnership()",
  "executeMetaTransaction",
];

// Generic meta transaction type
export const metaTransactionType = [
  { name: "nonce", type: "uint256" },
  { name: "from", type: "address" },
  { name: "contractAddress", type: "address" },
  { name: "functionName", type: "string" },
  { name: "functionSignature", type: "bytes" },
];

// Prepare the signature
export async function prepareDataSignature(
  user: HardhatEthersSigner,
  customTransactionTypes: object,
  primaryType: string,
  message: object,
  forwarderAddress: string,
  domainName = "Fermion Protocol",
  domainVersion = "V0",
  type = "Protocol",
) {
  // Initialize data
  const domainType =
    type == "Protocol"
      ? [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "verifyingContract", type: "address" },
          { name: "salt", type: "bytes32" },
        ]
      : [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ];

  const domainData = {
    name: domainName,
    version: domainVersion,
    verifyingContract: forwarderAddress,
  };

  if (type == "Protocol") {
    //hardhat default chain id is 31337
    domainData.salt = toBeHex(31337n, 32);
  } else {
    const { chainId } = await provider.getNetwork();
    domainData.chainId = chainId.toString();
  }

  // Prepare the types
  let metaTxTypes = {
    EIP712Domain: domainType,
  };
  metaTxTypes = Object.assign({}, metaTxTypes, customTransactionTypes);

  // Prepare the data to sign
  const dataToSign = JSON.stringify({
    types: metaTxTypes,
    domain: domainData,
    primaryType: primaryType,
    message: message,
  });

  // Sign the data
  const signature = await provider.send("eth_signTypedData_v4", [await user.getAddress(), dataToSign]);

  return signature;
}

export function randomNonce() {
  return parseInt(randomBytes(8).toString());
}

export async function getStateModifyingFunctions(
  facetNames: string[],
  omitFunctions: string[] = [],
  onlyFunctions: string[] = [],
) {
  let stateModifyingFunctions: any[] = [];
  for (const facetName of facetNames) {
    const FacetContractFactory = await getContractFactory(facetName);
    const functions = FacetContractFactory.interface.fragments;
    const facetStateModifyingFunctions = functions
      .filter(
        (fn) =>
          fn.type == "function" &&
          fn.stateMutability !== "view" &&
          !omitFunctions.some((f) => fn.name.includes(f)) &&
          (onlyFunctions.length === 0 || onlyFunctions.some((f) => fn.name.includes(f))),
      )
      .map((fn) => fn.format("sighash"));

    stateModifyingFunctions = stateModifyingFunctions.concat(facetStateModifyingFunctions);
  }

  return stateModifyingFunctions;
}

export async function getStateModifyingFunctionsHashes(
  facetNames: string[],
  omitFunctions: string[] = [],
  onlyFunctions: string[] = [],
) {
  const stateModifyingFunctions = await getStateModifyingFunctions(
    facetNames,
    [...omitFunctions, "initialize", "init"],
    onlyFunctions,
  );

  return stateModifyingFunctions.map((smf) => id(smf));
}

export async function getFunctionSignatureDetails(
  facetNames: string[],
  omitFunctions: string[] = [],
  onlyFunctions: string[] = [],
): Promise<Array<{ name: string; hash: string }>> {
  const stateModifyingFunctionSignatures = await getStateModifyingFunctions(
    facetNames,
    [...omitFunctions, "initialize", "init"],
    onlyFunctions,
  );

  return stateModifyingFunctionSignatures.map((sig) => ({
    name: sig,
    hash: id(sig),
  }));
}
