import hre from "hardhat";
const { provider, ZeroAddress, getSigners, getSigner, getContractAt } = hre.ethers;
const network = hre.network.name;
// import environments from "../environments";

// import { deploymentComplete, getFees, readContracts, writeContracts, checkRole, addressNotFound, listAccounts } from "./util/utils.js";
const { deployProtocolClientImpls } = requireUncached("./util/deploy-protocol-client-impls.js");

import {
    // deploymentComplete,
    readContracts,
    writeContracts,
    checkRole,
    // addressNotFound,
    // listAccounts,
  } from "./libraries/utils";

/**
 * Upgrades clients
 *
 * Prerequisite:
 * - Admin must have UPGRADER role. Use `manage-roles.js` to grant it.
 *
 * Currently script upgrades the only existing client - BosonVoucher.
 * If new clients are introduced, this script should be modified to get the list of clients to upgrade from the config.
 */
export async function upgradeClients(env, clientConfig, version) {
  // Bail now if hardhat network, unless the upgrade is tested
  if (network === "hardhat" && env !== "upgrade-test" && !env.includes("dry-run")) process.exit();

  let { contracts } = await readContracts(env);

  const divider = "-".repeat(80);
  console.log(`${divider}\nFermion Protocol Client Upgrader\n${divider}`);
  console.log(`⛓  Network: ${network}\n📅 ${new Date()}`);

  const adminAddress = (await getSigners())[0].address;

  // If admin address is unspecified, exit the process
  if (adminAddress == ZeroAddress || !adminAddress) {
    console.log("Admin address must not be zero address");
    process.exit(1);
  }

  console.log(divider);

  // Get signer for admin address
  const adminSigner = await getSigner(adminAddress);

  // Get addresses of currently deployed Beacon contract
  const beaconAddress = contracts.find((c) => c.name === "BosonVoucher Beacon")?.address;
  if (!beaconAddress) {
    return addressNotFound("BosonVoucher Beacon");
  }

  // Validate that admin has UPGRADER role
  checkRole(contracts, "UPGRADER", adminAddress);

  clientConfig = (clientConfig && JSON.parse(clientConfig)) || require("./config/client-upgrade");

  // Deploy Protocol Client implementation contracts
  console.log(`\n📋 Deploying new logic contract`);

  const clientImplementationArgs = Object.values(clientConfig).map(
    (config) => process.env.FORWARDER_ADDRESS || config[network]
  );
  const [bosonVoucherImplementation] = await deployProtocolClientImpls(clientImplementationArgs, maxPriorityFeePerGas);

  // Update implementation address on beacon contract
  console.log(`\n📋 Updating implementation address on beacon`);
  const beacon = await getContractAt("BosonClientBeacon", beaconAddress);
  await beacon
    .connect(adminSigner)
    .setImplementation(await bosonVoucherImplementation.getAddress(), await getFees(maxPriorityFeePerGas));

  // Remove old entry from contracts
  contracts = contracts.filter((i) => i.name !== "BosonVoucher Logic");
  deploymentComplete(
    "BosonVoucher Logic",
    await bosonVoucherImplementation.getAddress(),
    clientImplementationArgs,
    "",
    contracts
  );

  const contractsPath = await writeContracts(contracts, env, version);
  console.log(divider);
  console.log(`✅ Contracts written to ${contractsPath}`);
  console.log(divider);

  console.log(`\n📋 Client upgraded.`);
  console.log("\n");
}
