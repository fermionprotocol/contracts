import hre from "hardhat";
import { readContracts } from "./libraries/utils";

export async function verifySuite(env: string = "", contracts: string[] = []) {
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

  const allContracts = contracts.length === 0;

  const { contracts: deploymentData } = await readContracts(env);

  for (const contract of deploymentData) {
    if (allContracts || contracts.includes(contract.name)) {
      console.log(`Verifying contract: ${contract.name}`);
      try {
        await hre.run("verify:verify", {
          address: contract.address,
          constructorArguments: contract.args,
        });
      } catch (e) {
        console.log(`❌ Failed to verify ${contract.name} on block explorer. ${e.message}`);
      }
    }
  }
}
