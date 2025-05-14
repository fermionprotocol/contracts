import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import {
  applyPercentage,
  deployMockTokens,
  getBlockTimestampFromTransaction,
  setNextBlockTimestamp,
} from "../utils/common";
import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, ZeroHash, encodeBytes32String, parseEther } from "ethers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { AuctionState, PriceUpdateProposalState, TokenState } from "../utils/enums";
import {
  MINIMAL_BID_INCREMENT,
  MIN_FRACTIONS,
  MAX_FRACTIONS,
  TOP_BID_LOCK_TIME,
  AUCTION_DURATION,
  UNLOCK_THRESHOLD,
  MAX_GOV_VOTE_DURATION,
  DEFAULT_GOV_VOTE_DURATION,
  HUNDRED_PERCENT,
} from "../utils/constants";
import { balanceOfERC20, totalSupplyERC20, getERC20Clone, impersonateAccount } from "../utils/common";
import { setStorageAt } from "@nomicfoundation/hardhat-network-helpers";
import { predictFermionDiamondAddress } from "../../scripts/deploy";

const { ZeroAddress, keccak256, toBeHex } = ethers;

describe("FermionFNFT - fractionalisation tests", function () {
  let fermionFNFTProxy: Contract;
  let fermionFNFTProxyNativeEth: Contract;
  let mockExchangeToken: Contract;
  let wallets: HardhatEthersSigner[];
  let bidders: HardhatEthersSigner[];
  let fermionMock: Contract;
  let fermionMockNativeEth: Contract;
  let wrapperContractOwner: HardhatEthersSigner;
  let seller: HardhatEthersSigner;
  const startTokenId = 2n ** 128n + 1n;
  const quantity = 10n;
  const startTokenIdNativeEth = startTokenId + quantity;
  const additionalDeposit = 0n;
  const metadataURI = "https://example.com";

  async function setupFermionFractionsTest() {
    wallets = await ethers.getSigners();
    wrapperContractOwner = wallets[2];
    seller = wallets[3];
    bidders = wallets.slice(4, 8);

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

    const FermionFNFT = await ethers.getContractFactory("FermionFNFT");
    const fermionFNFT = await FermionFNFT.deploy(
      mockBosonPriceDiscovery.address,
      predictedFermionDiamondAddress,
      await fermionSeaportWrapper.getAddress(),
      ZeroAddress,
      wallets[10].address,
      await fermionFractionsMint.getAddress(),
      await fermionFNFTPriceManager.getAddress(),
      await fermionBuyoutAuction.getAddress(),
    ); // dummy address

    const Proxy = await ethers.getContractFactory("MockProxy");
    const proxy = await Proxy.deploy(await fermionFNFT.getAddress());

    const fermionFNFTProxy = await ethers.getContractAt("FermionFNFT", await proxy.getAddress());

    const [mockBoson, mockExchangeToken] = await deployMockTokens(["ERC721", "ERC20"]);

    const fermionMockFactory = await ethers.getContractFactory("MockFermion");
    fermionMock = await fermionMockFactory.deploy(
      await fermionFNFTProxy.getAddress(),
      await mockExchangeToken.getAddress(),
    );
    const fermionMockAddress = await fermionMock.getAddress();

    await mockBoson.mint(fermionMockAddress, startTokenId, quantity);
    const offerId = 1n;
    await fermionFNFTProxy
      .attach(fermionMock)
      .initialize(
        await mockBoson.getAddress(),
        wrapperContractOwner.address,
        await mockExchangeToken.getAddress(),
        offerId,
        metadataURI,
        { name: "test FNFT", symbol: "tFNFT" },
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

    for (const bidder of bidders) {
      await mockExchangeToken.mint(bidder.address, parseEther("1000"));
    }

    // Setup fermionMock for native ETH bidding
    const predictedFermionDiamondAddressNativeEth = await predictFermionDiamondAddress(false, 2); // Diamond will be deployed 2 tx from now
    const fermionFNFTNativeEth = await FermionFNFT.deploy(
      mockBosonPriceDiscovery.address,
      predictedFermionDiamondAddressNativeEth,
      await fermionSeaportWrapper.getAddress(),
      ZeroAddress,
      wallets[10].address,
      await fermionFractionsMint.getAddress(),
      await fermionFNFTPriceManager.getAddress(),
      await fermionBuyoutAuction.getAddress(),
    ); // dummy address

    const proxyNativeEth = await Proxy.deploy(await fermionFNFTNativeEth.getAddress());

    const fermionFNFTProxyNativeEth = await ethers.getContractAt("FermionFNFT", await proxyNativeEth.getAddress());
    fermionMockNativeEth = await fermionMockFactory.deploy(await fermionFNFTProxyNativeEth.getAddress(), ZeroAddress);
    const fermionMockNativeEthAddress = await fermionMockNativeEth.getAddress();
    await mockBoson.mint(fermionMockNativeEthAddress, startTokenIdNativeEth, quantity);

    const offerIdNativeEth = 2n;
    await fermionFNFTProxyNativeEth
      .attach(fermionMockNativeEth)
      .initialize(
        await mockBoson.getAddress(),
        wrapperContractOwner.address,
        ZeroAddress,
        offerIdNativeEth,
        metadataURI,
        { name: "test FNFT Native ETH", symbol: "tFNFT_ETH" },
      );
    await fermionMockNativeEth.setDestinationOverride(await mockBoson.getAddress());
    await mockBoson.attach(fermionMockNativeEth).setApprovalForAll(await fermionFNFTProxyNativeEth.getAddress(), true);
    await fermionFNFTProxyNativeEth.attach(fermionMockNativeEth).wrap(startTokenIdNativeEth, quantity, seller.address);
    for (let i = 0n; i < quantity; i++) {
      const tokenId = startTokenIdNativeEth + i;
      await fermionFNFTProxyNativeEth.attach(fermionMockNativeEth).pushToNextTokenState(tokenId, TokenState.Unwrapping);
      await fermionFNFTProxyNativeEth.connect(mockBosonPriceDiscovery).unwrapToSelf(tokenId, ZeroAddress, 0);
      if (i < quantity - 1n) {
        await fermionFNFTProxyNativeEth.attach(fermionMockNativeEth).pushToNextTokenState(tokenId, TokenState.Verified);
        await fermionFNFTProxyNativeEth
          .attach(fermionMockNativeEth)
          .pushToNextTokenState(tokenId, TokenState.CheckedIn);
      }
    }

    return {
      fermionFNFT,
      fermionFNFTProxy,
      fermionFNFTProxyNativeEth,
      mockBoson,
      mockBosonPriceDiscovery,
      mockExchangeToken,
    };
  }

  before(async function () {
    ({ fermionFNFTProxy, fermionFNFTProxyNativeEth, mockExchangeToken } = await loadFixture(setupFermionFractionsTest));
  });

  afterEach(async function () {
    await loadFixture(setupFermionFractionsTest);
  });

  context("mintFractions - initial fractionalisation", function () {
    const fractionsAmount = 5000n * 10n ** 18n;
    const auctionParameters = {
      exitPrice: parseEther("0.1"),
      duration: 60n * 60n * 24n * 7n, // 1 week
      unlockThreshold: 7500n, // 75%
      topBidLockTime: 60n * 60n * 24n * 2n, // two days
    };
    const custodianFee = {
      amount: parseEther("0.05"),
      period: 30n * 24n * 60n * 60n, // 30 days
    };
    const custodianVaultParameters = {
      partialAuctionThreshold: custodianFee.amount * 15n,
      partialAuctionDuration: custodianFee.period / 2n,
      liquidationThreshold: custodianFee.amount * 2n,
      newFractionsPerAuction: fractionsAmount * 5n,
    };

    it("The owner can fractionalise a single NFT", async function () {
      expect(await fermionFNFTProxy.balanceOf(seller.address)).to.equal(quantity);
      expect(await fermionFNFTProxy.totalSupply(0)).to.equal(0n);
      expect(await fermionFNFTProxy.getERC20CloneAddress(0)).to.equal(ZeroAddress);

      const tx = await fermionFNFTProxy
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

      // lock the F-NFT (erc721 transfer)
      await expect(tx)
        .to.emit(fermionFNFTProxy, "Transfer")
        .withArgs(seller.address, await fermionFNFTProxy.getAddress(), startTokenId);

      await expect(tx)
        .to.emit(await getERC20Clone(fermionFNFTProxy), "Transfer")
        .withArgs(ZeroAddress, seller.address, fractionsAmount);

      await expect(tx)
        .to.emit(fermionFNFTProxy, "FractionsSetup")
        .withArgs(fractionsAmount, Object.values(auctionParameters));

      await expect(tx).to.emit(fermionFNFTProxy, "Fractionalised").withArgs(startTokenId, fractionsAmount);

      // state
      expect(await fermionFNFTProxy.ownerOf(startTokenId)).to.equal(await fermionFNFTProxy.getAddress());
      expect(await fermionFNFTProxy.balanceOf(seller.address)).to.equal(quantity - 1n);
      expect(await fermionFNFTProxy.tokenState(startTokenId)).to.equal(TokenState.CheckedIn); // token state remains

      expect(await balanceOfERC20(fermionFNFTProxy, seller.address)).to.equal(fractionsAmount);
      expect(await fermionFNFTProxy.totalSupply(0)).to.equal(fractionsAmount);
      expect(await fermionFNFTProxy.liquidSupply()).to.equal(fractionsAmount);
      expect(await fermionFNFTProxy.getCurrentEpoch()).to.equal(0n);
      expect(await fermionFNFTProxy.getERC20CloneAddress(0)).to.not.equal(ZeroAddress);
      expect(await fermionFNFTProxy.getERC20CloneAddress(1)).to.equal(ZeroAddress);
      expect(await fermionFNFTProxy.getBuyoutAuctionParameters(0)).to.eql(Object.values(auctionParameters));
    });

    it("The owner can fractionalise multiple NFT", async function () {
      const initialQuantity = 10n;
      expect(await fermionFNFTProxy.balanceOf(seller.address)).to.equal(initialQuantity);

      const quantity = 5n;
      const totalFractions = quantity * fractionsAmount;
      const tx = await fermionFNFTProxy
        .connect(seller)
        .mintFractions(
          startTokenId,
          quantity,
          fractionsAmount,
          auctionParameters,
          custodianVaultParameters,
          additionalDeposit,
          ZeroAddress,
        );

      // lock the F-NFT (erc721 transfer)
      for (let i = 0n; i < quantity; i++) {
        const tokenId = startTokenId + i;
        await expect(tx)
          .to.emit(fermionFNFTProxy, "Transfer")
          .withArgs(seller.address, await fermionFNFTProxy.getAddress(), tokenId);

        await expect(tx).to.emit(fermionFNFTProxy, "Fractionalised").withArgs(tokenId, fractionsAmount);
      }
      // mint fractions (erc20 mint)
      await expect(tx)
        .to.emit(await getERC20Clone(fermionFNFTProxy), "Transfer")
        .withArgs(ZeroAddress, seller.address, totalFractions);

      await expect(tx)
        .to.emit(fermionFNFTProxy, "FractionsSetup")
        .withArgs(fractionsAmount, Object.values(auctionParameters));

      // state
      expect(await fermionFNFTProxy.ownerOf(startTokenId)).to.equal(await fermionFNFTProxy.getAddress());
      expect(await fermionFNFTProxy.balanceOf(seller.address)).to.equal(initialQuantity - quantity);
      expect(await fermionFNFTProxy.tokenState(startTokenId)).to.equal(TokenState.CheckedIn); // token state remains
      expect(await balanceOfERC20(fermionFNFTProxy, seller.address)).to.equal(totalFractions);
      expect(await totalSupplyERC20(fermionFNFTProxy)).to.equal(totalFractions);
      expect(await fermionFNFTProxy.liquidSupply()).to.equal(totalFractions);
      expect(await fermionFNFTProxy.getBuyoutAuctionParameters(0)).to.eql(Object.values(auctionParameters));
    });

    it("Omitting the optional auction parameters", async function () {
      const auctionParameters = {
        exitPrice: parseEther("0.1"),
        duration: 0n,
        unlockThreshold: 0n,
        topBidLockTime: 0n,
      };

      const auctionDefaultParameters = {
        exitPrice: parseEther("0.1"), // taken from input
        duration: AUCTION_DURATION, // five days
        unlockThreshold: UNLOCK_THRESHOLD, // 50%
        topBidLockTime: TOP_BID_LOCK_TIME, // three days
      };

      const tx = await fermionFNFTProxy
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

      await expect(tx)
        .to.emit(fermionFNFTProxy, "FractionsSetup")
        .withArgs(fractionsAmount, Object.values(auctionDefaultParameters));

      // state
      expect(await fermionFNFTProxy.getBuyoutAuctionParameters(0)).to.eql(Object.values(auctionDefaultParameters));
    });

    it("Protocol can forcefully fractionalise", async function () {
      const tx = await fermionFNFTProxy
        .attach(fermionMock)
        .mintFractions(
          startTokenId,
          1,
          fractionsAmount,
          auctionParameters,
          custodianVaultParameters,
          additionalDeposit,
          ZeroAddress,
        );

      // lock the F-NFT (erc721 transfer)
      await expect(tx)
        .to.emit(fermionFNFTProxy, "Transfer")
        .withArgs(seller.address, await fermionFNFTProxy.getAddress(), startTokenId);

      // mint fractions (erc20 mint)
      await expect(tx)
        .to.emit(await getERC20Clone(fermionFNFTProxy), "Transfer")
        .withArgs(ZeroAddress, seller.address, fractionsAmount);

      await expect(tx)
        .to.emit(fermionFNFTProxy, "FractionsSetup")
        .withArgs(fractionsAmount, Object.values(auctionParameters));

      await expect(tx).to.emit(fermionFNFTProxy, "Fractionalised").withArgs(startTokenId, fractionsAmount);

      // state
      expect(await fermionFNFTProxy.ownerOf(startTokenId)).to.equal(await fermionFNFTProxy.getAddress());
      expect(await fermionFNFTProxy.tokenState(startTokenId)).to.equal(TokenState.CheckedIn); // token state remains
      expect(await balanceOfERC20(fermionFNFTProxy, seller.address)).to.equal(fractionsAmount);
      expect(await totalSupplyERC20(fermionFNFTProxy)).to.equal(fractionsAmount);
      expect(await fermionFNFTProxy.liquidSupply()).to.equal(fractionsAmount);
      expect(await fermionFNFTProxy.getBuyoutAuctionParameters(0)).to.eql(Object.values(auctionParameters));
    });

    context("Revert reasons", function () {
      it("Length is 0", async function () {
        await expect(
          fermionFNFTProxy
            .connect(seller)
            .mintFractions(
              startTokenId,
              0,
              fractionsAmount,
              auctionParameters,
              custodianVaultParameters,
              additionalDeposit,
              ZeroAddress,
            ),
        ).to.be.revertedWithCustomError(fermionFNFTProxy, "InvalidLength");
      });

      it("Initial fractionalisation happened already", async function () {
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

        await expect(
          fermionFNFTProxy.mintFractions(
            startTokenId + 1n,
            1,
            fractionsAmount,
            auctionParameters,
            custodianVaultParameters,
            additionalDeposit,
            ZeroAddress,
          ),
        ).to.be.revertedWithCustomError(fermionFNFTProxy, "InitialFractionalisationOnly");
      });

      it("Invalid exit price", async function () {
        const auctionParameters2 = { ...auctionParameters, exitPrice: 0n };
        await expect(
          fermionFNFTProxy
            .connect(seller)
            .mintFractions(
              startTokenId,
              1,
              fractionsAmount,
              auctionParameters2,
              custodianVaultParameters,
              additionalDeposit,
              ZeroAddress,
            ),
        )
          .to.be.revertedWithCustomError(fermionFNFTProxy, "InvalidExitPrice")
          .withArgs(0n);
      });

      it("Invalid unlock threshold percentage", async function () {
        const unlockThreshold = 10001n;
        const auctionParameters2 = { ...auctionParameters, unlockThreshold };
        await expect(
          fermionFNFTProxy
            .connect(seller)
            .mintFractions(
              startTokenId,
              1,
              fractionsAmount,
              auctionParameters2,
              custodianVaultParameters,
              additionalDeposit,
              ZeroAddress,
            ),
        )
          .to.be.revertedWithCustomError(fermionFNFTProxy, "InvalidPercentage")
          .withArgs(unlockThreshold);
      });

      it("Invalid number of initial fractions", async function () {
        const fractionsAmountLow = MIN_FRACTIONS - 1n;
        await expect(
          fermionFNFTProxy
            .connect(seller)
            .mintFractions(
              startTokenId,
              1,
              fractionsAmountLow,
              auctionParameters,
              custodianVaultParameters,
              additionalDeposit,
              ZeroAddress,
            ),
        )
          .to.be.revertedWithCustomError(fermionFNFTProxy, "InvalidFractionsAmount")
          .withArgs(fractionsAmountLow, MIN_FRACTIONS, MAX_FRACTIONS);

        const fractionsAmountHigh = MAX_FRACTIONS + 1n;
        await expect(
          fermionFNFTProxy
            .connect(seller)
            .mintFractions(
              startTokenId,
              1,
              fractionsAmountHigh,
              auctionParameters,
              custodianVaultParameters,
              additionalDeposit,
              ZeroAddress,
            ),
        )
          .to.be.revertedWithCustomError(fermionFNFTProxy, "InvalidFractionsAmount")
          .withArgs(fractionsAmountHigh, MIN_FRACTIONS, MAX_FRACTIONS);
      });

      it("Invalid number of initial additional fractions", async function () {
        const fractionsAmountLow = MIN_FRACTIONS - 1n;
        await expect(
          fermionFNFTProxy.connect(seller).mintFractions(
            startTokenId,
            1,
            fractionsAmount,
            auctionParameters,
            {
              ...custodianVaultParameters,
              newFractionsPerAuction: fractionsAmountLow,
            },
            additionalDeposit,
            ZeroAddress,
          ),
        )
          .to.be.revertedWithCustomError(fermionFNFTProxy, "InvalidFractionsAmount")
          .withArgs(fractionsAmountLow, MIN_FRACTIONS, MAX_FRACTIONS);

        const fractionsAmountHigh = MAX_FRACTIONS + 1n;
        await expect(
          fermionFNFTProxy.connect(seller).mintFractions(
            startTokenId,
            1,
            fractionsAmount,
            auctionParameters,
            {
              ...custodianVaultParameters,
              newFractionsPerAuction: fractionsAmountHigh,
            },
            additionalDeposit,
            ZeroAddress,
          ),
        )
          .to.be.revertedWithCustomError(fermionFNFTProxy, "InvalidFractionsAmount")
          .withArgs(fractionsAmountHigh, MIN_FRACTIONS, MAX_FRACTIONS);
      });

      it("Liquidation threshold is above the auction threshold", async function () {
        await expect(
          fermionFNFTProxy.connect(seller).mintFractions(
            startTokenId,
            1,
            fractionsAmount,
            auctionParameters,
            {
              ...custodianVaultParameters,
              liquidationThreshold: custodianVaultParameters.partialAuctionThreshold + 1n,
            },
            additionalDeposit,
            ZeroAddress,
          ),
        ).to.be.revertedWithCustomError(fermionFNFTProxy, "InvalidPartialAuctionThreshold");
      });

      it("The token is not verified", async function () {
        const tokenId = startTokenId + quantity - 1n;
        await expect(
          fermionFNFTProxy
            .connect(seller)
            .mintFractions(
              tokenId,
              1,
              fractionsAmount,
              auctionParameters,
              custodianVaultParameters,
              additionalDeposit,
              ZeroAddress,
            ),
        )
          .to.be.revertedWithCustomError(fermionFNFTProxy, "InvalidStateOrCaller")
          .withArgs(tokenId, seller.address, TokenState.Unverified);

        await fermionFNFTProxy.attach(fermionMock).pushToNextTokenState(tokenId, TokenState.Verified);

        await expect(
          fermionFNFTProxy
            .connect(seller)
            .mintFractions(
              tokenId,
              1,
              fractionsAmount,
              auctionParameters,
              custodianVaultParameters,
              additionalDeposit,
              ZeroAddress,
            ),
        )
          .to.be.revertedWithCustomError(fermionFNFTProxy, "InvalidStateOrCaller")
          .withArgs(tokenId, seller.address, TokenState.Verified);

        await fermionFNFTProxy.attach(fermionMock).pushToNextTokenState(tokenId, TokenState.CheckedIn);
        await fermionFNFTProxy.attach(fermionMock).pushToNextTokenState(tokenId, TokenState.CheckedOut); // checkout burns the token
        await expect(
          fermionFNFTProxy
            .connect(seller)
            .mintFractions(
              tokenId,
              1,
              fractionsAmount,
              auctionParameters,
              custodianVaultParameters,
              additionalDeposit,
              ZeroAddress,
            ),
        )
          .to.be.revertedWithCustomError(fermionFNFTProxy, "ERC721NonexistentToken")
          .withArgs(tokenId);
      });

      it("The caller is not approved", async function () {
        const rando = wallets[4];
        await expect(
          fermionFNFTProxy
            .connect(rando)
            .mintFractions(
              startTokenId,
              1,
              fractionsAmount,
              auctionParameters,
              custodianVaultParameters,
              additionalDeposit,
              ZeroAddress,
            ),
        )
          .to.be.revertedWithCustomError(fermionFNFTProxy, "ERC721InsufficientApproval")
          .withArgs(rando.address, startTokenId);
      });

      it("The token does not exist", async function () {
        const tokenId = startTokenId + quantity + 1n;
        await expect(
          fermionFNFTProxy
            .connect(seller)
            .mintFractions(
              tokenId,
              1,
              fractionsAmount,
              auctionParameters,
              custodianVaultParameters,
              additionalDeposit,
              ZeroAddress,
            ),
        )
          .to.be.revertedWithCustomError(fermionFNFTProxy, "ERC721NonexistentToken")
          .withArgs(tokenId);
      });
      it("ERC20 fraction clone is already initialised", async function () {
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

        const erc20Clone = await getERC20Clone(fermionFNFTProxy);
        await expect(
          erc20Clone.initialize("Fractions Name", "SYMBOL", wallets[0].address),
        ).to.be.revertedWithCustomError(erc20Clone, "InvalidInitialization");
      });
      it("ERC20 don't allow mint/burn via transferFractionsFrom", async function () {
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
        const erc20Clone = await getERC20Clone(fermionFNFTProxy);
        const fermionFNFTProxySigner = await impersonateAccount(await fermionFNFTProxy.getAddress());
        const arbitraryAddress = wallets[0].address;
        await expect(
          erc20Clone
            .connect(fermionFNFTProxySigner)
            .transferFractionsFrom(ZeroAddress, arbitraryAddress, fractionsAmount),
        ).to.be.revertedWithCustomError(erc20Clone, "ERC20InvalidSender");
        await expect(
          erc20Clone
            .connect(fermionFNFTProxySigner)
            .transferFractionsFrom(arbitraryAddress, ZeroAddress, fractionsAmount),
        ).to.be.revertedWithCustomError(erc20Clone, "ERC20InvalidReceiver");
      });
      it("Only FermionFNFTProxy can call transferFractionsFrom, mint and burn", async function () {
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

        const randomSigner = wallets[9];
        const erc20Clone = await getERC20Clone(fermionFNFTProxy);

        await expect(erc20Clone.connect(randomSigner).mint(randomSigner.address, fractionsAmount))
          .to.be.revertedWithCustomError(erc20Clone, "OwnableUnauthorizedAccount")
          .withArgs(randomSigner.address);

        await expect(erc20Clone.connect(randomSigner).burn(randomSigner.address, fractionsAmount))
          .to.be.revertedWithCustomError(erc20Clone, "OwnableUnauthorizedAccount")
          .withArgs(randomSigner.address);

        await expect(
          erc20Clone
            .connect(randomSigner)
            .transferFractionsFrom(randomSigner.address, randomSigner.address, fractionsAmount),
        )
          .to.be.revertedWithCustomError(erc20Clone, "OwnableUnauthorizedAccount")
          .withArgs(randomSigner.address);
      });
    });
  });

  context("mintFractions - subsequent fractionalisation", function () {
    const fractionsAmount = 5000n * 10n ** 18n;
    const auctionParameters = {
      exitPrice: parseEther("0.1"),
      duration: 60n * 60n * 24n * 7n, // 1 week
      unlockThreshold: 7500n, // 75%
      topBidLockTime: 60n * 60n * 24n * 2n, // two days
    };
    const startTokenId2 = startTokenId + 1n;
    const custodianFee = {
      amount: parseEther("0.05"),
      period: 30n * 24n * 60n * 60n, // 30 days
    };
    const custodianVaultParameters = {
      partialAuctionThreshold: custodianFee.amount * 15n,
      partialAuctionDuration: custodianFee.period / 2n,
      liquidationThreshold: custodianFee.amount * 2n,
      newFractionsPerAuction: fractionsAmount * 2n,
    };

    beforeEach(async function () {
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
    });

    it("The owner can fractionalise a single NFT", async function () {
      const tx = await fermionFNFTProxy.connect(seller).mintFractions(startTokenId2, 1, additionalDeposit);

      // lock the F-NFT (erc721 transfer)
      await expect(tx)
        .to.emit(fermionFNFTProxy, "Transfer")
        .withArgs(seller.address, await fermionFNFTProxy.getAddress(), startTokenId2);

      // mint fractions (erc20 mint)
      await expect(tx)
        .to.emit(await getERC20Clone(fermionFNFTProxy), "Transfer")
        .withArgs(ZeroAddress, seller.address, fractionsAmount);

      await expect(tx).to.not.emit(fermionFNFTProxy, "FractionsSetup");

      await expect(tx).to.emit(fermionFNFTProxy, "Fractionalised").withArgs(startTokenId2, fractionsAmount);

      // state
      expect(await fermionFNFTProxy.ownerOf(startTokenId2)).to.equal(await fermionFNFTProxy.getAddress());
      expect(await fermionFNFTProxy.tokenState(startTokenId2)).to.equal(TokenState.CheckedIn); // token state remains
      expect(await balanceOfERC20(fermionFNFTProxy, seller.address)).to.equal(2n * fractionsAmount);
      expect(await totalSupplyERC20(fermionFNFTProxy)).to.equal(2n * fractionsAmount);
      expect(await fermionFNFTProxy.liquidSupply()).to.equal(2n * fractionsAmount);
    });

    it("The owner can fractionalise multiple NFT", async function () {
      const quantity = 5n;
      const totalFractions = quantity * fractionsAmount;
      const tx = await fermionFNFTProxy.connect(seller).mintFractions(startTokenId2, quantity, additionalDeposit);

      // lock the F-NFT (erc721 transfer)
      for (let i = 0n; i < quantity; i++) {
        const tokenId = startTokenId2 + i;
        await expect(tx)
          .to.emit(fermionFNFTProxy, "Transfer")
          .withArgs(seller.address, await fermionFNFTProxy.getAddress(), tokenId);

        await expect(tx).to.emit(fermionFNFTProxy, "Fractionalised").withArgs(tokenId, fractionsAmount);
      }

      // mint fractions (erc20 mint)
      await expect(tx)
        .to.emit(await getERC20Clone(fermionFNFTProxy), "Transfer")
        .withArgs(ZeroAddress, seller.address, totalFractions);

      await expect(tx).to.not.emit(fermionFNFTProxy, "FractionsSetup");

      // state
      expect(await fermionFNFTProxy.ownerOf(startTokenId2)).to.equal(await fermionFNFTProxy.getAddress());
      expect(await fermionFNFTProxy.tokenState(startTokenId2)).to.equal(TokenState.CheckedIn); // token state remains
      expect(await balanceOfERC20(fermionFNFTProxy, seller.address)).to.equal(totalFractions + fractionsAmount);
      expect(await totalSupplyERC20(fermionFNFTProxy)).to.equal(totalFractions + fractionsAmount);
      expect(await fermionFNFTProxy.liquidSupply()).to.equal(totalFractions + fractionsAmount);
    });

    it("Protocol can forcefully fractionalise", async function () {
      const tx = await fermionFNFTProxy.attach(fermionMock).mintFractions(startTokenId2, 1, additionalDeposit);

      // lock the F-NFT (erc721 transfer)
      await expect(tx)
        .to.emit(fermionFNFTProxy, "Transfer")
        .withArgs(seller.address, await fermionFNFTProxy.getAddress(), startTokenId2);

      // mint fractions (erc20 mint)
      await expect(tx)
        .to.emit(await getERC20Clone(fermionFNFTProxy), "Transfer")
        .withArgs(ZeroAddress, seller.address, fractionsAmount);

      await expect(tx).to.not.emit(fermionFNFTProxy, "FractionsSetup");

      await expect(tx).to.emit(fermionFNFTProxy, "Fractionalised").withArgs(startTokenId2, fractionsAmount);

      // state
      expect(await fermionFNFTProxy.ownerOf(startTokenId2)).to.equal(await fermionFNFTProxy.getAddress());
      expect(await fermionFNFTProxy.tokenState(startTokenId2)).to.equal(TokenState.CheckedIn); // token state remains
      expect(await balanceOfERC20(fermionFNFTProxy, seller.address)).to.equal(2n * fractionsAmount);
      expect(await totalSupplyERC20(fermionFNFTProxy)).to.equal(2n * fractionsAmount);
      expect(await fermionFNFTProxy.liquidSupply()).to.equal(2n * fractionsAmount);
      expect(await fermionFNFTProxy.getBuyoutAuctionParameters(0)).to.eql(Object.values(auctionParameters));
    });

    it("The owner, different from initial fractionalizer can fractionalise a NFT", async function () {
      const buyer = wallets[4];
      await fermionFNFTProxy.connect(seller).transferFrom(seller.address, buyer.address, startTokenId2);

      const tx = await fermionFNFTProxy.connect(buyer).mintFractions(startTokenId2, 1, additionalDeposit);

      // lock the F-NFT (erc721 transfer)
      await expect(tx)
        .to.emit(fermionFNFTProxy, "Transfer")
        .withArgs(buyer.address, await fermionFNFTProxy.getAddress(), startTokenId2);

      // mint fractions (erc20 mint)
      await expect(tx)
        .to.emit(await getERC20Clone(fermionFNFTProxy), "Transfer")
        .withArgs(ZeroAddress, buyer.address, fractionsAmount);

      await expect(tx).to.not.emit(fermionFNFTProxy, "FractionsSetup");

      await expect(tx).to.emit(fermionFNFTProxy, "Fractionalised").withArgs(startTokenId2, fractionsAmount);

      // state
      expect(await fermionFNFTProxy.ownerOf(startTokenId2)).to.equal(await fermionFNFTProxy.getAddress());
      expect(await fermionFNFTProxy.tokenState(startTokenId2)).to.equal(TokenState.CheckedIn); // token state remains
      expect(await balanceOfERC20(fermionFNFTProxy, seller.address)).to.equal(fractionsAmount);
      expect(await balanceOfERC20(fermionFNFTProxy, buyer.address)).to.equal(fractionsAmount);
      expect(await totalSupplyERC20(fermionFNFTProxy)).to.equal(2n * fractionsAmount);
      expect(await fermionFNFTProxy.liquidSupply()).to.equal(2n * fractionsAmount);
    });

    context("Revert reasons", function () {
      it("Length is 0", async function () {
        await expect(
          fermionFNFTProxy.connect(seller).mintFractions(startTokenId2, 0, additionalDeposit),
        ).to.be.revertedWithCustomError(fermionFNFTProxy, "InvalidLength");
      });

      it("Missing Initial fractionalisation happened already", async function () {
        await loadFixture(setupFermionFractionsTest); // revert to initial state

        await expect(fermionFNFTProxy.mintFractions(startTokenId, 1, additionalDeposit)).to.be.revertedWithCustomError(
          fermionFNFTProxy,
          "MissingFractionalisation",
        );
      });

      it("The token is fractionalised already", async function () {
        // if fractionalised, the token is owned by the contract
        await expect(fermionFNFTProxy.connect(seller).mintFractions(startTokenId, 1, additionalDeposit))
          .to.be.revertedWithCustomError(fermionFNFTProxy, "ERC721InsufficientApproval")
          .withArgs(seller.address, startTokenId);
      });

      it("The token is not checked in", async function () {
        const tokenId = startTokenId + quantity - 1n;
        await expect(fermionFNFTProxy.connect(seller).mintFractions(tokenId, 1, additionalDeposit))
          .to.be.revertedWithCustomError(fermionFNFTProxy, "InvalidStateOrCaller")
          .withArgs(tokenId, seller.address, TokenState.Unverified);

        await fermionFNFTProxy.attach(fermionMock).pushToNextTokenState(tokenId, TokenState.Verified);

        await expect(fermionFNFTProxy.connect(seller).mintFractions(tokenId, 1, additionalDeposit))
          .to.be.revertedWithCustomError(fermionFNFTProxy, "InvalidStateOrCaller")
          .withArgs(tokenId, seller.address, TokenState.Verified);

        await fermionFNFTProxy.attach(fermionMock).pushToNextTokenState(tokenId, TokenState.CheckedIn);
        await fermionFNFTProxy.attach(fermionMock).pushToNextTokenState(tokenId, TokenState.CheckedOut); // checkout burns the token
        await expect(fermionFNFTProxy.connect(seller).mintFractions(tokenId, 1, additionalDeposit))
          .to.be.revertedWithCustomError(fermionFNFTProxy, "ERC721NonexistentToken")
          .withArgs(tokenId);
      });

      it("The caller is not approved", async function () {
        const rando = wallets[4];
        await expect(fermionFNFTProxy.connect(rando).mintFractions(startTokenId2, 1, additionalDeposit))
          .to.be.revertedWithCustomError(fermionFNFTProxy, "ERC721InsufficientApproval")
          .withArgs(rando.address, startTokenId2);
      });

      it("The token does not exist", async function () {
        const tokenId = startTokenId + quantity + 1n;
        await expect(fermionFNFTProxy.connect(seller).mintFractions(tokenId, 1, additionalDeposit))
          .to.be.revertedWithCustomError(fermionFNFTProxy, "ERC721NonexistentToken")
          .withArgs(tokenId);
      });
    });
  });

  context("mintAdditionalFractions", function () {
    const fractionsAmount = 5000n * 10n ** 18n;
    const auctionParameters = {
      exitPrice: parseEther("0.1"),
      duration: 60n * 60n * 24n * 7n, // 1 week
      unlockThreshold: 7500n, // 75%
      topBidLockTime: 60n * 60n * 24n * 2n, // two days
    };
    const custodianFee = {
      amount: parseEther("0.05"),
      period: 30n * 24n * 60n * 60n, // 30 days
    };
    const custodianVaultParameters = {
      partialAuctionThreshold: custodianFee.amount * 15n,
      partialAuctionDuration: custodianFee.period / 2n,
      liquidationThreshold: custodianFee.amount * 2n,
      newFractionsPerAuction: fractionsAmount * 2n,
    };

    beforeEach(async function () {
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
    });

    it("The fermion can mint additional fractions", async function () {
      const additionalAmount = fractionsAmount / 10n;
      const tx = await fermionFNFTProxy.attach(fermionMock).mintAdditionalFractions(additionalAmount);

      // lock the F-NFT (erc721 transfer)
      await expect(tx)
        .to.emit(fermionFNFTProxy, "AdditionalFractionsMinted")
        .withArgs(additionalAmount, additionalAmount + fractionsAmount);

      // mint fractions (erc20 mint)
      await expect(tx)
        .to.emit(await getERC20Clone(fermionFNFTProxy), "Transfer")
        .withArgs(ZeroAddress, await fermionMock.getAddress(), additionalAmount);

      // state
      expect(await balanceOfERC20(fermionFNFTProxy, await fermionMock.getAddress())).to.equal(additionalAmount);
      expect(await totalSupplyERC20(fermionFNFTProxy)).to.equal(fractionsAmount + additionalAmount);
      expect(await fermionFNFTProxy.liquidSupply()).to.equal(fractionsAmount + additionalAmount);
    });

    context("Revert reasons", function () {
      it("Caller is not the fermion", async function () {
        await expect(fermionFNFTProxy.connect(seller).mintAdditionalFractions(fractionsAmount))
          .to.be.revertedWithCustomError(fermionFNFTProxy, "AccessDenied")
          .withArgs(seller.address);
      });
    });
  });

  context("migrateFractions", function () {
    const fractionsAmount = 5000n * 10n ** 18n;
    const auctionParameters = {
      exitPrice: parseEther("0.1"),
      duration: 60n * 60n * 24n * 7n, // 1 week
      unlockThreshold: 7500n, // 75%
      topBidLockTime: 60n * 60n * 24n * 2n, // two days
    };
    const custodianFee = {
      amount: parseEther("0.05"),
      period: 30n * 24n * 60n * 60n, // 30 days
    };
    const custodianVaultParameters = {
      partialAuctionThreshold: custodianFee.amount * 15n,
      partialAuctionDuration: custodianFee.period / 2n,
      liquidationThreshold: custodianFee.amount * 2n,
      newFractionsPerAuction: fractionsAmount * 5n,
    };
    let accounts: string[];
    let balances: bigint[];

    beforeEach(async function () {
      // Mint fractions, but then manually delete the state to simulate v1.0.1 state
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

      const fermionFnftAddress = await fermionFNFTProxy.getAddress();
      const erc20FractionsAddress = await fermionFNFTProxy.getERC20CloneAddress(0);

      // delete the FermionFNFT state
      const fermionFractionSlotNumber = BigInt("0x4a7c305e00776741ac7013c3447ca536097b753ba0aa5e566dd79e90f6126200"); // keccak256(abi.encode(uint256(keccak256("fermion.fractions.storage")) - 1)) & ~bytes32(uint256(0xff))
      const epochToCloneSlot = BigInt(keccak256("0x" + fermionFractionSlotNumber.toString(16)));
      const currentEpochSlot = fermionFractionSlotNumber + 1n;

      await setStorageAt(fermionFnftAddress, fermionFractionSlotNumber, ZeroHash); // set epochToClone length to 0
      await setStorageAt(fermionFnftAddress, epochToCloneSlot, ZeroHash); // set first epoch to clone address to 0
      await setStorageAt(fermionFnftAddress, currentEpochSlot, ZeroHash); // set currentEpoch to 0

      // delete the ERC20 contract
      await ethers.provider.send("hardhat_setCode", [await erc20FractionsAddress, "0x"]);

      // set up the balances
      const erc20StorageSlotNumber = BigInt("0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00"); // keccak256(abi.encode(uint256(keccak256("openzeppelin.storage.ERC20")) - 1)) & ~bytes32(uint256(0xff))
      accounts = wallets.slice(3, 10).map((wallet) => wallet.address);
      accounts.push(await fermionFNFTProxy.getAddress());
      balances = [...Array(Number(accounts.length)).keys()].map((n) => parseEther((n + 1).toString()));

      for (let i = 0; i < accounts.length; i++) {
        const balanceSlot = BigInt(keccak256(toBeHex(accounts[i], 32) + erc20StorageSlotNumber.toString(16)));
        await setStorageAt(fermionFnftAddress, balanceSlot, toBeHex(balances[i].toString(), 32));
      }
    });

    it("Migrate all accounts", async function () {
      expect(await fermionFNFTProxy.getERC20CloneAddress(0)).to.equal(ZeroAddress);

      const tx = await fermionFNFTProxy.migrateFractions(accounts.slice(0, -1)); // do not pass in the fnft contract address
      const erc20CloneAddress = await fermionFNFTProxy.getERC20CloneAddress(0);
      const erc20Clone = await ethers.getContractAt("ERC20", erc20CloneAddress);

      for (let i = 0; i < accounts.length; i++) {
        await expect(tx).to.emit(fermionFNFTProxy, "FractionsMigrated").withArgs(accounts[i], balances[i]);

        expect(await erc20Clone.balanceOf(accounts[i])).to.equal(balances[i]);
      }
    });

    it("Migrating in multiple steps", async function () {
      await fermionFNFTProxy.migrateFractions(accounts.slice(0, 3));

      const accounts2 = accounts.slice(3, 7);
      const balances2 = balances.slice(3, 7);
      const tx = await fermionFNFTProxy.migrateFractions(accounts2);
      const erc20CloneAddress = await fermionFNFTProxy.getERC20CloneAddress(0);
      const erc20Clone = await ethers.getContractAt("ERC20", erc20CloneAddress);

      for (let i = 0; i < accounts2.length; i++) {
        await expect(tx).to.emit(fermionFNFTProxy, "FractionsMigrated").withArgs(accounts2[i], balances2[i]);

        expect(await erc20Clone.balanceOf(accounts2[i])).to.equal(balances2[i]);
      }
    });

    context("Revert reasons", function () {
      it("Address length is 0", async function () {
        await fermionFNFTProxy.migrateFractions([]); // make initial migration

        await expect(fermionFNFTProxy.migrateFractions([])).to.be.revertedWithCustomError(
          fermionFNFTProxy,
          "InvalidLength",
        );
      });

      it("Balance is 0", async function () {
        const randomAddress = wallets[10].address;
        await expect(fermionFNFTProxy.migrateFractions([randomAddress])).to.be.revertedWithCustomError(
          fermionFNFTProxy,
          "NoFractions",
        );
      });

      it("Migrated already", async function () {
        await fermionFNFTProxy.migrateFractions(accounts.slice(0, -1));

        await expect(fermionFNFTProxy.migrateFractions([accounts[2]]))
          .to.be.revertedWithCustomError(fermionFNFTProxy, "AlreadyMigrated")
          .withArgs(accounts[2]);
      });

      it("Cannot make another initial initialization", async function () {
        await expect(
          fermionFNFTProxy.mintFractions(
            startTokenId + 1n,
            1,
            fractionsAmount,
            auctionParameters,
            custodianVaultParameters,
            additionalDeposit,
            ZeroAddress,
          ),
        ).to.be.revertedWithCustomError(fermionFNFTProxy, "InitialFractionalisationOnly");
      });

      it("Cannot make new fractions until migration is complete", async function () {
        await expect(
          fermionFNFTProxy.connect(seller).mintFractions(startTokenId + 1n, 1, additionalDeposit),
        ).to.be.revertedWithPanic(0x32); // reverts because the migration is not complete

        await fermionFNFTProxy.migrateFractions(accounts.slice(0, -1));

        await expect(fermionFNFTProxy.connect(seller).mintFractions(startTokenId + 1n, 1, additionalDeposit)).to.emit(
          fermionFNFTProxy,
          "Fractionalised",
        );
      });
    });
  });

  context("bid", function () {
    const fractionsPerToken = 5000n * 10n ** 18n;
    const exitPrice = parseEther("0.1");
    const auctionParameters = {
      exitPrice: exitPrice,
      duration: 60n * 60n * 24n * 7n, // 1 week
      unlockThreshold: 7500n, // 75%
      topBidLockTime: 60n * 60n * 24n * 2n, // two days
    };
    const custodianFee = {
      amount: parseEther("0.05"),
      period: 30n * 24n * 60n * 60n, // 30 days
    };
    const custodianVaultParameters = {
      partialAuctionThreshold: custodianFee.amount * 15n,
      partialAuctionDuration: custodianFee.period / 2n,
      liquidationThreshold: custodianFee.amount * 2n,
      newFractionsPerAuction: fractionsPerToken,
    };

    beforeEach(async function () {
      await fermionFNFTProxy
        .connect(seller)
        .mintFractions(
          startTokenId,
          1,
          fractionsPerToken,
          auctionParameters,
          custodianVaultParameters,
          additionalDeposit,
          ZeroAddress,
        );

      await fermionFNFTProxyNativeEth
        .connect(seller)
        .mintFractions(
          startTokenIdNativeEth,
          1,
          fractionsPerToken,
          auctionParameters,
          custodianVaultParameters,
          additionalDeposit,
          ZeroAddress,
        );
    });

    context("Bid without fractions or votes", function () {
      const fractions = 0n;

      it("Bid over the exit price", async function () {
        const bidAmount = exitPrice + parseEther("0.1");
        await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);

        const tx = await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, bidAmount, fractions);

        await expect(tx)
          .to.emit(fermionFNFTProxy, "Bid")
          .withArgs(startTokenId, bidders[0].address, bidAmount, fractions, bidAmount);

        const blockTimeStamp = (await tx.getBlock()).timestamp;
        const auctionEnd = BigInt(blockTimeStamp) + auctionParameters.duration;
        await expect(tx).to.emit(fermionFNFTProxy, "AuctionStarted").withArgs(startTokenId, auctionEnd, 0);

        // state
        const expectedAuctionDetails = {
          timer: auctionEnd,
          maxBid: bidAmount,
          maxBidder: bidders[0].address,
          totalFractions: fractionsPerToken,
          lockedFractions: fractions,
          lockedBidAmount: bidAmount,
          state: BigInt(AuctionState.Ongoing),
        };

        expect(await fermionFNFTProxy.getAuctionDetails(startTokenId)).to.eql(Object.values(expectedAuctionDetails));
        expect(await mockExchangeToken.balanceOf(bidders[0].address)).to.equal(parseEther("1000") - bidAmount);
        expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(bidAmount);
      });

      it("Bid matches the exit price", async function () {
        const bidAmount = exitPrice;
        await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);

        const tx = await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, bidAmount, fractions);

        await expect(tx)
          .to.emit(fermionFNFTProxy, "Bid")
          .withArgs(startTokenId, bidders[0].address, bidAmount, fractions, bidAmount);

        const blockTimeStamp = (await tx.getBlock()).timestamp;
        const auctionEnd = BigInt(blockTimeStamp) + auctionParameters.duration;
        await expect(tx).to.emit(fermionFNFTProxy, "AuctionStarted").withArgs(startTokenId, auctionEnd, 0);

        // state
        const expectedAuctionDetails = {
          timer: auctionEnd,
          maxBid: bidAmount,
          maxBidder: bidders[0].address,
          totalFractions: fractionsPerToken,
          lockedFractions: fractions,
          lockedBidAmount: bidAmount,
          state: BigInt(AuctionState.Ongoing),
        };

        expect(await fermionFNFTProxy.getAuctionDetails(startTokenId)).to.eql(Object.values(expectedAuctionDetails));
        expect(await mockExchangeToken.balanceOf(bidders[0].address)).to.equal(parseEther("1000") - bidAmount);
        expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(bidAmount);
      });

      it("Bid under the exit price", async function () {
        const bidAmount = exitPrice - parseEther("0.05");
        await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);

        const tx = await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, bidAmount, fractions);

        await expect(tx)
          .to.emit(fermionFNFTProxy, "Bid")
          .withArgs(startTokenId, bidders[0].address, bidAmount, fractions, bidAmount);
        await expect(tx).to.not.emit(fermionFNFTProxy, "AuctionStarted");

        const blockTimeStamp = (await tx.getBlock()).timestamp;
        const topBidLockTime = BigInt(blockTimeStamp) + auctionParameters.topBidLockTime;

        // state
        const expectedAuctionDetails = {
          timer: topBidLockTime,
          maxBid: bidAmount,
          maxBidder: bidders[0].address,
          totalFractions: 0n,
          lockedFractions: fractions,
          lockedBidAmount: bidAmount,
          state: BigInt(AuctionState.NotStarted),
        };

        expect(await fermionFNFTProxy.getAuctionDetails(startTokenId)).to.eql(Object.values(expectedAuctionDetails));
        expect(await mockExchangeToken.balanceOf(bidders[0].address)).to.equal(parseEther("1000") - bidAmount);
        expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(bidAmount);
      });

      it("When outbid, the locked amounts are released to previous bidder", async function () {
        const bidAmount = exitPrice + parseEther("0.1");
        await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);

        await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, bidAmount, fractions);

        const bidAmount2 = bidAmount + parseEther("0.1");
        await mockExchangeToken.connect(bidders[1]).approve(await fermionFNFTProxy.getAddress(), bidAmount2);

        const tx = await fermionFNFTProxy.connect(bidders[1]).bid(startTokenId, bidAmount2, fractions);

        await expect(tx)
          .to.emit(mockExchangeToken, "Transfer")
          .withArgs(await fermionFNFTProxy.getAddress(), bidders[0].address, bidAmount);

        expect(await mockExchangeToken.balanceOf(bidders[0].address)).to.equal(parseEther("1000"));
        expect(await mockExchangeToken.balanceOf(bidders[1].address)).to.equal(parseEther("1000") - bidAmount2);
        expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(bidAmount2);

        // outbidding self
        const bidAmount3 = bidAmount2 + parseEther("0.1");
        await mockExchangeToken.connect(bidders[1]).approve(await fermionFNFTProxy.getAddress(), bidAmount3);

        const tx2 = await fermionFNFTProxy.connect(bidders[1]).bid(startTokenId, bidAmount3, fractions);
        await expect(tx2)
          .to.emit(mockExchangeToken, "Transfer")
          .withArgs(await fermionFNFTProxy.getAddress(), bidders[1].address, bidAmount2);

        expect(await mockExchangeToken.balanceOf(bidders[1].address)).to.equal(parseEther("1000") - bidAmount3);
        expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(bidAmount3);
      });

      it("When outbid with native ETH, the locked ETH is stored for claim", async function () {
        const bidAmount = parseEther("1.0");
        const bidAmount2 = parseEther("1.1");

        // First bid
        await fermionFNFTProxyNativeEth
          .connect(bidders[0])
          .bid(startTokenIdNativeEth, bidAmount, fractions, { value: bidAmount, gasPrice: 0 }); // gasPrice is explicitly set to 0 to pass the coverage test

        // Second bidder outbids
        await fermionFNFTProxyNativeEth
          .connect(bidders[1])
          .bid(startTokenIdNativeEth, bidAmount2, fractions, { value: bidAmount2, gasPrice: 0 });

        // Verify native ETH was stored for claim
        expect(await fermionFNFTProxyNativeEth.getNativeBidClaimAmount(bidders[0].address)).to.equal(bidAmount);

        // Verify balances before claiming
        expect(await ethers.provider.getBalance(bidders[0].address)).to.equal(parseEther("10000") - bidAmount);
        expect(await ethers.provider.getBalance(bidders[1].address)).to.equal(parseEther("10000") - bidAmount2);
        expect(await ethers.provider.getBalance(await fermionFNFTProxyNativeEth.getAddress())).to.equal(
          bidAmount + bidAmount2,
        );

        // Claim the stored native ETH
        const claimTx = await fermionFNFTProxyNativeEth.connect(bidders[0]).claimNativeBidFunds({ gasPrice: 0 });
        await expect(claimTx).to.changeEtherBalance(bidders[0], bidAmount);

        // Verify claimable amount is cleared after claiming
        expect(await fermionFNFTProxyNativeEth.getNativeBidClaimAmount(bidders[0].address)).to.equal(0);

        // Verify final balances
        expect(await ethers.provider.getBalance(bidders[0].address)).to.equal(parseEther("10000"));
        expect(await ethers.provider.getBalance(bidders[1].address)).to.equal(parseEther("10000") - bidAmount2);
        expect(await ethers.provider.getBalance(await fermionFNFTProxyNativeEth.getAddress())).to.equal(bidAmount2);
      });

      it("Bidding before the buffer time does not extend the timer", async function () {
        const bidAmount = exitPrice + parseEther("0.1");
        await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);

        const tx = await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, bidAmount, fractions);

        const blockTimeStamp = (await tx.getBlock()).timestamp;
        const auctionEnd = BigInt(blockTimeStamp) + auctionParameters.duration;

        const auctionDetails = await fermionFNFTProxy.getAuctionDetails(startTokenId);
        await expect(auctionDetails.timer).to.equal(auctionEnd);

        const bidAmount2 = bidAmount + parseEther("0.1");
        await mockExchangeToken.connect(bidders[1]).approve(await fermionFNFTProxy.getAddress(), bidAmount2);

        const tx2 = await fermionFNFTProxy.connect(bidders[1]).bid(startTokenId, bidAmount2, fractions);
        await expect(tx2).to.not.emit(fermionFNFTProxy, "AuctionStarted");

        const auctionDetails2 = await fermionFNFTProxy.getAuctionDetails(startTokenId);
        await expect(auctionDetails2.timer).to.equal(auctionEnd);
      });
    });

    context("Bid with fractions", function () {
      const fractions = (fractionsPerToken * 20n) / 100n; // 20% of bid paid with fractions

      beforeEach(async function () {
        const erc20Clone = await getERC20Clone(fermionFNFTProxy);
        await erc20Clone.connect(seller).transfer(bidders[0].address, fractions);
      });

      it("Bid over the exit price", async function () {
        const price = exitPrice + parseEther("0.1");
        const bidAmount = ((fractionsPerToken - fractions) * price) / fractionsPerToken; // amount to pay
        await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);

        const tx = await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, price, fractions);

        await expect(tx)
          .to.emit(fermionFNFTProxy, "Bid")
          .withArgs(startTokenId, bidders[0].address, price, fractions, bidAmount);

        const blockTimeStamp = (await tx.getBlock()).timestamp;
        const auctionEnd = BigInt(blockTimeStamp) + auctionParameters.duration;
        await expect(tx).to.emit(fermionFNFTProxy, "AuctionStarted").withArgs(startTokenId, auctionEnd, 0);

        // state
        const expectedAuctionDetails = {
          timer: auctionEnd,
          maxBid: price,
          maxBidder: bidders[0].address,
          totalFractions: fractionsPerToken,
          lockedFractions: fractions,
          lockedBidAmount: bidAmount,
          state: BigInt(AuctionState.Ongoing),
        };

        expect(await fermionFNFTProxy.getAuctionDetails(startTokenId)).to.eql(Object.values(expectedAuctionDetails));
        expect(await mockExchangeToken.balanceOf(bidders[0].address)).to.equal(parseEther("1000") - bidAmount);
        expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(bidAmount);
        expect(await balanceOfERC20(fermionFNFTProxy, bidders[0].address)).to.equal(0n); // all fractions used
        expect(await balanceOfERC20(fermionFNFTProxy, await fermionFNFTProxy.getAddress())).to.equal(fractions);
      });

      it("Bid under the exit price", async function () {
        const price = exitPrice - parseEther("0.05");
        const bidAmount = ((fractionsPerToken - fractions) * price) / fractionsPerToken; // amount to pay

        await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);

        const tx = await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, price, fractions);

        await expect(tx)
          .to.emit(fermionFNFTProxy, "Bid")
          .withArgs(startTokenId, bidders[0].address, price, fractions, bidAmount);
        await expect(tx).to.not.emit(fermionFNFTProxy, "AuctionStarted");

        const blockTimeStamp = (await tx.getBlock()).timestamp;
        const topBidLockTime = BigInt(blockTimeStamp) + auctionParameters.topBidLockTime;

        // state
        const expectedAuctionDetails = {
          timer: topBidLockTime,
          maxBid: price,
          maxBidder: bidders[0].address,
          totalFractions: 0n,
          lockedFractions: fractions,
          lockedBidAmount: bidAmount,
          state: BigInt(AuctionState.NotStarted),
        };

        expect(await fermionFNFTProxy.getAuctionDetails(startTokenId)).to.eql(Object.values(expectedAuctionDetails));
        expect(await mockExchangeToken.balanceOf(bidders[0].address)).to.equal(parseEther("1000") - bidAmount);
        expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(bidAmount);
        expect(await balanceOfERC20(fermionFNFTProxy, bidders[0].address)).to.equal(0n); // all fractions used
        expect(await balanceOfERC20(fermionFNFTProxy, await fermionFNFTProxy.getAddress())).to.equal(fractions);
      });

      it("When outbid, the locked amounts are released to previous bidder", async function () {
        const price = exitPrice + parseEther("0.1");
        const bidAmount = ((fractionsPerToken - fractions) * price) / fractionsPerToken; // amount to pay
        await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);

        await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, price, fractions);

        // outbidding with fractions
        const price2 = price + parseEther("0.1");
        const fractions2 = (fractionsPerToken * 30n) / 100n; // 30% of bid paid with fractions
        const erc20Clone = await getERC20Clone(fermionFNFTProxy);
        await erc20Clone.connect(seller).transfer(bidders[1].address, fractions2);

        const bidAmount2 = ((fractionsPerToken - fractions2) * price2) / fractionsPerToken; // amount to pay
        await mockExchangeToken.connect(bidders[1]).approve(await fermionFNFTProxy.getAddress(), bidAmount2);
        const tx = await fermionFNFTProxy.connect(bidders[1]).bid(startTokenId, price2, fractions2);
        await expect(tx)
          .to.emit(mockExchangeToken, "Transfer")
          .withArgs(await fermionFNFTProxy.getAddress(), bidders[0].address, bidAmount);
        await expect(tx)
          .to.emit(erc20Clone, "Transfer")
          .withArgs(await fermionFNFTProxy.getAddress(), bidders[0].address, fractions);

        expect(await mockExchangeToken.balanceOf(bidders[0].address)).to.equal(parseEther("1000"));
        expect(await mockExchangeToken.balanceOf(bidders[1].address)).to.equal(parseEther("1000") - bidAmount2);
        expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(bidAmount2);
        expect(await balanceOfERC20(fermionFNFTProxy, bidders[0].address)).to.equal(fractions);
        expect(await balanceOfERC20(fermionFNFTProxy, await fermionFNFTProxy.getAddress())).to.equal(fractions2);

        // outbidding without fractions
        const bidAmount3 = price2 + parseEther("0.1");
        await mockExchangeToken.connect(bidders[2]).approve(await fermionFNFTProxy.getAddress(), bidAmount3);

        const tx2 = await fermionFNFTProxy.connect(bidders[2]).bid(startTokenId, bidAmount3, 0n);
        await expect(tx2)
          .to.emit(mockExchangeToken, "Transfer")
          .withArgs(await fermionFNFTProxy.getAddress(), bidders[1].address, bidAmount2);
        await expect(tx2)
          .to.emit(erc20Clone, "Transfer")
          .withArgs(await fermionFNFTProxy.getAddress(), bidders[1].address, fractions2);

        expect(await mockExchangeToken.balanceOf(bidders[1].address)).to.equal(parseEther("1000"));
        expect(await mockExchangeToken.balanceOf(bidders[2].address)).to.equal(parseEther("1000") - bidAmount3);
        expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(bidAmount3);
        expect(await balanceOfERC20(fermionFNFTProxy, bidders[1].address)).to.equal(fractions2);
        expect(await balanceOfERC20(fermionFNFTProxy, await fermionFNFTProxy.getAddress())).to.equal(0n); // all fractions returned
      });

      it("Do not use all fractions", async function () {
        const price = exitPrice + parseEther("0.1");
        const fractionsPart = (fractions * 80n) / 100n; // 80% of user's fractions
        const bidAmount = ((fractionsPerToken - fractionsPart) * price) / fractionsPerToken; // amount to pay
        await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);

        const tx = await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, price, fractionsPart);

        await expect(tx)
          .to.emit(fermionFNFTProxy, "Bid")
          .withArgs(startTokenId, bidders[0].address, price, fractionsPart, bidAmount);

        const blockTimeStamp = (await tx.getBlock()).timestamp;
        const auctionEnd = BigInt(blockTimeStamp) + auctionParameters.duration;
        await expect(tx).to.emit(fermionFNFTProxy, "AuctionStarted").withArgs(startTokenId, auctionEnd, 0);

        // state
        const expectedAuctionDetails = {
          timer: auctionEnd,
          maxBid: price,
          maxBidder: bidders[0].address,
          totalFractions: fractionsPerToken,
          lockedFractions: fractionsPart,
          lockedBidAmount: bidAmount,
          state: BigInt(AuctionState.Ongoing),
        };

        expect(await fermionFNFTProxy.getAuctionDetails(startTokenId)).to.eql(Object.values(expectedAuctionDetails));
        expect(await mockExchangeToken.balanceOf(bidders[0].address)).to.equal(parseEther("1000") - bidAmount);
        expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(bidAmount);
        expect(await balanceOfERC20(fermionFNFTProxy, bidders[0].address)).to.equal(fractions - fractionsPart); // all fractions used
        expect(await balanceOfERC20(fermionFNFTProxy, await fermionFNFTProxy.getAddress())).to.equal(fractionsPart);
      });

      it("Provide more than 100%", async function () {
        // fractionalise another token and transfer the fractions to the bidder
        await fermionFNFTProxy.connect(seller).mintFractions(startTokenId + 1n, 1, additionalDeposit);
        const erc20Clone = await getERC20Clone(fermionFNFTProxy);
        await erc20Clone.connect(seller).transfer(bidders[0].address, fractionsPerToken);

        const price = exitPrice + parseEther("0.1");
        const fractionsPart = fractions + fractionsPerToken; // more than 1 token
        const bidAmount = 0n; // amount to pay

        const tx = await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, price, fractionsPart);

        await expect(tx)
          .to.emit(fermionFNFTProxy, "Bid")
          .withArgs(startTokenId, bidders[0].address, price, fractionsPerToken, bidAmount);

        const blockTimeStamp = (await tx.getBlock()).timestamp;
        const auctionEnd = BigInt(blockTimeStamp) + auctionParameters.duration;
        await expect(tx).to.emit(fermionFNFTProxy, "AuctionStarted").withArgs(startTokenId, auctionEnd, 0);

        // state
        const expectedAuctionDetails = {
          timer: auctionEnd,
          maxBid: price,
          maxBidder: bidders[0].address,
          totalFractions: fractionsPerToken,
          lockedFractions: fractionsPerToken,
          lockedBidAmount: bidAmount,
          state: BigInt(AuctionState.Reserved),
        };

        expect(await fermionFNFTProxy.getAuctionDetails(startTokenId)).to.eql(Object.values(expectedAuctionDetails));
        expect(await mockExchangeToken.balanceOf(bidders[0].address)).to.equal(parseEther("1000") - bidAmount);
        expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(bidAmount);
        expect(await balanceOfERC20(fermionFNFTProxy, bidders[0].address)).to.equal(fractions); // fractions for 1 token used, remainder fractionsPart-fractionsPerToken=fractions
        expect(await balanceOfERC20(fermionFNFTProxy, await fermionFNFTProxy.getAddress())).to.equal(fractionsPerToken);
      });
    });

    context("Bid with votes", function () {
      const fractions = 0n;
      const votes = (fractionsPerToken * 30n) / 100n; // 30% of bid paid with locked votes

      beforeEach(async function () {
        const erc20Clone = await getERC20Clone(fermionFNFTProxy);
        await erc20Clone.connect(seller).transfer(bidders[0].address, votes);

        // bidder 0 votes to start the auction
        await fermionFNFTProxy.connect(bidders[0]).voteToStartAuction(startTokenId, votes);
      });

      it("Bid over the exit price", async function () {
        const price = exitPrice + parseEther("0.1");
        const bidAmount = ((fractionsPerToken - votes) * price) / fractionsPerToken; // amount to pay
        await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);

        const tx = await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, price, fractions);

        await expect(tx)
          .to.emit(fermionFNFTProxy, "Bid")
          .withArgs(startTokenId, bidders[0].address, price, votes, bidAmount);

        const blockTimeStamp = (await tx.getBlock()).timestamp;
        const auctionEnd = BigInt(blockTimeStamp) + auctionParameters.duration;
        await expect(tx).to.emit(fermionFNFTProxy, "AuctionStarted").withArgs(startTokenId, auctionEnd, 0);

        // state
        const expectedAuctionDetails = {
          timer: auctionEnd,
          maxBid: price,
          maxBidder: bidders[0].address,
          totalFractions: fractionsPerToken,
          lockedFractions: 0n, // locked fractions do not include votes
          lockedBidAmount: bidAmount,
          state: BigInt(AuctionState.Ongoing),
        };

        expect(await fermionFNFTProxy.getAuctionDetails(startTokenId)).to.eql(Object.values(expectedAuctionDetails));
        expect(await mockExchangeToken.balanceOf(bidders[0].address)).to.equal(parseEther("1000") - bidAmount);
        expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(bidAmount);
        expect(await balanceOfERC20(fermionFNFTProxy, bidders[0].address)).to.equal(0n);
        expect(await balanceOfERC20(fermionFNFTProxy, await fermionFNFTProxy.getAddress())).to.equal(votes);
      });

      it("Bid under the exit price", async function () {
        const price = exitPrice - parseEther("0.01");
        const bidAmount = ((fractionsPerToken - votes) * price) / fractionsPerToken; // amount to pay

        await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);

        const tx = await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, price, fractions);

        await expect(tx)
          .to.emit(fermionFNFTProxy, "Bid")
          .withArgs(startTokenId, bidders[0].address, price, votes, bidAmount);
        await expect(tx).to.not.emit(fermionFNFTProxy, "AuctionStarted");

        const blockTimeStamp = (await tx.getBlock()).timestamp;
        const topBidLockTime = BigInt(blockTimeStamp) + auctionParameters.topBidLockTime;

        // state
        const expectedAuctionDetails = {
          timer: topBidLockTime,
          maxBid: price,
          maxBidder: bidders[0].address,
          totalFractions: 0n,
          lockedFractions: 0n, // locked fractions do not include votes
          lockedBidAmount: bidAmount,
          state: BigInt(AuctionState.NotStarted),
        };

        expect(await fermionFNFTProxy.getAuctionDetails(startTokenId)).to.eql(Object.values(expectedAuctionDetails));
        expect(await mockExchangeToken.balanceOf(bidders[0].address)).to.equal(parseEther("1000") - bidAmount);
        expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(bidAmount);
        expect(await balanceOfERC20(fermionFNFTProxy, bidders[0].address)).to.equal(0n);
        expect(await balanceOfERC20(fermionFNFTProxy, await fermionFNFTProxy.getAddress())).to.equal(votes);
      });

      it("When outbid, the locked amounts are released to previous bidder", async function () {
        const price = exitPrice - parseEther("0.01"); // to not start the auction
        const bidAmount = ((fractionsPerToken - votes) * price) / fractionsPerToken; // amount to pay
        await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);

        await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, price, fractions);

        // outbidding with votes
        const price2 = price + parseEther("0.1");
        const fractions2 = 0n;
        const votes2 = (fractionsPerToken * 25n) / 100n; // 25% of bid paid with fractions
        const erc20Clone = await getERC20Clone(fermionFNFTProxy);
        await erc20Clone.connect(seller).transfer(bidders[1].address, votes2);
        await fermionFNFTProxy.connect(bidders[1]).voteToStartAuction(startTokenId, votes2);
        const bidAmount2 = ((fractionsPerToken - votes2) * price2) / fractionsPerToken; // amount to pay
        await mockExchangeToken.connect(bidders[1]).approve(await fermionFNFTProxy.getAddress(), bidAmount2);

        const tx = await fermionFNFTProxy.connect(bidders[1]).bid(startTokenId, price2, fractions2);

        await expect(tx)
          .to.emit(mockExchangeToken, "Transfer")
          .withArgs(await fermionFNFTProxy.getAddress(), bidders[0].address, bidAmount);

        expect(await mockExchangeToken.balanceOf(bidders[0].address)).to.equal(parseEther("1000"));
        expect(await mockExchangeToken.balanceOf(bidders[1].address)).to.equal(parseEther("1000") - bidAmount2);
        expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(bidAmount2);
        expect(await balanceOfERC20(fermionFNFTProxy, bidders[0].address)).to.equal(0n); // locked votes are not returned
        expect(await balanceOfERC20(fermionFNFTProxy, await fermionFNFTProxy.getAddress())).to.equal(votes + votes2); // locked votes are not returned

        // outbidding without votes
        const bidAmount3 = price2 + parseEther("0.1");
        await mockExchangeToken.connect(bidders[2]).approve(await fermionFNFTProxy.getAddress(), bidAmount3);

        const tx2 = await fermionFNFTProxy.connect(bidders[2]).bid(startTokenId, bidAmount3, 0n);
        await expect(tx2)
          .to.emit(mockExchangeToken, "Transfer")
          .withArgs(await fermionFNFTProxy.getAddress(), bidders[1].address, bidAmount2);

        expect(await mockExchangeToken.balanceOf(bidders[1].address)).to.equal(parseEther("1000"));
        expect(await mockExchangeToken.balanceOf(bidders[2].address)).to.equal(parseEther("1000") - bidAmount3);
        expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(bidAmount3);
        expect(await balanceOfERC20(fermionFNFTProxy, bidders[1].address)).to.equal(fractions2);
        expect(await balanceOfERC20(fermionFNFTProxy, await fermionFNFTProxy.getAddress())).to.equal(votes + votes2); // locked votes are not returned
      });
    });

    context("Bid with votes and fractions", function () {
      const fractions = (fractionsPerToken * 20n) / 100n; // 20% of bid paid with fractions
      const votes = (fractionsPerToken * 30n) / 100n; // 30% of bid paid with locked votes

      beforeEach(async function () {
        const erc20Clone = await getERC20Clone(fermionFNFTProxy);
        await erc20Clone.connect(seller).transfer(bidders[0].address, fractions + votes);

        // bidder 0 votes to start the auction
        await fermionFNFTProxy.connect(bidders[0]).voteToStartAuction(startTokenId, votes);
      });

      it("Bid over the exit price", async function () {
        const price = exitPrice + parseEther("0.1");
        const bidAmount = ((fractionsPerToken - fractions - votes) * price) / fractionsPerToken; // amount to pay
        await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);

        const tx = await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, price, fractions);

        await expect(tx)
          .to.emit(fermionFNFTProxy, "Bid")
          .withArgs(startTokenId, bidders[0].address, price, fractions + votes, bidAmount);

        const blockTimeStamp = (await tx.getBlock()).timestamp;
        const auctionEnd = BigInt(blockTimeStamp) + auctionParameters.duration;
        await expect(tx).to.emit(fermionFNFTProxy, "AuctionStarted").withArgs(startTokenId, auctionEnd, 0);

        // state
        const expectedAuctionDetails = {
          timer: auctionEnd,
          maxBid: price,
          maxBidder: bidders[0].address,
          totalFractions: fractionsPerToken,
          lockedFractions: fractions, // locked fractions do not include votes
          lockedBidAmount: bidAmount,
          state: BigInt(AuctionState.Ongoing),
        };

        expect(await fermionFNFTProxy.getAuctionDetails(startTokenId)).to.eql(Object.values(expectedAuctionDetails));
        expect(await mockExchangeToken.balanceOf(bidders[0].address)).to.equal(parseEther("1000") - bidAmount);
        expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(bidAmount);
        expect(await balanceOfERC20(fermionFNFTProxy, bidders[0].address)).to.equal(0n); // all fractions used
        expect(await balanceOfERC20(fermionFNFTProxy, await fermionFNFTProxy.getAddress())).to.equal(fractions + votes);
      });

      it("Bid under the exit price", async function () {
        const price = exitPrice - parseEther("0.01");
        const bidAmount = ((fractionsPerToken - fractions - votes) * price) / fractionsPerToken; // amount to pay

        await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);

        const tx = await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, price, fractions);

        await expect(tx)
          .to.emit(fermionFNFTProxy, "Bid")
          .withArgs(startTokenId, bidders[0].address, price, fractions + votes, bidAmount);
        await expect(tx).to.not.emit(fermionFNFTProxy, "AuctionStarted");

        const blockTimeStamp = (await tx.getBlock()).timestamp;
        const topBidLockTime = BigInt(blockTimeStamp) + auctionParameters.topBidLockTime;

        // state
        const expectedAuctionDetails = {
          timer: topBidLockTime,
          maxBid: price,
          maxBidder: bidders[0].address,
          totalFractions: 0n,
          lockedFractions: fractions, // locked fractions do not include votes
          lockedBidAmount: bidAmount,
          state: BigInt(AuctionState.NotStarted),
        };

        expect(await fermionFNFTProxy.getAuctionDetails(startTokenId)).to.eql(Object.values(expectedAuctionDetails));
        expect(await mockExchangeToken.balanceOf(bidders[0].address)).to.equal(parseEther("1000") - bidAmount);
        expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(bidAmount);
        expect(await balanceOfERC20(fermionFNFTProxy, bidders[0].address)).to.equal(0n); // all fractions used
        expect(await balanceOfERC20(fermionFNFTProxy, await fermionFNFTProxy.getAddress())).to.equal(fractions + votes);
      });

      it("When outbid, the locked amounts are released to previous bidder", async function () {
        const price = exitPrice - parseEther("0.01"); // to not start the auction
        const bidAmount = ((fractionsPerToken - fractions - votes) * price) / fractionsPerToken; // amount to pay
        await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);

        await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, price, fractions);

        // outbidding with fractions and votes
        const price2 = price + parseEther("0.1");
        const fractions2 = (fractionsPerToken * 10n) / 100n; // 10% of bid paid with fractions
        const votes2 = (fractionsPerToken * 15n) / 100n; // 15% of bid paid with fractions
        const erc20Clone = await getERC20Clone(fermionFNFTProxy);
        await erc20Clone.connect(seller).transfer(bidders[1].address, fractions2 + votes2);
        await fermionFNFTProxy.connect(bidders[1]).voteToStartAuction(startTokenId, votes2);
        const bidAmount2 = ((fractionsPerToken - fractions2 - votes2) * price2) / fractionsPerToken; // amount to pay
        await mockExchangeToken.connect(bidders[1]).approve(await fermionFNFTProxy.getAddress(), bidAmount2);

        const tx = await fermionFNFTProxy.connect(bidders[1]).bid(startTokenId, price2, fractions2);

        await expect(tx)
          .to.emit(mockExchangeToken, "Transfer")
          .withArgs(await fermionFNFTProxy.getAddress(), bidders[0].address, bidAmount);

        await expect(tx)
          .to.emit(erc20Clone, "Transfer")
          .withArgs(await fermionFNFTProxy.getAddress(), bidders[0].address, fractions);

        expect(await mockExchangeToken.balanceOf(bidders[0].address)).to.equal(parseEther("1000"));
        expect(await mockExchangeToken.balanceOf(bidders[1].address)).to.equal(parseEther("1000") - bidAmount2);
        expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(bidAmount2);
        expect(await balanceOfERC20(fermionFNFTProxy, bidders[0].address)).to.equal(fractions); // only fractions are returned, votes not
        expect(await balanceOfERC20(fermionFNFTProxy, await fermionFNFTProxy.getAddress())).to.equal(
          fractions2 + votes2 + votes,
        );

        // outbidding without fractions
        const bidAmount3 = price2 + parseEther("0.1");
        await mockExchangeToken.connect(bidders[2]).approve(await fermionFNFTProxy.getAddress(), bidAmount3);

        const tx2 = await fermionFNFTProxy.connect(bidders[2]).bid(startTokenId, bidAmount3, 0n);
        await expect(tx2)
          .to.emit(mockExchangeToken, "Transfer")
          .withArgs(await fermionFNFTProxy.getAddress(), bidders[1].address, bidAmount2);
        await expect(tx2)
          .to.emit(erc20Clone, "Transfer")
          .withArgs(await fermionFNFTProxy.getAddress(), bidders[1].address, fractions2);

        expect(await mockExchangeToken.balanceOf(bidders[1].address)).to.equal(parseEther("1000"));
        expect(await mockExchangeToken.balanceOf(bidders[2].address)).to.equal(parseEther("1000") - bidAmount3);
        expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(bidAmount3);
        expect(await balanceOfERC20(fermionFNFTProxy, bidders[1].address)).to.equal(fractions2); // only fractions are returned, votes not
        expect(await balanceOfERC20(fermionFNFTProxy, await fermionFNFTProxy.getAddress())).to.equal(votes + votes2); // all fractions returned
      });

      it("Do not use all fractions", async function () {
        const price = exitPrice + parseEther("0.1");
        const fractionsPart = (fractions * 80n) / 100n; // 80% of user's fractions
        const bidAmount = ((fractionsPerToken - fractionsPart - votes) * price) / fractionsPerToken; // amount to pay
        await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);

        const tx = await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, price, fractionsPart);

        await expect(tx)
          .to.emit(fermionFNFTProxy, "Bid")
          .withArgs(startTokenId, bidders[0].address, price, fractionsPart + votes, bidAmount);

        const blockTimeStamp = (await tx.getBlock()).timestamp;
        const auctionEnd = BigInt(blockTimeStamp) + auctionParameters.duration;
        await expect(tx).to.emit(fermionFNFTProxy, "AuctionStarted").withArgs(startTokenId, auctionEnd, 0);

        // state
        const expectedAuctionDetails = {
          timer: auctionEnd,
          maxBid: price,
          maxBidder: bidders[0].address,
          totalFractions: fractionsPerToken,
          lockedFractions: fractionsPart, // locked fractions do not include votes
          lockedBidAmount: bidAmount,
          state: BigInt(AuctionState.Ongoing),
        };

        expect(await fermionFNFTProxy.getAuctionDetails(startTokenId)).to.eql(Object.values(expectedAuctionDetails));
        expect(await mockExchangeToken.balanceOf(bidders[0].address)).to.equal(parseEther("1000") - bidAmount);
        expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(bidAmount);
        expect(await balanceOfERC20(fermionFNFTProxy, bidders[0].address)).to.equal(fractions - fractionsPart); // all fractions used
        expect(await balanceOfERC20(fermionFNFTProxy, await fermionFNFTProxy.getAddress())).to.equal(
          fractionsPart + votes,
        );
      });

      it("Provide more than 100%", async function () {
        // fractionalise another token and transfer the fractions to the bidder
        const erc20Clone = await getERC20Clone(fermionFNFTProxy);
        await fermionFNFTProxy.connect(seller).mintFractions(startTokenId + 1n, 1, additionalDeposit);
        await erc20Clone.connect(seller).transfer(bidders[0].address, fractionsPerToken);

        const price = exitPrice + parseEther("0.1");
        const fractionsPart = fractions + fractionsPerToken; // more than 1 token
        const bidAmount = 0n; // amount to pay
        await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);

        const tx = await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, price, fractionsPart);

        await expect(tx)
          .to.emit(fermionFNFTProxy, "Bid")
          .withArgs(startTokenId, bidders[0].address, price, fractionsPerToken, bidAmount);

        const blockTimeStamp = (await tx.getBlock()).timestamp;
        const auctionEnd = BigInt(blockTimeStamp) + auctionParameters.duration;
        await expect(tx).to.emit(fermionFNFTProxy, "AuctionStarted").withArgs(startTokenId, auctionEnd, 0);

        // state
        const expectedAuctionDetails = {
          timer: auctionEnd,
          maxBid: price,
          maxBidder: bidders[0].address,
          totalFractions: fractionsPerToken,
          lockedFractions: fractionsPerToken - votes, // locked fractions do not include votes
          lockedBidAmount: bidAmount,
          state: BigInt(AuctionState.Reserved),
        };

        expect(await fermionFNFTProxy.getAuctionDetails(startTokenId)).to.eql(Object.values(expectedAuctionDetails));
        expect(await mockExchangeToken.balanceOf(bidders[0].address)).to.equal(parseEther("1000") - bidAmount);
        expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(bidAmount);
        expect(await balanceOfERC20(fermionFNFTProxy, bidders[0].address)).to.equal(fractions + votes); // total balance before was fractions + fractionsPerToken + votes
        expect(await balanceOfERC20(fermionFNFTProxy, await fermionFNFTProxy.getAddress())).to.equal(fractionsPerToken);
      });

      it("Bid with  more than 100% fractions starts the auction even if below the price", async function () {
        // Testing that only the fractions used for the bid are returned
        // fractionalise another token and transfer the fractions to the bidder
        await fermionFNFTProxy.connect(seller).mintFractions(startTokenId + 1n, 1, additionalDeposit);
        const erc20Clone = await getERC20Clone(fermionFNFTProxy);
        await erc20Clone.connect(seller).transfer(bidders[0].address, fractionsPerToken);

        const price = exitPrice - parseEther("0.01");
        const fractionsPart = fractions + fractionsPerToken; // more than 1 token
        const bidAmount = 0n; // amount to pay

        const tx = await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, price, fractionsPart);

        await expect(tx)
          .to.emit(fermionFNFTProxy, "Bid")
          .withArgs(startTokenId, bidders[0].address, price, fractionsPerToken, bidAmount);

        const blockTimeStamp = (await tx.getBlock()).timestamp;
        const auctionEnd = BigInt(blockTimeStamp) + auctionParameters.duration;
        await expect(tx).to.emit(fermionFNFTProxy, "AuctionStarted").withArgs(startTokenId, auctionEnd, 0);

        // state
        const expectedAuctionDetails = {
          timer: auctionEnd,
          maxBid: price,
          maxBidder: bidders[0].address,
          totalFractions: fractionsPerToken,
          lockedFractions: fractionsPerToken - votes,
          lockedBidAmount: bidAmount,
          state: BigInt(AuctionState.Reserved),
        };

        expect(await fermionFNFTProxy.getAuctionDetails(startTokenId)).to.eql(Object.values(expectedAuctionDetails));
        expect(await mockExchangeToken.balanceOf(bidders[0].address)).to.equal(parseEther("1000") - bidAmount);
        expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(bidAmount);
      });
    });

    context("Revert reasons", function () {
      const fractions = 0n;

      it("The bid is under minimal bid", async function () {
        const bidAmount = exitPrice + parseEther("0.1");
        await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);
        await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, bidAmount, fractions);

        const minimalBid = (bidAmount * (10000n + MINIMAL_BID_INCREMENT)) / 10000n;
        const bidAmount2 = minimalBid - 1n;
        await mockExchangeToken.connect(bidders[1]).approve(await fermionFNFTProxy.getAddress(), bidAmount2);

        await expect(fermionFNFTProxy.connect(bidders[1]).bid(startTokenId, bidAmount2, fractions))
          .to.be.revertedWithCustomError(fermionFNFTProxy, "InvalidBid")
          .withArgs(startTokenId, bidAmount2, minimalBid);
      });

      it("The bid matches minimal bid, but it's equal to current bid", async function () {
        // Special case - minimal bid equals current bid
        const bidAmount = 1n;
        await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);
        await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, bidAmount, fractions);

        const minimalBid = (bidAmount * (10000n + MINIMAL_BID_INCREMENT)) / 10000n;
        const bidAmount2 = minimalBid;
        await mockExchangeToken.connect(bidders[1]).approve(await fermionFNFTProxy.getAddress(), bidAmount2);

        await expect(fermionFNFTProxy.connect(bidders[1]).bid(startTokenId, bidAmount2, fractions))
          .to.be.revertedWithCustomError(fermionFNFTProxy, "InvalidBid")
          .withArgs(startTokenId, bidAmount2, minimalBid + 1n);
      });

      it("Auction ended", async function () {
        const bidAmount = exitPrice + parseEther("0.1");
        await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);
        const tx = await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, bidAmount, fractions);

        const blockTimeStamp = (await tx.getBlock()).timestamp;
        const auctionEnd = BigInt(blockTimeStamp) + auctionParameters.duration;

        await setNextBlockTimestamp(String(auctionEnd + 1n));

        const bidAmount2 = bidAmount + parseEther("0.1");
        await mockExchangeToken.connect(bidders[1]).approve(await fermionFNFTProxy.getAddress(), bidAmount2);

        await expect(fermionFNFTProxy.connect(bidders[1]).bid(startTokenId, bidAmount2, fractions))
          .to.be.revertedWithCustomError(fermionFNFTProxy, "AuctionEnded")
          .withArgs(startTokenId, auctionEnd);
      });

      it("Bidder does not have enough fractions", async function () {
        const bidAmount = exitPrice + parseEther("0.1");
        const fractions = (fractionsPerToken * 20n) / 100n; // 20% of bid paid with fractions
        const erc20Clone = await getERC20Clone(fermionFNFTProxy);
        await erc20Clone.connect(seller).transfer(bidders[0].address, fractions);
        await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);

        await expect(fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, bidAmount, fractions + 1n))
          .to.be.revertedWithCustomError(erc20Clone, "ERC20InsufficientBalance")
          .withArgs(bidders[0].address, fractions, fractions + 1n);
      });

      it("Bidder does not have pay enough fractions", async function () {
        const bidAmount = exitPrice + parseEther("0.1");
        await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount - 1n);

        await expect(fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, bidAmount, fractions))
          .to.be.revertedWithCustomError(await getERC20Clone(fermionFNFTProxy), "ERC20InsufficientAllowance")
          .withArgs(await fermionFNFTProxy.getAddress(), bidAmount - 1n, bidAmount);
      });

      it("Token is not fractionalised", async function () {
        const bidAmount = exitPrice + parseEther("0.1");
        await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);

        await expect(fermionFNFTProxy.connect(bidders[0]).bid(startTokenId + 1n, bidAmount, fractions))
          .to.be.revertedWithCustomError(fermionFNFTProxy, "TokenNotFractionalised")
          .withArgs(startTokenId + 1n);
      });

      it("Token was recombined, but not fractionalised again", async function () {
        const bidAmount = exitPrice + parseEther("0.01");
        await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);
        const tx = await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, bidAmount, 0n);
        const blockTimeStamp = (await tx.getBlock()).timestamp;
        const auctionEnd = BigInt(blockTimeStamp) + auctionParameters.duration;
        await setNextBlockTimestamp(String(auctionEnd + 1n));
        await fermionFNFTProxy.connect(bidders[0]).redeem(startTokenId);

        await expect(fermionFNFTProxy.connect(bidders[1]).bid(startTokenId, bidAmount, fractions))
          .to.be.revertedWithCustomError(fermionFNFTProxy, "TokenNotFractionalised")
          .withArgs(startTokenId);
      });

      it("Token is reserved", async function () {
        // fractionalise another token and transfer the fractions to the bidder
        await fermionFNFTProxy.connect(seller).mintFractions(startTokenId + 1n, 1, additionalDeposit);
        const erc20Clone = await getERC20Clone(fermionFNFTProxy);
        await erc20Clone.connect(seller).transfer(bidders[0].address, fractions + fractionsPerToken);

        const price = exitPrice + parseEther("0.1");
        const fractionsPart = fractions + fractionsPerToken; // more than 1 token

        await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, price, fractionsPart);

        const bidAmount2 = price + parseEther("0.1");
        await mockExchangeToken.connect(bidders[1]).approve(await fermionFNFTProxy.getAddress(), bidAmount2);
        await expect(fermionFNFTProxy.connect(bidders[1]).bid(startTokenId, bidAmount2, 0n))
          .to.be.revertedWithCustomError(fermionFNFTProxy, "AuctionReserved")
          .withArgs(startTokenId);
      });

      it("No native funds available to claim", async function () {
        await expect(fermionFNFTProxyNativeEth.connect(bidders[0]).claimNativeBidFunds()).to.be.revertedWithCustomError(
          fermionFNFTProxyNativeEth,
          "NoNativeFundsToClaim",
        );
      });
    });
  });

  context("removeBid", function () {
    const fractionsPerToken = 5000n * 10n ** 18n;
    const exitPrice = parseEther("0.1");
    const auctionParameters = {
      exitPrice: exitPrice,
      duration: 60n * 60n * 24n * 7n, // 1 week
      unlockThreshold: 7500n, // 75%
      topBidLockTime: 60n * 60n * 24n * 2n, // two days
    };
    const custodianFee = {
      amount: parseEther("0.05"),
      period: 30n * 24n * 60n * 60n, // 30 days
    };
    const custodianVaultParameters = {
      partialAuctionThreshold: custodianFee.amount * 15n,
      partialAuctionDuration: custodianFee.period / 2n,
      liquidationThreshold: custodianFee.amount * 2n,
      newFractionsPerAuction: fractionsPerToken,
    };

    const expectedAuctionDetails = {
      timer: 0n,
      maxBid: 0n,
      maxBidder: ZeroAddress,
      totalFractions: 0n,
      lockedFractions: 0n,
      lockedBidAmount: 0n,
      state: BigInt(AuctionState.NotStarted),
    };

    beforeEach(async function () {
      await fermionFNFTProxy
        .connect(seller)
        .mintFractions(
          startTokenId,
          1,
          fractionsPerToken,
          auctionParameters,
          custodianVaultParameters,
          additionalDeposit,
          ZeroAddress,
        );
    });

    context("Bid without fractions or votes", function () {
      const fractions = 0n;

      it("Remove bid after lock expires", async function () {
        const bidAmount = exitPrice - parseEther("0.05");
        await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);

        const tx = await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, bidAmount, fractions);
        const blockTimeStamp = (await tx.getBlock()).timestamp;
        const topBidLockTime = BigInt(blockTimeStamp) + auctionParameters.topBidLockTime;
        await setNextBlockTimestamp(String(topBidLockTime + 1n));

        const tx2 = await fermionFNFTProxy.connect(bidders[0]).removeBid(startTokenId);
        await expect(tx2)
          .to.emit(mockExchangeToken, "Transfer")
          .withArgs(await fermionFNFTProxy.getAddress(), bidders[0].address, bidAmount);
        await expect(tx2).to.emit(fermionFNFTProxy, "Bid").withArgs(0, ZeroAddress, 0n, 0n, 0n);

        // state
        expect(await fermionFNFTProxy.getAuctionDetails(startTokenId)).to.eql(Object.values(expectedAuctionDetails));
        expect(await mockExchangeToken.balanceOf(bidders[0].address)).to.equal(parseEther("1000"));
        expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(0n);
      });
    });

    context("Bid with fractions", function () {
      const price = exitPrice - parseEther("0.05");
      const fractions = (fractionsPerToken * 20n) / 100n; // 20% of bid paid with fractions

      beforeEach(async function () {
        const erc20Clone = await getERC20Clone(fermionFNFTProxy);
        await erc20Clone.connect(seller).transfer(bidders[0].address, fractions);
      });

      it("Remove bid after lock expires", async function () {
        const bidAmount = ((fractionsPerToken - fractions) * price) / fractionsPerToken; // amount to pay

        await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);

        const tx = await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, price, fractions);
        const blockTimeStamp = (await tx.getBlock()).timestamp;
        const topBidLockTime = BigInt(blockTimeStamp) + auctionParameters.topBidLockTime;
        await setNextBlockTimestamp(String(topBidLockTime + 1n));

        const tx2 = await fermionFNFTProxy.connect(bidders[0]).removeBid(startTokenId);
        await expect(tx2)
          .to.emit(mockExchangeToken, "Transfer")
          .withArgs(await fermionFNFTProxy.getAddress(), bidders[0].address, bidAmount);
        await expect(tx2)
          .to.emit(await getERC20Clone(fermionFNFTProxy), "Transfer")
          .withArgs(await fermionFNFTProxy.getAddress(), bidders[0].address, fractions);
        await expect(tx2).to.emit(fermionFNFTProxy, "Bid").withArgs(0, ZeroAddress, 0n, 0n, 0n);

        expect(await mockExchangeToken.balanceOf(bidders[0].address)).to.equal(parseEther("1000"));
        expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(0n);
        expect(await balanceOfERC20(fermionFNFTProxy, bidders[0].address)).to.equal(fractions);
        expect(await balanceOfERC20(fermionFNFTProxy, await fermionFNFTProxy.getAddress())).to.equal(0n);
      });
    });

    context("Bid with votes", function () {
      const fractions = 0n;
      const votes = (fractionsPerToken * 30n) / 100n; // 30% of bid paid with locked votes

      beforeEach(async function () {
        const erc20Clone = await getERC20Clone(fermionFNFTProxy);
        await erc20Clone.connect(seller).transfer(bidders[0].address, votes);

        // bidder 0 votes to start the auction
        await fermionFNFTProxy.connect(bidders[0]).voteToStartAuction(startTokenId, votes);
      });

      it("Remove bid after lock expires", async function () {
        const price = exitPrice - parseEther("0.01");
        const bidAmount = ((fractionsPerToken - votes) * price) / fractionsPerToken; // amount to pay

        await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);

        const tx = await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, price, fractions);
        const blockTimeStamp = (await tx.getBlock()).timestamp;
        const topBidLockTime = BigInt(blockTimeStamp) + auctionParameters.topBidLockTime;
        await setNextBlockTimestamp(String(topBidLockTime + 1n));

        const tx2 = await fermionFNFTProxy.connect(bidders[0]).removeBid(startTokenId);
        await expect(tx2)
          .to.emit(mockExchangeToken, "Transfer")
          .withArgs(await fermionFNFTProxy.getAddress(), bidders[0].address, bidAmount);
        await expect(tx2).to.emit(fermionFNFTProxy, "Bid").withArgs(0, ZeroAddress, 0n, 0n, 0n);

        expect(await mockExchangeToken.balanceOf(bidders[0].address)).to.equal(parseEther("1000"));
        expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(0n);
        expect(await balanceOfERC20(fermionFNFTProxy, bidders[0].address)).to.equal(0n); // locked votes are not returned
        expect(await balanceOfERC20(fermionFNFTProxy, await fermionFNFTProxy.getAddress())).to.equal(votes); // locked votes are not returned
      });
    });

    context("Bid with votes and fractions", function () {
      const price = exitPrice - parseEther("0.01");
      const fractions = (fractionsPerToken * 20n) / 100n; // 20% of bid paid with fractions
      const votes = (fractionsPerToken * 30n) / 100n; // 30% of bid paid with locked votes

      beforeEach(async function () {
        const erc20Clone = await getERC20Clone(fermionFNFTProxy);
        await erc20Clone.connect(seller).transfer(bidders[0].address, fractions + votes);

        // bidder 0 votes to start the auction
        await fermionFNFTProxy.connect(bidders[0]).voteToStartAuction(startTokenId, votes);
      });

      it("Remove bid after lock expires", async function () {
        const bidAmount = ((fractionsPerToken - fractions - votes) * price) / fractionsPerToken; // amount to pay
        await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);

        const tx = await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, price, fractions);
        const blockTimeStamp = (await tx.getBlock()).timestamp;
        const topBidLockTime = BigInt(blockTimeStamp) + auctionParameters.topBidLockTime;
        await setNextBlockTimestamp(String(topBidLockTime + 1n));

        const tx2 = await fermionFNFTProxy.connect(bidders[0]).removeBid(startTokenId);
        await expect(tx2)
          .to.emit(mockExchangeToken, "Transfer")
          .withArgs(await fermionFNFTProxy.getAddress(), bidders[0].address, bidAmount);
        await expect(tx2)
          .to.emit(await getERC20Clone(fermionFNFTProxy), "Transfer")
          .withArgs(await fermionFNFTProxy.getAddress(), bidders[0].address, fractions);

        expect(await mockExchangeToken.balanceOf(bidders[0].address)).to.equal(parseEther("1000"));
        expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(0n);
        expect(await balanceOfERC20(fermionFNFTProxy, bidders[0].address)).to.equal(fractions); // only fractions are returned, votes not
        expect(await balanceOfERC20(fermionFNFTProxy, await fermionFNFTProxy.getAddress())).to.equal(votes);
      });
    });

    context("Revert reasons", function () {
      const fractions = 0n;

      it("The time lock is not over yet", async function () {
        const bidAmount = exitPrice - parseEther("0.01");
        await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);
        await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, bidAmount, fractions);

        await expect(fermionFNFTProxy.connect(bidders[0]).removeBid(startTokenId))
          .to.be.revertedWithCustomError(fermionFNFTProxy, "BidRemovalNotAllowed")
          .withArgs(startTokenId);
      });

      it("The auction is ongoing", async function () {
        const bidAmount = exitPrice + parseEther("0.1");
        await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);
        await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, bidAmount, fractions);

        await expect(fermionFNFTProxy.connect(bidders[0]).removeBid(startTokenId))
          .to.be.revertedWithCustomError(fermionFNFTProxy, "BidRemovalNotAllowed")
          .withArgs(startTokenId);
      });

      it("The caller is not the max bidder", async function () {
        const bidAmount = exitPrice - parseEther("0.01");
        await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);

        const tx = await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, bidAmount, fractions);
        const blockTimeStamp = (await tx.getBlock()).timestamp;
        const topBidLockTime = BigInt(blockTimeStamp) + auctionParameters.topBidLockTime;
        await setNextBlockTimestamp(String(topBidLockTime + 1n));

        const bidAmount2 = bidAmount + parseEther("0.1");
        await mockExchangeToken.connect(bidders[1]).approve(await fermionFNFTProxy.getAddress(), bidAmount2);

        await expect(fermionFNFTProxy.connect(bidders[1]).removeBid(startTokenId))
          .to.be.revertedWithCustomError(fermionFNFTProxy, "NotMaxBidder")
          .withArgs(startTokenId, bidders[1].address, bidders[0].address);
      });

      it("Token is reserved", async function () {
        // Testing that only the fractions used for the bid are returned
        // fractionalise another token and transfer the fractions to the bidder
        await fermionFNFTProxy.connect(seller).mintFractions(startTokenId + 1n, 1, additionalDeposit);
        const erc20Clone = await getERC20Clone(fermionFNFTProxy);
        await erc20Clone.connect(seller).transfer(bidders[0].address, fractionsPerToken);

        const fractions = (fractionsPerToken * 20n) / 100n; // 20% of bid paid with fractions
        const price = exitPrice - parseEther("0.01");
        const fractionsPart = fractions + fractionsPerToken; // more than 1 token

        await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, price, fractionsPart);

        await expect(fermionFNFTProxy.connect(bidders[0]).removeBid(startTokenId))
          .to.be.revertedWithCustomError(fermionFNFTProxy, "BidRemovalNotAllowed")
          .withArgs(startTokenId);
      });
    });
  });

  context("redeem", function () {
    const fractionsPerToken = 5000n * 10n ** 18n;
    const exitPrice = parseEther("0.1");
    const price = exitPrice + parseEther("0.1");
    const auctionParameters = {
      exitPrice: exitPrice,
      duration: 60n * 60n * 24n * 7n, // 1 week
      unlockThreshold: 7500n, // 75%
      topBidLockTime: 60n * 60n * 24n * 2n, // two days
    };
    const custodianFee = {
      amount: parseEther("0.05"),
      period: 30n * 24n * 60n * 60n, // 30 days
    };
    const custodianVaultParameters = {
      partialAuctionThreshold: custodianFee.amount * 15n,
      partialAuctionDuration: custodianFee.period / 2n,
      liquidationThreshold: custodianFee.amount * 2n,
      newFractionsPerAuction: fractionsPerToken,
    };
    let expectedAuctionDetails: any;

    beforeEach(async function () {
      await fermionFNFTProxy
        .connect(seller)
        .mintFractions(
          startTokenId,
          1,
          fractionsPerToken,
          auctionParameters,
          custodianVaultParameters,
          additionalDeposit,
          ZeroAddress,
        );

      expectedAuctionDetails = {
        timer: 0n,
        maxBid: price,
        maxBidder: bidders[0].address,
        totalFractions: fractionsPerToken,
        lockedFractions: 0n,
        lockedBidAmount: 0n,
        state: BigInt(AuctionState.Redeemed),
      };
    });

    it("Bid without fractions or votes", async function () {
      const fractions = 0n;
      const bidAmount = price;
      await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);

      const tx = await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, bidAmount, fractions);
      const blockTimeStamp = (await tx.getBlock()).timestamp;
      const auctionEnd = BigInt(blockTimeStamp) + auctionParameters.duration;
      await setNextBlockTimestamp(String(auctionEnd + 1n));

      const tx2 = await fermionFNFTProxy.connect(bidders[0]).redeem(startTokenId);
      await expect(tx2).to.emit(fermionFNFTProxy, "Redeemed").withArgs(startTokenId, bidders[0].address);
      await expect(tx2)
        .to.emit(fermionFNFTProxy, "Transfer")
        .withArgs(await fermionFNFTProxy.getAddress(), bidders[0].address, startTokenId);

      expect(await fermionFNFTProxy.ownerOf(startTokenId)).to.equal(bidders[0].address);
      expect(await fermionFNFTProxy.balanceOf(bidders[0].address)).to.equal(1n);
      expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(bidAmount);
      expectedAuctionDetails.timer = auctionEnd;
      expectedAuctionDetails.lockedBidAmount = bidAmount;
      expect(await fermionFNFTProxy.getAuctionDetails(startTokenId)).to.eql(Object.values(expectedAuctionDetails));
    });

    it("Bid with fractions", async function () {
      const fractions = (fractionsPerToken * 20n) / 100n; // 20% of bid paid with fractions
      const erc20Clone = await getERC20Clone(fermionFNFTProxy);
      await erc20Clone.connect(seller).transfer(bidders[0].address, fractions);

      const bidAmount = ((fractionsPerToken - fractions) * price) / fractionsPerToken; // amount to pay
      await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);

      const tx = await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, price, fractions);
      const blockTimeStamp = (await tx.getBlock()).timestamp;
      const auctionEnd = BigInt(blockTimeStamp) + auctionParameters.duration;
      await setNextBlockTimestamp(String(auctionEnd + 1n));

      const tx2 = await fermionFNFTProxy.connect(bidders[0]).redeem(startTokenId);
      await expect(tx2).to.emit(fermionFNFTProxy, "Redeemed").withArgs(startTokenId, bidders[0].address);
      await expect(tx2)
        .to.emit(fermionFNFTProxy, "Transfer")
        .withArgs(await fermionFNFTProxy.getAddress(), bidders[0].address, startTokenId);
      await expect(tx2)
        .to.emit(erc20Clone, "Transfer")
        .withArgs(await fermionFNFTProxy.getAddress(), ZeroAddress, fractions);

      expect(await fermionFNFTProxy.ownerOf(startTokenId)).to.equal(bidders[0].address);
      expect(await fermionFNFTProxy.balanceOf(bidders[0].address)).to.equal(1n);
      expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(bidAmount);
      expectedAuctionDetails.timer = auctionEnd;
      expectedAuctionDetails.lockedBidAmount = bidAmount;
      expectedAuctionDetails.lockedFractions = fractions;
      expect(await fermionFNFTProxy.getAuctionDetails(startTokenId)).to.eql(Object.values(expectedAuctionDetails));
      expect(await balanceOfERC20(fermionFNFTProxy, bidders[0].address)).to.equal(0n);
      expect(await balanceOfERC20(fermionFNFTProxy, await fermionFNFTProxy.getAddress())).to.equal(0n);
    });

    it("Bid with votes", async function () {
      const fractions = 0n;
      const votes = (fractionsPerToken * 30n) / 100n; // 30% of bid paid with locked votes
      const erc20Clone = await getERC20Clone(fermionFNFTProxy);
      await erc20Clone.connect(seller).transfer(bidders[0].address, votes);

      // bidder 0 votes to start the auction
      await fermionFNFTProxy.connect(bidders[0]).voteToStartAuction(startTokenId, votes);

      const bidAmount = ((fractionsPerToken - votes) * price) / fractionsPerToken; // amount to pay
      await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);

      const tx = await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, price, fractions);
      const blockTimeStamp = (await tx.getBlock()).timestamp;
      const auctionEnd = BigInt(blockTimeStamp) + auctionParameters.duration;
      await setNextBlockTimestamp(String(auctionEnd + 1n));

      const tx2 = await fermionFNFTProxy.connect(bidders[0]).redeem(startTokenId);
      await expect(tx2).to.emit(fermionFNFTProxy, "Redeemed").withArgs(startTokenId, bidders[0].address);
      await expect(tx2)
        .to.emit(fermionFNFTProxy, "Transfer")
        .withArgs(await fermionFNFTProxy.getAddress(), bidders[0].address, startTokenId);
      await expect(tx2)
        .to.emit(erc20Clone, "Transfer")
        .withArgs(await fermionFNFTProxy.getAddress(), ZeroAddress, votes);

      expect(await fermionFNFTProxy.ownerOf(startTokenId)).to.equal(bidders[0].address);
      expect(await fermionFNFTProxy.balanceOf(bidders[0].address)).to.equal(1n);
      expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(bidAmount);
      expectedAuctionDetails.timer = auctionEnd;
      expectedAuctionDetails.lockedBidAmount = bidAmount;
      expectedAuctionDetails.lockedFractions = 0n; // locked fractions do not include votes
      expect(await fermionFNFTProxy.getAuctionDetails(startTokenId)).to.eql(Object.values(expectedAuctionDetails));
      expect(await balanceOfERC20(fermionFNFTProxy, bidders[0].address)).to.equal(0n); // all fractions used
      expect(await balanceOfERC20(fermionFNFTProxy, await fermionFNFTProxy.getAddress())).to.equal(0n);
    });

    it("Bid with votes and fractions", async function () {
      const fractions = (fractionsPerToken * 20n) / 100n; // 20% of bid paid with fractions
      const votes = (fractionsPerToken * 30n) / 100n; // 30% of bid paid with locked votes
      const erc20Clone = await getERC20Clone(fermionFNFTProxy);

      await erc20Clone.connect(seller).transfer(bidders[0].address, fractions + votes);
      // bidder 0 votes to start the auction
      await fermionFNFTProxy.connect(bidders[0]).voteToStartAuction(startTokenId, votes);

      const bidAmount = ((fractionsPerToken - fractions - votes) * price) / fractionsPerToken; // amount to pay
      await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);

      const tx = await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, price, fractions);
      const blockTimeStamp = (await tx.getBlock()).timestamp;
      const auctionEnd = BigInt(blockTimeStamp) + auctionParameters.duration;
      await setNextBlockTimestamp(String(auctionEnd + 1n));

      const tx2 = await fermionFNFTProxy.connect(bidders[0]).redeem(startTokenId);
      expect(await fermionFNFTProxy.balanceOf(bidders[0].address)).to.equal(1n);
      await expect(tx2).to.emit(fermionFNFTProxy, "Redeemed").withArgs(startTokenId, bidders[0].address);
      await expect(tx2)
        .to.emit(fermionFNFTProxy, "Transfer")
        .withArgs(await fermionFNFTProxy.getAddress(), bidders[0].address, startTokenId);
      await expect(tx2)
        .to.emit(erc20Clone, "Transfer")
        .withArgs(await fermionFNFTProxy.getAddress(), ZeroAddress, fractions + votes);

      expect(await fermionFNFTProxy.ownerOf(startTokenId)).to.equal(bidders[0].address);
      expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(bidAmount);
      expectedAuctionDetails.timer = auctionEnd;
      expectedAuctionDetails.lockedBidAmount = bidAmount;
      expectedAuctionDetails.lockedFractions = fractions; // locked fractions do not include votes
      expect(await fermionFNFTProxy.getAuctionDetails(startTokenId)).to.eql(Object.values(expectedAuctionDetails));
      expect(await balanceOfERC20(fermionFNFTProxy, bidders[0].address)).to.equal(0n); // all fractions used
      expect(await balanceOfERC20(fermionFNFTProxy, await fermionFNFTProxy.getAddress())).to.equal(0n);
    });

    it("Bid with 100% fractions", async function () {
      const fractions = fractionsPerToken; // 100% of bid paid with fractions
      const erc20Clone = await getERC20Clone(fermionFNFTProxy);
      await erc20Clone.connect(seller).transfer(bidders[0].address, fractions);

      const bidAmount = ((fractionsPerToken - fractions) * price) / fractionsPerToken; // amount to pay
      await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);

      const tx = await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, price, fractions);
      const blockTimeStamp = (await tx.getBlock()).timestamp;
      const auctionEnd = BigInt(blockTimeStamp) + auctionParameters.duration;
      await setNextBlockTimestamp(String(auctionEnd + 1n));

      const tx2 = await fermionFNFTProxy.connect(bidders[0]).redeem(startTokenId);
      await expect(tx2).to.emit(fermionFNFTProxy, "Redeemed").withArgs(startTokenId, bidders[0].address);
      await expect(tx2)
        .to.emit(fermionFNFTProxy, "Transfer")
        .withArgs(await fermionFNFTProxy.getAddress(), bidders[0].address, startTokenId);
      await expect(tx2)
        .to.emit(erc20Clone, "Transfer")
        .withArgs(await fermionFNFTProxy.getAddress(), ZeroAddress, fractions);

      expect(await fermionFNFTProxy.ownerOf(startTokenId)).to.equal(bidders[0].address);
      expect(await fermionFNFTProxy.balanceOf(bidders[0].address)).to.equal(1n);
      expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(bidAmount);
      expectedAuctionDetails.timer = auctionEnd;
      expectedAuctionDetails.lockedBidAmount = bidAmount;
      expectedAuctionDetails.lockedFractions = fractions;
      expect(await fermionFNFTProxy.getAuctionDetails(startTokenId)).to.eql(Object.values(expectedAuctionDetails));
      expect(await balanceOfERC20(fermionFNFTProxy, bidders[0].address)).to.equal(0n);
      expect(await balanceOfERC20(fermionFNFTProxy, await fermionFNFTProxy.getAddress())).to.equal(0n);
    });

    context("Redeem after someone claimed proceeds", async function () {
      beforeEach(async function () {
        const fractions = 0n;
        const bidAmount = price;
        await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);

        const tx = await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, bidAmount, fractions);
        const blockTimeStamp = (await tx.getBlock()).timestamp;
        const auctionEnd = BigInt(blockTimeStamp) + auctionParameters.duration;
        await setNextBlockTimestamp(String(auctionEnd + 1n));
      });

      it("Via claimWithLockedFractions", async function () {
        await fermionFNFTProxy.connect(seller).claimWithLockedFractions(startTokenId, 0, fractionsPerToken);

        const tx2 = await fermionFNFTProxy.connect(bidders[0]).redeem(startTokenId);
        await expect(tx2).to.emit(fermionFNFTProxy, "Redeemed").withArgs(startTokenId, bidders[0].address);
      });

      it("Via finalizeAndClaim", async function () {
        await fermionFNFTProxy.connect(seller).finalizeAndClaim(startTokenId, fractionsPerToken);

        const tx2 = await fermionFNFTProxy.connect(bidders[0]).redeem(startTokenId);
        await expect(tx2).to.emit(fermionFNFTProxy, "Redeemed").withArgs(startTokenId, bidders[0].address);
      });
    });

    context("Revert reasons", function () {
      it("The auction is not over yet", async function () {
        const fractions = 0n;
        const bidAmount = exitPrice + parseEther("0.1");
        await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);

        const tx = await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, bidAmount, fractions);
        const blockTimeStamp = (await tx.getBlock()).timestamp;
        const auctionEnd = BigInt(blockTimeStamp) + auctionParameters.duration;

        await expect(fermionFNFTProxy.connect(bidders[0]).redeem(startTokenId))
          .to.be.revertedWithCustomError(fermionFNFTProxy, "AuctionOngoing")
          .withArgs(startTokenId, auctionEnd);
      });

      it("The auction has not started", async function () {
        const fractions = 0n;
        const bidAmount = exitPrice - parseEther("0.01");
        await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);

        await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, bidAmount, fractions);

        await expect(fermionFNFTProxy.connect(bidders[0]).redeem(startTokenId))
          .to.be.revertedWithCustomError(fermionFNFTProxy, "AuctionNotStarted")
          .withArgs(startTokenId);
      });

      it("Caller is not the max bidder", async function () {
        const fractions = 0n;
        const bidAmount = exitPrice + parseEther("0.1");
        await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);

        const tx = await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, bidAmount, fractions);
        const blockTimeStamp = (await tx.getBlock()).timestamp;
        const auctionEnd = BigInt(blockTimeStamp) + auctionParameters.duration;
        await setNextBlockTimestamp(String(auctionEnd + 1n));

        await expect(fermionFNFTProxy.connect(bidders[1]).redeem(startTokenId))
          .to.be.revertedWithCustomError(fermionFNFTProxy, "NotMaxBidder")
          .withArgs(startTokenId, bidders[1].address, bidders[0].address);
      });

      it("Cannot redeem twice", async function () {
        const fractions = 0n;
        const bidAmount = exitPrice + parseEther("0.1");
        await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);

        const tx = await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, bidAmount, fractions);
        const blockTimeStamp = (await tx.getBlock()).timestamp;
        const auctionEnd = BigInt(blockTimeStamp) + auctionParameters.duration;
        await setNextBlockTimestamp(String(auctionEnd + 1n));

        await fermionFNFTProxy.connect(bidders[0]).redeem(startTokenId);

        await expect(fermionFNFTProxy.connect(bidders[0]).redeem(startTokenId))
          .to.be.revertedWithCustomError(fermionFNFTProxy, "AlreadyRedeemed")
          .withArgs(startTokenId);
      });

      it("Invalid token id", async function () {
        await expect(fermionFNFTProxy.connect(bidders[1]).redeem(startTokenId + 1n))
          .to.be.revertedWithCustomError(fermionFNFTProxy, "TokenNotFractionalised")
          .withArgs(startTokenId + 1n);
      });
    });
  });

  context("claim", function () {
    const fractionsPerToken = 5000n * 10n ** 18n;
    const exitPrice = parseEther("0.1");
    const price = exitPrice + parseEther("0.1");
    const auctionParameters = {
      exitPrice: exitPrice,
      duration: 60n * 60n * 24n * 7n, // 1 week
      unlockThreshold: 7500n, // 75%
      topBidLockTime: 60n * 60n * 24n * 2n, // two days
    };
    const custodianFee = {
      amount: parseEther("0.05"),
      period: 30n * 24n * 60n * 60n, // 30 days
    };
    const custodianVaultParameters = {
      partialAuctionThreshold: custodianFee.amount * 15n,
      partialAuctionDuration: custodianFee.period / 2n,
      liquidationThreshold: custodianFee.amount * 2n,
      newFractionsPerAuction: fractionsPerToken,
    };

    let fractionalOwners: HardhatEthersSigner[];
    const owner1Share = applyPercentage(fractionsPerToken, 2000); //20%
    const owner2Share = applyPercentage(fractionsPerToken, 3000); //30%
    const owner3Share = applyPercentage(fractionsPerToken, 1000); //10%
    const sellerShare = fractionsPerToken - owner1Share - owner2Share - owner3Share;

    const owner1payout = applyPercentage(price, 2000); //20%

    before(async function () {
      fractionalOwners = wallets.slice(5, 8); // overlap with bidders, except for the bidder 0
    });

    beforeEach(async function () {
      await fermionFNFTProxy
        .connect(seller)
        .mintFractions(
          startTokenId,
          1,
          fractionsPerToken,
          auctionParameters,
          custodianVaultParameters,
          additionalDeposit,
          ZeroAddress,
        );

      const erc20Clone = await getERC20Clone(fermionFNFTProxy);
      await erc20Clone.connect(seller).transfer(fractionalOwners[0].address, owner1Share);
      await erc20Clone.connect(seller).transfer(fractionalOwners[1].address, owner2Share);
      await erc20Clone.connect(seller).transfer(fractionalOwners[2].address, owner3Share);
    });

    async function claimAfterRedeem(
      biddersFractions: bigint,
      sellerShareAdjusted = sellerShare,
      bidAmount = price,
      vaultOrProtocolPayout = 0n,
    ) {
      await fermionFNFTProxy.connect(bidders[0]).redeem(startTokenId);
      expect(await fermionFNFTProxy.liquidSupply()).to.equal(0n);
      await verifyEventsAndBalances(
        "claim",
        [],
        biddersFractions,
        sellerShareAdjusted,
        bidAmount,
        vaultOrProtocolPayout,
      );
    }

    async function finalizeAndClaim(
      biddersFractions: bigint,
      sellerShareAdjusted = sellerShare,
      bidAmount = price,
      vaultOrProtocolPayout = 0n,
    ) {
      expect(await fermionFNFTProxy.liquidSupply()).to.equal(0n);
      await verifyEventsAndBalances(
        "finalizeAndClaim",
        [startTokenId],
        biddersFractions,
        sellerShareAdjusted,
        bidAmount,
        vaultOrProtocolPayout,
        false,
      );
    }

    async function claimWithLockedFractions(
      biddersFractions: bigint,
      sellerShareAdjusted = sellerShare,
      bidAmount = price,
      vaultOrProtocolPayout = 0n,
    ) {
      expect(await fermionFNFTProxy.liquidSupply()).to.equal(0n);
      await verifyEventsAndBalances(
        "claimWithLockedFractions",
        [startTokenId, 0],
        biddersFractions,
        sellerShareAdjusted,
        bidAmount,
        vaultOrProtocolPayout,
        false,
      );
    }

    async function verifyEventsAndBalances(
      method: string,
      args: any[] = [],
      biddersFractions: bigint,
      sellerShareAdjusted = sellerShare,
      bidAmount = price,
      vaultOrProtocolPayout = 0n,
      redeemed = true,
    ) {
      const erc20Clone = await getERC20Clone(fermionFNFTProxy);
      expect(await erc20Clone.totalSupply()).to.equal(fractionsPerToken - (redeemed ? biddersFractions : 0n));

      const availableVaultPayout =
        vaultOrProtocolPayout - applyPercentage(vaultOrProtocolPayout, (biddersFractions * 10000n) / fractionsPerToken);

      const availableForClaim = fractionsPerToken - biddersFractions;

      const owner1payout = ((bidAmount + availableVaultPayout) * owner1Share) / availableForClaim; //20% of available
      const owner2payout = ((bidAmount + availableVaultPayout) * owner2Share) / availableForClaim; //30% of available
      const owner3payout = ((bidAmount + availableVaultPayout) * owner3Share) / availableForClaim; //10% of available
      const sellerPayout = bidAmount + availableVaultPayout - owner1payout - owner2payout - owner3payout;

      await expect(fermionFNFTProxy.connect(fractionalOwners[0])[method](...args, owner1Share))
        .to.emit(fermionFNFTProxy, "Claimed")
        .withArgs(fractionalOwners[0].address, owner1Share, owner1payout, 0);
      expect(await erc20Clone.totalSupply()).to.equal(fractionsPerToken - biddersFractions - owner1Share);
      expect(await fermionFNFTProxy.liquidSupply()).to.equal(0n);
      await expect(fermionFNFTProxy.connect(fractionalOwners[1])[method](...args, owner2Share))
        .to.emit(fermionFNFTProxy, "Claimed")
        .withArgs(fractionalOwners[1].address, owner2Share, owner2payout, 0);
      expect(await erc20Clone.totalSupply()).to.equal(fractionsPerToken - biddersFractions - owner1Share - owner2Share);
      expect(await fermionFNFTProxy.liquidSupply()).to.equal(0n);
      await expect(fermionFNFTProxy.connect(fractionalOwners[2])[method](...args, owner3Share))
        .to.emit(fermionFNFTProxy, "Claimed")
        .withArgs(fractionalOwners[2].address, owner3Share, owner3payout, 0);
      expect(await erc20Clone.totalSupply()).to.equal(
        fractionsPerToken - biddersFractions - owner1Share - owner2Share - owner3Share,
      );
      expect(await fermionFNFTProxy.liquidSupply()).to.equal(0n);
      await expect(fermionFNFTProxy.connect(seller)[method](...args, sellerShareAdjusted))
        .to.emit(fermionFNFTProxy, "Claimed")
        .withArgs(seller.address, sellerShareAdjusted, sellerPayout, 0);
      expect(await erc20Clone.totalSupply()).to.equal(
        fractionsPerToken - biddersFractions - owner1Share - owner2Share - owner3Share - sellerShareAdjusted,
      );
      expect(await fermionFNFTProxy.liquidSupply()).to.equal(0n);

      expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(0n);
      expect(await erc20Clone.balanceOf(fractionalOwners[0].address)).to.equal(0n);
      expect(await erc20Clone.balanceOf(fractionalOwners[1].address)).to.equal(0n);
      expect(await erc20Clone.balanceOf(fractionalOwners[2].address)).to.equal(0n);
      expect(await erc20Clone.balanceOf(seller.address)).to.equal(0n);
      expect(await mockExchangeToken.balanceOf(fractionalOwners[0].address)).to.equal(
        parseEther("1000") + owner1payout,
      );
      expect(await mockExchangeToken.balanceOf(fractionalOwners[1].address)).to.equal(
        parseEther("1000") + owner2payout,
      );
      expect(await mockExchangeToken.balanceOf(fractionalOwners[2].address)).to.equal(
        parseEther("1000") + owner3payout,
      );
      expect(await mockExchangeToken.balanceOf(seller.address)).to.equal(sellerPayout);
    }

    const scenarios = ["redeem and claim", "finalize and claim", "claim with locked fractions"];

    const finalizations = {
      "redeem and claim": claimAfterRedeem,
      "finalize and claim": finalizeAndClaim,
      "claim with locked fractions": claimWithLockedFractions,
    };

    scenarios.forEach((scenario) => {
      context(scenario, function () {
        it("Bid without fractions or votes", async function () {
          const fractions = 0n;
          const bidAmount = price;
          await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);
          const tx = await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, bidAmount, fractions);
          const blockTimeStamp = (await tx.getBlock()).timestamp;
          const auctionEnd = BigInt(blockTimeStamp) + auctionParameters.duration;
          await setNextBlockTimestamp(String(auctionEnd + 1n));

          await finalizations[scenario](fractions);
        });

        it("Bid with fractions", async function () {
          const fractions = (fractionsPerToken * 20n) / 100n; // 20% of bid paid with fractions
          const erc20clone = await getERC20Clone(fermionFNFTProxy);
          await erc20clone.connect(seller).transfer(bidders[0].address, fractions);
          const bidAmount = ((fractionsPerToken - fractions) * price) / fractionsPerToken; // amount to pay
          await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);
          const tx = await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, price, fractions);
          const blockTimeStamp = (await tx.getBlock()).timestamp;
          const auctionEnd = BigInt(blockTimeStamp) + auctionParameters.duration;
          await setNextBlockTimestamp(String(auctionEnd + 1n));

          await finalizations[scenario](fractions, sellerShare - fractions, bidAmount);
        });

        it("Bid with votes", async function () {
          const fractions = 0n;
          const votes = (fractionsPerToken * 30n) / 100n; // 30% of bid paid with locked votes
          const erc20clone = await getERC20Clone(fermionFNFTProxy);
          await erc20clone.connect(seller).transfer(bidders[0].address, votes);
          await fermionFNFTProxy.connect(bidders[0]).voteToStartAuction(startTokenId, votes);
          const bidAmount = ((fractionsPerToken - votes) * price) / fractionsPerToken; // amount to pay
          await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);
          const tx = await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, price, fractions);
          const blockTimeStamp = (await tx.getBlock()).timestamp;
          const auctionEnd = BigInt(blockTimeStamp) + auctionParameters.duration;
          await setNextBlockTimestamp(String(auctionEnd + 1n));

          await finalizations[scenario](votes, sellerShare - votes, bidAmount);
        });

        it("Bid with votes and fractions", async function () {
          const fractions = (fractionsPerToken * 10n) / 100n; // 20% of bid paid with fractions
          const votes = (fractionsPerToken * 5n) / 100n; // 30% of bid paid with locked votes
          const erc20clone = await getERC20Clone(fermionFNFTProxy);
          await erc20clone.connect(seller).transfer(bidders[0].address, fractions + votes);
          await fermionFNFTProxy.connect(bidders[0]).voteToStartAuction(startTokenId, votes);
          const bidAmount = ((fractionsPerToken - fractions - votes) * price) / fractionsPerToken; // amount to pay
          await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);
          const tx = await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, price, fractions);
          const blockTimeStamp = (await tx.getBlock()).timestamp;
          const auctionEnd = BigInt(blockTimeStamp) + auctionParameters.duration;
          await setNextBlockTimestamp(String(auctionEnd + 1n));

          await finalizations[scenario](fractions + votes, sellerShare - fractions - votes, bidAmount);
        });

        it("Custody vault returns some funds", async function () {
          const amountToRelease = parseEther("0.03");
          await mockExchangeToken.mint(await fermionMock.getAddress(), amountToRelease);
          await fermionMock.setAmountToRelease(amountToRelease);

          const fractions = 0n;
          const bidAmount = price;
          await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);
          const tx = await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, bidAmount, fractions);
          const blockTimeStamp = (await tx.getBlock()).timestamp;
          const auctionEnd = BigInt(blockTimeStamp) + auctionParameters.duration;
          await setNextBlockTimestamp(String(auctionEnd + 1n));

          await finalizations[scenario](fractions, sellerShare, bidAmount, amountToRelease);
        });

        it("Custody vault declares some debt", async function () {
          const amountToRepay = parseEther("0.03");
          await mockExchangeToken.mint(await fermionMock.getAddress(), amountToRepay);
          await fermionMock.setAmountToRelease(-amountToRepay);

          const fractions = 0n;
          const bidAmount = price;
          await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);
          const tx = await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, bidAmount, fractions);
          const blockTimeStamp = (await tx.getBlock()).timestamp;
          const auctionEnd = BigInt(blockTimeStamp) + auctionParameters.duration;
          await setNextBlockTimestamp(String(auctionEnd + 1n));

          await finalizations[scenario](fractions, sellerShare, bidAmount, -amountToRepay);
        });

        it("Protocol takes some royalties", async function () {
          const royaltyAmount = parseEther("0.01");
          await fermionMock.setRoyalties(royaltyAmount);

          const fractions = 0n;
          const bidAmount = price;
          await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);
          const tx = await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, bidAmount, fractions);
          const blockTimeStamp = (await tx.getBlock()).timestamp;
          const auctionEnd = BigInt(blockTimeStamp) + auctionParameters.duration;
          await setNextBlockTimestamp(String(auctionEnd + 1n));

          await finalizations[scenario](fractions, sellerShare, bidAmount, -royaltyAmount);
        });
      });
    });

    it("Claim only a portion", async function () {
      const fractions = 0n;
      const bidAmount = price;
      await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);
      const tx = await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, bidAmount, fractions);
      const blockTimeStamp = (await tx.getBlock()).timestamp;
      const auctionEnd = BigInt(blockTimeStamp) + auctionParameters.duration;
      await setNextBlockTimestamp(String(auctionEnd + 1n));
      await fermionFNFTProxy.connect(bidders[0]).redeem(startTokenId);

      const partialOwner1Share = applyPercentage(owner1Share, 2500);
      const partialOwner1Payout = applyPercentage(owner1payout, 2500);
      await expect(fermionFNFTProxy.connect(fractionalOwners[0]).claim(partialOwner1Share))
        .to.emit(fermionFNFTProxy, "Claimed")
        .withArgs(fractionalOwners[0].address, partialOwner1Share, partialOwner1Payout, 0);

      expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(
        bidAmount - partialOwner1Payout,
      );
      expect(await balanceOfERC20(fermionFNFTProxy, fractionalOwners[0].address)).to.equal(
        owner1Share - partialOwner1Share,
      );
      expect(await mockExchangeToken.balanceOf(fractionalOwners[0].address)).to.equal(
        parseEther("1000") + partialOwner1Payout,
      );
    });

    context("Multiple Tokens", function () {
      beforeEach(async function () {
        await fermionFNFTProxy.connect(seller).mintFractions(startTokenId + 1n, 1, additionalDeposit);
      });

      it("Two items - no claim in between", async function () {
        const fractions = 0n;
        const price1 = exitPrice + parseEther("0.1");
        const price2 = exitPrice + parseEther("0.2");

        await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), price1 + price2);
        await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, price1, fractions);
        const tx = await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId + 1n, price2, fractions);
        const blockTimeStamp = (await tx.getBlock()).timestamp;
        const auctionEnd = BigInt(blockTimeStamp) + auctionParameters.duration;
        await setNextBlockTimestamp(String(auctionEnd + 1n));
        await fermionFNFTProxy.connect(bidders[0]).redeem(startTokenId);
        await fermionFNFTProxy.connect(bidders[0]).redeem(startTokenId + 1n);

        const owner1payout = applyPercentage((price1 + price2) / 2n, 2000); //20%
        await expect(fermionFNFTProxy.connect(fractionalOwners[0]).claim(owner1Share))
          .to.emit(fermionFNFTProxy, "Claimed")
          .withArgs(fractionalOwners[0].address, owner1Share, owner1payout, 0);

        expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(
          price1 + price2 - owner1payout,
        );
        expect(await balanceOfERC20(fermionFNFTProxy, fractionalOwners[0].address)).to.equal(0n);
        expect(await mockExchangeToken.balanceOf(fractionalOwners[0].address)).to.equal(
          parseEther("1000") + owner1payout,
        );
      });

      it("Two items - claim in between", async function () {
        const fractions = 0n;
        const price1 = exitPrice + parseEther("0.1");
        const price2 = exitPrice + parseEther("0.2");

        await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), price1 + price2);
        await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, price1, fractions);
        const tx = await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId + 1n, price2, fractions);
        const blockTimeStamp = (await tx.getBlock()).timestamp;
        const auctionEnd = BigInt(blockTimeStamp) + auctionParameters.duration;
        await setNextBlockTimestamp(String(auctionEnd + 1n));
        await fermionFNFTProxy.connect(bidders[0]).redeem(startTokenId);

        // owner1 payout is the same as with a single item
        await expect(fermionFNFTProxy.connect(fractionalOwners[0]).claim(owner1Share))
          .to.emit(fermionFNFTProxy, "Claimed")
          .withArgs(fractionalOwners[0].address, owner1Share, owner1payout, 0);

        expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(
          price1 + price2 - owner1payout,
        );
        expect(await balanceOfERC20(fermionFNFTProxy, fractionalOwners[0].address)).to.equal(0n);
        expect(await mockExchangeToken.balanceOf(fractionalOwners[0].address)).to.equal(
          parseEther("1000") + owner1payout,
        );

        await fermionFNFTProxy.connect(bidders[0]).redeem(startTokenId + 1n);

        const owner2payout =
          ((price2 + price1 - owner1payout) * owner2Share) /
          (owner2Share + owner3Share + sellerShare + fractionsPerToken); // a new token was fractionated
        await expect(fermionFNFTProxy.connect(fractionalOwners[1]).claim(owner2Share))
          .to.emit(fermionFNFTProxy, "Claimed")
          .withArgs(fractionalOwners[1].address, owner2Share, owner2payout, 0);

        expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(
          price1 + price2 - owner1payout - owner2payout,
        );
        expect(await balanceOfERC20(fermionFNFTProxy, fractionalOwners[1].address)).to.equal(0n);
        expect(await mockExchangeToken.balanceOf(fractionalOwners[1].address)).to.equal(
          parseEther("1000") + owner2payout,
        );
      });

      it("Two items, one redeemed, only fractions for it can be claimed", async function () {
        const fractions = 0n;
        const price1 = exitPrice + parseEther("0.1");
        const price2 = exitPrice + parseEther("0.2");

        await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), price1 + price2);
        await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, price1, fractions);
        const tx = await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId + 1n, price2, fractions);
        const blockTimeStamp = (await tx.getBlock()).timestamp;
        const auctionEnd = BigInt(blockTimeStamp) + auctionParameters.duration;
        await setNextBlockTimestamp(String(auctionEnd + 1n));
        await fermionFNFTProxy.connect(bidders[0]).redeem(startTokenId);

        const newSellerShare = sellerShare + fractionsPerToken;

        await expect(fermionFNFTProxy.connect(seller).claim(newSellerShare))
          .to.emit(fermionFNFTProxy, "Claimed")
          .withArgs(seller.address, fractionsPerToken, price1, 0);

        expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(price2);
        expect(await balanceOfERC20(fermionFNFTProxy, seller.address)).to.equal(sellerShare);
        expect(await mockExchangeToken.balanceOf(seller.address)).to.equal(price1);
      });

      context("Some owner has locked votes", async function () {
        const fractions = 0n;
        const price1 = exitPrice + parseEther("0.1");
        const price2 = exitPrice + parseEther("0.2");

        const votes = (fractionsPerToken * 9n) / 10n; // seller locks in 90% of first token sale

        beforeEach(async function () {
          await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), price1 + price2);
          await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, price1, fractions);
          await fermionFNFTProxy.connect(seller).voteToStartAuction(startTokenId, votes);

          const tx = await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId + 1n, price2, fractions);
          const blockTimeStamp = (await tx.getBlock()).timestamp;
          const auctionEnd = BigInt(blockTimeStamp) + auctionParameters.duration;
          await setNextBlockTimestamp(String(auctionEnd + 1n));
        });

        it("Claim after redeem", async function () {
          await fermionFNFTProxy.connect(bidders[0]).redeem(startTokenId);
          await fermionFNFTProxy.connect(bidders[0]).redeem(startTokenId + 1n);

          // claim unrestricted shares (owner with no votes)
          const unrestrictedShares = owner1Share + owner2Share + owner3Share + sellerShare + fractionsPerToken - votes;
          const unrestrictedPayout = (price1 * 1n) / 10n + price2;

          const owner1payout = (unrestrictedPayout * owner1Share) / unrestrictedShares;

          await expect(fermionFNFTProxy.connect(fractionalOwners[0]).claim(owner1Share))
            .to.emit(fermionFNFTProxy, "Claimed")
            .withArgs(fractionalOwners[0].address, owner1Share, owner1payout, 0);

          expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(
            price1 + price2 - owner1payout,
          );
          expect(await balanceOfERC20(fermionFNFTProxy, fractionalOwners[0].address)).to.equal(0n);
          expect(await mockExchangeToken.balanceOf(fractionalOwners[0].address)).to.equal(
            parseEther("1000") + owner1payout,
          );

          // claim restricted shares (owner with votes)
          const sellerUnrestrictedShares = sellerShare + fractionsPerToken - votes;
          const remainingUnrestrictedShares = unrestrictedShares - owner1Share;
          const remainingUnrestrictedPayout = unrestrictedPayout - owner1payout;
          const sellerUnrestrictedPayout =
            (remainingUnrestrictedPayout * sellerUnrestrictedShares) / remainingUnrestrictedShares;
          const lockedPayout = (price1 * 9n) / 10n;
          const totalPayout = sellerUnrestrictedPayout + lockedPayout;

          await expect(
            fermionFNFTProxy.connect(seller).claimWithLockedFractions(startTokenId, 0, sellerUnrestrictedShares),
          )
            .to.emit(fermionFNFTProxy, "Claimed")
            .withArgs(seller.address, sellerUnrestrictedShares + votes, totalPayout, 0);

          expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(
            price1 + price2 - owner1payout - totalPayout,
          );
          expect(await balanceOfERC20(fermionFNFTProxy, seller.address)).to.equal(0n);
          expect(await mockExchangeToken.balanceOf(seller.address)).to.equal(totalPayout);
        });

        it("Claim after claimWithLockedFractions", async function () {
          await fermionFNFTProxy.connect(bidders[0]).redeem(startTokenId + 1n); // to finalize the other auction

          // claim restricted shares (owner with votes)
          const sellerUnrestrictedShares = sellerShare + fractionsPerToken - votes;
          const unrestrictedShares = owner1Share + owner2Share + owner3Share + sellerUnrestrictedShares;
          const unrestrictedPayout = (price1 * 1n) / 10n + price2;
          const sellerUnrestrictedPayout = (unrestrictedPayout * sellerUnrestrictedShares) / unrestrictedShares;
          const lockedPayout = (price1 * 9n) / 10n;
          const totalPayout = sellerUnrestrictedPayout + lockedPayout;

          await expect(
            fermionFNFTProxy.connect(seller).claimWithLockedFractions(startTokenId, 0, sellerUnrestrictedShares),
          )
            .to.emit(fermionFNFTProxy, "Claimed")
            .withArgs(seller.address, sellerUnrestrictedShares + votes, totalPayout, 0);

          expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(
            price1 + price2 - totalPayout,
          );
          expect(await balanceOfERC20(fermionFNFTProxy, seller.address)).to.equal(0n);
          expect(await mockExchangeToken.balanceOf(seller.address)).to.equal(totalPayout);

          const remainingUnrestrictedShares = unrestrictedShares - sellerUnrestrictedShares;
          const remainingUnrestrictedPayout = unrestrictedPayout - sellerUnrestrictedPayout;
          const owner1payout = (remainingUnrestrictedPayout * owner1Share) / remainingUnrestrictedShares;

          await expect(fermionFNFTProxy.connect(fractionalOwners[0]).claim(owner1Share))
            .to.emit(fermionFNFTProxy, "Claimed")
            .withArgs(fractionalOwners[0].address, owner1Share, owner1payout, 0);

          expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(
            price1 + price2 - owner1payout - totalPayout,
          );
          expect(await balanceOfERC20(fermionFNFTProxy, fractionalOwners[0].address)).to.equal(0n);
          expect(await mockExchangeToken.balanceOf(fractionalOwners[0].address)).to.equal(
            parseEther("1000") + owner1payout,
          );
        });

        it("Cannot spend locked votes twice", async function () {
          await fermionFNFTProxy.connect(bidders[0]).redeem(startTokenId + 1n); // to finalize the other auction

          // claim with half of unrestricted shares
          const sellerUnrestrictedShares = sellerShare + fractionsPerToken - votes;
          const unrestrictedShares = owner1Share + owner2Share + owner3Share + sellerUnrestrictedShares;
          const sellerUnrestrictedSharesHalf = sellerUnrestrictedShares / 2n;
          const unrestrictedPayout = (price1 * 1n) / 10n + price2;
          const sellerUnrestrictedPayout = (unrestrictedPayout * sellerUnrestrictedSharesHalf) / unrestrictedShares;
          const lockedPayout = (price1 * 9n) / 10n;
          const totalPayout = sellerUnrestrictedPayout + lockedPayout;

          await expect(
            fermionFNFTProxy.connect(seller).claimWithLockedFractions(startTokenId, 0, sellerUnrestrictedSharesHalf),
          )
            .to.emit(fermionFNFTProxy, "Claimed")
            .withArgs(seller.address, sellerUnrestrictedSharesHalf + votes, totalPayout, 0);

          expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(
            price1 + price2 - totalPayout,
          );
          expect(await balanceOfERC20(fermionFNFTProxy, seller.address)).to.equal(sellerUnrestrictedSharesHalf);
          expect(await mockExchangeToken.balanceOf(seller.address)).to.equal(totalPayout);

          // claim with the other half of unrestricted shares. This time the seller has no locked votes
          const unrestrictedPayout2 = unrestrictedPayout - sellerUnrestrictedPayout;
          const unrestrictedShares2 = unrestrictedShares - sellerUnrestrictedSharesHalf;
          const sellerUnrestrictedPayout2 = (unrestrictedPayout2 * sellerUnrestrictedSharesHalf) / unrestrictedShares2;
          const totalPayout2 = sellerUnrestrictedPayout2;

          await expect(
            fermionFNFTProxy.connect(seller).claimWithLockedFractions(startTokenId, 0, sellerUnrestrictedSharesHalf),
          )
            .to.emit(fermionFNFTProxy, "Claimed")
            .withArgs(seller.address, sellerUnrestrictedSharesHalf, totalPayout2, 0);

          expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(
            price1 + price2 - totalPayout - totalPayout2,
          );
          expect(await balanceOfERC20(fermionFNFTProxy, seller.address)).to.equal(0n);
          expect(await mockExchangeToken.balanceOf(seller.address)).to.equal(totalPayout + totalPayout2);
        });

        it("Claim without additional votes", async function () {
          // claim with half of unrestricted shares
          const sellerUnrestrictedShares = sellerShare + fractionsPerToken - votes;
          const lockedPayout = (price1 * 9n) / 10n;

          await expect(fermionFNFTProxy.connect(seller).claimWithLockedFractions(startTokenId, 0, 0))
            .to.emit(fermionFNFTProxy, "Claimed")
            .withArgs(seller.address, votes, lockedPayout, 0);

          expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(
            price1 + price2 - lockedPayout,
          );
          expect(await balanceOfERC20(fermionFNFTProxy, seller.address)).to.equal(sellerUnrestrictedShares);
          expect(await mockExchangeToken.balanceOf(seller.address)).to.equal(lockedPayout);
        });
      });
    });

    context("Revert reasons", function () {
      it("Claim 0", async function () {
        await expect(fermionFNFTProxy.connect(fractionalOwners[0]).claim(0n)).to.be.revertedWithCustomError(
          fermionFNFTProxy,
          "InvalidAmount",
        );
      });

      it("Finalize and Claim 0", async function () {
        const fractions = 0n;
        const bidAmount = price;
        await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);
        const tx = await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, bidAmount, fractions);
        const blockTimeStamp = (await tx.getBlock()).timestamp;
        const auctionEnd = BigInt(blockTimeStamp) + auctionParameters.duration;
        await setNextBlockTimestamp(String(auctionEnd + 1n));
        await fermionFNFTProxy.connect(bidders[0]).redeem(startTokenId);

        await expect(
          fermionFNFTProxy.connect(fractionalOwners[0]).finalizeAndClaim(startTokenId, 0n),
        ).to.be.revertedWithCustomError(fermionFNFTProxy, "InvalidAmount");
      });

      it("Available supply zero", async function () {
        await expect(fermionFNFTProxy.connect(fractionalOwners[0]).claim(owner1Share)).to.be.revertedWithCustomError(
          fermionFNFTProxy,
          "NoFractions",
        );
      });

      it("Auction not started", async function () {
        await expect(
          fermionFNFTProxy.connect(fractionalOwners[0]).finalizeAndClaim(startTokenId, 0n),
        ).to.be.revertedWithCustomError(fermionFNFTProxy, "AuctionNotStarted");
      });

      it("Claim more than have", async function () {
        const fractions = 0n;
        const bidAmount = price;
        await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);
        const tx = await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, bidAmount, fractions);
        const blockTimeStamp = (await tx.getBlock()).timestamp;
        const auctionEnd = BigInt(blockTimeStamp) + auctionParameters.duration;
        await setNextBlockTimestamp(String(auctionEnd + 1n));
        await fermionFNFTProxy.connect(bidders[0]).redeem(startTokenId);

        await expect(fermionFNFTProxy.connect(fractionalOwners[0]).claim(owner1Share + 1n))
          .to.be.revertedWithCustomError(await getERC20Clone(fermionFNFTProxy), "ERC20InsufficientBalance")
          .withArgs(fractionalOwners[0].address, owner1Share, owner1Share + 1n);

        await expect(fermionFNFTProxy.connect(fractionalOwners[0]).finalizeAndClaim(startTokenId, owner1Share + 1n))
          .to.be.revertedWithCustomError(await getERC20Clone(fermionFNFTProxy), "ERC20InsufficientBalance")
          .withArgs(fractionalOwners[0].address, owner1Share, owner1Share + 1n);
      });

      context("Claim with locked fractions", function () {
        beforeEach(async function () {
          const fractions = 0n;
          const bidAmount = price;
          await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);
          const tx = await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, bidAmount, fractions);
          const blockTimeStamp = (await tx.getBlock()).timestamp;
          const auctionEnd = BigInt(blockTimeStamp) + auctionParameters.duration;
          await setNextBlockTimestamp(String(auctionEnd + 1n));
          await fermionFNFTProxy.connect(bidders[0]).redeem(startTokenId);
        });

        it("Wrong auction index", async function () {
          const invalidAuctionIndex = 2;
          await expect(
            fermionFNFTProxy
              .connect(fractionalOwners[0])
              .claimWithLockedFractions(startTokenId, invalidAuctionIndex, 0),
          )
            .to.be.revertedWithCustomError(fermionFNFTProxy, "InvalidAuctionIndex")
            .withArgs(invalidAuctionIndex, 1);
        });

        it("Claim nothing", async function () {
          await expect(
            fermionFNFTProxy.connect(fractionalOwners[0]).claimWithLockedFractions(startTokenId, 0n, 0n),
          ).to.be.revertedWithCustomError(fermionFNFTProxy, "NoFractions");
        });
      });
    });
  });

  context("second fractionalisation", function () {
    const fractionsPerToken = 5000n * 10n ** 18n;
    const exitPrice = parseEther("0.1");
    const price = exitPrice + parseEther("0.1");
    const auctionParameters = {
      exitPrice: exitPrice,
      duration: 60n * 60n * 24n * 7n, // 1 week
      unlockThreshold: 7500n, // 75%
      topBidLockTime: 60n * 60n * 24n * 2n, // two days
    };
    const custodianFee = {
      amount: parseEther("0.05"),
      period: 30n * 24n * 60n * 60n, // 30 days
    };
    const custodianVaultParameters = {
      partialAuctionThreshold: custodianFee.amount * 15n,
      partialAuctionDuration: custodianFee.period / 2n,
      liquidationThreshold: custodianFee.amount * 2n,
      newFractionsPerAuction: fractionsPerToken,
    };

    it("Item can be recombined and fractionalisated again", async function () {
      await fermionFNFTProxy
        .connect(seller)
        .mintFractions(
          startTokenId,
          2,
          fractionsPerToken,
          auctionParameters,
          custodianVaultParameters,
          additionalDeposit,
          ZeroAddress,
        );

      const fractions = 0n;
      const bidAmount = price;
      await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);
      const tx = await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, bidAmount, fractions);
      const blockTimeStamp = (await tx.getBlock()).timestamp;
      const auctionEnd = BigInt(blockTimeStamp) + auctionParameters.duration;
      await setNextBlockTimestamp(String(auctionEnd + 1n));
      await fermionFNFTProxy.connect(bidders[0]).redeem(startTokenId);

      // state
      const expectedAuctionDetails = {
        timer: auctionEnd,
        maxBid: bidAmount,
        maxBidder: bidders[0].address,
        totalFractions: fractionsPerToken,
        lockedFractions: fractions,
        lockedBidAmount: bidAmount,
        state: BigInt(AuctionState.Redeemed),
      };

      expect(await fermionFNFTProxy.getAuctionDetails(startTokenId)).to.eql(Object.values(expectedAuctionDetails));

      // New owner fractionalise it again, but with the same parameters
      await expect(
        fermionFNFTProxy
          .connect(bidders[0])
          .mintFractions(
            startTokenId,
            1,
            fractionsPerToken,
            auctionParameters,
            custodianVaultParameters,
            additionalDeposit,
            ZeroAddress,
          ),
      ).to.be.revertedWithCustomError(fermionFNFTProxy, "InitialFractionalisationOnly");

      const tx2 = await fermionFNFTProxy.connect(bidders[0]).mintFractions(startTokenId, 1, additionalDeposit);
      await expect(tx2).to.emit(fermionFNFTProxy, "Fractionalised").withArgs(startTokenId, fractionsPerToken);

      // state
      // current auction should not exists
      const expectedAuctionDetails2 = {
        timer: 0n,
        maxBid: 0n,
        maxBidder: ZeroAddress,
        totalFractions: 0n,
        lockedFractions: 0n,
        lockedBidAmount: 0n,
        state: BigInt(AuctionState.NotStarted),
      };

      expect(await fermionFNFTProxy.getAuctionDetails(startTokenId)).to.eql(Object.values(expectedAuctionDetails2));

      // start an auction
      const bidAmount2 = price;
      await mockExchangeToken.connect(bidders[1]).approve(await fermionFNFTProxy.getAddress(), bidAmount2);
      const tx3 = await fermionFNFTProxy.connect(bidders[1]).bid(startTokenId, bidAmount2, fractions);
      const blockTimeStamp2 = (await tx3.getBlock()).timestamp;
      const auctionEnd2 = BigInt(blockTimeStamp2) + auctionParameters.duration;

      const expectedAuctionDetails3 = {
        timer: auctionEnd2,
        maxBid: bidAmount2,
        maxBidder: bidders[1].address,
        totalFractions: fractionsPerToken,
        lockedFractions: 0n,
        lockedBidAmount: bidAmount2,
        state: BigInt(AuctionState.Ongoing),
      };

      expect(await fermionFNFTProxy.getAuctionDetails(startTokenId)).to.eql(Object.values(expectedAuctionDetails3));
      expect(await fermionFNFTProxy.getPastAuctionDetails(startTokenId, 1, 0)).to.eql(
        Object.values(expectedAuctionDetails3),
      );
      expect(await fermionFNFTProxy.getPastAuctionDetails(startTokenId, 0, 0)).to.eql(
        Object.values(expectedAuctionDetails),
      );

      // claim the previous auction
      await expect(fermionFNFTProxy.connect(seller).claimWithLockedFractions(startTokenId, 0, fractionsPerToken))
        .to.emit(fermionFNFTProxy, "Claimed")
        .withArgs(seller.address, fractionsPerToken, bidAmount, 0);
    });

    it("Item can be recombined and fractionalisated again with new parameters", async function () {
      await fermionFNFTProxy
        .connect(seller)
        .mintFractions(
          startTokenId,
          1,
          fractionsPerToken,
          auctionParameters,
          custodianVaultParameters,
          additionalDeposit,
          ZeroAddress,
        );

      const fractions = 0n;
      const bidAmount = price;
      await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);
      const tx = await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, bidAmount, fractions);
      const blockTimeStamp = (await tx.getBlock()).timestamp;
      const auctionEnd = BigInt(blockTimeStamp) + auctionParameters.duration;
      await setNextBlockTimestamp(String(auctionEnd + 1n));
      await fermionFNFTProxy.connect(bidders[0]).redeem(startTokenId);

      // state
      const expectedAuctionDetails = {
        timer: auctionEnd,
        maxBid: bidAmount,
        maxBidder: bidders[0].address,
        totalFractions: fractionsPerToken,
        lockedFractions: fractions,
        lockedBidAmount: bidAmount,
        state: BigInt(AuctionState.Redeemed),
      };

      expect(await fermionFNFTProxy.getAuctionDetails(startTokenId)).to.eql(Object.values(expectedAuctionDetails));

      // New owner fractionalise it again and must provide new parameters
      await expect(
        fermionFNFTProxy.connect(bidders[0]).mintFractions(startTokenId, 1, additionalDeposit),
      ).to.be.revertedWithCustomError(fermionFNFTProxy, "MissingFractionalisation");

      const fractionsPerToken2 = 10000n * 10n ** 18n;
      const exitPrice2 = parseEther("10");
      // const price = exitPrice + parseEther("0.1");
      const auctionParameters2 = {
        exitPrice: exitPrice2,
        duration: 60n * 60n * 24n * 7n * 2n, // 2 weeks
        unlockThreshold: 5000n, // 50%
        topBidLockTime: 60n * 60n * 24n * 3n, // three days
      };
      const tx2 = await fermionFNFTProxy
        .connect(bidders[0])
        .mintFractions(
          startTokenId,
          1,
          fractionsPerToken2,
          auctionParameters2,
          custodianVaultParameters,
          additionalDeposit,
          ZeroAddress,
        );
      await expect(tx2).to.emit(fermionFNFTProxy, "Fractionalised").withArgs(startTokenId, fractionsPerToken2);

      expect(await fermionFNFTProxy.getBuyoutAuctionParameters(1)).to.eql(Object.values(auctionParameters2));

      // state
      // current auction should not exists
      const expectedAuctionDetails2 = {
        timer: 0n,
        maxBid: 0n,
        maxBidder: ZeroAddress,
        totalFractions: 0n,
        lockedFractions: 0n,
        lockedBidAmount: 0n,
        state: BigInt(AuctionState.NotStarted),
      };

      expect(await fermionFNFTProxy.getAuctionDetails(startTokenId)).to.eql(Object.values(expectedAuctionDetails2));

      // start an auction
      const bidAmount2 = price;
      await mockExchangeToken.connect(bidders[1]).approve(await fermionFNFTProxy.getAddress(), bidAmount2);
      const tx3 = await fermionFNFTProxy.connect(bidders[1]).bid(startTokenId, bidAmount2, fractions);
      const blockTimeStamp2 = (await tx3.getBlock()).timestamp;
      const topBidLockTime = BigInt(blockTimeStamp2) + auctionParameters2.topBidLockTime;

      const expectedAuctionDetails3 = {
        timer: topBidLockTime, // not started yet, because the exit price is higher now
        maxBid: bidAmount2,
        maxBidder: bidders[1].address,
        totalFractions: 0n,
        lockedFractions: 0n,
        lockedBidAmount: bidAmount2,
        state: BigInt(AuctionState.NotStarted), // not started yet, because the exit price is higher now
      };

      expect(await fermionFNFTProxy.getAuctionDetails(startTokenId)).to.eql(Object.values(expectedAuctionDetails3));
      expect(await fermionFNFTProxy.getPastAuctionDetails(startTokenId, 0, 1)).to.eql(
        Object.values(expectedAuctionDetails3),
      );
      expect(await fermionFNFTProxy.getPastAuctionDetails(startTokenId, 0, 0)).to.eql(
        Object.values(expectedAuctionDetails),
      );
    });
    it("Should not dillute fractions value when claiming from previous epoch", async function () {
      await fermionFNFTProxy
        .connect(seller)
        .mintFractions(
          startTokenId,
          1,
          fractionsPerToken,
          auctionParameters,
          custodianVaultParameters,
          additionalDeposit,
          ZeroAddress,
        );

      const startingBalanceSeller = await mockExchangeToken.balanceOf(seller.address);
      const startingBallanceBidder = await mockExchangeToken.balanceOf(bidders[0].address);

      const price = parseEther("3");
      const fractions = 0n;
      const bidAmount = price;

      await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);
      const tx = await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, bidAmount, fractions);
      const blockTimeStamp = (await tx.getBlock()).timestamp;
      const auctionEnd = BigInt(blockTimeStamp) + auctionParameters.duration;
      await setNextBlockTimestamp(String(auctionEnd + 1n));
      await fermionFNFTProxy.connect(bidders[0]).redeem(startTokenId);

      const fractionsPerToken2 = 2n ** 127n;
      const auctionParameters2 = {
        exitPrice: 1n,
        duration: 1n, // 1s
        unlockThreshold: 100_00n,
        topBidLockTime: 1n,
      };
      await fermionFNFTProxy
        .connect(bidders[0])
        .mintFractions(
          startTokenId,
          1,
          fractionsPerToken2,
          auctionParameters2,
          custodianVaultParameters,
          additionalDeposit,
          ZeroAddress,
        );

      // start an auction
      const bidAmount2 = 2n;
      await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount2);
      const tx3 = await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, bidAmount2, fractions);
      const blockTimeStamp2 = (await tx3.getBlock()).timestamp;
      const auctionEnd2 = BigInt(blockTimeStamp2) + auctionParameters2.duration;

      await setNextBlockTimestamp(String(auctionEnd2 + 1n));
      await fermionFNFTProxy.connect(bidders[0]).finalizeAndClaim(startTokenId, fractionsPerToken2);
      await fermionFNFTProxy.connect(bidders[0]).redeem(startTokenId);
      await fermionFNFTProxy.connect(seller).claimFromEpoch(fractionsPerToken, 0);

      const endingBalanceSeller = await mockExchangeToken.balanceOf(seller.address);
      const endingBallanceBidder = await mockExchangeToken.balanceOf(bidders[0].address);

      // Verify seller received exactly the price amount from first auction
      expect(endingBalanceSeller - startingBalanceSeller).to.equal(price);

      // Verify bidder paid exactly the price amount
      expect(startingBallanceBidder - endingBallanceBidder).to.equal(price);

      // Verify the total change in balances sums to zero (conservation of funds)
      expect(endingBalanceSeller - startingBalanceSeller + (endingBallanceBidder - startingBallanceBidder)).to.equal(
        0n,
      );
    });
  });

  context("claimFromEpoch", function () {
    context("Revert reasons", function () {
      it("Invalid claim amount", async function () {
        const currentEpoch = await fermionFNFTProxy.currentEpoch();
        await expect(fermionFNFTProxy.connect(seller).claimFromEpoch(0n, currentEpoch)).to.be.revertedWithCustomError(
          fermionFNFTProxy,
          "InvalidAmount",
        );
      });
    });
  });

  context("getPastAuctionDetails", function () {
    context("Revert reasons", function () {
      it("Invalid index", async function () {
        await expect(fermionFNFTProxy.getPastAuctionDetails(startTokenId, 1, 0))
          .to.be.revertedWithCustomError(fermionFNFTProxy, "InvalidAuctionIndex")
          .withArgs(1, 0);
      });
    });
  });

  context("voting", function () {
    const fractionsPerToken = 5000n * 10n ** 18n;
    const exitPrice = parseEther("0.1");
    const auctionParameters = {
      exitPrice: exitPrice,
      duration: 60n * 60n * 24n * 7n, // 1 week
      unlockThreshold: 5000n, // 50%
      topBidLockTime: 60n * 60n * 24n * 2n, // two days
    };
    const custodianFee = {
      amount: parseEther("0.05"),
      period: 30n * 24n * 60n * 60n, // 30 days
    };
    const custodianVaultParameters = {
      partialAuctionThreshold: custodianFee.amount * 15n,
      partialAuctionDuration: custodianFee.period / 2n,
      liquidationThreshold: custodianFee.amount * 2n,
      newFractionsPerAuction: fractionsPerToken,
    };

    const votes1 = (fractionsPerToken * 30n) / 100n; // 30%
    const votes2 = (fractionsPerToken * 45n) / 100n; // 45%

    beforeEach(async function () {
      await fermionFNFTProxy
        .connect(seller)
        .mintFractions(
          startTokenId,
          1,
          fractionsPerToken,
          auctionParameters,
          custodianVaultParameters,
          additionalDeposit,
          ZeroAddress,
        );
      const erc20Clone = await getERC20Clone(fermionFNFTProxy);
      await erc20Clone.connect(seller).transfer(bidders[0].address, votes1);
      await erc20Clone.connect(seller).transfer(bidders[1].address, votes2);
    });

    context("voteToStartAuction", function () {
      it("The fractional owner can vote to start the auction", async function () {
        const tx = await fermionFNFTProxy.connect(bidders[0]).voteToStartAuction(startTokenId, votes1);

        await expect(tx).to.emit(fermionFNFTProxy, "Voted").withArgs(startTokenId, bidders[0].address, votes1);
        await expect(tx).to.not.emit(fermionFNFTProxy, "AuctionStarted");

        // state
        const [totalVotes, threshold, availableFractions] = await fermionFNFTProxy.getVotes(startTokenId);
        expect(totalVotes).to.equal(votes1);
        expect(threshold).to.equal(applyPercentage(fractionsPerToken, auctionParameters.unlockThreshold));
        expect(availableFractions).to.equal(fractionsPerToken - votes1);
        expect(await fermionFNFTProxy.getIndividualLockedVotes(startTokenId, bidders[0].address)).to.equal(votes1);
        expect(await balanceOfERC20(fermionFNFTProxy, bidders[0].address)).to.equal(0n);
        expect(await balanceOfERC20(fermionFNFTProxy, await fermionFNFTProxy.getAddress())).to.equal(votes1);
      });

      it("The fractional owner can vote multiple times", async function () {
        const firstVote = (votes1 * 20n) / 100n;
        const tx = await fermionFNFTProxy.connect(bidders[0]).voteToStartAuction(startTokenId, firstVote);

        await expect(tx).to.emit(fermionFNFTProxy, "Voted").withArgs(startTokenId, bidders[0].address, firstVote);

        // state
        const [totalVotes, threshold, availableFractions] = await fermionFNFTProxy.getVotes(startTokenId);
        expect(totalVotes).to.equal(firstVote);
        expect(threshold).to.equal(applyPercentage(fractionsPerToken, auctionParameters.unlockThreshold));
        expect(availableFractions).to.equal(fractionsPerToken - firstVote);
        expect(await fermionFNFTProxy.getIndividualLockedVotes(startTokenId, bidders[0].address)).to.equal(firstVote);
        expect(await balanceOfERC20(fermionFNFTProxy, bidders[0].address)).to.equal(votes1 - firstVote);
        expect(await balanceOfERC20(fermionFNFTProxy, await fermionFNFTProxy.getAddress())).to.equal(firstVote);

        const secondVote = votes1 - firstVote;
        const tx2 = await fermionFNFTProxy.connect(bidders[0]).voteToStartAuction(startTokenId, secondVote);

        await expect(tx2).to.emit(fermionFNFTProxy, "Voted").withArgs(startTokenId, bidders[0].address, secondVote);

        // state
        const [totalVotes2, threshold2, availableFractions2] = await fermionFNFTProxy.getVotes(startTokenId);
        expect(totalVotes2).to.equal(firstVote + secondVote);
        expect(threshold2).to.equal(applyPercentage(fractionsPerToken, auctionParameters.unlockThreshold));
        expect(availableFractions2).to.equal(fractionsPerToken - firstVote - secondVote);
        expect(await fermionFNFTProxy.getIndividualLockedVotes(startTokenId, bidders[0].address)).to.equal(votes1);
        expect(await balanceOfERC20(fermionFNFTProxy, bidders[0].address)).to.equal(0n);
        expect(await balanceOfERC20(fermionFNFTProxy, await fermionFNFTProxy.getAddress())).to.equal(
          firstVote + secondVote,
        );
      });

      it("When total votes exceeds threshold, the auction starts", async function () {
        const bidAmount = exitPrice - parseEther("0.01");
        await mockExchangeToken.connect(bidders[2]).approve(await fermionFNFTProxy.getAddress(), bidAmount);
        await fermionFNFTProxy.connect(bidders[2]).bid(startTokenId, bidAmount, 0n);

        const tx = await fermionFNFTProxy.connect(bidders[0]).voteToStartAuction(startTokenId, votes1);
        await expect(tx).to.not.emit(fermionFNFTProxy, "AuctionStarted");

        const tx2 = await fermionFNFTProxy.connect(bidders[1]).voteToStartAuction(startTokenId, votes2);
        const blockTimeStamp = (await tx2.getBlock()).timestamp;
        const auctionEnd = BigInt(blockTimeStamp) + auctionParameters.duration;
        await expect(tx2).to.emit(fermionFNFTProxy, "AuctionStarted").withArgs(startTokenId, auctionEnd, 0);

        // state
        const [totalVotes, threshold, availableFractions] = await fermionFNFTProxy.getVotes(startTokenId);
        expect(totalVotes).to.equal(votes1 + votes2);
        expect(threshold).to.equal(applyPercentage(fractionsPerToken, auctionParameters.unlockThreshold));
        expect(availableFractions).to.equal(fractionsPerToken - votes1 - votes2);
        expect(await fermionFNFTProxy.getIndividualLockedVotes(startTokenId, bidders[0].address)).to.equal(votes1);
        expect(await fermionFNFTProxy.getIndividualLockedVotes(startTokenId, bidders[1].address)).to.equal(votes2);
        expect(await balanceOfERC20(fermionFNFTProxy, bidders[0].address)).to.equal(0n);
        expect(await balanceOfERC20(fermionFNFTProxy, bidders[1].address)).to.equal(0n);
        expect(await balanceOfERC20(fermionFNFTProxy, await fermionFNFTProxy.getAddress())).to.equal(votes1 + votes2);
      });

      it("When total votes match the threshold exactly, the auction starts", async function () {
        const bidAmount = exitPrice - parseEther("0.01");
        await mockExchangeToken.connect(bidders[2]).approve(await fermionFNFTProxy.getAddress(), bidAmount);
        await fermionFNFTProxy.connect(bidders[2]).bid(startTokenId, bidAmount, 0n);

        await fermionFNFTProxy.connect(bidders[0]).voteToStartAuction(startTokenId, votes1);

        const requiredVotes = applyPercentage(fractionsPerToken, auctionParameters.unlockThreshold) - votes1;

        const tx = await fermionFNFTProxy.connect(bidders[1]).voteToStartAuction(startTokenId, requiredVotes);
        await expect(tx).to.emit(fermionFNFTProxy, "AuctionStarted");
      });

      it("Voting with more than available votes", async function () {
        const bidAmount = exitPrice - parseEther("0.01");
        await mockExchangeToken.connect(bidders[2]).approve(await fermionFNFTProxy.getAddress(), bidAmount);
        await fermionFNFTProxy.connect(bidders[2]).bid(startTokenId, bidAmount, 0n);

        // fractionalise another token and transfer the fractions to the bidder
        await fermionFNFTProxy.connect(seller).mintFractions(startTokenId + 1n, 1, additionalDeposit);
        const erc20Clone = await getERC20Clone(fermionFNFTProxy);
        await erc20Clone.connect(seller).transfer(bidders[0].address, fractionsPerToken);

        await fermionFNFTProxy.connect(bidders[0]).voteToStartAuction(startTokenId, votes1);
        await fermionFNFTProxy.connect(bidders[0]).voteToStartAuction(startTokenId, fractionsPerToken);

        // state
        const [totalVotes, threshold, availableFractions] = await fermionFNFTProxy.getVotes(startTokenId);
        expect(totalVotes).to.equal(fractionsPerToken);
        expect(threshold).to.equal(applyPercentage(fractionsPerToken, auctionParameters.unlockThreshold));
        expect(availableFractions).to.equal(0n);
        expect(await fermionFNFTProxy.getIndividualLockedVotes(startTokenId, bidders[0].address)).to.equal(
          fractionsPerToken,
        );
        expect(await balanceOfERC20(fermionFNFTProxy, bidders[0].address)).to.equal(votes1);
        expect(await balanceOfERC20(fermionFNFTProxy, await fermionFNFTProxy.getAddress())).to.equal(fractionsPerToken);
      });

      it("It's possible to vote after the auction started", async function () {
        const bidAmount = exitPrice + parseEther("0.01");
        await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);
        await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, bidAmount, 0n);

        await expect(fermionFNFTProxy.connect(bidders[1]).voteToStartAuction(startTokenId, votes2))
          .to.emit(fermionFNFTProxy, "Voted")
          .withArgs(startTokenId, bidders[1].address, votes2);
      });

      context("Revert reasons", function () {
        it("Amount to lock is 0", async function () {
          const votes = 0;
          await expect(
            fermionFNFTProxy.connect(bidders[0]).voteToStartAuction(startTokenId, votes),
          ).to.be.revertedWithCustomError(fermionFNFTProxy, "InvalidAmount");
        });

        it("Token is not fractionalised", async function () {
          await expect(fermionFNFTProxy.connect(bidders[0]).voteToStartAuction(startTokenId + 1n, votes1))
            .to.be.revertedWithCustomError(fermionFNFTProxy, "TokenNotFractionalised")
            .withArgs(startTokenId + 1n);
        });

        it("Voter is the current max bidder", async function () {
          const bidAmount = exitPrice - parseEther("0.01");
          await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);
          await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, bidAmount, 0n);

          await expect(fermionFNFTProxy.connect(bidders[0]).voteToStartAuction(startTokenId, votes1))
            .to.be.revertedWithCustomError(fermionFNFTProxy, "MaxBidderCannotVote")
            .withArgs(startTokenId);
        });

        it("No bids available", async function () {
          await fermionFNFTProxy.connect(bidders[0]).voteToStartAuction(startTokenId, votes1);

          await expect(fermionFNFTProxy.connect(bidders[1]).voteToStartAuction(startTokenId, votes2))
            .to.be.revertedWithCustomError(fermionFNFTProxy, "NoBids")
            .withArgs(startTokenId);
        });

        context("No votes available", function () {
          beforeEach(async function () {
            // mint additional fractions
            await fermionFNFTProxy.connect(seller).mintFractions(startTokenId + 1n, 1, additionalDeposit);
          });

          it("All consumed by votes", async function () {
            const bidAmount = exitPrice + parseEther("0.01");
            await mockExchangeToken.connect(bidders[1]).approve(await fermionFNFTProxy.getAddress(), bidAmount);
            await fermionFNFTProxy.connect(bidders[1]).bid(startTokenId, bidAmount, 0n);

            await fermionFNFTProxy.connect(seller).voteToStartAuction(startTokenId, fractionsPerToken);

            await expect(fermionFNFTProxy.connect(bidders[0]).voteToStartAuction(startTokenId, votes1))
              .to.be.revertedWithCustomError(fermionFNFTProxy, "NoFractionsAvailable")
              .withArgs(startTokenId);
          });

          it("Partially consumed by bid-locked votes", async function () {
            const bidAmount = exitPrice + parseEther("0.01");
            await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);
            await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, bidAmount, votes1);

            await fermionFNFTProxy.connect(seller).voteToStartAuction(startTokenId, fractionsPerToken);

            await expect(fermionFNFTProxy.connect(bidders[1]).voteToStartAuction(startTokenId, votes2))
              .to.be.revertedWithCustomError(fermionFNFTProxy, "NoFractionsAvailable")
              .withArgs(startTokenId);
          });
        });

        it("The voter does not have enough fractions", async function () {
          await expect(fermionFNFTProxy.connect(bidders[0]).voteToStartAuction(startTokenId, votes1 + 1n))
            .to.be.revertedWithCustomError(await getERC20Clone(fermionFNFTProxy), "ERC20InsufficientBalance")
            .withArgs(bidders[0].address, votes1, votes1 + 1n);
        });

        it("Token was recombined, but not fractionalised again", async function () {
          const bidAmount = exitPrice + parseEther("0.01");
          await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);
          const tx = await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, bidAmount, 0n);
          const blockTimeStamp = (await tx.getBlock()).timestamp;
          const auctionEnd = BigInt(blockTimeStamp) + auctionParameters.duration;
          await setNextBlockTimestamp(String(auctionEnd + 1n));
          await fermionFNFTProxy.connect(bidders[0]).redeem(startTokenId);

          await expect(fermionFNFTProxy.connect(bidders[0]).voteToStartAuction(startTokenId, votes1))
            .to.be.revertedWithCustomError(fermionFNFTProxy, "TokenNotFractionalised")
            .withArgs(startTokenId);
        });
      });
    });

    context("removeVoteToStartAuction", function () {
      const votesToRemove = (votes1 * 20n) / 100n; // remove 20% of votes
      beforeEach(async function () {
        await fermionFNFTProxy.connect(bidders[0]).voteToStartAuction(startTokenId, votes1);
      });

      it("The fractional owner remove the votes", async function () {
        const tx = await fermionFNFTProxy.connect(bidders[0]).removeVoteToStartAuction(startTokenId, votesToRemove);

        await expect(tx)
          .to.emit(fermionFNFTProxy, "VoteRemoved")
          .withArgs(startTokenId, bidders[0].address, votesToRemove);

        // state
        const [totalVotes, threshold, availableFractions] = await fermionFNFTProxy.getVotes(startTokenId);
        await expect(totalVotes).to.equal(votes1 - votesToRemove);
        await expect(threshold).to.equal(applyPercentage(fractionsPerToken, auctionParameters.unlockThreshold));
        await expect(availableFractions).to.equal(fractionsPerToken - votes1 + votesToRemove);
        expect(await fermionFNFTProxy.getIndividualLockedVotes(startTokenId, bidders[0].address)).to.equal(
          votes1 - votesToRemove,
        );
        expect(await balanceOfERC20(fermionFNFTProxy, bidders[0].address)).to.equal(votesToRemove);
        expect(await balanceOfERC20(fermionFNFTProxy, await fermionFNFTProxy.getAddress())).to.equal(
          votes1 - votesToRemove,
        );
      });

      it("The fractional owner can remove the votes multiple times", async function () {
        const tx = await fermionFNFTProxy.connect(bidders[0]).removeVoteToStartAuction(startTokenId, votesToRemove);

        await expect(tx)
          .to.emit(fermionFNFTProxy, "VoteRemoved")
          .withArgs(startTokenId, bidders[0].address, votesToRemove);

        const remainder = votes1 - votesToRemove;
        const tx2 = await fermionFNFTProxy.connect(bidders[0]).removeVoteToStartAuction(startTokenId, remainder);

        await expect(tx2)
          .to.emit(fermionFNFTProxy, "VoteRemoved")
          .withArgs(startTokenId, bidders[0].address, remainder);

        // state
        const [totalVotes2, threshold2, availableFractions2] = await fermionFNFTProxy.getVotes(startTokenId);
        await expect(totalVotes2).to.equal(0n);
        await expect(threshold2).to.equal(applyPercentage(fractionsPerToken, auctionParameters.unlockThreshold));
        await expect(availableFractions2).to.equal(fractionsPerToken);
        expect(await fermionFNFTProxy.getIndividualLockedVotes(startTokenId, bidders[0].address)).to.equal(0n);
        expect(await balanceOfERC20(fermionFNFTProxy, bidders[0].address)).to.equal(votes1);
        expect(await balanceOfERC20(fermionFNFTProxy, await fermionFNFTProxy.getAddress())).to.equal(0n);
      });

      context("Revert reasons", function () {
        it("Amount to remove is 0", async function () {
          const votes = 0;
          await expect(
            fermionFNFTProxy.connect(bidders[0]).removeVoteToStartAuction(startTokenId, votes),
          ).to.be.revertedWithCustomError(fermionFNFTProxy, "InvalidAmount");
        });

        it("Auction already started - via payment above exit price", async function () {
          const bidAmount = exitPrice + parseEther("0.01");
          await mockExchangeToken.connect(bidders[3]).approve(await fermionFNFTProxy.getAddress(), bidAmount);
          const tx = await fermionFNFTProxy.connect(bidders[3]).bid(startTokenId, bidAmount, 0n);
          const blockTimeStamp = (await tx.getBlock()).timestamp;
          const auctionEnd = BigInt(blockTimeStamp) + auctionParameters.duration;

          await expect(fermionFNFTProxy.connect(bidders[0]).removeVoteToStartAuction(startTokenId, votes1))
            .to.be.revertedWithCustomError(fermionFNFTProxy, "AuctionOngoing")
            .withArgs(startTokenId, auctionEnd);
        });

        it("Auction already started - via vote over threshold", async function () {
          const bidAmount = exitPrice - parseEther("0.01");
          await mockExchangeToken.connect(bidders[3]).approve(await fermionFNFTProxy.getAddress(), bidAmount);
          await fermionFNFTProxy.connect(bidders[3]).bid(startTokenId, bidAmount, 0n);

          const tx = await fermionFNFTProxy.connect(bidders[1]).voteToStartAuction(startTokenId, votes2);
          const blockTimeStamp = (await tx.getBlock()).timestamp;
          const auctionEnd = BigInt(blockTimeStamp) + auctionParameters.duration;

          await expect(fermionFNFTProxy.connect(bidders[0]).removeVoteToStartAuction(startTokenId, votes1))
            .to.be.revertedWithCustomError(fermionFNFTProxy, "AuctionOngoing")
            .withArgs(startTokenId, auctionEnd);
        });

        it("The voter tries to withdraw more than they locked", async function () {
          await expect(fermionFNFTProxy.connect(bidders[0]).removeVoteToStartAuction(startTokenId, votes1 + 1n))
            .to.be.revertedWithCustomError(fermionFNFTProxy, "NotEnoughLockedVotes")
            .withArgs(startTokenId, votes1 + 1n, votes1);
        });

        it("The voter used the votes to place a bid", async function () {
          const bidAmount = exitPrice - parseEther("0.01");
          await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);
          await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, bidAmount, 0n);

          await expect(fermionFNFTProxy.connect(bidders[0]).removeVoteToStartAuction(startTokenId, votes1))
            .to.be.revertedWithCustomError(fermionFNFTProxy, "MaxBidderCannotVote")
            .withArgs(startTokenId);
        });
      });
    });
  });

  context("updateExitPrice", function () {
    let mockOracle: any;
    let mockOracleAddress: any;
    let owner1: any, owner2: HardhatEthersSigner;

    const MIN_GOV_VOTE_DURATION = 86400;
    const fractionsAmount = 5000n * 10n ** 18n;
    const auctionParameters = {
      exitPrice: parseEther("0.1"),
      duration: 60n * 60n * 24n * 7n, // 1 week
      unlockThreshold: 7500n, // 75%
      topBidLockTime: 60n * 60n * 24n * 2n, // two days
    };
    const custodianFee = {
      amount: parseEther("0.05"),
      period: 30n * 24n * 60n * 60n, // 30 days
    };
    const custodianVaultParameters = {
      partialAuctionThreshold: custodianFee.amount * 15n,
      partialAuctionDuration: custodianFee.period / 2n,
      liquidationThreshold: custodianFee.amount * 2n,
      newFractionsPerAuction: fractionsAmount * 2n,
    };

    beforeEach(async function () {
      owner1 = seller;
      owner2 = bidders[0];
      const MockPriceOracle = await ethers.getContractFactory("MockPriceOracle");
      mockOracle = await MockPriceOracle.deploy();
      mockOracleAddress = await mockOracle.getAddress();
      await mockOracle.setPrice(parseEther("1.5"));
      await fermionMock.addPriceOracle(mockOracleAddress, encodeBytes32String("GOLD"));
    });

    context("Oracle-based updates", function () {
      beforeEach(async function () {
        fermionFNFTProxy = fermionFNFTProxy.connect(seller);

        await fermionFNFTProxy.mintFractions(
          startTokenId,
          1,
          fractionsAmount,
          auctionParameters,
          custodianVaultParameters,
          additionalDeposit,
          mockOracleAddress,
        );
      });

      it("should update the exit price using oracle when valid and added to registry", async function () {
        await mockOracle.setPrice(parseEther("2.5"));
        await mockOracle.enableInvalidPriceRevert(false);
        await mockOracle.enableOtherErrorRevert(false);
        await expect(fermionFNFTProxy.updateExitPrice(0, 7500, MIN_GOV_VOTE_DURATION))
          .to.emit(fermionFNFTProxy, "ExitPriceUpdated")
          .withArgs(parseEther("2.5"), true);
      });

      it("should revert if oracle returns a different error", async function () {
        await mockOracle.enableInvalidPriceRevert(false);
        await mockOracle.enableOtherErrorRevert(true);
        await expect(fermionFNFTProxy.updateExitPrice(0, 7500, MIN_GOV_VOTE_DURATION)).to.be.revertedWithCustomError(
          fermionFNFTProxy,
          "OracleInternalError",
        );
      });

      it("should fallback to governance if oracle returns InvalidPrice()", async function () {
        await mockOracle.enableInvalidPriceRevert(true);

        const tx = await fermionFNFTProxy.updateExitPrice(parseEther("2"), 7500, MIN_GOV_VOTE_DURATION);
        const blockTimestamp = await getBlockTimestampFromTransaction(tx);

        await expect(tx)
          .to.emit(fermionFNFTProxy, "PriceUpdateProposalCreated")
          .withArgs(1, parseEther("2"), blockTimestamp + MIN_GOV_VOTE_DURATION, 7500);
      });

      it("should fallback to governance if oracle is not whitelisted in registry", async function () {
        await fermionMock.removePriceOracle(mockOracleAddress);
        await mockOracle.setPrice(parseEther("2.5"));
        await mockOracle.enableInvalidPriceRevert(false);
        await mockOracle.enableOtherErrorRevert(false);

        const tx = await fermionFNFTProxy.updateExitPrice(parseEther("2"), 7500, MIN_GOV_VOTE_DURATION);
        const blockTimestamp = await getBlockTimestampFromTransaction(tx);

        await expect(tx)
          .to.emit(fermionFNFTProxy, "PriceUpdateProposalCreated")
          .withArgs(1, parseEther("2"), blockTimestamp + MIN_GOV_VOTE_DURATION, 7500);
      });
    });

    context("Governance based updates", function () {
      beforeEach(async function () {
        fermionFNFTProxy = fermionFNFTProxy.connect(seller);

        await fermionFNFTProxy.mintFractions(
          startTokenId,
          1,
          fractionsAmount,
          auctionParameters,
          custodianVaultParameters,
          additionalDeposit,
          ZeroAddress,
        );
      });

      // Proposal Creation Tests
      context("Proposal Creation", function () {
        it("should create a proposal with valid parameters", async function () {
          const tx = await fermionFNFTProxy.updateExitPrice(parseEther("2"), 7500, MIN_GOV_VOTE_DURATION);
          const blockTimestamp = await getBlockTimestampFromTransaction(tx);

          await expect(tx)
            .to.emit(fermionFNFTProxy, "PriceUpdateProposalCreated")
            .withArgs(1, parseEther("2"), blockTimestamp + MIN_GOV_VOTE_DURATION, 7500);

          const proposal = await fermionFNFTProxy.getCurrentProposalDetails();
          expect(proposal.proposalId).to.equal(1);
          expect(proposal.newExitPrice).to.equal(parseEther("2"));
          expect(proposal.votingDeadline).to.equal(blockTimestamp + MIN_GOV_VOTE_DURATION);
          expect(proposal.quorumPercent).to.equal(7500);
          expect(proposal.state).to.equal(PriceUpdateProposalState.Active);
        });

        it("should create a proposal with default gov duration", async function () {
          const tx = await fermionFNFTProxy.updateExitPrice(parseEther("2"), 7500, 0);
          const blockTimestamp = await getBlockTimestampFromTransaction(tx);

          await expect(tx)
            .to.emit(fermionFNFTProxy, "PriceUpdateProposalCreated")
            .withArgs(1, parseEther("2"), blockTimestamp + DEFAULT_GOV_VOTE_DURATION, 7500);

          const proposal = await fermionFNFTProxy.getCurrentProposalDetails();
          expect(proposal.proposalId).to.equal(1);
          expect(proposal.newExitPrice).to.equal(parseEther("2"));
          expect(proposal.votingDeadline).to.equal(blockTimestamp + DEFAULT_GOV_VOTE_DURATION);
          expect(proposal.quorumPercent).to.equal(7500);
          expect(proposal.state).to.equal(PriceUpdateProposalState.Active);
        });

        it("should allow querying the current proposal state", async function () {
          await fermionFNFTProxy.updateExitPrice(parseEther("2"), 7500, DEFAULT_GOV_VOTE_DURATION);

          const proposal = await fermionFNFTProxy.getCurrentProposalDetails();
          expect(proposal.proposalId).to.equal(1);
          expect(proposal.newExitPrice).to.equal(parseEther("2"));
          expect(proposal.yesVotes).to.equal(0);
          expect(proposal.noVotes).to.equal(0);
          expect(proposal.state).to.equal(PriceUpdateProposalState.Active); // Active state
        });

        it("should revert if caller is not a fraction owner", async function () {
          const unauthorized = bidders[1]; // A wallet with no fractions
          await expect(
            fermionFNFTProxy.connect(unauthorized).updateExitPrice(parseEther("2"), 7500, MIN_GOV_VOTE_DURATION),
          ).to.be.revertedWithCustomError(fermionFNFTProxy, "OnlyFractionOwner");
        });

        it("should revert for invalid quorum percentage", async function () {
          const MIN_QUORUM_PERCENT = 2000n; // 20%
          const HUNDRED_PERCENT = 10000n; // 100%

          await expect(
            fermionFNFTProxy.updateExitPrice(parseEther("2"), MIN_QUORUM_PERCENT - 1n, MIN_GOV_VOTE_DURATION),
          ).to.be.revertedWithCustomError(fermionFNFTProxy, "InvalidPercentage");

          await expect(
            fermionFNFTProxy.updateExitPrice(parseEther("2"), HUNDRED_PERCENT + 1n, MIN_GOV_VOTE_DURATION),
          ).to.be.revertedWithCustomError(fermionFNFTProxy, "InvalidPercentage");
        });

        it("should revert for invalid vote duration (too short)", async function () {
          await expect(
            fermionFNFTProxy.updateExitPrice(parseEther("2"), 7500, MIN_GOV_VOTE_DURATION - 1),
          ).to.be.revertedWithCustomError(fermionFNFTProxy, "InvalidVoteDuration");
        });

        it("should revert for invalid vote duration (too long)", async function () {
          await expect(
            fermionFNFTProxy.updateExitPrice(parseEther("2"), 7500, MAX_GOV_VOTE_DURATION + 1),
          ).to.be.revertedWithCustomError(fermionFNFTProxy, "InvalidVoteDuration");
        });

        it("should revert if a proposal is already active", async function () {
          await fermionFNFTProxy.updateExitPrice(parseEther("2"), 7500, MIN_GOV_VOTE_DURATION);
          await expect(
            fermionFNFTProxy.updateExitPrice(parseEther("3"), 7500, MIN_GOV_VOTE_DURATION),
          ).to.be.revertedWithCustomError(fermionFNFTProxy, "OngoingProposalExists");
        });
      });
      context("Voting on Proposals", function () {
        it("should allow fraction owners to vote", async function () {
          const owner1Balance = await balanceOfERC20(fermionFNFTProxy, owner1.address);

          await fermionFNFTProxy.updateExitPrice(parseEther("2"), 7500, MIN_GOV_VOTE_DURATION);
          const tx = await fermionFNFTProxy.connect(owner1).voteOnProposal(1, true);

          expect(tx).to.emit(fermionFNFTProxy, "PriceUpdateVoted").withArgs(1, owner1.address, owner1Balance, true);

          const proposal = await fermionFNFTProxy.getCurrentProposalDetails();
          expect(proposal.yesVotes).to.equal(owner1Balance);

          const voterDetails = await fermionFNFTProxy.getVoterDetails(owner1.address);
          expect(voterDetails.proposalId).to.equal(1);
          expect(voterDetails.voteCount).to.equal(owner1Balance);
        });
        it("should allow a voter to update their vote count with additional fractions", async function () {
          await fermionFNFTProxy.updateExitPrice(parseEther("2"), 7500, MIN_GOV_VOTE_DURATION);
          const initialVoteAmount = await balanceOfERC20(fermionFNFTProxy, owner1.address);

          // Transfer some fractions from owner1 to owner2 initially to set up the test.
          const setupTransferAmount = parseEther("2");
          const erc20Clone = await getERC20Clone(fermionFNFTProxy);
          await erc20Clone.connect(owner1).transfer(owner2.address, setupTransferAmount);

          // Verify initial balances
          const owner1InitialBalance = await balanceOfERC20(fermionFNFTProxy, owner1.address);
          const owner2InitialBalance = await balanceOfERC20(fermionFNFTProxy, owner2.address);
          expect(owner1InitialBalance).to.equal(initialVoteAmount - setupTransferAmount);
          expect(owner2InitialBalance).to.equal(setupTransferAmount);

          // Cast an initial vote from owner1.
          await fermionFNFTProxy.connect(owner1).voteOnProposal(1, true);
          let proposal = await fermionFNFTProxy.getCurrentProposalDetails();
          expect(proposal.yesVotes).to.equal(owner1InitialBalance);

          // Transfer additional fractions back to owner1 from owner2.
          const additionalFractions = parseEther("1");
          await erc20Clone.connect(owner2).transfer(owner1.address, additionalFractions);

          await fermionFNFTProxy.connect(owner1).voteOnProposal(1, true);

          proposal = await fermionFNFTProxy.getCurrentProposalDetails();
          expect(proposal.yesVotes).to.equal(owner1InitialBalance + additionalFractions);

          const voterDetails = await fermionFNFTProxy.getVoterDetails(owner1.address);
          expect(voterDetails.voteCount).to.equal(owner1InitialBalance + additionalFractions);
          expect(voterDetails.votedYes).to.equal(true);
        });
        it("should handle vote transfers and preserve vote count when remaining balance supports it", async function () {
          // Step 1: Get `owner1`'s initial balance of fractions
          const owner1Balance = await balanceOfERC20(fermionFNFTProxy, owner1.address);
          const transferAmount = owner1Balance / 4n; // Smaller transfer amount to ensure remaining balance is sufficient

          // Step 2: Create a governance proposal and cast a NO vote using `owner1`
          const tx = await fermionFNFTProxy.updateExitPrice(parseEther("2"), 7500, MIN_GOV_VOTE_DURATION);
          await fermionFNFTProxy.connect(owner1).voteOnProposal(1, false);

          // Verify initial proposal state
          let proposal = await fermionFNFTProxy.getCurrentProposalDetails();
          expect(proposal.noVotes).to.equal(owner1Balance);

          // Step 3: Transfer fractions from `owner1` to `owner2`, leaving enough balance to support the vote count
          const remainingBalance = owner1Balance - transferAmount;
          const erc20Clone = await getERC20Clone(fermionFNFTProxy);
          await erc20Clone.connect(owner1).transfer(owner2.address, transferAmount);

          // Try to adjust votes on transfer if the caller is not the current epoch's ERC20 clone (nothing should happen)
          await fermionFNFTProxy.connect(owner2).adjustVotesOnTransfer(owner1.address, transferAmount);

          // Verify no votes are removed, as remaining balance supports the vote count
          proposal = await fermionFNFTProxy.getCurrentProposalDetails();
          let voterDetails = await fermionFNFTProxy.getVoterDetails(owner1.address);

          expect(remainingBalance).to.be.gte(voterDetails.voteCount);
          expect(proposal.noVotes).to.equal(remainingBalance);
          expect(voterDetails.voteCount).to.equal(remainingBalance);

          // Step 4: Transfer additional fractions to make the remaining balance insufficient
          await erc20Clone.connect(owner1).transfer(owner2.address, remainingBalance);

          // Verify `proposal.noVotes` is adjusted, and `owner1`'s vote count is reset
          proposal = await fermionFNFTProxy.getCurrentProposalDetails();
          voterDetails = await fermionFNFTProxy.getVoterDetails(owner1.address);

          expect(proposal.noVotes).to.equal(0);
          expect(voterDetails.voteCount).to.equal(0);

          // Step 5: Allow `owner2` to cast a vote with the newly acquired fractions
          await fermionFNFTProxy.connect(owner2).voteOnProposal(1, false);

          // Verify `proposal.noVotes` reflects the original total balance (transferred from `owner1` to `owner2`)
          const currentProposalDetails = await fermionFNFTProxy.getCurrentProposalDetails();
          expect(currentProposalDetails.noVotes).to.equal(owner1Balance);

          // Step 6: Finalize the current proposal to allow creation of a new one
          await setNextBlockTimestamp(Number((await getBlockTimestampFromTransaction(tx)) + MIN_GOV_VOTE_DURATION + 1));
          await fermionFNFTProxy.connect(owner2).voteOnProposal(1, false); // Finalize the proposal

          // Verify the proposal is finalized
          const finalizedProposal = await fermionFNFTProxy.getCurrentProposalDetails();
          expect(finalizedProposal.state).to.equal(PriceUpdateProposalState.Failed);

          // Additional Scenario: Ensure vote count is preserved when remaining balance supports it
          const initialVoteCount = 1n;
          const smallTransferAmount = 2n;

          // Step 7: Distribute fractions by transferring from `owner2` to `owner1`
          await erc20Clone.connect(owner2).transfer(owner1.address, smallTransferAmount + initialVoteCount);

          // Create a new proposal and cast a vote with `owner1`'s new balance
          await fermionFNFTProxy.updateExitPrice(parseEther("3"), 7500, MIN_GOV_VOTE_DURATION);
          await fermionFNFTProxy.connect(owner1).voteOnProposal(2, false);

          // Verify updated vote count matches transferred balance
          proposal = await fermionFNFTProxy.getCurrentProposalDetails();
          voterDetails = await fermionFNFTProxy.getVoterDetails(owner1.address);

          const expectedVoteCount = smallTransferAmount + initialVoteCount;
          expect(proposal.noVotes).to.equal(expectedVoteCount);
          expect(voterDetails.voteCount).to.equal(expectedVoteCount);
        });
        it("should preserve votes when remaining balance >= vote count after transfers", async function () {
          // Step 1: Owner1's initial setup
          const owner1Balance = await balanceOfERC20(fermionFNFTProxy, owner1.address);
          const transferAmountA = owner1Balance / 4n; // A smaller portion of Owner1's balance
          const transferAmountX = owner1Balance / 8n; // An even smaller transfer

          // Step 2: Create a governance proposal and Owner1 votes NO
          await fermionFNFTProxy.updateExitPrice(parseEther("2"), 7500, MIN_GOV_VOTE_DURATION);
          await fermionFNFTProxy.connect(owner1).voteOnProposal(1, false);

          // Verify initial proposal state
          let proposal = await fermionFNFTProxy.getCurrentProposalDetails();
          const voterDetails = await fermionFNFTProxy.getVoterDetails(owner1.address);
          expect(proposal.noVotes).to.equal(owner1Balance);
          expect(voterDetails.voteCount).to.equal(owner1Balance);

          // Step 3: Owner1 transfers A amount to Owner2
          const erc20Clone = await getERC20Clone(fermionFNFTProxy);
          await erc20Clone.connect(owner1).transfer(owner2.address, transferAmountA);

          // Verify Owner1's votes are reduced, and the remaining balance supports the vote count
          const owner1RemainingBalance = await balanceOfERC20(fermionFNFTProxy, owner1.address);
          expect(owner1RemainingBalance).to.be.equal(voterDetails.voteCount - transferAmountA);

          // Step 4: Owner2 votes with the received A amount
          await fermionFNFTProxy.connect(owner2).voteOnProposal(1, true);

          proposal = await fermionFNFTProxy.getCurrentProposalDetails();
          let owner2VoterDetails = await fermionFNFTProxy.getVoterDetails(owner2.address);
          expect(proposal.yesVotes).to.equal(transferAmountA);
          expect(owner2VoterDetails.voteCount).to.equal(transferAmountA);

          // Step 5: Owner1 transfers X amount to Owner2
          await erc20Clone.connect(owner1).transfer(owner2.address, transferAmountX);

          // Step 6: Owner2 transfers X amount back to Owner1
          await erc20Clone.connect(owner2).transfer(owner1.address, transferAmountX);

          // Step 7: Verify that Owner2's votes remain untouched
          proposal = await fermionFNFTProxy.getCurrentProposalDetails();
          owner2VoterDetails = await fermionFNFTProxy.getVoterDetails(owner2.address);

          expect(proposal.yesVotes).to.equal(transferAmountA); // Owner2's votes remain unchanged
          expect(owner2VoterDetails.voteCount).to.equal(transferAmountA); // Vote count is unchanged
        });
        it("should revert for double voting", async function () {
          await fermionFNFTProxy.updateExitPrice(parseEther("2"), 7500, MIN_GOV_VOTE_DURATION);
          await fermionFNFTProxy.connect(owner1).voteOnProposal(1, true);

          await expect(fermionFNFTProxy.connect(owner1).voteOnProposal(1, true)).to.be.revertedWithCustomError(
            fermionFNFTProxy,
            "AlreadyVoted",
          );
        });

        it("should revert if the voter has no fractions", async function () {
          await fermionFNFTProxy.updateExitPrice(parseEther("2"), 7500, MIN_GOV_VOTE_DURATION);
          const random = wallets[11]; //random wallet
          await expect(fermionFNFTProxy.connect(random).voteOnProposal(1, true)).to.be.revertedWithCustomError(
            fermionFNFTProxy,
            "NoVotingPower",
          );
        });

        it("should revert if a voter changes vote direction", async function () {
          await fermionFNFTProxy.updateExitPrice(parseEther("2"), 7500, MIN_GOV_VOTE_DURATION);
          await fermionFNFTProxy.connect(owner1).voteOnProposal(1, true);
          await expect(fermionFNFTProxy.connect(owner1).voteOnProposal(1, false)).to.be.revertedWithCustomError(
            fermionFNFTProxy,
            "ConflictingVote",
          );
        });
        context("removeVoteOnProposal", function () {
          beforeEach(async function () {
            await fermionFNFTProxy.updateExitPrice(parseEther("2"), 7500, MIN_GOV_VOTE_DURATION);
          });
          it("should correctly update vote counts for NO votes when removed", async function () {
            // Step 1: Cast a NO vote
            const owner1Balance = await balanceOfERC20(fermionFNFTProxy, owner1);
            await fermionFNFTProxy.connect(owner1).voteOnProposal(1, false);

            // Step 2: Verify the initial state of the proposal
            let proposal = await fermionFNFTProxy.getCurrentProposalDetails();
            expect(proposal.noVotes).to.equal(owner1Balance);

            const voterDetails = await fermionFNFTProxy.getVoterDetails(owner1.address);
            expect(voterDetails.voteCount).to.equal(owner1Balance);
            expect(voterDetails.votedYes).to.equal(false);

            // Step 3: Remove the NO vote
            const tx = await fermionFNFTProxy.connect(owner1).removeVoteOnProposal();

            // Verify emitted event
            await expect(tx)
              .to.emit(fermionFNFTProxy, "PriceUpdateVoteRemoved")
              .withArgs(proposal.proposalId, owner1.address, owner1Balance, false);

            // Step 4: Verify the proposal state after vote removal
            proposal = await fermionFNFTProxy.getCurrentProposalDetails();
            expect(proposal.noVotes).to.equal(0);

            const updatedVoterDetails = await fermionFNFTProxy.getVoterDetails(owner1.address);
            expect(updatedVoterDetails.voteCount).to.equal(0);
          });
          it("should allow a voter to remove their vote on an active proposal", async function () {
            // Step 1: Cast a YES vote
            const owner1Balance = await balanceOfERC20(fermionFNFTProxy, owner1);
            await fermionFNFTProxy.connect(owner1).voteOnProposal(1, true);

            // Step 2: Verify the initial state of the proposal
            let proposal = await fermionFNFTProxy.getCurrentProposalDetails();
            expect(proposal.yesVotes).to.equal(owner1Balance);

            const voterDetails = await fermionFNFTProxy.getVoterDetails(owner1.address);
            expect(voterDetails.voteCount).to.equal(owner1Balance);
            expect(voterDetails.votedYes).to.equal(true);

            // Step 3: Remove the vote
            const tx = await fermionFNFTProxy.connect(owner1).removeVoteOnProposal();

            // Verify emitted event
            await expect(tx)
              .to.emit(fermionFNFTProxy, "PriceUpdateVoteRemoved")
              .withArgs(proposal.proposalId, owner1.address, owner1Balance, true);

            // Step 4: Verify the proposal state after vote removal
            proposal = await fermionFNFTProxy.getCurrentProposalDetails();
            expect(proposal.yesVotes).to.equal(0);

            const updatedVoterDetails = await fermionFNFTProxy.getVoterDetails(owner1.address);
            expect(updatedVoterDetails.voteCount).to.equal(0);
          });

          it("should revert if there is no active proposal", async function () {
            // Finalize the current proposal
            const tx = await fermionFNFTProxy.connect(owner1).voteOnProposal(1, true);
            await setNextBlockTimestamp((await getBlockTimestampFromTransaction(tx)) + MIN_GOV_VOTE_DURATION + 1);
            await fermionFNFTProxy.connect(owner1).voteOnProposal(1, true); // Finalize the proposal

            // Attempt to remove a vote on a finalized proposal
            await expect(fermionFNFTProxy.connect(owner1).removeVoteOnProposal()).to.be.revertedWithCustomError(
              fermionFNFTProxy,
              "ProposalNotActive",
            );
          });

          it("should revert if the voter has no votes recorded", async function () {
            const unauthorized = bidders[1]; // A wallet with no votes
            await expect(fermionFNFTProxy.connect(unauthorized).removeVoteOnProposal()).to.be.revertedWithCustomError(
              fermionFNFTProxy,
              "NoVotingPower",
            );
          });
        });
      });
      context("Finalizing Proposals", function () {
        it("should finalize as executed when quorum is met and yes votes are greater", async function () {
          let tx = await fermionFNFTProxy.updateExitPrice(parseEther("3"), 7500, MIN_GOV_VOTE_DURATION);
          await fermionFNFTProxy.connect(seller).voteOnProposal(1, true);

          await setNextBlockTimestamp((await getBlockTimestampFromTransaction(tx)) + MIN_GOV_VOTE_DURATION + 1);

          tx = await fermionFNFTProxy.connect(owner1).voteOnProposal(1, true);

          const proposal = await fermionFNFTProxy.getCurrentProposalDetails();
          expect(proposal.state).to.equal(PriceUpdateProposalState.Executed);

          await expect(tx)
            .to.emit(fermionFNFTProxy, "ExitPriceUpdated")
            .withArgs(parseEther("3"), false)
            .and.to.emit(fermionFNFTProxy, "PriceUpdateProposalFinalized")
            .withArgs(1, true);
        });

        it("should finalize correctly with edge-case quorum", async function () {
          const quorumPercent = 5000n; // 50%
          const tx = await fermionFNFTProxy.updateExitPrice(
            parseEther("3"),
            quorumPercent.toString(),
            MIN_GOV_VOTE_DURATION,
          );
          const liquidSupply = await fermionFNFTProxy.liquidSupply();
          const quorumThreshold = (liquidSupply * quorumPercent) / 10000n;
          const erc20Clone = await getERC20Clone(fermionFNFTProxy);
          await erc20Clone.connect(owner1).transfer(owner2.address, quorumThreshold);
          await fermionFNFTProxy.connect(owner2).voteOnProposal(1, true);

          await setNextBlockTimestamp((await getBlockTimestampFromTransaction(tx)) + MIN_GOV_VOTE_DURATION + 1);

          await fermionFNFTProxy.connect(owner2).voteOnProposal(1, true); // finalization

          // Retrieve proposal details after finalization
          const proposal = await fermionFNFTProxy.getCurrentProposalDetails();
          expect(proposal.state).to.equal(PriceUpdateProposalState.Executed);
          expect(proposal.yesVotes).to.equal(quorumThreshold);
        });

        it("should finalize as failed when quorum is not met", async function () {
          let tx = await fermionFNFTProxy.updateExitPrice(parseEther("3"), 7500, MIN_GOV_VOTE_DURATION);
          await setNextBlockTimestamp((await getBlockTimestampFromTransaction(tx)) + MIN_GOV_VOTE_DURATION + 1);
          tx = await fermionFNFTProxy.connect(owner1).voteOnProposal(1, false); // Vote won't matter as quorum is not met.

          const proposal = await fermionFNFTProxy.getCurrentProposalDetails();
          expect(proposal.state).to.equal(PriceUpdateProposalState.Failed);

          await expect(tx).to.emit(fermionFNFTProxy, "PriceUpdateProposalFinalized").withArgs(1, false);
        });

        it("should finalize as failed when quorum is met but no votes are greater", async function () {
          let tx = await fermionFNFTProxy.updateExitPrice(parseEther("3"), 7500, MIN_GOV_VOTE_DURATION);
          await fermionFNFTProxy.connect(owner1).voteOnProposal(1, false); // Majority votes 'no'
          await setNextBlockTimestamp((await getBlockTimestampFromTransaction(tx)) + MIN_GOV_VOTE_DURATION + 1);

          tx = await fermionFNFTProxy.connect(owner1).voteOnProposal(1, true);

          const proposal = await fermionFNFTProxy.getCurrentProposalDetails();
          expect(proposal.state).to.equal(PriceUpdateProposalState.Failed);

          await expect(tx).to.emit(fermionFNFTProxy, "PriceUpdateProposalFinalized").withArgs(1, false);
        });

        it("should finalize as failed when no votes are cast", async function () {
          let tx = await fermionFNFTProxy.updateExitPrice(parseEther("3"), 7500, MIN_GOV_VOTE_DURATION);
          await setNextBlockTimestamp((await getBlockTimestampFromTransaction(tx)) + MIN_GOV_VOTE_DURATION + 1);

          tx = await fermionFNFTProxy.connect(owner1).voteOnProposal(1, true); // Trigger finalization.

          const proposal = await fermionFNFTProxy.getCurrentProposalDetails();
          expect(proposal.state).to.equal(PriceUpdateProposalState.Failed);

          await expect(tx).to.emit(fermionFNFTProxy, "PriceUpdateProposalFinalized").withArgs(1, false);
        });

        it("should stay ACTIVE when attempting to finalize before the deadline", async function () {
          const tx = await fermionFNFTProxy.updateExitPrice(parseEther("3"), 7500, MIN_GOV_VOTE_DURATION);
          await fermionFNFTProxy.connect(owner1).voteOnProposal(1, true);

          const proposal = await fermionFNFTProxy.getCurrentProposalDetails();
          expect(proposal.state).to.equal(PriceUpdateProposalState.Active);

          const owner1Balance: bigint = await balanceOfERC20(fermionFNFTProxy, owner1.address);
          const transferAmount: bigint = owner1Balance / 2n;
          const erc20Clone = await getERC20Clone(fermionFNFTProxy);
          await erc20Clone.connect(owner1).transfer(owner2.address, transferAmount);

          await setNextBlockTimestamp((await getBlockTimestampFromTransaction(tx)) + MIN_GOV_VOTE_DURATION - 10);
          await fermionFNFTProxy.connect(owner2).voteOnProposal(1, true);

          const updatedProposal = await fermionFNFTProxy.getCurrentProposalDetails();
          expect(updatedProposal.state).to.equal(PriceUpdateProposalState.Active);
          expect(updatedProposal.yesVotes).to.equal(owner1Balance);
        });

        it("should revert if there is no active proposal", async function () {
          await expect(fermionFNFTProxy.connect(owner2).voteOnProposal(0, true)).to.be.revertedWithCustomError(
            fermionFNFTProxy,
            "ProposalNotActive",
          );

          await expect(fermionFNFTProxy.connect(owner2).voteOnProposal(1, true)).to.be.revertedWithCustomError(
            fermionFNFTProxy,
            "InvalidProposalId",
          );
        });

        it("should revert if a proposal is already finalized", async function () {
          const tx = await fermionFNFTProxy.updateExitPrice(parseEther("3"), 7500, MIN_GOV_VOTE_DURATION);
          await fermionFNFTProxy.connect(owner1).voteOnProposal(1, true);
          await setNextBlockTimestamp((await getBlockTimestampFromTransaction(tx)) + MIN_GOV_VOTE_DURATION + 1);
          await fermionFNFTProxy.connect(owner1).voteOnProposal(1, true); // Trigger finalization.

          const proposal = await fermionFNFTProxy.getCurrentProposalDetails();
          expect(proposal.state).to.equal(PriceUpdateProposalState.Executed);

          await expect(fermionFNFTProxy.connect(owner1).voteOnProposal(1, true)).to.be.revertedWithCustomError(
            fermionFNFTProxy,
            "ProposalNotActive",
          );
        });
      });
      context("startAuction", function () {
        const exitPrice = auctionParameters.exitPrice;

        beforeEach(async function () {
          await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), exitPrice + 1n);
          await mockExchangeToken.connect(bidders[1]).approve(await fermionFNFTProxy.getAddress(), exitPrice);
        });

        it("should allow startAuction if the max bid > exitPrice after exit price udpate", async function () {
          const maxBid = exitPrice - 1n;
          await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, maxBid, 0);

          await expect(fermionFNFTProxy.startAuction(startTokenId)).to.be.revertedWithCustomError(
            fermionFNFTProxy,
            "BidBelowExitPrice",
          );

          // Update the exit price through governance
          let tx = await fermionFNFTProxy.connect(seller).updateExitPrice(maxBid - 1n, 7500, MIN_GOV_VOTE_DURATION);
          await fermionFNFTProxy.connect(seller).voteOnProposal(1, true);

          await setNextBlockTimestamp((await getBlockTimestampFromTransaction(tx)) + MIN_GOV_VOTE_DURATION + 1);
          await fermionFNFTProxy.connect(seller).voteOnProposal(1, true);

          tx = await fermionFNFTProxy.startAuction(startTokenId);

          const blockTimeStamp = (await tx.getBlock()).timestamp;
          const auctionEnd = BigInt(blockTimeStamp) + auctionParameters.duration;
          await expect(tx).to.emit(fermionFNFTProxy, "AuctionStarted").withArgs(startTokenId, auctionEnd, 0);

          const auctionDetails = await fermionFNFTProxy.getAuctionDetails(startTokenId);
          expect(auctionDetails.state).to.equal(AuctionState.Ongoing);
          expect(auctionDetails.timer).to.equal(auctionEnd);
        });

        it("should allow startAuction if the max bid = exitPrice after exit price udpate", async function () {
          const maxBid = exitPrice - 1n;
          await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, maxBid, 0);

          await expect(fermionFNFTProxy.startAuction(startTokenId)).to.be.revertedWithCustomError(
            fermionFNFTProxy,
            "BidBelowExitPrice",
          );

          // Update the exit price through governance
          let tx = await fermionFNFTProxy.connect(seller).updateExitPrice(maxBid, 7500, MIN_GOV_VOTE_DURATION);
          await fermionFNFTProxy.connect(seller).voteOnProposal(1, true);

          await setNextBlockTimestamp((await getBlockTimestampFromTransaction(tx)) + MIN_GOV_VOTE_DURATION + 1);
          await fermionFNFTProxy.connect(seller).voteOnProposal(1, true);

          tx = await fermionFNFTProxy.startAuction(startTokenId);

          const blockTimeStamp = (await tx.getBlock()).timestamp;
          const auctionEnd = BigInt(blockTimeStamp) + auctionParameters.duration;
          await expect(tx).to.emit(fermionFNFTProxy, "AuctionStarted").withArgs(startTokenId, auctionEnd, 0);

          const auctionDetails = await fermionFNFTProxy.getAuctionDetails(startTokenId);
          expect(auctionDetails.state).to.equal(AuctionState.Ongoing);
          expect(auctionDetails.timer).to.equal(auctionEnd);
        });

        it("should revert if the token is recombined but not fractionalized again", async function () {
          const bidAmount = exitPrice + parseEther("0.01");
          await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);
          const tx = await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, bidAmount, 0n);
          const blockTimeStamp = (await tx.getBlock()).timestamp;
          const auctionEnd = BigInt(blockTimeStamp) + auctionParameters.duration;
          await setNextBlockTimestamp(String(auctionEnd + 1n));
          await fermionFNFTProxy.connect(bidders[0]).redeem(startTokenId);

          await expect(fermionFNFTProxy.startAuction(startTokenId)).to.be.revertedWithCustomError(
            fermionFNFTProxy,
            "TokenNotFractionalised",
          );
        });

        it("should revert if the auction is already ongoing", async function () {
          const maxBid = exitPrice + 1n;
          await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, maxBid, 0); // bid above exit price to start auction
          await expect(fermionFNFTProxy.startAuction(startTokenId)).to.be.revertedWithCustomError(
            fermionFNFTProxy,
            "AuctionOngoing",
          );
        });

        it("should revert if max bid < exit price", async function () {
          const bidIncrement = applyPercentage(exitPrice, HUNDRED_PERCENT - MINIMAL_BID_INCREMENT);
          const bidPrice = exitPrice - bidIncrement; // bid price < exit price
          await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, bidPrice, 0); // bid < exit price

          await expect(fermionFNFTProxy.startAuction(startTokenId))
            .to.be.revertedWithCustomError(fermionFNFTProxy, "BidBelowExitPrice")
            .withArgs(startTokenId, bidPrice, exitPrice);
        });
      });
    });
  });
});
