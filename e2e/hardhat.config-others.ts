import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";

const config: HardhatUserConfig = {
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
