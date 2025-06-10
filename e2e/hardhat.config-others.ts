import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import { ACCOUNTS } from "./accounts";

const config: HardhatUserConfig = {
  networks: {
    hardhat: {
      allowUnlimitedContractSize: true,
      chainId: 31337,
      accounts: ACCOUNTS.map(({ privateKey }) => ({
        privateKey,
        balance: "1000000000000000000000000000"
      })),
      mining: {
        auto: true,
        interval: 5000
      }
    }
  },
  paths: {
    sources: "./other-contracts",
    artifacts: "./other-contracts/artifacts"
  },
  solidity: {
    compilers: [
      {
        version: "0.8.22"
      }
    ]
  }
};

export default config;
