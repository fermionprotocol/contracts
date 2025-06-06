import { HardhatUserConfig, subtask, task, vars } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@nomicfoundation/hardhat-verify";
import "hardhat-preprocessor";
import "hardhat-contract-sizer";
import path from "path";
import { glob } from "glob";
import { TASK_COMPILE_SOLIDITY_GET_SOURCE_PATHS } from "hardhat/builtin-tasks/task-names";
const DEFAULT_DEPLOYER_KEY = "123456789abcdef123456789abcdef123456789abcdef123456789abcdef1234"; // Used only for initialization

task("deploy-suite", "Deploy suite deploys protocol diamond, all facets and initializes the protocol diamond")
  .addOptionalParam("env", "The deployment environment")
  .addOptionalParam("modules", "The modules to execute")
  .addFlag("dryRun", "Test the deployment without deploying")
  .addFlag("create3", "Use CREATE3 for deployment")
  .setAction(async ({ env, modules, dryRun, create3 }) => {
    let balanceBefore: bigint = 0n;
    let getBalance: () => Promise<bigint> = async () => 0n;
    if (dryRun) {
      let setupDryRun;
      ({ setupDryRun, getBalance } = await import(`./scripts/dry-run`));
      ({ env, deployerBalance: balanceBefore } = await setupDryRun(env));
    }

    const { deploySuite } = await import("./scripts/deploy");
    await deploySuite(env, modules && modules.split(","), create3);

    if (dryRun) {
      const balanceAfter = await getBalance();
      const etherSpent = balanceBefore - balanceAfter;

      const { formatUnits } = await import("ethers");
      console.log("Ether spent: ", formatUnits(etherSpent, "ether"));
    }
  });

task("verify-suite", "Verify contracts on the block explorer")
  .addParam("env", "The environment of the contract address file")
  .addOptionalParam("contracts", "The list of contracts to verify")
  .setAction(async ({ env, contracts }) => {
    const { verifySuite } = await import("./scripts/verify");

    await verifySuite(env, contracts && contracts.split(","));
  });

task("generate-upgrade-config", "Generate upgrade config by comparing contract changes between versions")
  .addParam("currentVersion", "Branch/tag/commit of the current version")
  .addOptionalParam("newVersion", "Branch/tag/commit of the new version. If not provided, current branch will be used")
  .addParam("targetVersion", "Version number for the upgrade config (e.g., 1.1.0)")
  .setAction(async (args, hre) => {
    console.log("Starting generate-upgrade-config task...");
    console.log(`Current version: ${args.currentVersion}`);
    console.log(`New version: ${args.newVersion || "HEAD"}`);
    console.log(`Target version: ${args.targetVersion}`);

    const { generateUpgradeConfig } = await import("./scripts/upgrade/generate-upgrade-config");
    await generateUpgradeConfig(hre, args.currentVersion, args.newVersion || "HEAD", args.targetVersion);
  });

task(
  "upgrade-facets",
  "Upgrade facets performs protocol upgrade including pre-upgrade and post-upgrade hooks for protocol diamond",
)
  .addParam("env", "The deployment environment")
  .addParam("targetVersion", "The version to upgrade to")
  .addFlag("dryRun", "Test the upgrade without actually upgrading")
  .setAction(async ({ env, targetVersion, dryRun }) => {
    const { upgradeFacets } = await import("./scripts/upgrade/upgrade-facets");
    await upgradeFacets(env, targetVersion, dryRun);
  });

task("upgrade-clients", "Upgrade client contracts including FermionFNFT and its dependencies")
  .addParam("env", "The deployment environment")
  .addParam("targetVersion", "The version to upgrade to")
  .addFlag("dryRun", "Test the upgrade without actually upgrading")
  .setAction(async ({ env, targetVersion, dryRun }) => {
    const { upgradeClients } = await import("./scripts/upgrade/upgrade-clients");
    await upgradeClients(env, targetVersion, dryRun);
  });

const config: HardhatUserConfig = {
  networks: {
    hardhat: {
      gasPrice: 0,
      initialBaseFeePerGas: 0,
      allowUnlimitedContractSize: true, // Temporary enabled to finish the development, until Fermion Wrapper is refactored
    },
    amoy: {
      url: vars.get("RPC_PROVIDER_AMOY", "https://rpc-amoy.polygon.technology"),
      accounts: [vars.get("DEPLOYER_KEY_AMOY", DEFAULT_DEPLOYER_KEY)],
    },
    sepolia: {
      url: vars.get("RPC_PROVIDER_SEPOLIA", "https://rpc.sepolia.org"),
      accounts: [vars.get("DEPLOYER_KEY_SEPOLIA", DEFAULT_DEPLOYER_KEY)],
    },
    polygon: {
      url: vars.get("RPC_PROVIDER_POLYGON", "https://polygon-rpc.com"),
      accounts: [vars.get("DEPLOYER_KEY_POLYGON", DEFAULT_DEPLOYER_KEY)],
    },
    ethereum: {
      url: vars.get("RPC_PROVIDER_ETHEREUM", "https://cloudflare-eth.com"),
      accounts: [vars.get("DEPLOYER_KEY_ETHEREUM", DEFAULT_DEPLOYER_KEY)],
    },
    baseSepolia: {
      url: vars.get("RPC_PROVIDER_BASE_SEPOLIA", "https://base-sepolia-rpc.publicnode.com"),
      accounts: [vars.get("DEPLOYER_KEY_BASE_SEPOLIA", DEFAULT_DEPLOYER_KEY)],
    },
    base: {
      url: vars.get("RPC_PROVIDER_BASE", "https://mainnet.base.org"),
      accounts: [vars.get("DEPLOYER_KEY_BASE", DEFAULT_DEPLOYER_KEY)],
    },
    optimismSepolia: {
      url: vars.get("RPC_PROVIDER_OPTIMISM_SEPOLIA", "https://sepolia.optimism.io"),
      accounts: [vars.get("DEPLOYER_KEY_OPTIMISM_SEPOLIA", DEFAULT_DEPLOYER_KEY)],
    },
    optimism: {
      url: vars.get("RPC_PROVIDER_OPTIMISM", "https://optimism.llamarpc.com"),
      accounts: [vars.get("DEPLOYER_KEY_OPTIMISM", DEFAULT_DEPLOYER_KEY)],
    },
    arbitrumSepolia: {
      url: vars.get("RPC_PROVIDER_ARBITRUM_SEPOLIA", "https://arbitrum-sepolia.drpc.org"),
      accounts: [vars.get("DEPLOYER_KEY_ARBITRUM_SEPOLIA", DEFAULT_DEPLOYER_KEY)],
    },
    arbitrum: {
      url: vars.get("RPC_PROVIDER_ARBITRUM", "https://arb1.arbitrum.io/rpc"),
      accounts: [vars.get("DEPLOYER_KEY_ARBITRUM", DEFAULT_DEPLOYER_KEY)],
    },
  },
  solidity: {
    compilers: [
      {
        version: "0.8.24",
        settings: {
          viaIR: false,
          optimizer: {
            enabled: true,
            runs: 200,
            details: {
              yul: true,
            },
          },
          evmVersion: "cancun",
          outputSelection: {
            "*": {
              "*": ["storageLayout"],
            },
          },
        },
      },
      {
        version: "0.8.22",
        settings: {
          viaIR: false,
          optimizer: {
            enabled: true,
            runs: 200,
            details: {
              yul: true,
            },
          },
          evmVersion: "london",
        },
      },
      {
        version: "0.5.17", // Mock weth contract
      },
    ],
  },
  preprocess: {
    eachLine: () => ({
      transform: (line, { absolutePath }) => {
        if (absolutePath.includes("boson-protocol-contracts")) {
          line = line.replace(
            "@openzeppelin/contracts",
            "@bosonprotocol/boson-protocol-contracts/node_modules/@openzeppelin/contracts",
          );
        }
        return line;
      },
    }),
  },
  etherscan: {
    apiKey: vars.get("ETHERSCAN_API_KEY", ""),
  },
  mocha: {
    timeout: 100000,
  },
};

subtask(TASK_COMPILE_SOLIDITY_GET_SOURCE_PATHS, async (_, { config }) => {
  const contracts_path = path.join(config.paths.root, "contracts");
  const contracts = await glob(path.join(contracts_path, "**", "*.sol").replace(/\\/g, "/"), {
    ignore: [
      path.join(contracts_path, "external", "**", "*.sol").replace(/\\/g, "/"), // Windows support
    ],
  });

  return [...contracts].map(path.normalize);
});

export default config;
