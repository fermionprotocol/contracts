import hre from "hardhat";
import path from "path";
import { glob } from "glob";
import { ethers } from "hardhat";
import { deploySuite } from "../../scripts/deploy";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { BigNumberish, Contract, Interface, toBeHex } from "ethers";
import { subtask } from "hardhat/config";
import { EntityRole, WalletRole } from "./enums";
import { expect } from "chai";

import { TASK_COMPILE_SOLIDITY_GET_SOURCE_PATHS } from "hardhat/builtin-tasks/task-names";

// We define a fixture to reuse the same setup in every test.
// We use loadFixture to run this setup once, snapshot that state,
// and reset Hardhat Network to that snapshot in every test.
// Use the same deployment script that is used in the deploy-suite task
export async function deployFermionProtocolFixture(defaultSigner: HardhatEthersSigner) {
  const {
    diamondAddress,
    facets,
    bosonProtocolAddress,
    wrapperImplementationAddress,
    seaportAddress,
    seaportContract,
    bosonTokenAddress,
  } = await deploySuite();

  const fermionErrors = await ethers.getContractAt("FermionErrors", diamondAddress);

  const wallets = await ethers.getSigners();
  defaultSigner = wallets[1];

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
  // await facets[AccessController].grantRole(ethers.id("ADMIN"), defaultSigner.address);

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
      .to.be.revertedWithCustomError(fermionErrors, "WalletHasNoRole")
      .withArgs(sellerId, wallet.address, EntityRole.Seller, WalletRole.Assistant);

    // an entity-wide Treasury or admin wallet (not Assistant)
    await entityFacet.addEntityWallets(sellerId, [wallet], [[]], [[[WalletRole.Treasury, WalletRole.Admin]]]);
    await expect(facet.connect(wallet)[method](...args))
      .to.be.revertedWithCustomError(fermionErrors, "WalletHasNoRole")
      .withArgs(sellerId, wallet.address, EntityRole.Seller, WalletRole.Assistant);

    // a Seller specific Treasury or Admin wallet
    const wallet2 = wallets[10];
    await entityFacet.addEntityWallets(
      sellerId,
      [wallet2],
      [[EntityRole.Seller]],
      [[[WalletRole.Treasury, WalletRole.Admin]]],
    );
    await expect(facet.connect(wallet2)[method](...args))
      .to.be.revertedWithCustomError(fermionErrors, "WalletHasNoRole")
      .withArgs(sellerId, wallet2.address, EntityRole.Seller, WalletRole.Assistant);

    // an Assistant of another role than Seller
    await entityFacet.addEntityWallets(sellerId, [wallet2], [[EntityRole.Verifier]], [[[WalletRole.Assistant]]]);
    await expect(facet.connect(wallet2)[method](...args))
      .to.be.revertedWithCustomError(fermionErrors, "WalletHasNoRole")
      .withArgs(sellerId, wallet2.address, EntityRole.Seller, WalletRole.Assistant);
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
