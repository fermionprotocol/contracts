import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { getInterfaceID, deployMockTokens } from "../utils/common";
import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, MaxUint256, ZeroHash, ContractFactory } from "ethers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { TokenState } from "../utils/enums";
import { predictFermionDiamondAddress } from "../../scripts/deploy";

const { parseEther, ZeroAddress } = ethers;

describe("FermionFNFT", function () {
  let fermionFNFT: Contract, fermionFNFTProxy: Contract;
  let wallets: HardhatEthersSigner[];
  let seller: HardhatEthersSigner;
  let fermionMock: Contract;
  let fnftConstructorArgs: any[];

  const startTokenId = 2n ** 128n + 1n;
  const quantity = 10n;
  const additionalDeposit = 0n;
  const offerId = 123n;
  const metadataURI = "https://example.com";

  async function setupFermionFNFTTest() {
    wallets = await ethers.getSigners();
    const wrapperContractOwner = wallets[2];
    seller = wallets[3];

    const [mockConduit, mockBosonPriceDiscovery, openSeaRecipient] = wallets.slice(9, 12);

    const predictedFermionDiamondAddress = await predictFermionDiamondAddress(false, 9); // Diamond will be deployed 10 tx from now
    const seaportWrapperConstructorArgs = [
      mockBosonPriceDiscovery.address,
      predictedFermionDiamondAddress,
      {
        seaport: wallets[10].address, // dummy address
        openSeaConduit: mockConduit.address,
        openSeaConduitKey: ZeroHash,
        openSeaSignedZone: ZeroAddress,
        openSeaZoneHash: ZeroHash,
        openSeaRecipient: openSeaRecipient,
      },
    ];
    const FermionSeaportWrapper = await ethers.getContractFactory("SeaportWrapper");
    const fermionSeaportWrapper = await FermionSeaportWrapper.deploy(...seaportWrapperConstructorArgs);
    const FermionFractionsERC20 = await ethers.getContractFactory("FermionFractionsERC20");
    const fermionFractionsERC20Implementation = await FermionFractionsERC20.deploy(predictedFermionDiamondAddress);
    const FermionFNFTPriceManager = await ethers.getContractFactory("FermionFNFTPriceManager");
    const fermionFNFTPriceManager = await FermionFNFTPriceManager.deploy(predictedFermionDiamondAddress);
    const FermionFractionsMint = await ethers.getContractFactory("FermionFractionsMint");
    const fermionFractionsMint = await FermionFractionsMint.deploy(
      mockBosonPriceDiscovery.address,
      predictedFermionDiamondAddress,
      await fermionFractionsERC20Implementation.getAddress(),
    );
    const FermionBuyoutAuction = await ethers.getContractFactory("FermionBuyoutAuction");
    const fermionBuyoutAuction = await FermionBuyoutAuction.deploy(
      mockBosonPriceDiscovery.address,
      predictedFermionDiamondAddress,
    );

    fnftConstructorArgs = [
      mockBosonPriceDiscovery.address,
      predictedFermionDiamondAddress,
      await fermionSeaportWrapper.getAddress(),
      wallets[11].address,
      wallets[10].address,
      await fermionFractionsMint.getAddress(),
      await fermionFNFTPriceManager.getAddress(),
      await fermionBuyoutAuction.getAddress(),
    ];
    const FermionFNFT = await ethers.getContractFactory("FermionFNFT");
    const fermionFNFT = await FermionFNFT.deploy(...fnftConstructorArgs); // dummy address

    const Proxy = await ethers.getContractFactory("MockProxy");
    const proxy = await Proxy.deploy(await fermionFNFT.getAddress());

    const fermionFNFTProxy = await ethers.getContractAt("FermionFNFT", await proxy.getAddress());

    const [mockBoson, mockExchangeToken] = await deployMockTokens(["ERC721", "ERC20"]);

    const fermionMockFactory = await ethers.getContractFactory("MockFermion");
    fermionMock = await fermionMockFactory.deploy(
      await fermionFNFTProxy.getAddress(),
      await mockExchangeToken.getAddress(),
    );

    await mockBoson.mint(await fermionMock.getAddress(), startTokenId, quantity);
    await fermionFNFTProxy
      .attach(fermionMock)
      .initialize(
        await mockBoson.getAddress(),
        wrapperContractOwner.address,
        await mockExchangeToken.getAddress(),
        offerId,
        metadataURI,
        { name: "", symbol: "" },
      );
    await fermionMock.setDestinationOverride(await mockBoson.getAddress());
    await mockBoson.attach(fermionMock).setApprovalForAll(await fermionFNFTProxy.getAddress(), true);
    await fermionFNFTProxy.attach(fermionMock).wrap(startTokenId, quantity, seller.address);

    for (let i = 0n; i < quantity; i++) {
      const tokenId = startTokenId + i;
      await fermionFNFTProxy.attach(fermionMock).pushToNextTokenState(tokenId, TokenState.Unwrapping);
      await fermionFNFTProxy.connect(mockBosonPriceDiscovery).unwrapToSelf(tokenId, ZeroAddress, 0);
      if (i < quantity - 1n) {
        await fermionFNFTProxy.attach(fermionMock).pushToNextTokenState(tokenId, TokenState.Verified);
        await fermionFNFTProxy.attach(fermionMock).pushToNextTokenState(tokenId, TokenState.CheckedIn);
      }
    }

    return { fermionFNFT, fermionFNFTProxy, mockBoson, mockBosonPriceDiscovery };
  }

  before(async function () {
    ({ fermionFNFT, fermionFNFTProxy } = await loadFixture(setupFermionFNFTTest));
  });

  afterEach(async function () {
    await loadFixture(setupFermionFNFTTest);
  });

  context("constructor", function () {
    let FermionFNFT: ContractFactory;

    before(async function () {
      FermionFNFT = await ethers.getContractFactory("FermionFNFT");
    });

    it("_bosonPriceDiscovery is zero", async function () {
      const invalidConstructorArgs = [...fnftConstructorArgs];
      invalidConstructorArgs[0] = ZeroAddress;
      await expect(FermionFNFT.deploy(...invalidConstructorArgs)).to.be.revertedWithCustomError(
        fermionFNFT,
        "InvalidAddress",
      );
    });

    it("_fermionProtocol is zero", async function () {
      const invalidConstructorArgs = [...fnftConstructorArgs];
      invalidConstructorArgs[1] = ZeroAddress;
      await expect(FermionFNFT.deploy(...invalidConstructorArgs)).to.be.revertedWithCustomError(
        fermionFNFT,
        "InvalidAddress",
      );
    });

    it("_seaportWrapper is zero", async function () {
      const invalidConstructorArgs = [...fnftConstructorArgs];
      invalidConstructorArgs[2] = ZeroAddress;
      await expect(FermionFNFT.deploy(...invalidConstructorArgs)).to.be.revertedWithCustomError(
        fermionFNFT,
        "InvalidAddress",
      );
    });

    it("_wrappedNative is zero", async function () {
      const invalidConstructorArgs = [...fnftConstructorArgs];
      invalidConstructorArgs[4] = ZeroAddress;
      await expect(FermionFNFT.deploy(...invalidConstructorArgs)).to.be.revertedWithCustomError(
        fermionFNFT,
        "InvalidAddress",
      );
    });

    it("_fnftFractionMint is zero", async function () {
      const invalidConstructorArgs = [...fnftConstructorArgs];
      invalidConstructorArgs[5] = ZeroAddress;
      await expect(FermionFNFT.deploy(...invalidConstructorArgs)).to.be.revertedWithCustomError(
        fermionFNFT,
        "InvalidAddress",
      );
    });

    it("_fermionFNFTPriceManager is zero", async function () {
      const invalidConstructorArgs = [...fnftConstructorArgs];
      invalidConstructorArgs[6] = ZeroAddress;
      await expect(FermionFNFT.deploy(...invalidConstructorArgs)).to.be.revertedWithCustomError(
        fermionFNFT,
        "InvalidAddress",
      );
    });

    it("_fnftBuyoutAuction is zero", async function () {
      const invalidConstructorArgs = [...fnftConstructorArgs];
      invalidConstructorArgs[7] = ZeroAddress;
      await expect(FermionFNFT.deploy(...invalidConstructorArgs)).to.be.revertedWithCustomError(
        fermionFNFT,
        "InvalidAddress",
      );
    });

    it("_strictAuthorizedTransferSecurityRegistry is zero", async function () {
      const invalidConstructorArgs = [...fnftConstructorArgs];
      invalidConstructorArgs[3] = ZeroAddress;
      await expect(FermionFNFT.deploy(...invalidConstructorArgs)).to.be.revertedWithCustomError(
        fermionFNFT,
        "InvalidAddress",
      );
    });
  });

  context("supportsInterface", function () {
    it("Supports ERC165 and ERC721 interfaces", async function () {
      const { interface: ERC165Interface } = await ethers.getContractAt(
        "@openzeppelin/contracts/utils/introspection/IERC165.sol:IERC165",
        ZeroAddress,
      );
      const { interface: ERC721Interface } = await ethers.getContractAt("IERC721", ZeroAddress);
      const { interface: FermionWrapperInterface } = await ethers.getContractAt("IFermionWrapper", ZeroAddress);
      const { interface: FermionFractionsInterface } = await ethers.getContractAt("IFermionFractions", ZeroAddress);
      const { interface: FermionFNFTInterface } = await ethers.getContractAt("IFermionFNFT", ZeroAddress);
      const { interface: ERC2981Interface } = await ethers.getContractAt("IERC2981", ZeroAddress);

      const ERC165InterfaceID = getInterfaceID(ERC165Interface);
      const ERC721InterfaceID = getInterfaceID(ERC721Interface, [ERC165InterfaceID]);
      const FermionWrapperInterfaceID = getInterfaceID(FermionWrapperInterface, [ERC165InterfaceID, ERC721InterfaceID]);
      const FermionFractionsInterfaceID = getInterfaceID(FermionFractionsInterface);
      const FermionFNFTInterfaceID = getInterfaceID(FermionFNFTInterface, [
        ERC165InterfaceID,
        ERC721InterfaceID,
        FermionWrapperInterfaceID,
        FermionFractionsInterfaceID,
      ]);
      const ERC2981InterfaceID = getInterfaceID(ERC2981Interface, [ERC165InterfaceID]);

      expect(await fermionFNFT.supportsInterface(ERC165InterfaceID)).to.be.equal(true);
      expect(await fermionFNFT.supportsInterface(ERC721InterfaceID)).to.be.equal(true);
      expect(await fermionFNFT.supportsInterface(FermionWrapperInterfaceID)).to.be.equal(true);
      expect(await fermionFNFT.supportsInterface(FermionFractionsInterfaceID)).to.be.equal(true);
      expect(await fermionFNFT.supportsInterface(FermionFNFTInterfaceID)).to.be.equal(true);
      expect(await fermionFNFT.supportsInterface(ERC2981InterfaceID)).to.be.equal(true);
    });
  });

  context("ERC721/ERC20 methods", async function () {
    it("name", async function () {
      expect(await fermionFNFTProxy.name()).to.equal(`Fermion FNFT ${offerId}`);
    });

    it("symbol", async function () {
      expect(await fermionFNFTProxy.symbol()).to.equal(`FFNFT_${offerId}`);
    });

    it("custom name and symbol", async function () {
      const Proxy = await ethers.getContractFactory("MockProxy");
      const proxy = await Proxy.deploy(await fermionFNFT.getAddress());

      const fermionFNFTProxy = await ethers.getContractAt("FermionFNFT", await proxy.getAddress());
      const randomWallet = wallets[4].address;

      const name = "customName";
      const symbol = "customSymbol";
      await fermionFNFTProxy.initialize(randomWallet, randomWallet, randomWallet, offerId, metadataURI, {
        name,
        symbol,
      });

      expect(await fermionFNFTProxy.name()).to.equal(name);
      expect(await fermionFNFTProxy.symbol()).to.equal(symbol);
    });

    it("custom name, default symbol", async function () {
      const Proxy = await ethers.getContractFactory("MockProxy");
      const proxy = await Proxy.deploy(await fermionFNFT.getAddress());

      const fermionFNFTProxy = await ethers.getContractAt("FermionFNFT", await proxy.getAddress());
      const randomWallet = wallets[4].address;

      const name = "customName";
      const symbol = "";
      await fermionFNFTProxy.initialize(randomWallet, randomWallet, randomWallet, offerId, metadataURI, {
        name,
        symbol,
      });

      expect(await fermionFNFTProxy.name()).to.equal(name);
      expect(await fermionFNFTProxy.symbol()).to.equal(`FFNFT_${offerId}`);
    });

    it("default name, custom symbol", async function () {
      const Proxy = await ethers.getContractFactory("MockProxy");
      const proxy = await Proxy.deploy(await fermionFNFT.getAddress());

      const fermionFNFTProxy = await ethers.getContractAt("FermionFNFT", await proxy.getAddress());
      const randomWallet = wallets[4].address;

      const name = "";
      const symbol = "customSymbol";
      await fermionFNFTProxy.initialize(randomWallet, randomWallet, randomWallet, offerId, metadataURI, {
        name,
        symbol,
      });

      expect(await fermionFNFTProxy.name()).to.equal(`Fermion FNFT ${offerId}`);
      expect(await fermionFNFTProxy.symbol()).to.equal(symbol);
    });
  });

  context("ERC20 methods", function () {
    context("Approve fractions transfer", async function () {
      let approvedAccount: HardhatEthersSigner;
      let fermionFractionsERC20: Contract;
      const fractionsAmount = 5000n * 10n ** 18n;
      beforeEach(async function () {
        const auctionParameters = {
          exitPrice: parseEther("0.1"),
          duration: 0n,
          unlockThreshold: 0n,
          topBidLockTime: 0n,
        };
        const custodianFee = {
          amount: parseEther("0.05"),
          period: 30n * 24n * 60n * 60n, // 30 days
        };
        const custodianVaultParameters = {
          partialAuctionThreshold: custodianFee.amount * 15n,
          partialAuctionDuration: custodianFee.period / 2n,
          liquidationThreshold: custodianFee.amount * 2n,
          newFractionsPerAuction: fractionsAmount,
        };

        await fermionFNFTProxy
          .connect(seller)
          .mintFractions(
            startTokenId,
            1,
            fractionsAmount,
            auctionParameters,
            custodianVaultParameters,
            additionalDeposit,
            ZeroAddress,
          );

        approvedAccount = wallets[4];
        const erc20CloneAddress = await fermionFNFTProxy.getERC20FractionsClone();
        fermionFractionsERC20 = await ethers.getContractAt("FermionFractionsERC20", erc20CloneAddress);
      });
      it("decimals", async function () {
        expect(await fermionFractionsERC20.decimals()).to.equal(18);
      });

      it("Standard ERC20 approval", async function () {
        // Approve fractions transfer
        await expect(fermionFractionsERC20.connect(seller).approve(approvedAccount.address, fractionsAmount))
          .to.emit(fermionFractionsERC20, "Approval")
          .withArgs(seller.address, approvedAccount.address, fractionsAmount);

        // Get allowance
        expect(await fermionFractionsERC20.allowance(seller.address, approvedAccount.address)).to.equal(
          fractionsAmount,
        );

        // Transfer fractions
        await fermionFractionsERC20
          .connect(approvedAccount)
          .transferFrom(seller.address, approvedAccount.address, fractionsAmount);

        // Allowance should be 0
        expect(await fermionFractionsERC20.allowance(seller.address, approvedAccount.address)).to.equal(0);

        // Check balance
        expect(await fermionFractionsERC20.balanceOf(approvedAccount.address)).to.equal(fractionsAmount);
        expect(await fermionFractionsERC20.balanceOf(seller.address)).to.equal(0);
      });

      it("Unlimited ERC20 approval", async function () {
        const unlimitedFractions = MaxUint256;

        // Approve fractions transfer
        await expect(fermionFractionsERC20.connect(seller).approve(approvedAccount.address, unlimitedFractions))
          .to.emit(fermionFractionsERC20, "Approval")
          .withArgs(seller.address, approvedAccount.address, unlimitedFractions);

        // Get allowance
        expect(await fermionFractionsERC20.allowance(seller.address, approvedAccount.address)).to.equal(
          unlimitedFractions,
        );

        // Transfer fractions
        await fermionFractionsERC20
          .connect(approvedAccount)
          .transferFrom(seller.address, approvedAccount.address, fractionsAmount);

        expect(await fermionFractionsERC20.allowance(seller.address, approvedAccount.address)).to.equal(
          unlimitedFractions,
        );

        // Check balance
        expect(await fermionFractionsERC20.balanceOf(approvedAccount.address)).to.equal(fractionsAmount);
        expect(await fermionFractionsERC20.balanceOf(seller.address)).to.equal(0);
      });
    });

    it("Reverts", async function () {
      const fractionsAmount = 5000n * 10n ** 18n;
      const auctionParameters = {
        exitPrice: parseEther("0.1"),
        duration: 0n,
        unlockThreshold: 0n,
        topBidLockTime: 0n,
      };
      const custodianFee = {
        amount: parseEther("0.05"),
        period: 30n * 24n * 60n * 60n, // 30 days
      };
      const custodianVaultParameters = {
        partialAuctionThreshold: custodianFee.amount * 15n,
        partialAuctionDuration: custodianFee.period / 2n,
        liquidationThreshold: custodianFee.amount * 2n,
        newFractionsPerAuction: fractionsAmount,
      };

      await fermionFNFTProxy
        .connect(seller)
        .mintFractions(
          startTokenId,
          1,
          fractionsAmount,
          auctionParameters,
          custodianVaultParameters,
          additionalDeposit,
          ZeroAddress,
        );

      const erc20CloneAddress = await fermionFNFTProxy.getERC20FractionsClone();
      const fermionFractionsERC20 = await ethers.getContractAt("FermionFractionsERC20", erc20CloneAddress);
      // Approve to 0 address
      await expect(fermionFractionsERC20.connect(seller).approve(ZeroAddress, fractionsAmount))
        .to.be.revertedWithCustomError(fermionFractionsERC20, "ERC20InvalidSpender")
        .withArgs(ZeroAddress);

      // Send to 0 address
      await expect(fermionFractionsERC20.connect(seller).transfer(ZeroAddress, fractionsAmount))
        .to.be.revertedWithCustomError(fermionFractionsERC20, "ERC20InvalidReceiver")
        .withArgs(ZeroAddress);
    });
  });
});
