import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployMockTokens } from "../utils/common";
import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, ZeroHash, parseEther } from "ethers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { TokenState } from "../utils/enums";
import {
  MIN_FRACTIONS,
  MAX_FRACTIONS,
  TOP_BID_LOCK_TIME,
  AUCTION_DURATION,
  UNLOCK_THRESHOLD,
} from "../utils/constants";

const { ZeroAddress } = ethers;

describe("FermionFNFT - fractionalisation tests", function () {
  let fermionFNFTProxy: Contract;
  let wallets: HardhatEthersSigner[];
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
    // fermionFNFTProxy = fermionFNFTProxy.connect(fermionProtocolSigner);

    const [mockBoson] = await deployMockTokens(["ERC721"]);

    await mockBoson.mint(fermionProtocolSigner, startTokenId, quantity);
    await fermionFNFTProxy.initialize(await mockBoson.getAddress(), wrapperContractOwner.address);
    await mockBoson.connect(fermionProtocolSigner).setApprovalForAll(await fermionFNFTProxy.getAddress(), true);
    await fermionFNFTProxy.wrapForAuction(startTokenId, quantity, seller.address);

    for (let i = 0n; i < quantity; i++) {
      const tokenId = startTokenId + i;
      await fermionFNFTProxy.connect(mockBosonPriceDiscovery).unwrapToSelf(startTokenId + i, ZeroAddress, 0);
      if (i < quantity - 1n) await fermionFNFTProxy.pushToNextTokenState(tokenId, TokenState.Verified);
    }

    return { fermionFNFT, fermionFNFTProxy, mockBoson, mockBosonPriceDiscovery };
  }

  before(async function () {
    ({ fermionFNFTProxy } = await loadFixture(setupFermionFractionsTest));
  });

  afterEach(async function () {
    await loadFixture(setupFermionFractionsTest);
  });

  context("mintFractions", function () {
    const fractionsAmount = 5000n * 10n ** 18n;
    const auctionParameters = {
      exitPrice: parseEther("0.1"),
      duration: 60n * 60n * 24n * 7n, // 1 week
      unlockThreshold: 7500n, // 75%
      topBidLockTime: 60n * 60n * 24n * 2n, // two days
    };

    beforeEach(async function () {});

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
        .to.emit(fermionFNFTProxy, "FracionsSetup")
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
        .to.emit(fermionFNFTProxy, "FracionsSetup")
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
        .to.emit(fermionFNFTProxy, "FracionsSetup")
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
        .to.emit(fermionFNFTProxy, "FracionsSetup")
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

      it("The token is fractionalised already", async function () {
        await fermionFNFTProxy.connect(seller).mintFractions(startTokenId, 1, fractionsAmount, auctionParameters);

        await expect(
          fermionFNFTProxy.connect(seller).mintFractions(startTokenId, 1, fractionsAmount, auctionParameters),
        ).to.be.revertedWithCustomError(fermionFNFTProxy, "InitialFractionalisationOnly");
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
});
