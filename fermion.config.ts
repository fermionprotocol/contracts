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
      openSeaConduit: "0x1E0049783F008A0085193E00003D00cd54003c71",
      openSeaConduitKey: "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000",
    },
  },
};

export default fermionConfig;
