import { ethers } from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/src/signers";
const { getContractFactory, id, isHexString, provider, randomBytes, toBeHex } = ethers;

// Generic meta transaction type
export const metaTransactionType = [
  { name: "nonce", type: "uint256" },
  { name: "from", type: "address" },
  { name: "contractAddress", type: "address" },
  { name: "functionName", type: "string" },
  { name: "functionSignature", type: "bytes" },
];

// Prepare the signature parameters
export async function prepareDataSignatureParameters(
  user: HardhatEthersSigner,
  customTransactionTypes: object,
  primaryType: string,
  message: object,
  forwarderAddress,
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

  // Collect the Signature components
  const { r, s, v } = getSignatureParameters(signature);

  return {
    r: r,
    s: s,
    v: v,
    signature,
  };
}

export function randomNonce() {
  return parseInt(randomBytes(8).toString());
}

function getSignatureParameters(signature: string) {
  if (!isHexString(signature)) {
    throw new Error('Given value "'.concat(signature, '" is not a valid hex string.'));
  }

  signature = signature.substring(2);
  const r = "0x" + signature.substring(0, 64);
  const s = "0x" + signature.substring(64, 128);
  const v = parseInt(signature.substring(128, 130), 16);

  return {
    r: r,
    s: s,
    v: v,
  };
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

