import { ZeroAddress, ZeroHash } from "ethers";

interface FermionConfig {
  seaport: SeaportConfigs;
}

interface SeaportConfigs {
  [networkName: string]: SeaportConfig;
}

interface SeaportConfig {
  seaport: string;
  openSeaConduit: string;
  openSeaConduitKey: string;
}

const fermionConfig: FermionConfig = {
  seaport: {
    hardhat: {
      seaport: ZeroAddress,
      openSeaConduit: ZeroAddress,
      openSeaConduitKey: ZeroHash,
    },
    localhost: {
      seaport: ZeroAddress,
      openSeaConduit: ZeroAddress,
      openSeaConduitKey: ZeroHash,
    },
    amoy: {
      seaport: "0x0000000000000068F116a894984e2DB1123eB395",
      openSeaConduit: ZeroAddress,
      openSeaConduitKey: ZeroHash,
    },
  },
};

export default fermionConfig;
