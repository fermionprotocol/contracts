import { HardhatUserConfig, subtask, task, vars } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "hardhat-preprocessor";
import "hardhat-contract-sizer";
import path from "path";
import { glob } from "glob";
import { TASK_COMPILE_SOLIDITY_GET_SOURCE_PATHS } from "hardhat/builtin-tasks/task-names";
const DEFAULT_DEPLOYER_KEY = "123456789abcdef123456789abcdef123456789abcdef123456789abcdef1234"; // Used only for initialization

task("deploy-suite", "Deploy suite deploys protocol diamond, all facets and initializes the protocol diamond")
  .addOptionalParam("env", "The deployment environment")
  .addOptionalParam("modules", "The modules to execute")
  .setAction(async ({ env, modules }) => {
    const { deploySuite } = await import("./scripts/deploy");
    await deploySuite(env, modules && modules.split(","));
  });

const config: HardhatUserConfig = {
  networks: {
    hardhat: {
      gasPrice: 0,
      initialBaseFeePerGas: 0,
    },
    amoy: {
      url: vars.get("RPC_PROVIDER_AMOY", "https://rpc-amoy.polygon.technology"),
      accounts: [vars.get("DEPLOYER_KEY_AMOY", DEFAULT_DEPLOYER_KEY)],
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
            runs: 150,
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
