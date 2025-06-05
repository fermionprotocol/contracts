import hre from "hardhat";
import path from "path";
import { glob } from "glob";
import { ethers } from "hardhat";
import { deploySuite } from "../../scripts/deploy";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { BigNumberish, Contract, Interface, toBeHex, TransactionResponse } from "ethers";
import { subtask } from "hardhat/config";
import { EntityRole, AccountRole } from "./enums";
import { expect } from "chai";
import fermionConfig from "./../../fermion.config";

import { TASK_COMPILE_SOLIDITY_GET_SOURCE_PATHS } from "hardhat/builtin-tasks/task-names";

// We define a fixture to reuse the same setup in every test.
// We use loadFixture to run this setup once, snapshot that state,
// and reset Hardhat Network to that snapshot in every test.
// Use the same deployment script that is used in the deploy-suite task
// If you want to pass env or defaultSigner to this fixture, do it like this:
// ```
// const fixtureArgs = { env, defaultSigner };
// await loadFixture(deployFermionProtocolFixture.bind(fixtureArgs)))
// ```
export async function deployFermionProtocolFixture(defaultSigner: HardhatEthersSigner) {
  fermionConfig.protocolParameters.protocolFeePercentage = 500; // tests use non-zero protocol fee

  const {
    diamondAddress,
    facets,
    bosonProtocolAddress,
    wrapperImplementationAddress,
    seaportAddress,
    seaportContract,
    bosonTokenAddress,
  } = await deploySuite(this?.env);

  const fermionErrors = await ethers.getContractAt("FermionErrors", diamondAddress);
  const wallets = await ethers.getSigners();
  defaultSigner = defaultSigner || this?.defaultSigner || wallets[1];

  const implementationAddresses = {};
  for (const facetName of Object.keys(facets)) {
    implementationAddresses[facetName] = await facets[facetName].getAddress();
    if (facetName === "AccessController") {
      // PauseFacet is called only by the admin, do not connect it to the default signer
      facets[facetName] = facets[facetName].attach(diamondAddress);
    } else {
      facets[facetName] = facets[facetName].connect(defaultSigner).attach(diamondAddress);
    }
  }

  await facets["AccessController"].grantRole(ethers.id("PAUSER"), defaultSigner.address);
  await facets["AccessController"].grantRole(ethers.id("ADMIN"), defaultSigner.address);
  await facets["AccessController"].grantRole(ethers.id("UPGRADER"), wallets[0].address);

  return {
    diamondAddress,
    facets,
    implementationAddresses,
    fermionErrors,
    wallets,
    defaultSigner,
    bosonProtocolAddress,
    wrapperImplementationAddress,
    seaportAddress,
    seaportContract,
    bosonTokenAddress,
  };
}

export async function deployMockTokens(tokenList: string[]) {
  const tokens: Contract[] = [];
  for (const tokenType of tokenList) {
    const Token = await ethers.getContractFactory(`Mock${tokenType}`);
    tokens.push(await Token.deploy());
  }

  return tokens;
}

export function deriveTokenId(offerId: BigNumberish, exchangeId: BigNumberish) {
  return (BigInt(offerId) << 128n) | BigInt(exchangeId);
}

export function getInterfaceID(contractInterface: Interface, inheritedInterfaces: string[] = []) {
  let interfaceID = 0n;
  const functions = contractInterface.fragments;
  for (const fn of functions) {
    if (fn.type === "function") {
      interfaceID = interfaceID ^ BigInt(fn.selector);
    }
  }

  for (const inheritedInterface of inheritedInterfaces) {
    interfaceID = interfaceID ^ BigInt(inheritedInterface);
  }

  return toBeHex(interfaceID, 4);
}

// Set the compilation folder to the chosen set of contracts and compile them.
// Used to avoid artifacts clashes.
export async function setCompilationFolder(base: string, contracts: string[][]) {
  subtask(TASK_COMPILE_SOLIDITY_GET_SOURCE_PATHS, async (_, { config }) => {
    const basePath = path.join(config.paths.root, "contracts", "external", base);

    const contractPaths = await glob(contracts.map((contract) => path.join(basePath, ...contract).replace(/\\/g, "/")));

    return [...contractPaths].map(path.normalize);
  });

  await recompileContracts();
}

// Reset the compilation folder to the Fermion Protocol contracts and compiles them.
// Used to avoid artifacts clashes.
export async function resetCompilationFolder() {
  subtask(TASK_COMPILE_SOLIDITY_GET_SOURCE_PATHS, async (_, { config }) => {
    const contracts_path = path.join(config.paths.root, "contracts");
    const contracts = await glob(path.join(contracts_path, "**", "*.sol").replace(/\\/g, "/"), {
      ignore: [
        path.join(contracts_path, "external", "**", "*.sol").replace(/\\/g, "/"), // Windows support
      ],
    });

    return [...contracts].map(path.normalize);
  });

  await recompileContracts();
}

export async function recompileContracts() {
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

export function verifySellerAssistantRoleClosure(
  facet: Contract,
  wallets: HardhatEthersSigner[],
  entityFacet: Contract,
  fermionErrors: Contract,
) {
  return async function (method: string, args: any[]) {
    const wallet = wallets[9];
    const sellerId = "1";

    // completely random wallet
    await expect(facet.connect(wallet)[method](...args))
      .to.be.revertedWithCustomError(fermionErrors, "AccountHasNoRole")
      .withArgs(sellerId, wallet.address, EntityRole.Seller, AccountRole.Assistant);

    // an entity-wide Treasury or Manager wallet (not Assistant)
    await entityFacet.addEntityAccounts(sellerId, [wallet], [[]], [[[AccountRole.Treasury, AccountRole.Manager]]]);
    await expect(facet.connect(wallet)[method](...args))
      .to.be.revertedWithCustomError(fermionErrors, "AccountHasNoRole")
      .withArgs(sellerId, wallet.address, EntityRole.Seller, AccountRole.Assistant);

    // a Seller specific Treasury or Manager wallet
    const wallet2 = wallets[10];
    await entityFacet.addEntityAccounts(
      sellerId,
      [wallet2],
      [[EntityRole.Seller]],
      [[[AccountRole.Treasury, AccountRole.Manager]]],
    );
    await expect(facet.connect(wallet2)[method](...args))
      .to.be.revertedWithCustomError(fermionErrors, "AccountHasNoRole")
      .withArgs(sellerId, wallet2.address, EntityRole.Seller, AccountRole.Assistant);

    // an Assistant of another role than Seller
    await entityFacet.addEntityAccounts(sellerId, [wallet2], [[EntityRole.Verifier]], [[[AccountRole.Assistant]]]);
    await expect(facet.connect(wallet2)[method](...args))
      .to.be.revertedWithCustomError(fermionErrors, "AccountHasNoRole")
      .withArgs(sellerId, wallet2.address, EntityRole.Seller, AccountRole.Assistant);
  };
}

export async function setNextBlockTimestamp(timestamp: string | number | BigNumberish, mine = false) {
  if (typeof timestamp == "string" && timestamp.startsWith("0x0") && timestamp.length > 3)
    timestamp = "0x" + timestamp.substring(3);
  await ethers.provider.send("evm_setNextBlockTimestamp", [timestamp]);

  // when testing static call, a block must be mined to get the correct timestamp
  if (mine) await ethers.provider.send("evm_mine", []);
}

export function applyPercentage(amount: BigNumberish, percentage: BigNumberish | number) {
  return (BigInt(amount) * BigInt(percentage)) / 10000n;
}

// TODO: refactor this function to take into account in bosonFee is percentage based or flat fee (in case of BOSON token), because after boson v2.4.2,boson flat fee could be higher than 0
export function calculateMinimalPrice(
  verifierFee: BigNumberish,
  facilitatorFeePercent: BigNumberish,
  bosonProtocolFee: BigNumberish,
  fermionFeePercentage: BigNumberish,
  isBosonFlatFee: boolean = false,
): bigint {
  // Convert everything to BigInt for safety and precision
  const verifierFeeBigInt = BigInt(verifierFee);
  const facilitatorFeePercentBigInt = BigInt(facilitatorFeePercent);
  const bosonProtocolFeePercentageBigInt = isBosonFlatFee ? 0n : BigInt(bosonProtocolFee);
  const bosonProtocolFeeFlatBigInt = isBosonFlatFee ? BigInt(bosonProtocolFee) : 0n;
  const fermionFeePercentageBigInt = BigInt(fermionFeePercentage);

  // Sum the percentage-based fees
  const totalPercentFee = facilitatorFeePercentBigInt + bosonProtocolFeePercentageBigInt + fermionFeePercentageBigInt;

  // Calculate the minimal price to cover both absolute verifierFee and percentage-based fees
  let minimalPrice = (100_00n * (verifierFeeBigInt + bosonProtocolFeeFlatBigInt)) / (100_00n - totalPercentFee);

  // Due to rounding, the true minimal price can lower than the calculated one. Calculate it iteratively
  let actualFees =
    applyPercentage(minimalPrice, facilitatorFeePercentBigInt) +
    applyPercentage(minimalPrice, bosonProtocolFeePercentageBigInt) +
    applyPercentage(minimalPrice, fermionFeePercentageBigInt) +
    verifierFeeBigInt +
    bosonProtocolFeeFlatBigInt;

  while (actualFees < minimalPrice) {
    minimalPrice = actualFees;
    actualFees =
      applyPercentage(minimalPrice, facilitatorFeePercentBigInt) +
      applyPercentage(minimalPrice, bosonProtocolFeePercentageBigInt) +
      applyPercentage(minimalPrice, fermionFeePercentageBigInt) +
      verifierFeeBigInt +
      bosonProtocolFeeFlatBigInt;
  }

  return minimalPrice;
}

export async function getBlockTimestampFromTransaction(tx: TransactionResponse): Promise<number> {
  const receipt = await tx.wait(); // Wait for the transaction to be mined
  const block = await ethers.provider.getBlock(receipt.blockNumber); // Fetch the block details
  return block.timestamp; // Return the block timestamp
}

// Helper functions for interacting with ERC20 clones
export async function getERC20Clone(fermionFNFTProxy: Contract, epoch: bigint = 0n) {
  if (epoch === 0n) {
    const cloneAddress = await fermionFNFTProxy.getERC20FractionsClone();
    return await ethers.getContractAt("FermionFractionsERC20", cloneAddress);
  } else {
    const cloneAddress = await fermionFNFTProxy.getERC20FractionsClone(epoch);
    return await ethers.getContractAt("FermionFractionsERC20", cloneAddress);
  }
}

export async function balanceOfERC20(fermionFNFTProxy: Contract, address: string, epoch: bigint = 0n) {
  const cloneAddress = await getERC20Clone(fermionFNFTProxy, epoch);
  return await cloneAddress.balanceOf(address);
}

export async function totalSupplyERC20(fermionFNFTProxy: Contract, epoch: bigint = 0n) {
  const cloneAddress = await getERC20Clone(fermionFNFTProxy, epoch);
  return await cloneAddress.totalSupply();
}

/**
 * Impersonates an account and returns a signer for it
 * Also funds the account with 1 ETH to pay for gas
 * @param address The address to impersonate
 * @returns A signer for the impersonated account
 */
export async function impersonateAccount(address: string) {
  // Import hardhat at runtime to avoid circular dependencies
  const hre = await import("hardhat");

  // Impersonate the account
  await hre.default.network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [address],
  });

  // Get a signer for the impersonated account
  const signer = await ethers.getSigner(address);

  // Fund the account with some ETH to pay for gas
  const [fundingAccount] = await ethers.getSigners();
  await fundingAccount.sendTransaction({
    to: address,
    value: ethers.parseEther("1.0"),
  });

  return signer;
}
