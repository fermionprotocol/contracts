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
    apiKey: {
      polygonAmoy: vars.get("POLYGONSCAN_API_KEY", ""),
      sepolia: vars.get("ETHERSCAN_API_KEY", ""),
      polygon: vars.get("POLYGONSCAN_API_KEY", ""),
      mainnet: vars.get("ETHERSCAN_API_KEY", ""),
      base: vars.get("BASESCAN_API_KEY", ""),
      baseSepolia: vars.get("BASESCAN_API_KEY", ""),
      optimism: vars.get("OPTIMISTIC_ETHERSCAN_API_KEY", ""),
      optimismSepolia: vars.get("OPTIMISTIC_ETHERSCAN_API_KEY", ""),
      arbitrumSepolia: vars.get("ARBITRUM_SEPOLIA_ETHERSCAN_API_KEY", ""),
    },
    customChains: [
      {
        network: "optimism",
        chainId: 10,
        urls: {
          apiURL: "https://api-optimistic.etherscan.io/api",
          browserURL: "https://optimistic.etherscan.io/",
        },
      },
      {
        network: "optimismSepolia",
        chainId: 11155420,
        urls: {
          apiURL: "https://api-sepolia-optimistic.etherscan.io/api",
          browserURL: "https://sepolia-optimism.etherscan.io",
        },
      },
      {
        network: "arbitrumSepolia",
        chainId: 421614,
        urls: {
          apiURL: "https://api-sepolia.arbiscan.io/api",
          browserURL: "https://sepolia.arbiscan.io",
        },
      },
    ],
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
