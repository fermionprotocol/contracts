import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployMockTokens, setNextBlockTimestamp } from "../utils/common";
import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, ZeroHash, parseEther } from "ethers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { AuctionState, TokenState } from "../utils/enums";
import {
  AUCTION_END_BUFFER,
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
  let fermionProtocolSigner: HardhatEthersSigner;
  let wrapperContractOwner: HardhatEthersSigner;
  let seller: HardhatEthersSigner;
  const startTokenId = 2n ** 128n + 1n;
  const quantity = 10n;

  async function setupFermionFractionsTest() {
    wallets = await ethers.getSigners();
    fermionProtocolSigner = wallets[1]; // wallet that simulates the fermion protocol
    wrapperContractOwner = wallets[2];
    seller = wallets[3];
    bidders = wallets.slice(4, 8);

    const [mockConduit, mockBosonPriceDiscovery] = wallets.slice(9, 11);
    const FermionFNFT = await ethers.getContractFactory("FermionFNFT");
    const fermionFNFT = await FermionFNFT.deploy(mockBosonPriceDiscovery.address, {
      seaport: ZeroAddress,
      openSeaConduit: mockConduit.address,
      openSeaConduitKey: ZeroHash,
    }); // For these tests, zero constructor arguments are okay

    const Proxy = await ethers.getContractFactory("MockProxy");
    const proxy = await Proxy.deploy(await fermionFNFT.getAddress());

    const fermionFNFTProxy = await ethers.getContractAt("FermionFNFT", await proxy.getAddress(), fermionProtocolSigner);

    const [mockBoson, mockExchangeToken] = await deployMockTokens(["ERC721", "ERC20"]);

    await mockBoson.mint(fermionProtocolSigner, startTokenId, quantity);
    await fermionFNFTProxy.initialize(
      await mockBoson.getAddress(),
      wrapperContractOwner.address,
      await mockExchangeToken.getAddress(),
    );
    await mockBoson.connect(fermionProtocolSigner).setApprovalForAll(await fermionFNFTProxy.getAddress(), true);
    await fermionFNFTProxy.wrapForAuction(startTokenId, quantity, seller.address);

    for (let i = 0n; i < quantity; i++) {
      const tokenId = startTokenId + i;
      await fermionFNFTProxy.connect(mockBosonPriceDiscovery).unwrapToSelf(startTokenId + i, ZeroAddress, 0);
      if (i < quantity - 1n) await fermionFNFTProxy.pushToNextTokenState(tokenId, TokenState.Verified);
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

  context("mintFractions - initial", function () {
    const fractionsAmount = 5000n * 10n ** 18n;
    const auctionParameters = {
      exitPrice: parseEther("0.1"),
      duration: 60n * 60n * 24n * 7n, // 1 week
      unlockThreshold: 7500n, // 75%
      topBidLockTime: 60n * 60n * 24n * 2n, // two days
    };

    it("The owner can fractionalise a single NFT", async function () {
      const tx = await fermionFNFTProxy
        .connect(seller)
        .mintFractions(startTokenId, 1, fractionsAmount, auctionParameters);

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
      expect(await fermionFNFTProxy.tokenState(startTokenId)).to.equal(TokenState.Verified); // token state remains
      expect(await fermionFNFTProxy.balanceOf(seller.address)).to.equal(fractionsAmount);
      expect(await fermionFNFTProxy.totalSupply()).to.equal(fractionsAmount);
      expect(await fermionFNFTProxy.liquidSupply()).to.equal(fractionsAmount);
      expect(await fermionFNFTProxy.getBuyoutAuctionParameters()).to.eql(Object.values(auctionParameters));
    });

    it("The owner can fractionalise multiple NFT", async function () {
      const quantity = 5n;
      const totalFractions = quantity * fractionsAmount;
      const tx = await fermionFNFTProxy
        .connect(seller)
        .mintFractions(startTokenId, quantity, fractionsAmount, auctionParameters);

      // lock the F-NFT (erc721 transfer)
      for (let i = 0n; i < 5n; i++) {
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
      expect(await fermionFNFTProxy.tokenState(startTokenId)).to.equal(TokenState.Verified); // token state remains
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
        .mintFractions(startTokenId, 1, fractionsAmount, auctionParameters);

      await expect(tx)
        .to.emit(fermionFNFTProxy, "FractionsSetup")
        .withArgs(fractionsAmount, Object.values(auctionDefaultParameters));

      // state
      expect(await fermionFNFTProxy.getBuyoutAuctionParameters()).to.eql(Object.values(auctionDefaultParameters));
    });

    it("Protocol can forcefully fractionalise", async function () {
      const tx = await fermionFNFTProxy
        .connect(fermionProtocolSigner)
        .mintFractions(startTokenId, 1, fractionsAmount, auctionParameters);

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
      expect(await fermionFNFTProxy.tokenState(startTokenId)).to.equal(TokenState.Verified); // token state remains
      expect(await fermionFNFTProxy.balanceOf(seller.address)).to.equal(fractionsAmount);
      expect(await fermionFNFTProxy.totalSupply()).to.equal(fractionsAmount);
      expect(await fermionFNFTProxy.liquidSupply()).to.equal(fractionsAmount);
      expect(await fermionFNFTProxy.getBuyoutAuctionParameters()).to.eql(Object.values(auctionParameters));
    });

    context("Revert reasons", function () {
      it("Length is 0", async function () {
        await expect(
          fermionFNFTProxy.connect(seller).mintFractions(startTokenId, 0, fractionsAmount, auctionParameters),
        ).to.be.revertedWithCustomError(fermionFNFTProxy, "InvalidLength");
      });

      it("Initial fractionalisation happened already", async function () {
        await fermionFNFTProxy.connect(seller).mintFractions(startTokenId, 1, fractionsAmount, auctionParameters);

        await expect(
          fermionFNFTProxy.mintFractions(startTokenId + 1n, 1, fractionsAmount, auctionParameters),
        ).to.be.revertedWithCustomError(fermionFNFTProxy, "InitialFractionalisationOnly");
      });

      it("Invalid exit price", async function () {
        const auctionParameters2 = { ...auctionParameters, exitPrice: 0n };
        await expect(
          fermionFNFTProxy.connect(seller).mintFractions(startTokenId, 1, fractionsAmount, auctionParameters2),
        )
          .to.be.revertedWithCustomError(fermionFNFTProxy, "InvalidExitPrice")
          .withArgs(0n);
      });

      it("Invalid unlock threshold percentage", async function () {
        const unlockThreshold = 10001n;
        const auctionParameters2 = { ...auctionParameters, unlockThreshold };
        await expect(
          fermionFNFTProxy.connect(seller).mintFractions(startTokenId, 1, fractionsAmount, auctionParameters2),
        )
          .to.be.revertedWithCustomError(fermionFNFTProxy, "InvalidPercentage")
          .withArgs(unlockThreshold);
      });

      it("Invalid number of fractions", async function () {
        const fractionsAmountLow = MIN_FRACTIONS - 1n;
        await expect(
          fermionFNFTProxy.connect(seller).mintFractions(startTokenId, 1, fractionsAmountLow, auctionParameters),
        )
          .to.be.revertedWithCustomError(fermionFNFTProxy, "InvalidFractionsAmount")
          .withArgs(fractionsAmountLow, MIN_FRACTIONS, MAX_FRACTIONS);

        const fractionsAmountHigh = MAX_FRACTIONS + 1n;
        await expect(
          fermionFNFTProxy.connect(seller).mintFractions(startTokenId, 1, fractionsAmountHigh, auctionParameters),
        )
          .to.be.revertedWithCustomError(fermionFNFTProxy, "InvalidFractionsAmount")
          .withArgs(fractionsAmountHigh, MIN_FRACTIONS, MAX_FRACTIONS);
      });

      it("The token is not verified", async function () {
        const tokenId = startTokenId + quantity - 1n;
        await expect(fermionFNFTProxy.connect(seller).mintFractions(tokenId, 1, fractionsAmount, auctionParameters))
          .to.be.revertedWithCustomError(fermionFNFTProxy, "InvalidStateOrCaller")
          .withArgs(tokenId, seller.address, TokenState.Unverified);

        await fermionFNFTProxy.pushToNextTokenState(tokenId, TokenState.Verified);
        await fermionFNFTProxy.pushToNextTokenState(tokenId, TokenState.CheckedIn);

        await expect(fermionFNFTProxy.connect(seller).mintFractions(tokenId, 1, fractionsAmount, auctionParameters))
          .to.be.revertedWithCustomError(fermionFNFTProxy, "InvalidStateOrCaller")
          .withArgs(tokenId, seller.address, TokenState.CheckedIn);

        await fermionFNFTProxy.pushToNextTokenState(tokenId, TokenState.CheckedOut); // checkout burns the token
        await expect(fermionFNFTProxy.connect(seller).mintFractions(tokenId, 1, fractionsAmount, auctionParameters))
          .to.be.revertedWithCustomError(fermionFNFTProxy, "ERC721NonexistentToken")
          .withArgs(tokenId);
      });

      it("The caller is not approved", async function () {
        const rando = wallets[4];
        await expect(fermionFNFTProxy.connect(rando).mintFractions(startTokenId, 1, fractionsAmount, auctionParameters))
          .to.be.revertedWithCustomError(fermionFNFTProxy, "ERC721InsufficientApproval")
          .withArgs(rando.address, startTokenId);
      });

      it("The token does not exist", async function () {
        const tokenId = startTokenId + quantity + 1n;
        await expect(fermionFNFTProxy.connect(seller).mintFractions(tokenId, 1, fractionsAmount, auctionParameters))
          .to.be.revertedWithCustomError(fermionFNFTProxy, "ERC721NonexistentToken")
          .withArgs(tokenId);
      });
    });
  });

  context("mintFractions - additional", function () {
    const fractionsAmount = 5000n * 10n ** 18n;
    const auctionParameters = {
      exitPrice: parseEther("0.1"),
      duration: 60n * 60n * 24n * 7n, // 1 week
      unlockThreshold: 7500n, // 75%
      topBidLockTime: 60n * 60n * 24n * 2n, // two days
    };
    const startTokenId2 = startTokenId + 1n;

    beforeEach(async function () {
      await fermionFNFTProxy.connect(seller).mintFractions(startTokenId, 1, fractionsAmount, auctionParameters);
    });

    it("The owner can fractionalise a single NFT", async function () {
      const tx = await fermionFNFTProxy.connect(seller).mintFractions(startTokenId2, 1);

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
      expect(await fermionFNFTProxy.tokenState(startTokenId2)).to.equal(TokenState.Verified); // token state remains
      expect(await fermionFNFTProxy.balanceOf(seller.address)).to.equal(2n * fractionsAmount);
      expect(await fermionFNFTProxy.totalSupply()).to.equal(2n * fractionsAmount);
      expect(await fermionFNFTProxy.liquidSupply()).to.equal(2n * fractionsAmount);
    });

    it("The owner can fractionalise multiple NFT", async function () {
      const quantity = 5n;
      const totalFractions = quantity * fractionsAmount;
      const tx = await fermionFNFTProxy.connect(seller).mintFractions(startTokenId2, quantity);

      // lock the F-NFT (erc721 transfer)
      for (let i = 0n; i < 5n; i++) {
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
      expect(await fermionFNFTProxy.tokenState(startTokenId2)).to.equal(TokenState.Verified); // token state remains
      expect(await fermionFNFTProxy.balanceOf(seller.address)).to.equal(totalFractions + fractionsAmount);
      expect(await fermionFNFTProxy.totalSupply()).to.equal(totalFractions + fractionsAmount);
      expect(await fermionFNFTProxy.liquidSupply()).to.equal(totalFractions + fractionsAmount);
    });

    it("Protocol can forcefully fractionalise", async function () {
      const tx = await fermionFNFTProxy.connect(fermionProtocolSigner).mintFractions(startTokenId2, 1);

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
      expect(await fermionFNFTProxy.tokenState(startTokenId2)).to.equal(TokenState.Verified); // token state remains
      expect(await fermionFNFTProxy.balanceOf(seller.address)).to.equal(2n * fractionsAmount);
      expect(await fermionFNFTProxy.totalSupply()).to.equal(2n * fractionsAmount);
      expect(await fermionFNFTProxy.liquidSupply()).to.equal(2n * fractionsAmount);
      expect(await fermionFNFTProxy.getBuyoutAuctionParameters()).to.eql(Object.values(auctionParameters));
    });

    it("The owner, different from initial fractionalizer can fractionalise a NFT", async function () {
      const buyer = wallets[4];
      await fermionFNFTProxy.connect(seller).transferFrom(seller.address, buyer.address, startTokenId2);

      const tx = await fermionFNFTProxy.connect(buyer).mintFractions(startTokenId2, 1);

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
      expect(await fermionFNFTProxy.tokenState(startTokenId2)).to.equal(TokenState.Verified); // token state remains
      expect(await fermionFNFTProxy.balanceOf(seller.address)).to.equal(fractionsAmount);
      expect(await fermionFNFTProxy.balanceOf(buyer.address)).to.equal(fractionsAmount);
      expect(await fermionFNFTProxy.totalSupply()).to.equal(2n * fractionsAmount);
      expect(await fermionFNFTProxy.liquidSupply()).to.equal(2n * fractionsAmount);
    });

    context("Revert reasons", function () {
      it("Length is 0", async function () {
        await expect(fermionFNFTProxy.connect(seller).mintFractions(startTokenId2, 0)).to.be.revertedWithCustomError(
          fermionFNFTProxy,
          "InvalidLength",
        );
      });

      it("Missing Initial fractionalisation happened already", async function () {
        await loadFixture(setupFermionFractionsTest); // revert to initial state

        await expect(fermionFNFTProxy.mintFractions(startTokenId, 1)).to.be.revertedWithCustomError(
          fermionFNFTProxy,
          "MissingFractionalisation",
        );
      });

      it("The token is fractionalised already", async function () {
        // if fractionalised, the token is owned by the contract
        await expect(fermionFNFTProxy.connect(seller).mintFractions(startTokenId, 1))
          .to.be.revertedWithCustomError(fermionFNFTProxy, "ERC721InsufficientApproval")
          .withArgs(seller.address, startTokenId);
      });

      it("The token is not verified", async function () {
        const tokenId = startTokenId + quantity - 1n;
        await expect(fermionFNFTProxy.connect(seller).mintFractions(tokenId, 1))
          .to.be.revertedWithCustomError(fermionFNFTProxy, "InvalidStateOrCaller")
          .withArgs(tokenId, seller.address, TokenState.Unverified);

        await fermionFNFTProxy.pushToNextTokenState(tokenId, TokenState.Verified);
        await fermionFNFTProxy.pushToNextTokenState(tokenId, TokenState.CheckedIn);

        await expect(fermionFNFTProxy.connect(seller).mintFractions(tokenId, 1))
          .to.be.revertedWithCustomError(fermionFNFTProxy, "InvalidStateOrCaller")
          .withArgs(tokenId, seller.address, TokenState.CheckedIn);

        await fermionFNFTProxy.pushToNextTokenState(tokenId, TokenState.CheckedOut); // checkout burns the token
        await expect(fermionFNFTProxy.connect(seller).mintFractions(tokenId, 1))
          .to.be.revertedWithCustomError(fermionFNFTProxy, "ERC721NonexistentToken")
          .withArgs(tokenId);
      });

      it("The caller is not approved", async function () {
        const rando = wallets[4];
        await expect(fermionFNFTProxy.connect(rando).mintFractions(startTokenId2, 1))
          .to.be.revertedWithCustomError(fermionFNFTProxy, "ERC721InsufficientApproval")
          .withArgs(rando.address, startTokenId2);
      });

      it("The token does not exist", async function () {
        const tokenId = startTokenId + quantity + 1n;
        await expect(fermionFNFTProxy.connect(seller).mintFractions(tokenId, 1))
          .to.be.revertedWithCustomError(fermionFNFTProxy, "ERC721NonexistentToken")
          .withArgs(tokenId);
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

    beforeEach(async function () {
      await fermionFNFTProxy.connect(seller).mintFractions(startTokenId, 1, fractionsPerToken, auctionParameters);
    });

    context.only("Bid without fractions or votes", function () {
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
        expect(auctionDetails.timer).to.equal(auctionEnd);

        const bidAmount2 = bidAmount + parseEther("0.1");
        await mockExchangeToken.connect(bidders[1]).approve(await fermionFNFTProxy.getAddress(), bidAmount2);

        const tx2 = await fermionFNFTProxy.connect(bidders[1]).bid(startTokenId, bidAmount2, fractions);
        await expect(tx2).to.not.emit(fermionFNFTProxy, "AuctionStarted");

        const auctionDetails2 = await fermionFNFTProxy.getAuctionDetails(startTokenId);
        expect(auctionDetails2.timer).to.equal(auctionEnd);
      });

      it("Bidding within the buffer time extends the end", async function () {
        const bidAmount = exitPrice + parseEther("0.1");
        await mockExchangeToken.connect(bidders[0]).approve(await fermionFNFTProxy.getAddress(), bidAmount);

        const tx = await fermionFNFTProxy.connect(bidders[0]).bid(startTokenId, bidAmount, fractions);

        const blockTimeStamp = (await tx.getBlock()).timestamp;
        const auctionEnd = BigInt(blockTimeStamp) + auctionParameters.duration;

        const auctionDetails = await fermionFNFTProxy.getAuctionDetails(startTokenId);
        expect(auctionDetails.timer).to.equal(auctionEnd);

        const newBidTime = auctionEnd - AUCTION_END_BUFFER + 60n; // 60s after the buffer period reached
        await setNextBlockTimestamp(String(newBidTime));

        const bidAmount2 = bidAmount + parseEther("0.1");
        await mockExchangeToken.connect(bidders[1]).approve(await fermionFNFTProxy.getAddress(), bidAmount2);

        const tx2 = await fermionFNFTProxy.connect(bidders[1]).bid(startTokenId, bidAmount2, fractions);
        const blockTimeStamp2 = (await tx2.getBlock()).timestamp;
        const auctionEnd2 = BigInt(blockTimeStamp2) + AUCTION_END_BUFFER;

        const auctionDetails2 = await fermionFNFTProxy.getAuctionDetails(startTokenId);
        expect(auctionDetails2.timer).to.equal(auctionEnd2);
      });
    });

    context.only("Bid with fractions", function () {
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
        await fermionFNFTProxy.connect(seller).mintFractions(startTokenId + 1n, 1);
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

    context("Bid with votes", function () {});
    context("Bid with votes and fractions", function () {});

    context("Revert reasons", function () {});
  });
});
