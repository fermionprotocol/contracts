import { ZeroAddress, ZeroHash } from "ethers";

interface FermionConfig {
  protocolParameters: ProtocolParameters;
  seaport: SeaportConfigs;
}

interface ProtocolParameters {
  treasury: string;
  protocolFeePercentage: number;
  verificationTimeout: bigint;
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
  protocolParameters: {
    treasury: "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199", // dummy
    protocolFeePercentage: 500,
    verificationTimeout: 60n * 60n * 24n * 7n,
  },
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
    sepolia: {
      seaport: "0x0000000000000068F116a894984e2DB1123eB395",
      openSeaConduit: "0x1E0049783F008A0085193E00003D00cd54003c71",
      openSeaConduitKey: "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000",
    },
    polygon: {
      seaport: "0x0000000000000068F116a894984e2DB1123eB395",
      openSeaConduit: "0x1E0049783F008A0085193E00003D00cd54003c71",
      openSeaConduitKey: "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000",
    },
    ethereum: {
      seaport: "0x0000000000000068F116a894984e2DB1123eB395",
      openSeaConduit: "0x1E0049783F008A0085193E00003D00cd54003c71",
      openSeaConduitKey: "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000",
    },
  },
};

export default fermionConfig;
