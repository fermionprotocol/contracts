import hre from "hardhat";
import { readContracts } from "./libraries/utils";
import { getFunctionSignatureDetails } from "./libraries/metaTransaction";

async function checkAllowlistedFunctions() {
  const { ethers, network } = hre;

  // Get network info
  const { chainId } = await ethers.provider.getNetwork();
  const networkName = network.name;
  console.log(`\n🌐 Network: ${networkName} (Chain ID: ${chainId})`);

  // Determine environment from ENV environment variable
  const env = process.env.ENV || "test";
  console.log(`Environment: ${env}`);

  try {
    // Read contracts to get protocol address
    const contractsFile = await readContracts(env);
    if (!contractsFile) {
      throw new Error(`No contract addresses file found for network ${networkName} (Chain ID: ${chainId})`);
    }

    const contracts = contractsFile.contracts;
    const protocolAddress = contracts.find((c: any) => c.name === "FermionDiamond")?.address;

    if (!protocolAddress) {
      throw new Error("Protocol address not found");
    }

    console.log(`\n📝 Using protocol address: ${protocolAddress}`);

    // Get MetaTransactionFacet contract using the protocol address
    const metaTransactionFacet = await ethers.getContractAt("MetaTransactionFacet", protocolAddress);

    // Get all deployed contracts from the addresses file, excluding Diamond
    const deployedContracts = contracts
      .map((c: { name: string }) => c.name)
      .filter((name: string) => name !== "FermionDiamond");

    console.log("\n📋 Found deployed contracts:");
    deployedContracts.forEach((contract: string) => console.log(`- ${contract}`));

    // Get all state-modifying functions from deployed contracts
    const functionsToCheck = await getFunctionSignatureDetails(deployedContracts);

    console.log("\n🔍 Checking allowlisted functions:");
    console.log("=================================");

    // Group functions by contract for better readability
    const functionsByContract = new Map<string, Array<{ name: string; hash: string; isAllowlisted: boolean }>>();
    const checkedHashes = new Set<string>();
    const allowlistedHashes = new Set<string>();

    for (const func of functionsToCheck) {
      // Skip if we've already checked this function hash
      if (checkedHashes.has(func.hash)) continue;
      checkedHashes.add(func.hash);

      const isAllowlisted = await metaTransactionFacet["isFunctionAllowlisted(bytes32)"](func.hash);
      if (isAllowlisted) {
        allowlistedHashes.add(func.hash);
      }

      const contractName = func.name.split("(")[0].split(".")[0];

      if (!functionsByContract.has(contractName)) {
        functionsByContract.set(contractName, []);
      }
      functionsByContract.get(contractName)?.push({
        name: func.name,
        hash: func.hash,
        isAllowlisted,
      });
    }

    // Print results grouped by contract
    for (const [contractName, functions] of functionsByContract) {
      console.log(`\n📦 ${contractName}:`);
      console.log("---------------------------------");

      for (const func of functions) {
        console.log(`\nFunction: ${func.name}`);
        console.log(`Hash:     ${func.hash}`);
        console.log(`Status:   ${func.isAllowlisted ? "✅ Allowlisted" : "❌ Not allowlisted"}`);
      }
    }

    // Print summary
    const totalFunctions = checkedHashes.size;
    const allowlistedFunctions = allowlistedHashes.size;

    console.log("\n📊 Summary:");
    console.log("---------------------------------");
    console.log(`Total functions checked: ${totalFunctions}`);
    console.log(`Allowlisted functions: ${allowlistedFunctions}`);
    console.log(`Non-allowlisted functions: ${totalFunctions - allowlistedFunctions}`);
  } catch (error: any) {
    if (error.code === "ENOENT") {
      console.error(`\n❌ Error: No contract addresses file found for network ${networkName} (Chain ID: ${chainId})`);
      console.error(`Please ensure you have deployed contracts to this network first.`);
      console.error(`Expected file path: addresses/${chainId}-${networkName.toLowerCase()}-${env}.json`);
      console.error(`Available environments: test, staging, prod`);
      console.error("\n❌ Error:", error.message);
    }
    process.exit(1);
  }
}

// Execute the script
checkAllowlistedFunctions()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
