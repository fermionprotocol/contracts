import { ZeroAddress, ZeroHash } from "ethers";

interface FermionConfig {
  protocolParameters: ProtocolParameters;
  externalContracts: ExternalContracts;
}

interface ProtocolParameters {
  treasury: string;
  protocolFeePercentage: number;
  defaultVerificationTimeout: bigint;
  maxVerificationTimeout: bigint;
}

interface ExternalContracts {
  [networkName: string]: {
    seaportConfig: SeaportConfig;
    wrappedNative: string;
  };
}
interface SeaportConfig {
  seaport: string;
  openSeaConduit: string;
  openSeaConduitKey: string;
}

const fermionConfig: FermionConfig = {
  protocolParameters: {
    treasury: "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199", // dummy
    protocolFeePercentage: 0,
    defaultVerificationTimeout: 60n * 60n * 24n * 7n,
    maxVerificationTimeout: 60n * 60n * 24n * 30n,
  },
  externalContracts: {
    hardhat: {
      seaportConfig: {
        seaport: ZeroAddress,
        openSeaConduit: ZeroAddress,
        openSeaConduitKey: ZeroHash,
      },
      wrappedNative: ZeroAddress,
    },
    localhost: {
      seaportConfig: {
        seaport: ZeroAddress,
        openSeaConduit: ZeroAddress,
        openSeaConduitKey: ZeroHash,
      },
      wrappedNative: ZeroAddress,
    },
    amoy: {
      seaportConfig: {
        seaport: "0x0000000000000068F116a894984e2DB1123eB395",
        openSeaConduit: "0x1E0049783F008A0085193E00003D00cd54003c71",
        openSeaConduitKey: "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000",
      },
      wrappedNative: "0x113d6C5038832f567808677B4F0B89ffC62c18F7",
    },
    sepolia: {
      seaportConfig: {
        seaport: "0x0000000000000068F116a894984e2DB1123eB395",
        openSeaConduit: "0x1E0049783F008A0085193E00003D00cd54003c71",
        openSeaConduitKey: "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000",
      },
      wrappedNative: "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9",
    },
    polygon: {
      seaportConfig: {
        seaport: "0x0000000000000068F116a894984e2DB1123eB395",
        openSeaConduit: "0x1E0049783F008A0085193E00003D00cd54003c71",
        openSeaConduitKey: "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000",
      },
      wrappedNative: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    },
    ethereum: {
      seaportConfig: {
        seaport: "0x0000000000000068F116a894984e2DB1123eB395",
        openSeaConduit: "0x1E0049783F008A0085193E00003D00cd54003c71",
        openSeaConduitKey: "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000",
      },
      wrappedNative: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    },
    baseSepolia: {
      seaportConfig: {
        seaport: "0x0000000000000068F116a894984e2DB1123eB395",
        openSeaConduit: "0x1E0049783F008A0085193E00003D00cd54003c71",
        openSeaConduitKey: "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000",
      },
      wrappedNative: "0x4200000000000000000000000000000000000006",
    },
    base: {
      seaportConfig: {
        seaport: "0x0000000000000068F116a894984e2DB1123eB395",
        openSeaConduit: "0x1E0049783F008A0085193E00003D00cd54003c71",
        openSeaConduitKey: "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000",
      },
      wrappedNative: "0x4200000000000000000000000000000000000006",
    },
    optimismSepolia: {
      seaportConfig: {
        seaport: "0x0000000000000068F116a894984e2DB1123eB395",
        openSeaConduit: "0x1E0049783F008A0085193E00003D00cd54003c71",
        openSeaConduitKey: "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000",
      },
      wrappedNative: "0x4200000000000000000000000000000000000006",
    },
    optimism: {
      seaportConfig: {
        seaport: "0x0000000000000068F116a894984e2DB1123eB395",
        openSeaConduit: "0x1E0049783F008A0085193E00003D00cd54003c71",
        openSeaConduitKey: "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000",
      },
      wrappedNative: "0x4200000000000000000000000000000000000006",
    },
  },
};

export default fermionConfig;
