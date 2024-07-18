import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { applyPercentage, deployMockTokens, setNextBlockTimestamp } from "../utils/common";
import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, ZeroHash, parseEther } from "ethers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { AuctionState, TokenState } from "../utils/enums";
import {
  MINIMAL_BID_INCREMENT,
  MIN_FRACTIONS,
  MAX_FRACTIONS,
  TOP_BID_LOCK_TIME,
  AUCTION_DURATION,
  UNLOCK_THRESHOLD,
} from "../utils/constants";

const { ZeroAddress } = ethers;

describe("FermionFNFT - fractionalisation tests", function () {
  let fermionFNFTProxy: Contract;
  let mockExchangeToken: Contract;
  let wallets: HardhatEthersSigner[];
  let bidders: HardhatEthersSigner[];
  let fermionMock: Contract;
  let wrapperContractOwner: HardhatEthersSigner;
  let seller: HardhatEthersSigner;
  const startTokenId = 2n ** 128n + 1n;
  const quantity = 10n;
  const additionalDeposit = 0n;

  async function setupFermionFractionsTest() {
    wallets = await ethers.getSigners();
    wrapperContractOwner = wallets[2];
    seller = wallets[3];
    bidders = wallets.slice(4, 8);

    const [mockConduit, mockBosonPriceDiscovery] = wallets.slice(9, 11);
    const FermionFNFT = await ethers.getContractFactory("FermionFNFT");
    const fermionFNFT = await FermionFNFT.deploy(
      mockBosonPriceDiscovery.address,
      {
        seaport: wallets[10].address, // dummy address,
        openSeaConduit: mockConduit.address,
        openSeaConduitKey: ZeroHash,
      },
      wallets[10].address,
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
    await fermionFNFTProxy
      .attach(fermionMock)
      .initialize(await mockBoson.getAddress(), wrapperContractOwner.address, await mockExchangeToken.getAddress());
    await fermionMock.setDestinationOverride(await mockBoson.getAddress());
    await mockBoson.attach(fermionMock).setApprovalForAll(await fermionFNFTProxy.getAddress(), true);
    await fermionFNFTProxy.attach(fermionMock).wrapForAuction(startTokenId, quantity, seller.address);

    for (let i = 0n; i < quantity; i++) {
      const tokenId = startTokenId + i;
      await fermionFNFTProxy.connect(mockBosonPriceDiscovery).unwrapToSelf(startTokenId + i, ZeroAddress, 0);
      if (i < quantity - 1n) {
        await fermionFNFTProxy.attach(fermionMock).pushToNextTokenState(tokenId, TokenState.Verified);
        await fermionFNFTProxy.attach(fermionMock).pushToNextTokenState(tokenId, TokenState.CheckedIn);
      }
    }

    for (const bidder of bidders) {
      await mockExchangeToken.mint(bidder.address, parseEther("1000"));
    }

    return { fermionFNFT, fermionFNFTProxy, mockBoson, mockBosonPriceDiscovery, mockExchangeToken };
  }

  before(async function () {
    ({ fermionFNFTProxy, mockExchangeToken } = await loadFixture(setupFermionFractionsTest));
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
      expect(await fermionFNFTProxy.balanceOfERC721(seller.address)).to.equal(quantity);

      const tx = await fermionFNFTProxy
        .connect(seller)
        .mintFractions(
          startTokenId,
          1,
          fractionsAmount,
          auctionParameters,
          custodianVaultParameters,
          additionalDeposit,
        );

      // lock the F-NFT (erc721 transfer)
      await expect(tx)
        .to.emit(fermionFNFTProxy, "Transfer")
        .withArgs(seller.address, await fermionFNFTProxy.getAddress(), startTokenId);

      // mint fractions (erc20 mint)
      await expect(tx).to.emit(fermionFNFTProxy, "Transfer").withArgs(ZeroAddress, seller.address, fractionsAmount);

      await expect(tx)
        .to.emit(fermionFNFTProxy, "FractionsSetup")
        .withArgs(fractionsAmount, Object.values(auctionParameters));

      await expect(tx).to.emit(fermionFNFTProxy, "Fractionalised").withArgs(startTokenId, fractionsAmount);

      // state
      expect(await fermionFNFTProxy.ownerOf(startTokenId)).to.equal(await fermionFNFTProxy.getAddress());
      expect(await fermionFNFTProxy.balanceOfERC721(seller.address)).to.equal(quantity - 1n);
      expect(await fermionFNFTProxy.tokenState(startTokenId)).to.equal(TokenState.CheckedIn); // token state remains
      expect(await fermionFNFTProxy.balanceOf(seller.address)).to.equal(fractionsAmount);
      expect(await fermionFNFTProxy.totalSupply()).to.equal(fractionsAmount);
      expect(await fermionFNFTProxy.liquidSupply()).to.equal(fractionsAmount);
      expect(await fermionFNFTProxy.getBuyoutAuctionParameters()).to.eql(Object.values(auctionParameters));
    });

    it("The owner can fractionalise multiple NFT", async function () {
      const initialQuantity = 10n;
      expect(await fermionFNFTProxy.balanceOfERC721(seller.address)).to.equal(initialQuantity);

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
      await expect(tx).to.emit(fermionFNFTProxy, "Transfer").withArgs(ZeroAddress, seller.address, totalFractions);

      await expect(tx)
        .to.emit(fermionFNFTProxy, "FractionsSetup")
        .withArgs(fractionsAmount, Object.values(auctionParameters));

      // state
      expect(await fermionFNFTProxy.ownerOf(startTokenId)).to.equal(await fermionFNFTProxy.getAddress());
      expect(await fermionFNFTProxy.balanceOfERC721(seller.address)).to.equal(initialQuantity - quantity);
      expect(await fermionFNFTProxy.tokenState(startTokenId)).to.equal(TokenState.CheckedIn); // token state remains
      expect(await fermionFNFTProxy.balanceOf(seller.address)).to.equal(totalFractions);
      expect(await fermionFNFTProxy.totalSupply()).to.equal(totalFractions);
      expect(await fermionFNFTProxy.liquidSupply()).to.equal(totalFractions);
      expect(await fermionFNFTProxy.getBuyoutAuctionParameters()).to.eql(Object.values(auctionParameters));
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
        );

      await expect(tx)
        .to.emit(fermionFNFTProxy, "FractionsSetup")
        .withArgs(fractionsAmount, Object.values(auctionDefaultParameters));

      // state
      expect(await fermionFNFTProxy.getBuyoutAuctionParameters()).to.eql(Object.values(auctionDefaultParameters));
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
        );

      // lock the F-NFT (erc721 transfer)
      await expect(tx)
        .to.emit(fermionFNFTProxy, "Transfer")
        .withArgs(seller.address, await fermionFNFTProxy.getAddress(), startTokenId);

      // mint fractions (erc20 mint)
      await expect(tx).to.emit(fermionFNFTProxy, "Transfer").withArgs(ZeroAddress, seller.address, fractionsAmount);

      await expect(tx)
        .to.emit(fermionFNFTProxy, "FractionsSetup")
        .withArgs(fractionsAmount, Object.values(auctionParameters));

      await expect(tx).to.emit(fermionFNFTProxy, "Fractionalised").withArgs(startTokenId, fractionsAmount);

      // state
      expect(await fermionFNFTProxy.ownerOf(startTokenId)).to.equal(await fermionFNFTProxy.getAddress());
      expect(await fermionFNFTProxy.tokenState(startTokenId)).to.equal(TokenState.CheckedIn); // token state remains
      expect(await fermionFNFTProxy.balanceOf(seller.address)).to.equal(fractionsAmount);
      expect(await fermionFNFTProxy.totalSupply()).to.equal(fractionsAmount);
      expect(await fermionFNFTProxy.liquidSupply()).to.equal(fractionsAmount);
      expect(await fermionFNFTProxy.getBuyoutAuctionParameters()).to.eql(Object.values(auctionParameters));
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
          );

        await expect(
          fermionFNFTProxy.mintFractions(
            startTokenId + 1n,
            1,
            fractionsAmount,
            auctionParameters,
            custodianVaultParameters,
            additionalDeposit,
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
          ),
        ).to.be.revertedWithCustomError(fermionFNFTProxy, "InvalidPartialAuctionThreshold");
      });

      it("The token is not verified", async function () {
        const tokenId = startTokenId + quantity - 1n;
        await expect(
          fermionFNFTProxy
            .connect(seller)
            .mintFractions(tokenId, 1, fractionsAmount, auctionParameters, custodianVaultParameters, additionalDeposit),
        )
          .to.be.revertedWithCustomError(fermionFNFTProxy, "InvalidStateOrCaller")
          .withArgs(tokenId, seller.address, TokenState.Unverified);

        await fermionFNFTProxy.attach(fermionMock).pushToNextTokenState(tokenId, TokenState.Verified);

        await expect(
          fermionFNFTProxy
            .connect(seller)
            .mintFractions(tokenId, 1, fractionsAmount, auctionParameters, custodianVaultParameters, additionalDeposit),
        )
          .to.be.revertedWithCustomError(fermionFNFTProxy, "InvalidStateOrCaller")
          .withArgs(tokenId, seller.address, TokenState.Verified);

        await fermionFNFTProxy.attach(fermionMock).pushToNextTokenState(tokenId, TokenState.CheckedIn);
        await fermionFNFTProxy.attach(fermionMock).pushToNextTokenState(tokenId, TokenState.CheckedOut); // checkout burns the token
        await expect(
          fermionFNFTProxy
            .connect(seller)
            .mintFractions(tokenId, 1, fractionsAmount, auctionParameters, custodianVaultParameters, additionalDeposit),
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
            .mintFractions(tokenId, 1, fractionsAmount, auctionParameters, custodianVaultParameters, additionalDeposit),
        )
          .to.be.revertedWithCustomError(fermionFNFTProxy, "ERC721NonexistentToken")
          .withArgs(tokenId);
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
        );
    });

    it("The owner can fractionalise a single NFT", async function () {
      const tx = await fermionFNFTProxy.connect(seller).mintFractions(startTokenId2, 1, additionalDeposit);

      // lock the F-NFT (erc721 transfer)
      await expect(tx)
        .to.emit(fermionFNFTProxy, "Transfer")
        .withArgs(seller.address, await fermionFNFTProxy.getAddress(), startTokenId2);

      // mint fractions (erc20 mint)
      await expect(tx).to.emit(fermionFNFTProxy, "Transfer").withArgs(ZeroAddress, seller.address, fractionsAmount);

      await expect(tx).to.not.emit(fermionFNFTProxy, "FractionsSetup");

      await expect(tx).to.emit(fermionFNFTProxy, "Fractionalised").withArgs(startTokenId2, fractionsAmount);

      // state
      expect(await fermionFNFTProxy.ownerOf(startTokenId2)).to.equal(await fermionFNFTProxy.getAddress());
      expect(await fermionFNFTProxy.tokenState(startTokenId2)).to.equal(TokenState.CheckedIn); // token state remains
      expect(await fermionFNFTProxy.balanceOf(seller.address)).to.equal(2n * fractionsAmount);
      expect(await fermionFNFTProxy.totalSupply()).to.equal(2n * fractionsAmount);
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
      await expect(tx).to.emit(fermionFNFTProxy, "Transfer").withArgs(ZeroAddress, seller.address, totalFractions);

      await expect(tx).to.not.emit(fermionFNFTProxy, "FractionsSetup");

      // state
      expect(await fermionFNFTProxy.ownerOf(startTokenId2)).to.equal(await fermionFNFTProxy.getAddress());
      expect(await fermionFNFTProxy.tokenState(startTokenId2)).to.equal(TokenState.CheckedIn); // token state remains
      expect(await fermionFNFTProxy.balanceOf(seller.address)).to.equal(totalFractions + fractionsAmount);
      expect(await fermionFNFTProxy.totalSupply()).to.equal(totalFractions + fractionsAmount);
      expect(await fermionFNFTProxy.liquidSupply()).to.equal(totalFractions + fractionsAmount);
    });

    it("Protocol can forcefully fractionalise", async function () {
      const tx = await fermionFNFTProxy.attach(fermionMock).mintFractions(startTokenId2, 1, additionalDeposit);

      // lock the F-NFT (erc721 transfer)
      await expect(tx)
        .to.emit(fermionFNFTProxy, "Transfer")
        .withArgs(seller.address, await fermionFNFTProxy.getAddress(), startTokenId2);

      // mint fractions (erc20 mint)
      await expect(tx).to.emit(fermionFNFTProxy, "Transfer").withArgs(ZeroAddress, seller.address, fractionsAmount);

      await expect(tx).to.not.emit(fermionFNFTProxy, "FractionsSetup");

      await expect(tx).to.emit(fermionFNFTProxy, "Fractionalised").withArgs(startTokenId2, fractionsAmount);

      // state
      expect(await fermionFNFTProxy.ownerOf(startTokenId2)).to.equal(await fermionFNFTProxy.getAddress());
      expect(await fermionFNFTProxy.tokenState(startTokenId2)).to.equal(TokenState.CheckedIn); // token state remains
      expect(await fermionFNFTProxy.balanceOf(seller.address)).to.equal(2n * fractionsAmount);
      expect(await fermionFNFTProxy.totalSupply()).to.equal(2n * fractionsAmount);
      expect(await fermionFNFTProxy.liquidSupply()).to.equal(2n * fractionsAmount);
      expect(await fermionFNFTProxy.getBuyoutAuctionParameters()).to.eql(Object.values(auctionParameters));
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
      await expect(tx).to.emit(fermionFNFTProxy, "Transfer").withArgs(ZeroAddress, buyer.address, fractionsAmount);

      await expect(tx).to.not.emit(fermionFNFTProxy, "FractionsSetup");

      await expect(tx).to.emit(fermionFNFTProxy, "Fractionalised").withArgs(startTokenId2, fractionsAmount);

      // state
      expect(await fermionFNFTProxy.ownerOf(startTokenId2)).to.equal(await fermionFNFTProxy.getAddress());
      expect(await fermionFNFTProxy.tokenState(startTokenId2)).to.equal(TokenState.CheckedIn); // token state remains
      expect(await fermionFNFTProxy.balanceOf(seller.address)).to.equal(fractionsAmount);
      expect(await fermionFNFTProxy.balanceOf(buyer.address)).to.equal(fractionsAmount);
      expect(await fermionFNFTProxy.totalSupply()).to.equal(2n * fractionsAmount);
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
        .to.emit(fermionFNFTProxy, "Transfer")
        .withArgs(ZeroAddress, await fermionMock.getAddress(), additionalAmount);

      // state
      expect(await fermionFNFTProxy.balanceOf(await fermionMock.getAddress())).to.equal(additionalAmount);
      expect(await fermionFNFTProxy.totalSupply()).to.equal(fractionsAmount + additionalAmount);
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
        await expect(tx).to.emit(fermionFNFTProxy, "AuctionStarted").withArgs(startTokenId, auctionEnd);

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
        await fermionFNFTProxy.connect(seller).transfer(bidders[0].address, fractions);
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
        await expect(tx).to.emit(fermionFNFTProxy, "AuctionStarted").withArgs(startTokenId, auctionEnd);

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
        expect(await fermionFNFTProxy.balanceOf(bidders[0].address)).to.equal(0n); // all fractions used
        expect(await fermionFNFTProxy.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(fractions);
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
        expect(await fermionFNFTProxy.balanceOf(bidders[0].address)).to.equal(0n); // all fractions used
        expect(await fermionFNFTProxy.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(fractions);
      });

      it("When outbid, the locked amounts are released to previous bidder", async function () {
        const price = exitPrice + parseEther("0.1");
        const bidAmount = ((fractionsPerToken - fractions) * price) / fractionsPerToken; // amount to pay
        await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);

        await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, price, fractions);

        // outbidding with fractions
        const price2 = price + parseEther("0.1");
        const fractions2 = (fractionsPerToken * 30n) / 100n; // 30% of bid paid with fractions
        await fermionFNFTProxy.connect(seller).transfer(bidders[1].address, fractions2);
        const bidAmount2 = ((fractionsPerToken - fractions2) * price2) / fractionsPerToken; // amount to pay
        await mockExchangeToken.connect(bidders[1]).approve(await fermionFNFTProxy.getAddress(), bidAmount2);

        const tx = await fermionFNFTProxy.connect(bidders[1]).bid(startTokenId, price2, fractions2);

        await expect(tx)
          .to.emit(mockExchangeToken, "Transfer")
          .withArgs(await fermionFNFTProxy.getAddress(), bidders[0].address, bidAmount);
        await expect(tx)
          .to.emit(fermionFNFTProxy, "Transfer")
          .withArgs(await fermionFNFTProxy.getAddress(), bidders[0].address, fractions);

        expect(await mockExchangeToken.balanceOf(bidders[0].address)).to.equal(parseEther("1000"));
        expect(await mockExchangeToken.balanceOf(bidders[1].address)).to.equal(parseEther("1000") - bidAmount2);
        expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(bidAmount2);
        expect(await fermionFNFTProxy.balanceOf(bidders[0].address)).to.equal(fractions);
        expect(await fermionFNFTProxy.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(fractions2);

        // outbidding without fractions
        const bidAmount3 = price2 + parseEther("0.1");
        await mockExchangeToken.connect(bidders[2]).approve(await fermionFNFTProxy.getAddress(), bidAmount3);

        const tx2 = await fermionFNFTProxy.connect(bidders[2]).bid(startTokenId, bidAmount3, 0n);
        await expect(tx2)
          .to.emit(mockExchangeToken, "Transfer")
          .withArgs(await fermionFNFTProxy.getAddress(), bidders[1].address, bidAmount2);
        await expect(tx2)
          .to.emit(fermionFNFTProxy, "Transfer")
          .withArgs(await fermionFNFTProxy.getAddress(), bidders[1].address, fractions2);

        expect(await mockExchangeToken.balanceOf(bidders[1].address)).to.equal(parseEther("1000"));
        expect(await mockExchangeToken.balanceOf(bidders[2].address)).to.equal(parseEther("1000") - bidAmount3);
        expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(bidAmount3);
        expect(await fermionFNFTProxy.balanceOf(bidders[1].address)).to.equal(fractions2);
        expect(await fermionFNFTProxy.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(0n); // all fractions returned
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
        await expect(tx).to.emit(fermionFNFTProxy, "AuctionStarted").withArgs(startTokenId, auctionEnd);

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
        expect(await fermionFNFTProxy.balanceOf(bidders[0].address)).to.equal(fractions - fractionsPart); // all fractions used
        expect(await fermionFNFTProxy.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(fractionsPart);
      });

      it("Provide more than 100%", async function () {
        // fractionalise another token and transfer the fractions to the bidder
        await fermionFNFTProxy.connect(seller).mintFractions(startTokenId + 1n, 1, additionalDeposit);
        await fermionFNFTProxy.connect(seller).transfer(bidders[0].address, fractionsPerToken);

        const price = exitPrice + parseEther("0.1");
        const fractionsPart = fractions + fractionsPerToken; // more than 1 token
        const bidAmount = 0n; // amount to pay

        const tx = await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, price, fractionsPart);

        await expect(tx)
          .to.emit(fermionFNFTProxy, "Bid")
          .withArgs(startTokenId, bidders[0].address, price, fractionsPerToken, bidAmount);

        const blockTimeStamp = (await tx.getBlock()).timestamp;
        const auctionEnd = BigInt(blockTimeStamp) + auctionParameters.duration;
        await expect(tx).to.emit(fermionFNFTProxy, "AuctionStarted").withArgs(startTokenId, auctionEnd);

        // state
        const expectedAuctionDetails = {
          timer: auctionEnd,
          maxBid: price,
          maxBidder: bidders[0].address,
          totalFractions: fractionsPerToken,
          lockedFractions: fractionsPerToken,
          lockedBidAmount: bidAmount,
          state: BigInt(AuctionState.Ongoing),
        };

        expect(await fermionFNFTProxy.getAuctionDetails(startTokenId)).to.eql(Object.values(expectedAuctionDetails));
        expect(await mockExchangeToken.balanceOf(bidders[0].address)).to.equal(parseEther("1000") - bidAmount);
        expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(bidAmount);
        expect(await fermionFNFTProxy.balanceOf(bidders[0].address)).to.equal(fractions); // fractions for 1 token used, remainder fractionsPart-fractionsPerToken=fractions
        expect(await fermionFNFTProxy.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(fractionsPerToken);
      });
    });

    context("Bid with votes", function () {
      const fractions = 0n;
      const votes = (fractionsPerToken * 30n) / 100n; // 30% of bid paid with locked votes

      beforeEach(async function () {
        await fermionFNFTProxy.connect(seller).transfer(bidders[0].address, votes);

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
        await expect(tx).to.emit(fermionFNFTProxy, "AuctionStarted").withArgs(startTokenId, auctionEnd);

        // state
        const expectedAuctionDetails = {
          timer: auctionEnd,
          maxBid: price,
          maxBidder: bidders[0].address,
          totalFractions: fractionsPerToken,
          lockedFractions: votes,
          lockedBidAmount: bidAmount,
          state: BigInt(AuctionState.Ongoing),
        };

        expect(await fermionFNFTProxy.getAuctionDetails(startTokenId)).to.eql(Object.values(expectedAuctionDetails));
        expect(await mockExchangeToken.balanceOf(bidders[0].address)).to.equal(parseEther("1000") - bidAmount);
        expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(bidAmount);
        expect(await fermionFNFTProxy.balanceOf(bidders[0].address)).to.equal(0n);
        expect(await fermionFNFTProxy.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(votes);
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
          lockedFractions: votes,
          lockedBidAmount: bidAmount,
          state: BigInt(AuctionState.NotStarted),
        };

        expect(await fermionFNFTProxy.getAuctionDetails(startTokenId)).to.eql(Object.values(expectedAuctionDetails));
        expect(await mockExchangeToken.balanceOf(bidders[0].address)).to.equal(parseEther("1000") - bidAmount);
        expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(bidAmount);
        expect(await fermionFNFTProxy.balanceOf(bidders[0].address)).to.equal(0n);
        expect(await fermionFNFTProxy.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(votes);
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
        await fermionFNFTProxy.connect(seller).transfer(bidders[1].address, votes2);
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
        expect(await fermionFNFTProxy.balanceOf(bidders[0].address)).to.equal(0n); // locked votes are not returned
        expect(await fermionFNFTProxy.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(votes + votes2); // locked votes are not returned

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
        expect(await fermionFNFTProxy.balanceOf(bidders[1].address)).to.equal(0n); // locked votes are not returned
        expect(await fermionFNFTProxy.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(votes + votes2); // locked votes are not returned
      });
    });

    context("Bid with votes and fractions", function () {
      const fractions = (fractionsPerToken * 20n) / 100n; // 20% of bid paid with fractions
      const votes = (fractionsPerToken * 30n) / 100n; // 30% of bid paid with locked votes

      beforeEach(async function () {
        await fermionFNFTProxy.connect(seller).transfer(bidders[0].address, fractions + votes);

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
        await expect(tx).to.emit(fermionFNFTProxy, "AuctionStarted").withArgs(startTokenId, auctionEnd);

        // state
        const expectedAuctionDetails = {
          timer: auctionEnd,
          maxBid: price,
          maxBidder: bidders[0].address,
          totalFractions: fractionsPerToken,
          lockedFractions: fractions + votes,
          lockedBidAmount: bidAmount,
          state: BigInt(AuctionState.Ongoing),
        };

        expect(await fermionFNFTProxy.getAuctionDetails(startTokenId)).to.eql(Object.values(expectedAuctionDetails));
        expect(await mockExchangeToken.balanceOf(bidders[0].address)).to.equal(parseEther("1000") - bidAmount);
        expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(bidAmount);
        expect(await fermionFNFTProxy.balanceOf(bidders[0].address)).to.equal(0n); // all fractions used
        expect(await fermionFNFTProxy.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(fractions + votes);
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
          lockedFractions: fractions + votes,
          lockedBidAmount: bidAmount,
          state: BigInt(AuctionState.NotStarted),
        };

        expect(await fermionFNFTProxy.getAuctionDetails(startTokenId)).to.eql(Object.values(expectedAuctionDetails));
        expect(await mockExchangeToken.balanceOf(bidders[0].address)).to.equal(parseEther("1000") - bidAmount);
        expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(bidAmount);
        expect(await fermionFNFTProxy.balanceOf(bidders[0].address)).to.equal(0n); // all fractions used
        expect(await fermionFNFTProxy.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(fractions + votes);
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
        await fermionFNFTProxy.connect(seller).transfer(bidders[1].address, fractions2 + votes2);
        await fermionFNFTProxy.connect(bidders[1]).voteToStartAuction(startTokenId, votes2);
        const bidAmount2 = ((fractionsPerToken - fractions2 - votes2) * price2) / fractionsPerToken; // amount to pay
        await mockExchangeToken.connect(bidders[1]).approve(await fermionFNFTProxy.getAddress(), bidAmount2);

        const tx = await fermionFNFTProxy.connect(bidders[1]).bid(startTokenId, price2, fractions2);

        await expect(tx)
          .to.emit(mockExchangeToken, "Transfer")
          .withArgs(await fermionFNFTProxy.getAddress(), bidders[0].address, bidAmount);
        await expect(tx)
          .to.emit(fermionFNFTProxy, "Transfer")
          .withArgs(await fermionFNFTProxy.getAddress(), bidders[0].address, fractions);

        expect(await mockExchangeToken.balanceOf(bidders[0].address)).to.equal(parseEther("1000"));
        expect(await mockExchangeToken.balanceOf(bidders[1].address)).to.equal(parseEther("1000") - bidAmount2);
        expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(bidAmount2);
        expect(await fermionFNFTProxy.balanceOf(bidders[0].address)).to.equal(fractions); // only fractions are returned, votes not
        expect(await fermionFNFTProxy.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(
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
          .to.emit(fermionFNFTProxy, "Transfer")
          .withArgs(await fermionFNFTProxy.getAddress(), bidders[1].address, fractions2);

        expect(await mockExchangeToken.balanceOf(bidders[1].address)).to.equal(parseEther("1000"));
        expect(await mockExchangeToken.balanceOf(bidders[2].address)).to.equal(parseEther("1000") - bidAmount3);
        expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(bidAmount3);
        expect(await fermionFNFTProxy.balanceOf(bidders[1].address)).to.equal(fractions2); // only fractions are returned, votes not
        expect(await fermionFNFTProxy.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(votes + votes2); // all fractions returned
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
        await expect(tx).to.emit(fermionFNFTProxy, "AuctionStarted").withArgs(startTokenId, auctionEnd);

        // state
        const expectedAuctionDetails = {
          timer: auctionEnd,
          maxBid: price,
          maxBidder: bidders[0].address,
          totalFractions: fractionsPerToken,
          lockedFractions: fractionsPart + votes,
          lockedBidAmount: bidAmount,
          state: BigInt(AuctionState.Ongoing),
        };

        expect(await fermionFNFTProxy.getAuctionDetails(startTokenId)).to.eql(Object.values(expectedAuctionDetails));
        expect(await mockExchangeToken.balanceOf(bidders[0].address)).to.equal(parseEther("1000") - bidAmount);
        expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(bidAmount);
        expect(await fermionFNFTProxy.balanceOf(bidders[0].address)).to.equal(fractions - fractionsPart); // all fractions used
        expect(await fermionFNFTProxy.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(fractionsPart + votes);
      });

      it("Provide more than 100%", async function () {
        // fractionalise another token and transfer the fractions to the bidder
        await fermionFNFTProxy.connect(seller).mintFractions(startTokenId + 1n, 1, additionalDeposit);
        await fermionFNFTProxy.connect(seller).transfer(bidders[0].address, fractionsPerToken);

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
        await expect(tx).to.emit(fermionFNFTProxy, "AuctionStarted").withArgs(startTokenId, auctionEnd);

        // state
        const expectedAuctionDetails = {
          timer: auctionEnd,
          maxBid: price,
          maxBidder: bidders[0].address,
          totalFractions: fractionsPerToken,
          lockedFractions: fractionsPerToken,
          lockedBidAmount: bidAmount,
          state: BigInt(AuctionState.Ongoing),
        };

        expect(await fermionFNFTProxy.getAuctionDetails(startTokenId)).to.eql(Object.values(expectedAuctionDetails));
        expect(await mockExchangeToken.balanceOf(bidders[0].address)).to.equal(parseEther("1000") - bidAmount);
        expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(bidAmount);
        expect(await fermionFNFTProxy.balanceOf(bidders[0].address)).to.equal(fractions + votes); // total balance before was fractions + fractionsPerToken + votes
        expect(await fermionFNFTProxy.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(fractionsPerToken);
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
        await fermionFNFTProxy.connect(seller).transfer(bidders[0].address, fractions);
        await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);

        await expect(fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, bidAmount, fractions + 1n))
          .to.be.revertedWithCustomError(fermionFNFTProxy, "ERC20InsufficientBalance")
          .withArgs(bidders[0].address, fractions, fractions + 1n);
      });

      it("Bidder does not have pay enough fractions", async function () {
        const bidAmount = exitPrice + parseEther("0.1");
        await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount - 1n);

        await expect(fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, bidAmount, fractions))
          .to.be.revertedWithCustomError(fermionFNFTProxy, "ERC20InsufficientAllowance")
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
        await fermionFNFTProxy.connect(seller).transfer(bidders[0].address, fractions);
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
          .to.emit(fermionFNFTProxy, "Transfer")
          .withArgs(await fermionFNFTProxy.getAddress(), bidders[0].address, fractions);
        await expect(tx2).to.emit(fermionFNFTProxy, "Bid").withArgs(0, ZeroAddress, 0n, 0n, 0n);

        expect(await mockExchangeToken.balanceOf(bidders[0].address)).to.equal(parseEther("1000"));
        expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(0n);
        expect(await fermionFNFTProxy.balanceOf(bidders[0].address)).to.equal(fractions);
        expect(await fermionFNFTProxy.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(0n);
      });

      it("Bid with  more than 100% fractions", async function () {
        // Testing that only the fractions used for the bid are returned
        // fractionalise another token and transfer the fractions to the bidder
        await fermionFNFTProxy.connect(seller).mintFractions(startTokenId + 1n, 1, additionalDeposit);
        await fermionFNFTProxy.connect(seller).transfer(bidders[0].address, fractionsPerToken);

        const fractionsPart = fractions + fractionsPerToken; // more than 1 token

        const tx = await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, price, fractionsPart);
        const blockTimeStamp = (await tx.getBlock()).timestamp;
        const topBidLockTime = BigInt(blockTimeStamp) + auctionParameters.topBidLockTime;
        await setNextBlockTimestamp(String(topBidLockTime + 1n));

        const tx2 = await fermionFNFTProxy.connect(bidders[0]).removeBid(startTokenId);
        await expect(tx2)
          .to.emit(fermionFNFTProxy, "Transfer")
          .withArgs(await fermionFNFTProxy.getAddress(), bidders[0].address, fractionsPerToken);

        expect(await mockExchangeToken.balanceOf(bidders[0].address)).to.equal(parseEther("1000"));
        expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(0n);
        expect(await fermionFNFTProxy.balanceOf(bidders[0].address)).to.equal(fractionsPart);
        expect(await fermionFNFTProxy.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(0n);
      });
    });

    context("Bid with votes", function () {
      const fractions = 0n;
      const votes = (fractionsPerToken * 30n) / 100n; // 30% of bid paid with locked votes

      beforeEach(async function () {
        await fermionFNFTProxy.connect(seller).transfer(bidders[0].address, votes);

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
        expect(await fermionFNFTProxy.balanceOf(bidders[0].address)).to.equal(0n); // locked votes are not returned
        expect(await fermionFNFTProxy.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(votes); // locked votes are not returned
      });
    });

    context("Bid with votes and fractions", function () {
      const price = exitPrice - parseEther("0.01");
      const fractions = (fractionsPerToken * 20n) / 100n; // 20% of bid paid with fractions
      const votes = (fractionsPerToken * 30n) / 100n; // 30% of bid paid with locked votes

      beforeEach(async function () {
        await fermionFNFTProxy.connect(seller).transfer(bidders[0].address, fractions + votes);

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
          .to.emit(fermionFNFTProxy, "Transfer")
          .withArgs(await fermionFNFTProxy.getAddress(), bidders[0].address, fractions);

        expect(await mockExchangeToken.balanceOf(bidders[0].address)).to.equal(parseEther("1000"));
        expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(0n);
        expect(await fermionFNFTProxy.balanceOf(bidders[0].address)).to.equal(fractions); // only fractions are returned, votes not
        expect(await fermionFNFTProxy.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(votes);
      });

      it("Bid with  more than 100% fractions", async function () {
        // Testing that only the fractions used for the bid are returned
        // fractionalise another token and transfer the fractions to the bidder
        await fermionFNFTProxy.connect(seller).mintFractions(startTokenId + 1n, 1, additionalDeposit);
        await fermionFNFTProxy.connect(seller).transfer(bidders[0].address, fractionsPerToken);

        const fractionsPart = fractions + fractionsPerToken; // more than 1 token
        const bidAmount = 0n; // amount to pay

        const tx = await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, price, fractionsPart);

        await expect(tx)
          .to.emit(fermionFNFTProxy, "Bid")
          .withArgs(startTokenId, bidders[0].address, price, fractionsPerToken, bidAmount);

        const blockTimeStamp = (await tx.getBlock()).timestamp;
        const topBidLockTime = BigInt(blockTimeStamp) + auctionParameters.topBidLockTime;
        await setNextBlockTimestamp(String(topBidLockTime + 1n));

        const tx2 = await fermionFNFTProxy.connect(bidders[0]).removeBid(startTokenId);

        await expect(tx2)
          .to.emit(fermionFNFTProxy, "Transfer")
          .withArgs(await fermionFNFTProxy.getAddress(), bidders[0].address, fractionsPerToken - votes);

        expect(await mockExchangeToken.balanceOf(bidders[0].address)).to.equal(parseEther("1000"));
        expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(0n);
        expect(await fermionFNFTProxy.balanceOf(bidders[0].address)).to.equal(fractionsPart);
        expect(await fermionFNFTProxy.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(votes);
      });
    });

    context("Revert reasons", function () {
      const fractions = 0n;

      it("The time lock is not over yet", async function () {
        const bidAmount = exitPrice - parseEther("0.1");
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
        const bidAmount = exitPrice - parseEther("0.1");
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
      expect(await fermionFNFTProxy.balanceOfERC721(bidders[0].address)).to.equal(1n);
      expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(bidAmount);
      expectedAuctionDetails.timer = auctionEnd;
      expectedAuctionDetails.lockedBidAmount = bidAmount;
      expect(await fermionFNFTProxy.getAuctionDetails(startTokenId)).to.eql(Object.values(expectedAuctionDetails));
    });

    it("Bid with fractions", async function () {
      const fractions = (fractionsPerToken * 20n) / 100n; // 20% of bid paid with fractions
      await fermionFNFTProxy.connect(seller).transfer(bidders[0].address, fractions);

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
        .to.emit(fermionFNFTProxy, "Transfer")
        .withArgs(await fermionFNFTProxy.getAddress(), ZeroAddress, fractions); // burn fractions

      expect(await fermionFNFTProxy.ownerOf(startTokenId)).to.equal(bidders[0].address);
      expect(await fermionFNFTProxy.balanceOfERC721(bidders[0].address)).to.equal(1n);
      expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(bidAmount);
      expectedAuctionDetails.timer = auctionEnd;
      expectedAuctionDetails.lockedBidAmount = bidAmount;
      expectedAuctionDetails.lockedFractions = fractions;
      expect(await fermionFNFTProxy.getAuctionDetails(startTokenId)).to.eql(Object.values(expectedAuctionDetails));
      expect(await fermionFNFTProxy.balanceOf(bidders[0].address)).to.equal(0n);
      expect(await fermionFNFTProxy.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(0n);
    });

    it("Bid with votes", async function () {
      const fractions = 0n;
      const votes = (fractionsPerToken * 30n) / 100n; // 30% of bid paid with locked votes
      await fermionFNFTProxy.connect(seller).transfer(bidders[0].address, votes);

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
        .to.emit(fermionFNFTProxy, "Transfer")
        .withArgs(await fermionFNFTProxy.getAddress(), ZeroAddress, votes); // burn votes

      expect(await fermionFNFTProxy.ownerOf(startTokenId)).to.equal(bidders[0].address);
      expect(await fermionFNFTProxy.balanceOfERC721(bidders[0].address)).to.equal(1n);
      expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(bidAmount);
      expectedAuctionDetails.timer = auctionEnd;
      expectedAuctionDetails.lockedBidAmount = bidAmount;
      expectedAuctionDetails.lockedFractions = votes;
      expect(await fermionFNFTProxy.getAuctionDetails(startTokenId)).to.eql(Object.values(expectedAuctionDetails));
      expect(await fermionFNFTProxy.balanceOf(bidders[0].address)).to.equal(0n); // all fractions used
      expect(await fermionFNFTProxy.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(0n);
    });

    it("Bid with votes and fractions", async function () {
      const fractions = (fractionsPerToken * 20n) / 100n; // 20% of bid paid with fractions
      const votes = (fractionsPerToken * 30n) / 100n; // 30% of bid paid with locked votes

      await fermionFNFTProxy.connect(seller).transfer(bidders[0].address, fractions + votes);
      // bidder 0 votes to start the auction
      await fermionFNFTProxy.connect(bidders[0]).voteToStartAuction(startTokenId, votes);

      const bidAmount = ((fractionsPerToken - fractions - votes) * price) / fractionsPerToken; // amount to pay
      await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);

      const tx = await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, price, fractions);
      const blockTimeStamp = (await tx.getBlock()).timestamp;
      const auctionEnd = BigInt(blockTimeStamp) + auctionParameters.duration;
      await setNextBlockTimestamp(String(auctionEnd + 1n));

      const tx2 = await fermionFNFTProxy.connect(bidders[0]).redeem(startTokenId);
      expect(await fermionFNFTProxy.balanceOfERC721(bidders[0].address)).to.equal(1n);
      await expect(tx2).to.emit(fermionFNFTProxy, "Redeemed").withArgs(startTokenId, bidders[0].address);
      await expect(tx2)
        .to.emit(fermionFNFTProxy, "Transfer")
        .withArgs(await fermionFNFTProxy.getAddress(), bidders[0].address, startTokenId);
      await expect(tx2)
        .to.emit(fermionFNFTProxy, "Transfer")
        .withArgs(await fermionFNFTProxy.getAddress(), ZeroAddress, fractions + votes); // burn votes and fractions

      expect(await fermionFNFTProxy.ownerOf(startTokenId)).to.equal(bidders[0].address);
      expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(bidAmount);
      expectedAuctionDetails.timer = auctionEnd;
      expectedAuctionDetails.lockedBidAmount = bidAmount;
      expectedAuctionDetails.lockedFractions = fractions + votes;
      expect(await fermionFNFTProxy.getAuctionDetails(startTokenId)).to.eql(Object.values(expectedAuctionDetails));
      expect(await fermionFNFTProxy.balanceOf(bidders[0].address)).to.equal(0n); // all fractions used
      expect(await fermionFNFTProxy.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(0n);
    });

    it("Bid with 100% fractions", async function () {
      const fractions = fractionsPerToken; // 100% of bid paid with fractions
      await fermionFNFTProxy.connect(seller).transfer(bidders[0].address, fractions);

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
        .to.emit(fermionFNFTProxy, "Transfer")
        .withArgs(await fermionFNFTProxy.getAddress(), ZeroAddress, fractions); // burn fractions

      expect(await fermionFNFTProxy.ownerOf(startTokenId)).to.equal(bidders[0].address);
      expect(await fermionFNFTProxy.balanceOfERC721(bidders[0].address)).to.equal(1n);
      expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(bidAmount);
      expectedAuctionDetails.timer = auctionEnd;
      expectedAuctionDetails.lockedBidAmount = bidAmount;
      expectedAuctionDetails.lockedFractions = fractions;
      expect(await fermionFNFTProxy.getAuctionDetails(startTokenId)).to.eql(Object.values(expectedAuctionDetails));
      expect(await fermionFNFTProxy.balanceOf(bidders[0].address)).to.equal(0n);
      expect(await fermionFNFTProxy.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(0n);
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
        const bidAmount = exitPrice - parseEther("0.1");
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
        );

      await fermionFNFTProxy.connect(seller).transfer(fractionalOwners[0].address, owner1Share);
      await fermionFNFTProxy.connect(seller).transfer(fractionalOwners[1].address, owner2Share);
      await fermionFNFTProxy.connect(seller).transfer(fractionalOwners[2].address, owner3Share);
    });

    async function claimAfterRedeem(
      biddersFractions: bigint,
      sellerShareAdjusted = sellerShare,
      bidAmount = price,
      vaultPayout = 0n,
    ) {
      await fermionFNFTProxy.connect(bidders[0]).redeem(startTokenId);
      expect(await fermionFNFTProxy.liquidSupply()).to.equal(0n);
      await verifyEventsAndBalances("claim", [], biddersFractions, sellerShareAdjusted, bidAmount, vaultPayout);
    }

    async function finalizeAndClaim(
      biddersFractions: bigint,
      sellerShareAdjusted = sellerShare,
      bidAmount = price,
      vaultPayout = 0n,
    ) {
      expect(await fermionFNFTProxy.liquidSupply()).to.equal(0n);
      await verifyEventsAndBalances(
        "finalizeAndClaim",
        [startTokenId],
        biddersFractions,
        sellerShareAdjusted,
        bidAmount,
        vaultPayout,
        false,
      );
    }

    async function claimWithLockedFractions(
      biddersFractions: bigint,
      sellerShareAdjusted = sellerShare,
      bidAmount = price,
      vaultPayout = 0n,
    ) {
      expect(await fermionFNFTProxy.liquidSupply()).to.equal(0n);
      await verifyEventsAndBalances(
        "claimWithLockedFractions",
        [startTokenId, 0],
        biddersFractions,
        sellerShareAdjusted,
        bidAmount,
        vaultPayout,
        false,
      );
    }

    async function verifyEventsAndBalances(
      method: string,
      args: any[] = [],
      biddersFractions: bigint,
      sellerShareAdjusted = sellerShare,
      bidAmount = price,
      vaultPayout = 0n,
      redeemed = true,
    ) {
      expect(await fermionFNFTProxy.totalSupply()).to.equal(fractionsPerToken - (redeemed ? biddersFractions : 0n));

      const availableVaultPayout =
        vaultPayout - applyPercentage(vaultPayout, (biddersFractions * 10000n) / fractionsPerToken);

      const availableForClaim = fractionsPerToken - biddersFractions;

      // console.log("availableforclaim", availableForClaim);
      // console.log("owner1Share",  owner1Share,owner1Share*10000n/availableForClaim);
      // console.log("bidAmount", bidAmount);

      // const owner1payout = applyPercentage(bidAmount + availableVaultPayout, owner1Share*10000n/availableForClaim); //20% of available
      const owner1payout = ((bidAmount + availableVaultPayout) * owner1Share) / availableForClaim; //20% of available
      const owner2payout = ((bidAmount + availableVaultPayout) * owner2Share) / availableForClaim; //30% of available
      const owner3payout = ((bidAmount + availableVaultPayout) * owner3Share) / availableForClaim; //10% of available
      const sellerPayout = bidAmount + availableVaultPayout - owner1payout - owner2payout - owner3payout;

      await expect(fermionFNFTProxy.connect(fractionalOwners[0])[method](...args, owner1Share))
        .to.emit(fermionFNFTProxy, "Claimed")
        .withArgs(fractionalOwners[0].address, owner1Share, owner1payout);
      expect(await fermionFNFTProxy.totalSupply()).to.equal(fractionsPerToken - biddersFractions - owner1Share);
      expect(await fermionFNFTProxy.liquidSupply()).to.equal(0n);
      await expect(fermionFNFTProxy.connect(fractionalOwners[1])[method](...args, owner2Share))
        .to.emit(fermionFNFTProxy, "Claimed")
        .withArgs(fractionalOwners[1].address, owner2Share, owner2payout);
      expect(await fermionFNFTProxy.totalSupply()).to.equal(
        fractionsPerToken - biddersFractions - owner1Share - owner2Share,
      );
      expect(await fermionFNFTProxy.liquidSupply()).to.equal(0n);
      await expect(fermionFNFTProxy.connect(fractionalOwners[2])[method](...args, owner3Share))
        .to.emit(fermionFNFTProxy, "Claimed")
        .withArgs(fractionalOwners[2].address, owner3Share, owner3payout);
      expect(await fermionFNFTProxy.totalSupply()).to.equal(
        fractionsPerToken - biddersFractions - owner1Share - owner2Share - owner3Share,
      );
      expect(await fermionFNFTProxy.liquidSupply()).to.equal(0n);
      await expect(fermionFNFTProxy.connect(seller)[method](...args, sellerShareAdjusted))
        .to.emit(fermionFNFTProxy, "Claimed")
        .withArgs(seller.address, sellerShareAdjusted, sellerPayout);
      expect(await fermionFNFTProxy.totalSupply()).to.equal(
        fractionsPerToken - biddersFractions - owner1Share - owner2Share - owner3Share - sellerShareAdjusted,
      );
      expect(await fermionFNFTProxy.liquidSupply()).to.equal(0n);

      expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(0n);
      expect(await fermionFNFTProxy.balanceOf(fractionalOwners[0].address)).to.equal(0n);
      expect(await fermionFNFTProxy.balanceOf(fractionalOwners[1].address)).to.equal(0n);
      expect(await fermionFNFTProxy.balanceOf(fractionalOwners[2].address)).to.equal(0n);
      expect(await fermionFNFTProxy.balanceOf(seller.address)).to.equal(0n);
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
          await fermionFNFTProxy.connect(seller).transfer(bidders[0].address, fractions);
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
          await fermionFNFTProxy.connect(seller).transfer(bidders[0].address, votes);
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
          await fermionFNFTProxy.connect(seller).transfer(bidders[0].address, fractions + votes);
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
        .withArgs(fractionalOwners[0].address, partialOwner1Share, partialOwner1Payout);

      expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(
        bidAmount - partialOwner1Payout,
      );
      expect(await fermionFNFTProxy.balanceOf(fractionalOwners[0].address)).to.equal(owner1Share - partialOwner1Share);
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
          .withArgs(fractionalOwners[0].address, owner1Share, owner1payout);

        expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(
          price1 + price2 - owner1payout,
        );
        expect(await fermionFNFTProxy.balanceOf(fractionalOwners[0].address)).to.equal(0n);
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
          .withArgs(fractionalOwners[0].address, owner1Share, owner1payout);

        expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(
          price1 + price2 - owner1payout,
        );
        expect(await fermionFNFTProxy.balanceOf(fractionalOwners[0].address)).to.equal(0n);
        expect(await mockExchangeToken.balanceOf(fractionalOwners[0].address)).to.equal(
          parseEther("1000") + owner1payout,
        );

        await fermionFNFTProxy.connect(bidders[0]).redeem(startTokenId + 1n);

        const owner2payout =
          ((price2 + price1 - owner1payout) * owner2Share) /
          (owner2Share + owner3Share + sellerShare + fractionsPerToken); // a new token was fractionated
        await expect(fermionFNFTProxy.connect(fractionalOwners[1]).claim(owner2Share))
          .to.emit(fermionFNFTProxy, "Claimed")
          .withArgs(fractionalOwners[1].address, owner2Share, owner2payout);

        expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(
          price1 + price2 - owner1payout - owner2payout,
        );
        expect(await fermionFNFTProxy.balanceOf(fractionalOwners[1].address)).to.equal(0n);
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
          .withArgs(seller.address, fractionsPerToken, price1);

        expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(price2);
        expect(await fermionFNFTProxy.balanceOf(seller.address)).to.equal(sellerShare);
        expect(await mockExchangeToken.balanceOf(seller.address)).to.equal(price1);
      });

      context("Some owner has locked votes", async function () {
        const fractions = 0n;
        const price1 = exitPrice + parseEther("0.1");
        const price2 = exitPrice + parseEther("0.2");

        const votes = (fractionsPerToken * 9n) / 10n; // seller locks in 90% of first token sale

        beforeEach(async function () {
          await fermionFNFTProxy.connect(seller).voteToStartAuction(startTokenId, votes);

          await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), price1 + price2);
          await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, price1, fractions);
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
            .withArgs(fractionalOwners[0].address, owner1Share, owner1payout);

          expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(
            price1 + price2 - owner1payout,
          );
          expect(await fermionFNFTProxy.balanceOf(fractionalOwners[0].address)).to.equal(0n);
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
            .withArgs(seller.address, sellerUnrestrictedShares + votes, totalPayout);

          expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(
            price1 + price2 - owner1payout - totalPayout,
          );
          expect(await fermionFNFTProxy.balanceOf(seller.address)).to.equal(0n);
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
            .withArgs(seller.address, sellerUnrestrictedShares + votes, totalPayout);

          expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(
            price1 + price2 - totalPayout,
          );
          expect(await fermionFNFTProxy.balanceOf(seller.address)).to.equal(0n);
          expect(await mockExchangeToken.balanceOf(seller.address)).to.equal(totalPayout);

          const remainingUnrestrictedShares = unrestrictedShares - sellerUnrestrictedShares;
          const remainingUnrestrictedPayout = unrestrictedPayout - sellerUnrestrictedPayout;
          const owner1payout = (remainingUnrestrictedPayout * owner1Share) / remainingUnrestrictedShares;

          await expect(fermionFNFTProxy.connect(fractionalOwners[0]).claim(owner1Share))
            .to.emit(fermionFNFTProxy, "Claimed")
            .withArgs(fractionalOwners[0].address, owner1Share, owner1payout);

          expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(
            price1 + price2 - owner1payout - totalPayout,
          );
          expect(await fermionFNFTProxy.balanceOf(fractionalOwners[0].address)).to.equal(0n);
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
            .withArgs(seller.address, sellerUnrestrictedSharesHalf + votes, totalPayout);

          expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(
            price1 + price2 - totalPayout,
          );
          expect(await fermionFNFTProxy.balanceOf(seller.address)).to.equal(sellerUnrestrictedSharesHalf);
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
            .withArgs(seller.address, sellerUnrestrictedSharesHalf, totalPayout2);

          expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(
            price1 + price2 - totalPayout - totalPayout2,
          );
          expect(await fermionFNFTProxy.balanceOf(seller.address)).to.equal(0n);
          expect(await mockExchangeToken.balanceOf(seller.address)).to.equal(totalPayout + totalPayout2);
        });

        it("Claim without additional votes", async function () {
          // claim with half of unrestricted shares
          const sellerUnrestrictedShares = sellerShare + fractionsPerToken - votes;
          const lockedPayout = (price1 * 9n) / 10n;

          await expect(fermionFNFTProxy.connect(seller).claimWithLockedFractions(startTokenId, 0, 0))
            .to.emit(fermionFNFTProxy, "Claimed")
            .withArgs(seller.address, votes, lockedPayout);

          expect(await mockExchangeToken.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(
            price1 + price2 - lockedPayout,
          );
          expect(await fermionFNFTProxy.balanceOf(seller.address)).to.equal(sellerUnrestrictedShares);
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
          .to.be.revertedWithCustomError(fermionFNFTProxy, "ERC20InsufficientBalance")
          .withArgs(fractionalOwners[0].address, owner1Share, owner1Share + 1n);

        await expect(fermionFNFTProxy.connect(fractionalOwners[0]).finalizeAndClaim(startTokenId, owner1Share + 1n))
          .to.be.revertedWithCustomError(fermionFNFTProxy, "ERC20InsufficientBalance")
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
      expect(await fermionFNFTProxy.getPastAuctionDetails(startTokenId, 1)).to.eql(
        Object.values(expectedAuctionDetails3),
      );
      expect(await fermionFNFTProxy.getPastAuctionDetails(startTokenId, 0)).to.eql(
        Object.values(expectedAuctionDetails),
      );

      // claim the previous auction
      await expect(fermionFNFTProxy.connect(seller).claimWithLockedFractions(startTokenId, 0, fractionsPerToken))
        .to.emit(fermionFNFTProxy, "Claimed")
        .withArgs(seller.address, fractionsPerToken, bidAmount);
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
        );
      await expect(tx2).to.emit(fermionFNFTProxy, "Fractionalised").withArgs(startTokenId, fractionsPerToken2);

      expect(await fermionFNFTProxy.getBuyoutAuctionParameters()).to.eql(Object.values(auctionParameters2));

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
      expect(await fermionFNFTProxy.getPastAuctionDetails(startTokenId, 1)).to.eql(
        Object.values(expectedAuctionDetails3),
      );
      expect(await fermionFNFTProxy.getPastAuctionDetails(startTokenId, 0)).to.eql(
        Object.values(expectedAuctionDetails),
      );
    });
  });

  context("getPastAuctionDetails", function () {
    context("Revert reasons", function () {
      it("Invalid index", async function () {
        await expect(fermionFNFTProxy.getPastAuctionDetails(startTokenId, 1))
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
        );

      await fermionFNFTProxy.connect(seller).transfer(bidders[0].address, votes1);
      await fermionFNFTProxy.connect(seller).transfer(bidders[1].address, votes2);
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
        expect(await fermionFNFTProxy.balanceOf(bidders[0].address)).to.equal(0n);
        expect(await fermionFNFTProxy.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(votes1);
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
        expect(await fermionFNFTProxy.balanceOf(bidders[0].address)).to.equal(votes1 - firstVote);
        expect(await fermionFNFTProxy.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(firstVote);

        const secondVote = votes1 - firstVote;
        const tx2 = await fermionFNFTProxy.connect(bidders[0]).voteToStartAuction(startTokenId, secondVote);

        await expect(tx2).to.emit(fermionFNFTProxy, "Voted").withArgs(startTokenId, bidders[0].address, secondVote);

        // state
        const [totalVotes2, threshold2, availableFractions2] = await fermionFNFTProxy.getVotes(startTokenId);
        expect(totalVotes2).to.equal(firstVote + secondVote);
        expect(threshold2).to.equal(applyPercentage(fractionsPerToken, auctionParameters.unlockThreshold));
        expect(availableFractions2).to.equal(fractionsPerToken - firstVote - secondVote);
        expect(await fermionFNFTProxy.getIndividualLockedVotes(startTokenId, bidders[0].address)).to.equal(votes1);
        expect(await fermionFNFTProxy.balanceOf(bidders[0].address)).to.equal(0n);
        expect(await fermionFNFTProxy.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(firstVote + secondVote);
      });

      it("When total votes exceeds threshold, the auction starts", async function () {
        const tx = await fermionFNFTProxy.connect(bidders[0]).voteToStartAuction(startTokenId, votes1);
        await expect(tx).to.not.emit(fermionFNFTProxy, "AuctionStarted");

        const tx2 = await fermionFNFTProxy.connect(bidders[1]).voteToStartAuction(startTokenId, votes2);
        const blockTimeStamp = (await tx2.getBlock()).timestamp;
        const auctionEnd = BigInt(blockTimeStamp) + auctionParameters.duration;
        await expect(tx2).to.emit(fermionFNFTProxy, "AuctionStarted").withArgs(startTokenId, auctionEnd);

        // state
        const [totalVotes, threshold, availableFractions] = await fermionFNFTProxy.getVotes(startTokenId);
        expect(totalVotes).to.equal(votes1 + votes2);
        expect(threshold).to.equal(applyPercentage(fractionsPerToken, auctionParameters.unlockThreshold));
        expect(availableFractions).to.equal(fractionsPerToken - votes1 - votes2);
        expect(await fermionFNFTProxy.getIndividualLockedVotes(startTokenId, bidders[0].address)).to.equal(votes1);
        expect(await fermionFNFTProxy.getIndividualLockedVotes(startTokenId, bidders[1].address)).to.equal(votes2);
        expect(await fermionFNFTProxy.balanceOf(bidders[0].address)).to.equal(0n);
        expect(await fermionFNFTProxy.balanceOf(bidders[1].address)).to.equal(0n);
        expect(await fermionFNFTProxy.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(votes1 + votes2);
      });

      it("Voting with more than available votes", async function () {
        // fractionalise another token and transfer the fractions to the bidder
        await fermionFNFTProxy.connect(seller).mintFractions(startTokenId + 1n, 1, additionalDeposit);
        await fermionFNFTProxy.connect(seller).transfer(bidders[0].address, fractionsPerToken);

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
        expect(await fermionFNFTProxy.balanceOf(bidders[0].address)).to.equal(votes1);
        expect(await fermionFNFTProxy.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(fractionsPerToken);
      });

      context("Revert reasons", function () {
        it("Amount to lock is 0", async function () {
          const votes = 0;
          await expect(
            fermionFNFTProxy.connect(bidders[0]).voteToStartAuction(startTokenId, votes),
          ).to.be.revertedWithCustomError(fermionFNFTProxy, "InvalidAmount");
        });

        it("Token is not fracionalised", async function () {
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

        it("Auction already started - via payment above exit price", async function () {
          const bidAmount = exitPrice + parseEther("0.01");
          await mockExchangeToken.connect(bidders[3]).approve(await fermionFNFTProxy.getAddress(), bidAmount);
          const tx = await fermionFNFTProxy.connect(bidders[3]).bid(startTokenId, bidAmount, 0n);
          const blockTimeStamp = (await tx.getBlock()).timestamp;
          const auctionEnd = BigInt(blockTimeStamp) + auctionParameters.duration;

          await expect(fermionFNFTProxy.connect(bidders[0]).voteToStartAuction(startTokenId, votes1))
            .to.be.revertedWithCustomError(fermionFNFTProxy, "AuctionOngoing")
            .withArgs(startTokenId, auctionEnd);
        });

        it("Auction already started - via vote over threshold", async function () {
          await fermionFNFTProxy.connect(bidders[0]).voteToStartAuction(startTokenId, votes1);

          const tx = await fermionFNFTProxy.connect(bidders[1]).voteToStartAuction(startTokenId, votes2);
          const blockTimeStamp = (await tx.getBlock()).timestamp;
          const auctionEnd = BigInt(blockTimeStamp) + auctionParameters.duration;

          await expect(fermionFNFTProxy.connect(bidders[0]).voteToStartAuction(startTokenId, votes1))
            .to.be.revertedWithCustomError(fermionFNFTProxy, "AuctionOngoing")
            .withArgs(startTokenId, auctionEnd);
        });

        it("The voter does not have enough fractions", async function () {
          await expect(fermionFNFTProxy.connect(bidders[0]).voteToStartAuction(startTokenId, votes1 + 1n))
            .to.be.revertedWithCustomError(fermionFNFTProxy, "ERC20InsufficientBalance")
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
        expect(await fermionFNFTProxy.balanceOf(bidders[0].address)).to.equal(votesToRemove);
        expect(await fermionFNFTProxy.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(votes1 - votesToRemove);
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
        expect(await fermionFNFTProxy.balanceOf(bidders[0].address)).to.equal(votes1);
        expect(await fermionFNFTProxy.balanceOf(await fermionFNFTProxy.getAddress())).to.equal(0n);
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
});
