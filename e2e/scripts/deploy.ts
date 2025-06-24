import * as hre from "hardhat";
import {
  deployFermionProtocolFixture,
  deployMockTokens,
  setCompilationFolder
} from "../../test/utils/common";
import { readBosonConfig } from "./read-boson-config";
import { setBosonConfig } from "./set-boson-config";
import { deployBosonMetaTransactionFacet } from "./deploy-boson-meta-tx-facet";
import { deployForwarderForBosonVouchers } from "./deploy-forwarder-for-boson-vouchers";

// Set the Boson Protocol contracts compilation folder to the Boson Protocol contracts and compiles them.
// Used to avoid artifacts clashes.
async function setBosonContractsCompilationFolder() {
  const contracts = [
    ["access", "**", "*.sol"],
    ["diamond", "**", "*.sol"],
    ["protocol", "**", "*.sol"],
    ["mock", "WETH9.sol"],
    ["mock", "Foreign20.sol"],
    ["mock", "MockForwarder.sol"]
  ];
  return setCompilationFolder("boson-protocol-contracts", contracts);
}

async function main() {
  const defaultSigner = (await hre.ethers.getSigners())[1];
  const { bosonProtocolAddress } =
    await deployFermionProtocolFixture.bind({ env: "test" })(defaultSigner);

  // deploy an ERC20 contract
  const [erc20] = await deployMockTokens(["ERC20"]);
  console.log(`ERC20 deployed at ${await erc20.getAddress()}`);

  const { tokenAddress, priceDiscoveryClient } = await readBosonConfig(bosonProtocolAddress);
  console.log("tokenAddress", tokenAddress);
  console.log("priceDiscoveryClient", priceDiscoveryClient);

  // set Boson Protocol flat fee to a non zero value
  const bosonProtocolFlatFee = "1000000000000000"; // = 0.001
  await setBosonConfig(bosonProtocolAddress, { bosonProtocolFlatFee });

  console.log("Switch Hardhat Compilation Folder to Boson Protocol....");
  await setBosonContractsCompilationFolder();

  console.log("Deploy MetaTransactionHandlerFacet on Boson....");
  await deployBosonMetaTransactionFacet(bosonProtocolAddress);

  console.log("Deploy a MockForwarder")
  await deployForwarderForBosonVouchers(bosonProtocolAddress);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
