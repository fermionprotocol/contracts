import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import {
  calculateMinimalPrice,
  deployFermionProtocolFixture,
  deployMockTokens,
  deriveTokenId,
  setNextBlockTimestamp,
  verifySellerAssistantRoleClosure,
} from "../utils/common";
import { getBosonHandler, getBosonVoucher } from "../utils/boson-protocol";
import PriceDiscovery from "@bosonprotocol/boson-protocol-contracts/scripts/domain/PriceDiscovery.js";
import Side from "@bosonprotocol/boson-protocol-contracts/scripts/domain/Side.js";
import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, ZeroHash } from "ethers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { EntityRole, PausableRegion, TokenState, AccountRole } from "../utils/enums";
import { FermionTypes } from "../../typechain-types/contracts/protocol/facets/Offer.sol/OfferFacet";
import { Seaport } from "@opensea/seaport-js";
import { ItemType } from "@opensea/seaport-js/lib/constants";
import { AdvancedOrder } from "@opensea/seaport-js/lib/types";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { getBosonProtocolFees } from "../utils/boson-protocol";
import fermionConfig from "./../../fermion.config";

const { id, MaxUint256, ZeroAddress, parseEther } = ethers;
const { protocolFeePercentage: bosonProtocolFeePercentage } = getBosonProtocolFees();

describe("Offer", function () {
  const sellerId = "1";
  const verifierId = "2";
  const custodianId = "3";
  const facilitatorId = "4";
  const facilitator2Id = "5";
  const custodianFee = {
    amount: parseEther("0.05"),
    period: 30n * 24n * 60n * 60n, // 30 days
  };
  let offerFacet: Contract,
    entityFacet: Contract,
    fundsFacet: Contract,
    pauseFacet: Contract,
    verificationFacet: Contract;
  let mockToken: Contract, mockBosonToken: Contract;
  let fermionErrors: Contract;
  let fermionProtocolAddress: string;
  let wallets: HardhatEthersSigner[];
  let defaultSigner: HardhatEthersSigner;
  let facilitator: HardhatEthersSigner, facilitator2: HardhatEthersSigner;
  let seaportAddress: string;
  let bosonProtocolAddress: string;
  let seaportContract: Contract;
  let bosonTokenAddress: string;
  let verifySellerAssistantRole: any;

  async function setupOfferTest() {
    facilitator = wallets[4];
    facilitator2 = wallets[5];
    // Create three entities
    // Seller, Verifier, Custodian combined
    // Verifier only
    // Custodian only
    // Facilitator
    const metadataURI = "https://example.com/seller-metadata.json";
    await entityFacet.createEntity([EntityRole.Seller, EntityRole.Verifier, EntityRole.Custodian], metadataURI); // "1"
    await entityFacet.connect(wallets[2]).createEntity([EntityRole.Verifier], metadataURI); // "2"
    await entityFacet.connect(wallets[3]).createEntity([EntityRole.Custodian], metadataURI); // "3"
    await entityFacet.connect(facilitator).createEntity([EntityRole.Seller], metadataURI); // "4"
    await entityFacet.connect(facilitator2).createEntity([EntityRole.Seller], metadataURI); // "4"

    await entityFacet.addFacilitators(sellerId, [facilitatorId, facilitator2Id]);

    [mockToken] = await deployMockTokens(["ERC20"]);
    mockToken = mockToken.connect(defaultSigner);
    await mockToken.mint(defaultSigner.address, parseEther("1000"));

    await offerFacet.addSupportedToken(await mockToken.getAddress());
    await offerFacet.addSupportedToken(ZeroAddress);

    mockBosonToken = await ethers.getContractAt("MockERC20", bosonTokenAddress, defaultSigner);
    await mockBosonToken.mint(defaultSigner.address, parseEther("1000"));
  }

  before(async function () {
    ({
      diamondAddress: fermionProtocolAddress,
      facets: {
        EntityFacet: entityFacet,
        OfferFacet: offerFacet,
        FundsFacet: fundsFacet,
        PauseFacet: pauseFacet,
        VerificationFacet: verificationFacet,
      },
      fermionErrors,
      wallets,
      defaultSigner,
      seaportAddress,
      bosonProtocolAddress,
      seaportContract,
      bosonTokenAddress,
    } = await loadFixture(deployFermionProtocolFixture));

    await loadFixture(setupOfferTest);

    verifySellerAssistantRole = verifySellerAssistantRoleClosure(offerFacet, wallets, entityFacet, fermionErrors);
  });

  afterEach(async function () {
    await loadFixture(setupOfferTest);
  });

  context("createOffer", function () {
    const sellerDeposit = 100;
    const verifierFee = 10;
    const custodianFee = {
      amount: parseEther("0.05"),
      period: 30n * 24n * 60n * 60n, // 30 days
    };
    const metadataURI = "https://example.com/offer-metadata.json";
    let exchangeToken: string;
    let fermionOffer: FermionTypes.OfferStruct;
    const bosonOfferId = "1";

    before(async function () {
      exchangeToken = await mockToken.getAddress();

      fermionOffer = {
        sellerId,
        sellerDeposit,
        verifierId,
        verifierFee,
        custodianId,
        custodianFee,
        facilitatorId,
        facilitatorFeePercent: "0",
        exchangeToken,
        metadataURI,
        metadataHash: id(metadataURI),
      };
    });

    it("Create fermion offer", async function () {
      // test event
      await expect(offerFacet.createOffer(fermionOffer))
        .to.emit(offerFacet, "OfferCreated")
        .withArgs(
          sellerId,
          verifierId,
          custodianId,
          Object.values({ ...fermionOffer, custodianFee: Object.values(fermionOffer.custodianFee) }),
          bosonOfferId,
        );

      // verify state
      const offer = await offerFacet.getOffer(bosonOfferId);
      expect(offer.sellerId).to.equal(sellerId);
      expect(offer.sellerDeposit).to.equal(sellerDeposit);
      expect(offer.verifierId).to.equal(verifierId);
      expect(offer.verifierFee).to.equal(verifierFee);
      expect(offer.custodianId).to.equal(custodianId);
      expect(offer.exchangeToken).to.equal(exchangeToken);
      expect(offer.metadataURI).to.equal(metadataURI);
      expect(offer.metadataHash).to.equal(id(metadataURI));
    });

    it("Boson Offer is created", async function () {
      const bosonOfferHandler = await getBosonHandler("IBosonOfferHandler");

      await expect(offerFacet.createOffer(fermionOffer)).to.emit(bosonOfferHandler, "OfferCreated");

      const [exists, offer, offerDates, offerDurations, disputeResolutionTerms, offerFees] =
        await bosonOfferHandler.getOffer(1n);
      expect(exists).to.be.equal(true);
      expect(offer.sellerId).to.equal("1"); // fermion's seller id inside Boson
      // expect(offer.price).to.equal(verifierFee);
      expect(offer.price).to.equal(0); // change after boson v2.4.2
      expect(offer.sellerDeposit).to.equal(sellerDeposit);
      // expect(offer.buyerCancelPenalty).to.equal(verifierFee);
      expect(offer.buyerCancelPenalty).to.equal(0); // change after boson v2.4.2
      expect(offer.quantityAvailable).to.equal(MaxUint256);
      expect(offer.exchangeToken).to.equal(exchangeToken);
      expect(offer.metadataUri).to.equal(metadataURI);
      expect(offer.metadataHash).to.equal(id(metadataURI));
      expect(offer.collectionIndex).to.equal(0);
      expect(offer.voided).to.be.equal(false);
      expect(offer.royaltyInfo).to.eql([[[], []]]); // one empty royalty info

      expect(offerDates.validFrom).to.equal(0);
      expect(offerDates.validUntil).to.equal(MaxUint256);
      expect(offerDates.voucherRedeemableFrom).to.equal(0);
      expect(offerDates.voucherRedeemableUntil).to.equal(0);

      expect(offerDurations.disputePeriod).to.equal(MaxUint256);
      expect(offerDurations.voucherValid).to.equal(1); // The lowest allowed value
      expect(offerDurations.resolutionPeriod).to.equal(7 * 24 * 60 * 60); // 7 days

      expect(disputeResolutionTerms.disputeResolverId).to.equal("3"); // fermion's DR id inside Boson
      expect(disputeResolutionTerms.escalationResponsePeriod).to.equal(1); // The lowest allowed value
      expect(disputeResolutionTerms.feeAmount).to.equal(0);
      expect(disputeResolutionTerms.buyerEscalationDeposit).to.equal(0);

      expect(offerFees.protocolFee).to.equal(0); // until the price is determined, the fees are unknown
      expect(offerFees.agentFee).to.equal(0);
    });

    it("Create fermion offer with self verification and self custody", async function () {
      const fermionOffer2 = { ...fermionOffer, verifierId: sellerId, custodianId: sellerId };

      // test event
      await expect(offerFacet.createOffer(fermionOffer2))
        .to.emit(offerFacet, "OfferCreated")
        .withArgs(
          sellerId,
          sellerId,
          sellerId,
          Object.values({ ...fermionOffer2, custodianFee: Object.values(fermionOffer2.custodianFee) }),
          bosonOfferId,
        );

      // verify state
      const offer = await offerFacet.getOffer(bosonOfferId);
      expect(offer.verifierId).to.equal(sellerId);
      expect(offer.custodianId).to.equal(sellerId);
    });

    it("Assistant wallets can create the offer", async function () {
      const entityAssistant = wallets[4]; // entity-wide Assistant
      const sellerAssistant = wallets[5]; // Seller-specific Assistant

      await entityFacet.addEntityAccounts(
        sellerId,
        [entityAssistant, sellerAssistant],
        [[], [EntityRole.Seller]],
        [[[AccountRole.Assistant]], [[AccountRole.Assistant]]],
      );

      // test event
      await expect(offerFacet.connect(entityAssistant).createOffer(fermionOffer))
        .to.emit(offerFacet, "OfferCreated")
        .withArgs(
          sellerId,
          verifierId,
          custodianId,
          Object.values({ ...fermionOffer, custodianFee: Object.values(fermionOffer.custodianFee) }),
          bosonOfferId,
        );

      await expect(offerFacet.connect(sellerAssistant).createOffer(fermionOffer))
        .to.emit(offerFacet, "OfferCreated")
        .withArgs(
          sellerId,
          verifierId,
          custodianId,
          Object.values({ ...fermionOffer, custodianFee: Object.values(fermionOffer.custodianFee) }),
          "2",
        );
    });

    it("Facilitator wallets can create the offer", async function () {
      const facilitatorAssistant = wallets[5]; // Facilitator-specific Assistant

      await entityFacet
        .connect(facilitator)
        .addEntityAccounts(facilitatorId, [facilitatorAssistant], [[EntityRole.Seller]], [[[AccountRole.Assistant]]]);

      // test event
      await expect(offerFacet.connect(facilitator).createOffer(fermionOffer))
        .to.emit(offerFacet, "OfferCreated")
        .withArgs(
          sellerId,
          verifierId,
          custodianId,
          Object.values({ ...fermionOffer, custodianFee: Object.values(fermionOffer.custodianFee) }),
          bosonOfferId,
        );

      await expect(offerFacet.connect(facilitatorAssistant).createOffer(fermionOffer))
        .to.emit(offerFacet, "OfferCreated")
        .withArgs(
          sellerId,
          verifierId,
          custodianId,
          Object.values({ ...fermionOffer, custodianFee: Object.values(fermionOffer.custodianFee) }),
          "2",
        );
    });

    context("Revert reasons", function () {
      it("Offer region is paused", async function () {
        await pauseFacet.pause([PausableRegion.Offer]);

        await expect(offerFacet.createOffer(fermionOffer))
          .to.be.revertedWithCustomError(fermionErrors, "RegionPaused")
          .withArgs(PausableRegion.Offer);
      });

      it("Caller is not the seller's assistant", async function () {
        await verifySellerAssistantRole("createOffer", [fermionOffer]);
      });

      it("Provided verifier ID is incorrect", async function () {
        // existent id, but not a verifier
        const fermionOffer2 = { ...fermionOffer, verifierId: "3" };
        await expect(offerFacet.createOffer(fermionOffer2))
          .to.be.revertedWithCustomError(fermionErrors, "EntityHasNoRole")
          .withArgs("3", EntityRole.Verifier);

        // non existent id
        fermionOffer2.verifierId = "10";
        await expect(offerFacet.createOffer(fermionOffer2))
          .to.be.revertedWithCustomError(fermionErrors, "EntityHasNoRole")
          .withArgs("10", EntityRole.Verifier);
      });

      it("Provided custodian ID is incorrect", async function () {
        // existent id, but not a custodian
        const fermionOffer2 = { ...fermionOffer, custodianId: "2" };
        await expect(offerFacet.createOffer(fermionOffer2))
          .to.be.revertedWithCustomError(fermionErrors, "EntityHasNoRole")
          .withArgs("2", EntityRole.Custodian);

        // non existent id
        fermionOffer2.custodianId = "10";
        await expect(offerFacet.createOffer(fermionOffer2))
          .to.be.revertedWithCustomError(fermionErrors, "EntityHasNoRole")
          .withArgs("10", EntityRole.Custodian);
      });

      it("Provided facilitator ID is incorrect", async function () {
        // existent id, but not a custodian
        const fermionOffer2 = { ...fermionOffer, facilitatorId: "2" };
        await expect(offerFacet.createOffer(fermionOffer2))
          .to.be.revertedWithCustomError(fermionErrors, "NotSellersFacilitator")
          .withArgs(sellerId, "2");

        // non existent id
        fermionOffer2.facilitatorId = "10";
        await expect(offerFacet.createOffer(fermionOffer2))
          .to.be.revertedWithCustomError(fermionErrors, "NotSellersFacilitator")
          .withArgs(sellerId, "10");
      });

      it("Facilitator don't set themselves as facilitator", async function () {
        const fermionOffer2 = { ...fermionOffer, facilitatorId: facilitator2Id };
        // test event
        await expect(offerFacet.connect(facilitator).createOffer({ ...fermionOffer2 }))
          .to.be.revertedWithCustomError(fermionErrors, "AccountHasNoRole")
          .withArgs(sellerId, facilitator.address, EntityRole.Seller, AccountRole.Assistant);
      });

      it("Facilitator fee percentage is more than 100%", async function () {
        const facilitatorFeePercent = "10001";
        const fermionOffer2 = { ...fermionOffer, facilitatorFeePercent };
        // test event
        await expect(offerFacet.connect(facilitator).createOffer({ ...fermionOffer2 }))
          .to.be.revertedWithCustomError(fermionErrors, "InvalidPercentage")
          .withArgs(facilitatorFeePercent);
      });
    });
  });

  context("getOffer", function () {
    it("Get offer", async function () {
      const bosonOfferId = "1";
      const exchangeToken = await mockToken.getAddress();
      const sellerDeposit = 100;
      const verifierFee = 10;
      const metadataURI = "https://example.com/offer-metadata.json";

      const fermionOffer = {
        sellerId,
        sellerDeposit,
        verifierId,
        verifierFee,
        custodianId,
        custodianFee,
        facilitatorId: sellerId,
        facilitatorFeePercent: "0",
        exchangeToken,
        metadataURI,
        metadataHash: id(metadataURI),
      };

      await offerFacet.createOffer(fermionOffer);

      const offer = await offerFacet.getOffer(bosonOfferId);
      expect(offer.sellerId).to.equal(sellerId);
      expect(offer.sellerDeposit).to.equal(sellerDeposit);
      expect(offer.verifierId).to.equal(verifierId);
      expect(offer.verifierFee).to.equal(verifierFee);
      expect(offer.custodianId).to.equal(custodianId);
      expect(offer.exchangeToken).to.equal(exchangeToken);
      expect(offer.metadataURI).to.equal(metadataURI);
      expect(offer.metadataHash).to.equal(id(metadataURI));
    });

    it("Get non-existent offer", async function () {
      const offer = await offerFacet.getOffer("2");
      expect(offer.sellerId).to.equal(0);
      expect(offer.sellerDeposit).to.equal(0);
      expect(offer.verifierId).to.equal(0);
      expect(offer.verifierFee).to.equal(0);
      expect(offer.custodianId).to.equal(0);
      expect(offer.exchangeToken).to.equal(ZeroAddress);
      expect(offer.metadataURI).to.equal("");
      expect(offer.metadataHash).to.equal("");
    });
  });

  context("mintAndWrapNFTs", function () {
    const bosonOfferId = 1n;
    const sellerDeposit = 100n;
    const quantity = 15n;
    beforeEach(async function () {
      const fermionOffer = {
        sellerId: "1",
        sellerDeposit,
        verifierId: "2",
        verifierFee: 10,
        custodianId: "3",
        custodianFee,
        facilitatorId,
        facilitatorFeePercent: "0",
        exchangeToken: await mockToken.getAddress(),
        metadataURI: "https://example.com/offer-metadata.json",
        metadataHash: ZeroHash,
      };

      // erc20 offer
      await offerFacet.createOffer(fermionOffer);

      // native offer
      fermionOffer.exchangeToken = ZeroAddress;
      await offerFacet.createOffer(fermionOffer);
    });

    it("Minting and wrapping", async function () {
      const bosonSellerId = "1";
      const bosonOfferHandler = await getBosonHandler("IBosonOfferHandler");
      const bosonExchangeHandler = await getBosonHandler("IBosonExchangeHandler");
      const bosonAccountHandler = await getBosonHandler("IBosonAccountHandler");
      const [defaultCollectionAddress] = await bosonAccountHandler.getSellersCollections(bosonSellerId);
      const bosonVoucher = await getBosonVoucher(defaultCollectionAddress);

      const nextBosonExchangeId = await bosonExchangeHandler.getNextExchangeId();
      const startingTokenId = deriveTokenId(bosonOfferId, nextBosonExchangeId);
      const predictedWrapperAddress = await offerFacet.predictFermionFNFTAddress(bosonOfferId);

      // ERC20 offer
      const tx = await offerFacet.mintAndWrapNFTs(bosonOfferId, quantity);

      // test events
      // fermion
      await expect(tx).to.emit(offerFacet, "NFTsMinted").withArgs(bosonOfferId, startingTokenId, quantity);
      await expect(tx)
        .to.emit(offerFacet, "NFTsWrapped")
        .withArgs(bosonOfferId, predictedWrapperAddress, startingTokenId, quantity);

      // boson
      await expect(tx)
        .to.emit(bosonOfferHandler, "RangeReserved")
        .withArgs(
          bosonOfferId,
          bosonSellerId,
          nextBosonExchangeId,
          nextBosonExchangeId + quantity - 1n,
          fermionProtocolAddress,
          fermionProtocolAddress,
        );

      // boson voucher
      await expect(tx)
        .to.emit(bosonVoucher, "RangeReserved")
        .withArgs(bosonOfferId, [startingTokenId, quantity, 0n, 0n, fermionProtocolAddress]);

      // fermion wrapper
      const fermionWrapper = await ethers.getContractAt("FermionFNFT", predictedWrapperAddress);
      for (let i = 0; i < quantity; i++) {
        const tokenId = startingTokenId + BigInt(i);

        await expect(tx).to.emit(fermionWrapper, "Transfer").withArgs(0n, defaultSigner.address, tokenId);

        const tokenState = await fermionWrapper.tokenState(tokenId);
        expect(tokenState).to.equal(TokenState.Wrapped);
      }

      // Native currency offer
      const bosonOfferId2 = bosonOfferId + 1n;
      const nextBosonExchangeId2 = nextBosonExchangeId + quantity;
      const startingTokenId2 = deriveTokenId(bosonOfferId2, nextBosonExchangeId2);
      const tx2 = await offerFacet.mintAndWrapNFTs(bosonOfferId2, quantity);
      const predictedWrapperAddress2 = await offerFacet.predictFermionFNFTAddress(bosonOfferId2);

      // test events
      // fermion
      await expect(tx2).to.emit(offerFacet, "NFTsMinted").withArgs(bosonOfferId2, startingTokenId2, quantity);
      await expect(tx2)
        .to.emit(offerFacet, "NFTsWrapped")
        .withArgs(bosonOfferId2, predictedWrapperAddress2, startingTokenId2, quantity);

      // boson
      await expect(tx2)
        .to.emit(bosonOfferHandler, "RangeReserved")
        .withArgs(
          bosonOfferId2,
          bosonSellerId,
          nextBosonExchangeId2,
          nextBosonExchangeId2 + quantity - 1n,
          fermionProtocolAddress,
          fermionProtocolAddress,
        );

      // boson voucher
      await expect(tx2)
        .to.emit(bosonVoucher, "RangeReserved")
        .withArgs(bosonOfferId2, [startingTokenId2, quantity, 0n, 0n, fermionProtocolAddress]);

      const fermionWrapper2 = await ethers.getContractAt("FermionFNFT", predictedWrapperAddress2);
      for (let i = 0; i < quantity; i++) {
        const tokenId = startingTokenId2 + BigInt(i);

        await expect(tx2).to.emit(fermionWrapper2, "Transfer").withArgs(0n, defaultSigner.address, tokenId);

        const tokenState = await fermionWrapper2.tokenState(tokenId);
        expect(tokenState).to.equal(TokenState.Wrapped);
      }

      // not checking the state of boson contracts (protocol, voucher contract)
      // since the change is guaranteed by the events and the state itself is checked in the boson-protocol tests
    });

    it("Assistant wallets can mint NFTs", async function () {
      const entityAssistant = wallets[4]; // entity-wide Assistant
      const sellerAssistant = wallets[5]; // Seller-specific Assistant

      await entityFacet.addEntityAccounts(
        sellerId,
        [entityAssistant, sellerAssistant],
        [[], [EntityRole.Seller]],
        [[[AccountRole.Assistant]], [[AccountRole.Assistant]]],
      );

      const totalSellerDeposit = sellerDeposit * quantity;
      await mockToken.mint(entityAssistant.address, totalSellerDeposit);

      // test event
      await expect(offerFacet.connect(entityAssistant).mintAndWrapNFTs(bosonOfferId, quantity)).to.emit(
        offerFacet,
        "NFTsMinted",
      );

      await expect(offerFacet.connect(sellerAssistant).mintAndWrapNFTs(bosonOfferId + 1n, quantity)).to.emit(
        offerFacet,
        "NFTsMinted",
      );
    });

    it("Facilitator wallets can mint NFTs", async function () {
      const facilitatorAssistant = wallets[5]; // Facilitator-specific Assistant

      await entityFacet
        .connect(facilitator)
        .addEntityAccounts(facilitatorId, [facilitatorAssistant], [[EntityRole.Seller]], [[[AccountRole.Assistant]]]);

      // test event
      await expect(offerFacet.connect(facilitator).mintAndWrapNFTs(bosonOfferId, quantity)).to.emit(
        offerFacet,
        "NFTsMinted",
      );

      await expect(offerFacet.connect(facilitatorAssistant).mintAndWrapNFTs(bosonOfferId + 1n, quantity)).to.emit(
        offerFacet,
        "NFTsMinted",
      );
    });

    context("Revert reasons", function () {
      it("Offer region is paused", async function () {
        await pauseFacet.pause([PausableRegion.Offer]);

        await expect(offerFacet.mintAndWrapNFTs(bosonOfferId, quantity))
          .to.be.revertedWithCustomError(fermionErrors, "RegionPaused")
          .withArgs(PausableRegion.Offer);
      });

      it("Caller is not the seller's assistant", async function () {
        await verifySellerAssistantRole("mintAndWrapNFTs", [bosonOfferId, quantity]);
      });

      it("Caller is not the facilitator defined in the offer", async function () {
        await expect(offerFacet.connect(facilitator2).mintAndWrapNFTs(bosonOfferId, quantity))
          .to.be.revertedWithCustomError(fermionErrors, "AccountHasNoRole")
          .withArgs(sellerId, facilitator2.address, EntityRole.Seller, AccountRole.Assistant);
      });

      it("Quantity is zero", async function () {
        await expect(offerFacet.mintAndWrapNFTs(bosonOfferId, 0n))
          .to.be.revertedWithCustomError(fermionErrors, "InvalidQuantity")
          .withArgs(0);
      });
    });
  });

  context("unwrapping", function () {
    const bosonOfferId = 1n;
    const quantity = 15n;
    const verifierFee = parseEther("0.01");
    const bosonSellerId = "1"; // Fermion's seller id inside Boson
    const bosonBuyerId = "2"; // Fermion's buyer id inside Boson
    const exchangeId = 1n;
    const tokenId = deriveTokenId(bosonOfferId, exchangeId).toString();
    const fullPrice = parseEther("10");
    const openSeaFee = (fullPrice * 2n) / 100n;
    const priceSubOSFee = fullPrice - openSeaFee;
    let openSeaAddress: string, buyerAddress: string;
    let bosonProtocolBalance: bigint, openSeaBalance: bigint;
    let buyerAdvancedOrder: AdvancedOrder;
    let seaport: Seaport;

    let exchangeToken: string;
    let wrapperAddress: string;
    let fermionWrapper: Contract;
    let bosonVoucher: Contract, bosonExchangeHandler: Contract;
    let defaultCollectionAddress: string;
    before(async function () {
      const bosonAccountHandler = await getBosonHandler("IBosonAccountHandler");
      [defaultCollectionAddress] = await bosonAccountHandler.getSellersCollections(bosonSellerId);
      bosonVoucher = await getBosonVoucher(defaultCollectionAddress);

      bosonExchangeHandler = await getBosonHandler("IBosonExchangeHandler");

      exchangeToken = await mockToken.getAddress();

      wrapperAddress = await offerFacet.predictFermionFNFTAddress(bosonOfferId);
      fermionWrapper = await ethers.getContractAt("FermionFNFT", wrapperAddress);
    });

    context("Non-zero seller deposit", function () {
      const sellerDeposit = parseEther("1");

      beforeEach(async function () {
        const fermionOffer = {
          sellerId: "1",
          sellerDeposit,
          verifierId,
          verifierFee,
          custodianId: "3",
          custodianFee,
          facilitatorId,
          facilitatorFeePercent: "0",
          exchangeToken,
          metadataURI: "https://example.com/offer-metadata.json",
          metadataHash: ZeroHash,
        };

        await offerFacet.createOffer(fermionOffer);
        await offerFacet.mintAndWrapNFTs(bosonOfferId, quantity);

        const buyer = wallets[4];
        const openSea = wallets[5]; // a mock OS address
        openSeaAddress = openSea.address;
        buyerAddress = buyer.address;
        seaport = new Seaport(buyer, { overrides: { seaportVersion: "1.6", contractAddress: seaportAddress } });

        await mockToken.mint(buyerAddress, fullPrice);

        const { executeAllActions } = await seaport.createOrder(
          {
            offer: [
              {
                itemType: ItemType.ERC20,
                token: exchangeToken,
                amount: fullPrice.toString(),
              },
            ],
            consideration: [
              {
                itemType: ItemType.ERC721,
                token: wrapperAddress,
                identifier: tokenId,
              },
              {
                itemType: ItemType.ERC20,
                token: exchangeToken,
                amount: openSeaFee.toString(),
                recipient: openSeaAddress,
              },
            ],
          },
          buyerAddress,
        );

        const buyerOrder = await executeAllActions();

        buyerAdvancedOrder = {
          ...buyerOrder,
          numerator: 1n,
          denominator: 1n,
          extraData: "0x",
        };

        bosonProtocolBalance = await mockToken.balanceOf(bosonProtocolAddress);
        openSeaBalance = await mockToken.balanceOf(openSeaAddress);
      });

      context("unwrap (with OS auction)", function () {
        beforeEach(async function () {
          // approve token transfer so unwrapping can succeed
          await mockToken.approve(fermionProtocolAddress, sellerDeposit);
        });

        it("Unwrapping", async function () {
          const tx = await offerFacet.unwrapNFT(tokenId, buyerAdvancedOrder);

          // events:
          // fermion
          const blockTimestamp = BigInt((await tx.getBlock()).timestamp);
          const itemVerificationTimeout = blockTimestamp + fermionConfig.protocolParameters.defaultVerificationTimeout;
          const itemMaxVerificationTimeout = blockTimestamp + fermionConfig.protocolParameters.maxVerificationTimeout;
          await expect(tx)
            .to.emit(offerFacet, "VerificationInitiated")
            .withArgs(bosonOfferId, verifierId, tokenId, itemVerificationTimeout, itemMaxVerificationTimeout);
          await expect(tx).to.emit(offerFacet, "ItemPriceObserved").withArgs(tokenId, priceSubOSFee);

          // Boson:
          await expect(tx)
            .to.emit(bosonExchangeHandler, "BuyerCommitted")
            .withArgs(bosonOfferId, bosonBuyerId, exchangeId, anyValue, anyValue, defaultCollectionAddress); // exchange and voucher details are not relevant

          await expect(tx)
            .to.emit(bosonExchangeHandler, "FundsEncumbered")
            .withArgs(bosonSellerId, exchangeToken, sellerDeposit, defaultCollectionAddress);

          await expect(tx)
            .to.emit(bosonExchangeHandler, "FundsEncumbered")
            .withArgs(bosonBuyerId, exchangeToken, fullPrice - openSeaFee, fermionProtocolAddress);

          await expect(tx)
            .to.emit(bosonExchangeHandler, "VoucherRedeemed")
            .withArgs(bosonOfferId, exchangeId, fermionProtocolAddress);

          // BosonVoucher
          // - transferred to the protocol
          await expect(tx).to.emit(bosonVoucher, "Transfer").withArgs(wrapperAddress, fermionProtocolAddress, tokenId);

          // - burned
          await expect(tx).to.emit(bosonVoucher, "Transfer").withArgs(fermionProtocolAddress, ZeroAddress, tokenId);

          // FermionFNFT
          // - Transfer to buyer (2step seller->wrapper->buyer)
          await expect(tx).to.emit(fermionWrapper, "Transfer").withArgs(defaultSigner.address, wrapperAddress, tokenId);
          await expect(tx).to.emit(fermionWrapper, "Transfer").withArgs(wrapperAddress, buyerAddress, tokenId);

          // State:
          // Boson
          const [exists, exchange, voucher] = await bosonExchangeHandler.getExchange(exchangeId);
          expect(exists).to.be.equal(true);
          expect(exchange.state).to.equal(3); // Redeemed
          expect(voucher.committedDate).to.not.equal(0);
          expect(voucher.redeemedDate).to.equal(voucher.committedDate); // commit and redeem should happen at the same time

          const newBosonProtocolBalance = await mockToken.balanceOf(bosonProtocolAddress);
          expect(newBosonProtocolBalance).to.equal(bosonProtocolBalance + sellerDeposit + fullPrice - openSeaFee);

          // FermionFNFT:
          expect(await fermionWrapper.tokenState(tokenId)).to.equal(TokenState.Unverified);
          expect(await fermionWrapper.ownerOf(tokenId)).to.equal(buyerAddress);

          // OpenSea balance should be updated
          const newOpenSeaBalance = await mockToken.balanceOf(openSeaAddress);
          expect(newOpenSeaBalance).to.equal(openSeaBalance + openSeaFee);
        });

        it("Facilitator can unwrap", async function () {
          await fundsFacet.depositFunds(sellerId, await mockToken.getAddress(), sellerDeposit);

          const tx = await offerFacet.connect(facilitator).unwrapNFT(tokenId, buyerAdvancedOrder);

          // events:
          // fermion
          const blockTimestamp = BigInt((await tx.getBlock()).timestamp);
          const itemVerificationTimeout = blockTimestamp + fermionConfig.protocolParameters.defaultVerificationTimeout;
          const itemMaxVerificationTimeout = blockTimestamp + fermionConfig.protocolParameters.maxVerificationTimeout;
          await expect(tx)
            .to.emit(offerFacet, "VerificationInitiated")
            .withArgs(bosonOfferId, verifierId, tokenId, itemVerificationTimeout, itemMaxVerificationTimeout);
          await expect(tx).to.emit(offerFacet, "ItemPriceObserved").withArgs(tokenId, priceSubOSFee);
        });

        context("Boson seller deposit covered from the available funds", function () {
          it("Fully covered", async function () {
            await fundsFacet.depositFunds(sellerId, exchangeToken, sellerDeposit);

            const sellerAvailableFunds = await fundsFacet.getAvailableFunds(sellerId, exchangeToken);

            const tx = await offerFacet.unwrapNFT(tokenId, buyerAdvancedOrder);

            // events:
            // fermion
            const blockTimestamp = BigInt((await tx.getBlock()).timestamp);
            const itemVerificationTimeout =
              blockTimestamp + fermionConfig.protocolParameters.defaultVerificationTimeout;
            const itemMaxVerificationTimeout = blockTimestamp + fermionConfig.protocolParameters.maxVerificationTimeout;
            await expect(tx)
              .to.emit(offerFacet, "VerificationInitiated")
              .withArgs(bosonOfferId, verifierId, tokenId, itemVerificationTimeout, itemMaxVerificationTimeout);
            await expect(tx).to.emit(offerFacet, "ItemPriceObserved").withArgs(tokenId, priceSubOSFee);

            // Boson:
            await expect(tx)
              .to.emit(bosonExchangeHandler, "FundsEncumbered")
              .withArgs(bosonSellerId, exchangeToken, sellerDeposit, defaultCollectionAddress);

            // State:
            // Fermion
            expect(await fundsFacet.getAvailableFunds(sellerId, exchangeToken)).to.equal(
              sellerAvailableFunds - sellerDeposit,
            );

            // Boson
            const newBosonProtocolBalance = await mockToken.balanceOf(bosonProtocolAddress);
            expect(newBosonProtocolBalance).to.equal(bosonProtocolBalance + sellerDeposit + fullPrice - openSeaFee);
          });

          it("Partially covered", async function () {
            const remainder = sellerDeposit / 10n;
            await fundsFacet.depositFunds(sellerId, exchangeToken, sellerDeposit - remainder);

            await mockToken.approve(fermionProtocolAddress, remainder);
            const tx = await offerFacet.unwrapNFT(tokenId, buyerAdvancedOrder);

            // events:
            // fermion
            const blockTimestamp = BigInt((await tx.getBlock()).timestamp);
            const itemVerificationTimeout =
              blockTimestamp + fermionConfig.protocolParameters.defaultVerificationTimeout;
            const itemMaxVerificationTimeout = blockTimestamp + fermionConfig.protocolParameters.maxVerificationTimeout;
            await expect(tx)
              .to.emit(offerFacet, "VerificationInitiated")
              .withArgs(bosonOfferId, verifierId, tokenId, itemVerificationTimeout, itemMaxVerificationTimeout);
            await expect(tx).to.emit(offerFacet, "ItemPriceObserved").withArgs(tokenId, priceSubOSFee);

            // Boson:
            await expect(tx)
              .to.emit(bosonExchangeHandler, "FundsEncumbered")
              .withArgs(bosonSellerId, exchangeToken, sellerDeposit, defaultCollectionAddress);

            // State:
            // Fermion
            expect(await fundsFacet.getAvailableFunds(sellerId, exchangeToken)).to.equal(0);

            // Boson
            const newBosonProtocolBalance = await mockToken.balanceOf(bosonProtocolAddress);
            expect(newBosonProtocolBalance).to.equal(bosonProtocolBalance + sellerDeposit + fullPrice - openSeaFee);
          });
        });

        context("Zero verifier fee", function () {
          const bosonOfferId = "2";
          const exchangeId = quantity + 1n;
          const tokenId = deriveTokenId(bosonOfferId, exchangeId).toString();
          let wrapperAddress: string;
          let fermionWrapper: Contract;

          beforeEach(async function () {
            const fermionOffer = {
              sellerId: "1",
              sellerDeposit: "0",
              verifierId,
              verifierFee: "0",
              custodianId: "3",
              custodianFee,
              facilitatorId: sellerId,
              facilitatorFeePercent: "0",
              exchangeToken: await mockToken.getAddress(),
              metadataURI: "https://example.com/offer-metadata.json",
              metadataHash: ZeroHash,
            };

            // erc20 offer
            await offerFacet.createOffer(fermionOffer);

            // mint and wrap
            await offerFacet.mintAndWrapNFTs(bosonOfferId, "1");

            wrapperAddress = await offerFacet.predictFermionFNFTAddress(bosonOfferId);
            fermionWrapper = await ethers.getContractAt("FermionFNFT", wrapperAddress);
          });

          it("Non-zero item price", async function () {
            const { executeAllActions } = await seaport.createOrder(
              {
                offer: [
                  {
                    itemType: ItemType.ERC20,
                    token: exchangeToken,
                    amount: fullPrice,
                  },
                ],
                consideration: [
                  {
                    itemType: ItemType.ERC721,
                    token: wrapperAddress,
                    identifier: tokenId,
                  },
                  {
                    itemType: ItemType.ERC20,
                    token: exchangeToken,
                    amount: openSeaFee,
                    recipient: openSeaAddress,
                  },
                ],
              },
              buyerAddress,
            );

            const buyerOrder = await executeAllActions();

            const buyerAdvancedOrder = {
              ...buyerOrder,
              numerator: 1n,
              denominator: 1n,
              extraData: "0x",
            };

            const bosonProtocolBalance = await mockToken.balanceOf(bosonProtocolAddress);
            const openSeaBalance = await mockToken.balanceOf(openSeaAddress);

            const tx = await offerFacet.unwrapNFT(tokenId, buyerAdvancedOrder);

            // events:
            // fermion
            const blockTimestamp = BigInt((await tx.getBlock()).timestamp);
            const itemVerificationTimeout =
              blockTimestamp + fermionConfig.protocolParameters.defaultVerificationTimeout;
            const itemMaxVerificationTimeout = blockTimestamp + fermionConfig.protocolParameters.maxVerificationTimeout;
            await expect(tx)
              .to.emit(offerFacet, "VerificationInitiated")
              .withArgs(bosonOfferId, verifierId, tokenId, itemVerificationTimeout, itemMaxVerificationTimeout);
            await expect(tx).to.emit(offerFacet, "ItemPriceObserved").withArgs(tokenId, priceSubOSFee);

            // Boson:
            await expect(tx)
              .to.emit(bosonExchangeHandler, "BuyerCommitted")
              .withArgs(bosonOfferId, bosonBuyerId, exchangeId, anyValue, anyValue, defaultCollectionAddress); // exchange and voucher details are not relevant

            await expect(tx)
              .to.emit(bosonExchangeHandler, "FundsEncumbered")
              .withArgs(bosonSellerId, exchangeToken, "0", defaultCollectionAddress);

            await expect(tx)
              .to.emit(bosonExchangeHandler, "FundsEncumbered")
              .withArgs(bosonBuyerId, exchangeToken, fullPrice - openSeaFee, fermionProtocolAddress);

            await expect(tx)
              .to.emit(bosonExchangeHandler, "VoucherRedeemed")
              .withArgs(bosonOfferId, exchangeId, fermionProtocolAddress);

            // BosonVoucher
            // - transferred to the protocol
            await expect(tx)
              .to.emit(bosonVoucher, "Transfer")
              .withArgs(wrapperAddress, fermionProtocolAddress, tokenId);

            // - burned
            await expect(tx).to.emit(bosonVoucher, "Transfer").withArgs(fermionProtocolAddress, ZeroAddress, tokenId);

            // FermionFNFT
            // - Transfer to buyer (2step seller->wrapper->buyer)
            await expect(tx)
              .to.emit(fermionWrapper, "Transfer")
              .withArgs(defaultSigner.address, wrapperAddress, tokenId);
            await expect(tx).to.emit(fermionWrapper, "Transfer").withArgs(wrapperAddress, buyerAddress, tokenId);

            // State:
            // Boson
            const [exists, exchange, voucher] = await bosonExchangeHandler.getExchange(exchangeId);
            expect(exists).to.be.equal(true);
            expect(exchange.state).to.equal(3); // Redeemed
            expect(voucher.committedDate).to.not.equal(0);
            expect(voucher.redeemedDate).to.equal(voucher.committedDate); // commit and redeem should happen at the same time

            const newBosonProtocolBalance = await mockToken.balanceOf(bosonProtocolAddress);
            expect(newBosonProtocolBalance).to.equal(bosonProtocolBalance + fullPrice - openSeaFee);

            // FermionFNFT:
            expect(await fermionWrapper.tokenState(tokenId)).to.equal(TokenState.Unverified);
            expect(await fermionWrapper.ownerOf(tokenId)).to.equal(buyerAddress);

            // OpenSea balance should be updated
            const newOpenSeaBalance = await mockToken.balanceOf(openSeaAddress);
            expect(newOpenSeaBalance).to.equal(openSeaBalance + openSeaFee);
          });

          it("Zero verifier fee allows zero prices", async function () {
            const fullPrice = "0";
            const openSeaFee = "0";

            const { executeAllActions } = await seaport.createOrder(
              {
                offer: [
                  {
                    itemType: ItemType.ERC20,
                    token: exchangeToken,
                    amount: fullPrice,
                  },
                ],
                consideration: [
                  {
                    itemType: ItemType.ERC721,
                    token: wrapperAddress,
                    identifier: tokenId,
                  },
                  {
                    itemType: ItemType.ERC20,
                    token: exchangeToken,
                    amount: openSeaFee,
                    recipient: openSeaAddress,
                  },
                ],
              },
              buyerAddress,
            );

            const buyerOrder = await executeAllActions();

            const buyerAdvancedOrder = {
              ...buyerOrder,
              numerator: 1n,
              denominator: 1n,
              extraData: "0x",
            };

            const bosonProtocolBalance = await mockToken.balanceOf(bosonProtocolAddress);
            const openSeaBalance = await mockToken.balanceOf(openSeaAddress);

            const tx = await offerFacet.unwrapNFT(tokenId, buyerAdvancedOrder);

            // events:
            // fermion
            const blockTimestamp = BigInt((await tx.getBlock()).timestamp);
            const itemVerificationTimeout =
              blockTimestamp + fermionConfig.protocolParameters.defaultVerificationTimeout;
            const itemMaxVerificationTimeout = blockTimestamp + fermionConfig.protocolParameters.maxVerificationTimeout;
            await expect(tx)
              .to.emit(offerFacet, "VerificationInitiated")
              .withArgs(bosonOfferId, verifierId, tokenId, itemVerificationTimeout, itemMaxVerificationTimeout);
            await expect(tx).to.emit(offerFacet, "ItemPriceObserved").withArgs(tokenId, 0n);

            // Boson:
            await expect(tx)
              .to.emit(bosonExchangeHandler, "BuyerCommitted")
              .withArgs(bosonOfferId, bosonBuyerId, exchangeId, anyValue, anyValue, defaultCollectionAddress); // exchange and voucher details are not relevant

            await expect(tx)
              .to.emit(bosonExchangeHandler, "FundsEncumbered")
              .withArgs(bosonSellerId, exchangeToken, "0", defaultCollectionAddress);

            await expect(tx)
              .to.emit(bosonExchangeHandler, "VoucherRedeemed")
              .withArgs(bosonOfferId, exchangeId, fermionProtocolAddress);

            // BosonVoucher
            // - transferred to the protocol
            await expect(tx)
              .to.emit(bosonVoucher, "Transfer")
              .withArgs(wrapperAddress, fermionProtocolAddress, tokenId);

            // - burned
            await expect(tx).to.emit(bosonVoucher, "Transfer").withArgs(fermionProtocolAddress, ZeroAddress, tokenId);

            // FermionFNFT
            // - Transfer to buyer (1step seller->buyer)
            await expect(tx).to.emit(fermionWrapper, "Transfer").withArgs(defaultSigner.address, buyerAddress, tokenId);

            // State:
            // Boson
            const [exists, exchange, voucher] = await bosonExchangeHandler.getExchange(exchangeId);
            expect(exists).to.be.equal(true);
            expect(exchange.state).to.equal(3); // Redeemed
            expect(voucher.committedDate).to.not.equal(0);
            expect(voucher.redeemedDate).to.equal(voucher.committedDate); // commit and redeem should happen at the same time

            const newBosonProtocolBalance = await mockToken.balanceOf(bosonProtocolAddress);
            expect(newBosonProtocolBalance).to.equal(bosonProtocolBalance); // no change expected

            // FermionFNFT:
            expect(await fermionWrapper.tokenState(tokenId)).to.equal(TokenState.Unverified);
            expect(await fermionWrapper.ownerOf(tokenId)).to.equal(buyerAddress);

            // OpenSea balance should remain the same
            const newOpenSeaBalance = await mockToken.balanceOf(openSeaAddress);
            expect(newOpenSeaBalance).to.equal(openSeaBalance);
          });
        });

        it("Set custom verification timeout", async function () {
          const blockTimestamp = BigInt((await ethers.provider.getBlock("latest")).timestamp);
          const customItemVerificationTimeout = blockTimestamp + 24n * 60n * 60n * 15n; // 15 days
          const tx = await offerFacet.unwrapNFTAndSetVerificationTimeout(
            tokenId,
            buyerAdvancedOrder,
            customItemVerificationTimeout,
          );

          // events:
          const itemMaxVerificationTimeout =
            BigInt((await tx.getBlock()).timestamp) + fermionConfig.protocolParameters.maxVerificationTimeout;

          // fermion
          await expect(tx)
            .to.emit(offerFacet, "VerificationInitiated")
            .withArgs(bosonOfferId, verifierId, tokenId, customItemVerificationTimeout, itemMaxVerificationTimeout);
          await expect(tx).to.emit(offerFacet, "ItemPriceObserved").withArgs(tokenId, priceSubOSFee);

          // State:
          expect(await verificationFacet.getItemVerificationTimeout(tokenId)).to.equal(customItemVerificationTimeout);
        });

        context("Revert reasons", function () {
          it("Offer region is paused", async function () {
            await pauseFacet.pause([PausableRegion.Offer]);

            await expect(offerFacet.unwrapNFT(tokenId, buyerAdvancedOrder))
              .to.be.revertedWithCustomError(fermionErrors, "RegionPaused")
              .withArgs(PausableRegion.Offer);
          });

          it("Caller is not the seller's assistant", async function () {
            await verifySellerAssistantRole("unwrapNFT", [tokenId, buyerAdvancedOrder]);
          });

          it("Caller is not the facilitator defined in the offer", async function () {
            await expect(offerFacet.connect(facilitator2).unwrapNFT(tokenId, buyerAdvancedOrder))
              .to.be.revertedWithCustomError(fermionErrors, "AccountHasNoRole")
              .withArgs(sellerId, facilitator2.address, EntityRole.Seller, AccountRole.Assistant);
          });

          context("Boson deposit not covered", async function () {
            it("Zero available funds", async function () {
              // ERC20 offer - insufficient allowance
              await mockToken.approve(fermionProtocolAddress, sellerDeposit - 1n);

              await expect(offerFacet.unwrapNFT(tokenId, buyerAdvancedOrder))
                .to.be.revertedWithCustomError(mockToken, "ERC20InsufficientAllowance")
                .withArgs(fermionProtocolAddress, sellerDeposit - 1n, sellerDeposit);

              // ERC20 offer - contract sends insufficient funds
              await mockToken.approve(fermionProtocolAddress, sellerDeposit);
              await mockToken.setBurnAmount(1);
              await expect(offerFacet.unwrapNFT(tokenId, buyerAdvancedOrder))
                .to.be.revertedWithCustomError(fermionErrors, "WrongValueReceived")
                .withArgs(sellerDeposit, sellerDeposit - 1n);
              await mockToken.setBurnAmount(0);

              // ERC20 offer - insufficient balance
              const sellerBalance = await mockToken.balanceOf(defaultSigner.address);
              await mockToken.transfer(wallets[4].address, sellerBalance); // transfer all the tokens to another wallet

              await expect(offerFacet.unwrapNFT(tokenId, buyerAdvancedOrder))
                .to.be.revertedWithCustomError(mockToken, "ERC20InsufficientBalance")
                .withArgs(defaultSigner.address, 0n, sellerDeposit);

              // Send native currency to ERC20 offer
              await expect(
                offerFacet.unwrapNFT(tokenId, buyerAdvancedOrder, { value: sellerDeposit }),
              ).to.be.revertedWithCustomError(fermionErrors, "NativeNotAllowed");
            });

            it("Partially covered by available funds", async function () {
              const remainder = sellerDeposit / 10n;
              await fundsFacet.depositFunds(sellerId, await mockToken.getAddress(), sellerDeposit - remainder);

              // ERC20 offer - insufficient allowance
              await mockToken.approve(fermionProtocolAddress, remainder - 1n);

              await expect(offerFacet.unwrapNFT(tokenId, buyerAdvancedOrder))
                .to.be.revertedWithCustomError(mockToken, "ERC20InsufficientAllowance")
                .withArgs(fermionProtocolAddress, remainder - 1n, remainder);

              // ERC20 offer - contract sends insufficient funds
              await mockToken.approve(fermionProtocolAddress, remainder);
              await mockToken.setBurnAmount(1);
              await expect(offerFacet.unwrapNFT(tokenId, buyerAdvancedOrder))
                .to.be.revertedWithCustomError(fermionErrors, "WrongValueReceived")
                .withArgs(remainder, remainder - 1n);
              await mockToken.setBurnAmount(0);

              // ERC20 offer - insufficient balance
              const sellerBalance = await mockToken.balanceOf(defaultSigner.address);
              await mockToken.transfer(wallets[4].address, sellerBalance); // transfer all the tokens to another wallet

              await expect(offerFacet.unwrapNFT(tokenId, buyerAdvancedOrder))
                .to.be.revertedWithCustomError(mockToken, "ERC20InsufficientBalance")
                .withArgs(defaultSigner.address, 0n, remainder);

              // Send native currency to ERC20 offer
              await expect(
                offerFacet.unwrapNFT(tokenId, buyerAdvancedOrder, { value: remainder }),
              ).to.be.revertedWithCustomError(fermionErrors, "NativeNotAllowed");
            });

            context("offer with native currency", function () {
              // Although support for offers in native currency is not complete, this is a test for the future
              // Note that "buyerAdvancedOrder" is in fact wrong, since it cannot be created for native currency
              // However, for the testing purposes, it's good enough, since the transaction reverts before it's used
              const bosonOfferId = "2";
              const exchangeId = quantity + 1n;
              const tokenId = deriveTokenId(bosonOfferId, exchangeId).toString();

              beforeEach(async function () {
                const fermionOffer = {
                  sellerId: "1",
                  sellerDeposit,
                  verifierId,
                  verifierFee,
                  custodianId: "3",
                  custodianFee,
                  facilitatorId: sellerId,
                  facilitatorFeePercent: "0",
                  exchangeToken: ZeroAddress,
                  metadataURI: "https://example.com/offer-metadata.json",
                  metadataHash: ZeroHash,
                };

                await offerFacet.createOffer(fermionOffer);
                await offerFacet.mintAndWrapNFTs(bosonOfferId, quantity);
              });

              it("Zero available funds", async function () {
                // Native currency offer - insufficient funds
                await expect(
                  offerFacet.unwrapNFT(tokenId, buyerAdvancedOrder, { value: sellerDeposit - 1n }),
                ).to.be.revertedWithCustomError(fermionErrors, "NativeNotAllowed");

                // Native currency offer - too much sent
                await expect(
                  offerFacet.unwrapNFT(tokenId, buyerAdvancedOrder, { value: sellerDeposit + 1n }),
                ).to.be.revertedWithCustomError(fermionErrors, "NativeNotAllowed");
              });

              it("Partially covered by available funds", async function () {
                const remainder = sellerDeposit / 10n;
                await fundsFacet.depositFunds(sellerId, ZeroAddress, sellerDeposit - remainder, {
                  value: sellerDeposit - remainder,
                });

                // Native currency offer - insufficient funds
                await expect(
                  offerFacet.unwrapNFT(tokenId, buyerAdvancedOrder, { value: remainder - 1n }),
                ).to.be.revertedWithCustomError(fermionErrors, "NativeNotAllowed");

                // Native currency offer - too much sent
                await expect(
                  offerFacet.unwrapNFT(tokenId, buyerAdvancedOrder, { value: remainder + 1n }),
                ).to.be.revertedWithCustomError(fermionErrors, "NativeNotAllowed");
              });
            });
          });

          it("Price does not cover the verifier fee", async function () {
            const minimalPriceOld = (10000n * verifierFee) / (10000n - BigInt(bosonProtocolFeePercentage));
            const minimalPriceNew = calculateMinimalPrice(
              verifierFee,
              0,
              bosonProtocolFeePercentage,
              fermionConfig.protocolParameters.protocolFeePercentage,
            );
            console.log(`Old Price: ${minimalPriceOld}`);
            console.log(`New Price: ${minimalPriceNew}`);
            buyerAdvancedOrder.parameters.offer[0].startAmount = minimalPriceNew.toString();
            buyerAdvancedOrder.parameters.consideration[1].startAmount = "1"; // openSea fee. In total, the protocol gets minimalPrice-1
            await expect(offerFacet.unwrapNFT(tokenId, buyerAdvancedOrder))
              .to.be.revertedWithCustomError(fermionErrors, "PriceTooLow")
              .withArgs(minimalPriceNew - 1n, minimalPriceNew);
          });

          it("Price does not cover the verifier fee [BOSON]", async function () {
            const bosonOfferId = "2";
            const bosonExchangeId = quantity + 1n;
            const tokenId = deriveTokenId(bosonOfferId, bosonExchangeId).toString();

            await offerFacet.addSupportedToken(bosonTokenAddress);
            const bosonConfigHandler = await getBosonHandler("IBosonConfigHandler");
            const bosonProtocolFlatFee = parseEther("0"); // ToDo: after boson v2.4.2, this could be higher than 0
            await bosonConfigHandler.setProtocolFeeFlatBoson(bosonProtocolFlatFee);

            const fermionOffer = {
              sellerId: "1",
              sellerDeposit: "0",
              verifierId,
              verifierFee,
              custodianId: "3",
              custodianFee,
              facilitatorId: sellerId,
              facilitatorFeePercent: "0",
              exchangeToken: bosonTokenAddress,
              metadataURI: "https://example.com/offer-metadata.json",
              metadataHash: ZeroHash,
            };

            await offerFacet.createOffer(fermionOffer);
            await offerFacet.mintAndWrapNFTs(bosonOfferId, "1");

            const minimalPrice = calculateMinimalPrice(
              verifierFee,
              fermionOffer.facilitatorFeePercent,
              bosonProtocolFlatFee,
              fermionConfig.protocolParameters.protocolFeePercentage,
            );
            buyerAdvancedOrder.parameters.offer[0].startAmount = minimalPrice.toString();
            buyerAdvancedOrder.parameters.consideration[1].startAmount = "1"; // openSea fee. In total, the protocol gets minimalPrice-1
            await expect(offerFacet.unwrapNFT(tokenId, buyerAdvancedOrder))
              .to.be.revertedWithCustomError(fermionErrors, "PriceTooLow")
              .withArgs(minimalPrice - 1n, minimalPrice);
          });

          it("Buyer order does not have 1 offer", async function () {
            // two offers
            buyerAdvancedOrder.parameters.offer.push(buyerAdvancedOrder.parameters.offer[0]);
            await expect(offerFacet.unwrapNFT(tokenId, buyerAdvancedOrder)).to.be.revertedWithCustomError(
              fermionErrors,
              "InvalidOpenSeaOrder",
            );

            // 0 offers
            buyerAdvancedOrder.parameters.offer = [];
            await expect(offerFacet.unwrapNFT(tokenId, buyerAdvancedOrder)).to.be.revertedWithCustomError(
              fermionErrors,
              "InvalidOpenSeaOrder",
            );
          });

          it("Buyer order have more than 2 considerations", async function () {
            buyerAdvancedOrder.parameters.consideration.push(buyerAdvancedOrder.parameters.consideration[1]);
            await expect(offerFacet.unwrapNFT(tokenId, buyerAdvancedOrder)).to.be.revertedWithCustomError(
              fermionErrors,
              "InvalidOpenSeaOrder",
            );
          });

          it("OS fee is greater than the price", async function () {
            buyerAdvancedOrder.parameters.offer[0].startAmount = "0";
            buyerAdvancedOrder.parameters.consideration[1].startAmount = "1";
            await expect(offerFacet.unwrapNFT(tokenId, buyerAdvancedOrder)).to.be.revertedWithCustomError(
              fermionErrors,
              "InvalidOpenSeaOrder",
            );
          });

          it("OS fee is more than expected", async function () {
            buyerAdvancedOrder.parameters.consideration[1].startAmount += 1n;
            await expect(offerFacet.unwrapNFT(tokenId, buyerAdvancedOrder)).to.be.revertedWithCustomError(
              fermionErrors,
              "InvalidOpenSeaOrder",
            );
          });

          it("Custom verification timeout too long", async function () {
            const nextBlockTimestamp = BigInt((await ethers.provider.getBlock("latest")).timestamp) + 10n;
            const customItemVerificationTimeout =
              nextBlockTimestamp + fermionConfig.protocolParameters.maxVerificationTimeout + 10n;

            await setNextBlockTimestamp(String(nextBlockTimestamp));

            await expect(
              offerFacet.unwrapNFTAndSetVerificationTimeout(tokenId, buyerAdvancedOrder, customItemVerificationTimeout),
            )
              .to.be.revertedWithCustomError(fermionErrors, "VerificationTimeoutTooLong")
              .withArgs(
                customItemVerificationTimeout,
                nextBlockTimestamp + fermionConfig.protocolParameters.maxVerificationTimeout,
              );
          });

          it("Unwrapping directly through the Boson contract", async function () {
            const attackerWallet = wallets[6];

            const openSea = wallets[5]; // a mock OS address
            openSeaAddress = openSea.address;
            const attackerAddress = attackerWallet.address;
            const seaport = new Seaport(attackerWallet, {
              overrides: { seaportVersion: "1.6", contractAddress: seaportAddress },
            });

            const { executeAllActions } = await seaport.createOrder(
              {
                offer: [
                  {
                    itemType: ItemType.ERC20,
                    token: exchangeToken,
                    amount: "0",
                  },
                ],
                consideration: [
                  {
                    itemType: ItemType.ERC721,
                    token: wrapperAddress,
                    identifier: tokenId,
                  },
                  {
                    itemType: ItemType.ERC20,
                    token: exchangeToken,
                    amount: "0",
                    recipient: openSeaAddress,
                  },
                ],
              },
              attackerAddress,
            );

            const buyerOrder = await executeAllActions();

            buyerAdvancedOrder = {
              ...buyerOrder,
              numerator: 1n,
              denominator: 1n,
              extraData: "0x",
            };

            const priceDiscoveryContractAddress = await fermionWrapper.getAddress(); // wrapper address
            const priceDiscoveryData = fermionWrapper.interface.encodeFunctionData("unwrap", [
              tokenId,
              buyerAdvancedOrder,
            ]);
            const price = "0";
            const priceDiscovery = new PriceDiscovery(
              price,
              Side.Wrapper,
              priceDiscoveryContractAddress,
              priceDiscoveryContractAddress,
              priceDiscoveryData,
            );

            const configHandler = await getBosonHandler("IBosonConfigHandler");
            const bosonPriceDiscoveryClientAddress = await configHandler.getPriceDiscoveryAddress();
            const priceDiscoveryHandler = await getBosonHandler("IBosonPriceDiscoveryHandler");

            await expect(
              priceDiscoveryHandler
                .connect(attackerWallet)
                .commitToPriceDiscoveryOffer(attackerWallet.address, tokenId, priceDiscovery),
            )
              .to.be.revertedWithCustomError(fermionWrapper, "InvalidStateOrCaller")
              .withArgs(tokenId, bosonPriceDiscoveryClientAddress, TokenState.Wrapped);
          });
        });

        context("Seaport tests", function () {
          // Not testing the protocol, just the interaction with Seaport
          it("Seaport should not allow invalid signature", async function () {
            await expect(
              offerFacet.unwrapNFT(tokenId, { ...buyerAdvancedOrder, signature: "0x" }),
            ).to.be.revertedWithCustomError(seaportContract, "InvalidSignature");

            const invalidSignature = buyerAdvancedOrder.signature.replace("1", "2");
            await expect(
              offerFacet.unwrapNFT(tokenId, { ...buyerAdvancedOrder, signature: invalidSignature }),
            ).to.be.revertedWithCustomError(seaportContract, "InvalidSigner");
          });

          it("Works with pre-validated orders", async function () {
            const buyer = wallets[4];
            await seaportContract.connect(buyer).validate([buyerAdvancedOrder]);
            await expect(offerFacet.unwrapNFT(tokenId, { ...buyerAdvancedOrder, signature: "0x" })).to.not.be.reverted;
          });
        });
      });

      context("unwrapToSelf", function () {
        const minimalPrice = calculateMinimalPrice(
          verifierFee,
          0, // facilitatorFee 0
          bosonProtocolFeePercentage,
          fermionConfig.protocolParameters.protocolFeePercentage,
        );

        console.log(`VerifierFee: ${verifierFee}`);
        console.log(`ProtocolFeePercentage: ${bosonProtocolFeePercentage}`);

        it("Unwrapping", async function () {
          await mockToken.approve(fermionProtocolAddress, sellerDeposit);
          await fundsFacet.depositFunds(sellerId, exchangeToken, sellerDeposit);

          await mockToken.approve(fermionProtocolAddress, minimalPrice);
          const tx = await offerFacet.unwrapNFTToSelf(tokenId, minimalPrice);

          // events:
          // fermion
          const blockTimestamp = BigInt((await tx.getBlock()).timestamp);
          const itemVerificationTimeout = blockTimestamp + fermionConfig.protocolParameters.defaultVerificationTimeout;
          const itemMaxVerificationTimeout = blockTimestamp + fermionConfig.protocolParameters.maxVerificationTimeout;
          await expect(tx)
            .to.emit(offerFacet, "VerificationInitiated")
            .withArgs(bosonOfferId, verifierId, tokenId, itemVerificationTimeout, itemMaxVerificationTimeout);
          await expect(tx).to.emit(offerFacet, "ItemPriceObserved").withArgs(tokenId, minimalPrice);

          // Boson:
          await expect(tx)
            .to.emit(bosonExchangeHandler, "BuyerCommitted")
            .withArgs(bosonOfferId, bosonBuyerId, exchangeId, anyValue, anyValue, defaultCollectionAddress); // exchange and voucher details are not relevant

          await expect(tx)
            .to.emit(bosonExchangeHandler, "FundsEncumbered")
            .withArgs(bosonSellerId, exchangeToken, sellerDeposit, defaultCollectionAddress);

          await expect(tx)
            .to.emit(bosonExchangeHandler, "FundsEncumbered")
            .withArgs(bosonBuyerId, exchangeToken, minimalPrice, fermionProtocolAddress);

          await expect(tx)
            .to.emit(bosonExchangeHandler, "VoucherRedeemed")
            .withArgs(bosonOfferId, exchangeId, fermionProtocolAddress);

          // BosonVoucher
          // - transferred to the protocol
          await expect(tx).to.emit(bosonVoucher, "Transfer").withArgs(wrapperAddress, fermionProtocolAddress, tokenId);

          // - burned
          await expect(tx).to.emit(bosonVoucher, "Transfer").withArgs(fermionProtocolAddress, ZeroAddress, tokenId);

          // FermionFNFT
          // - No transfer should happen, since the seller is the buyer
          await expect(tx).to.not.emit(fermionWrapper, "Transfer");

          // State:
          // Boson
          const [exists, exchange, voucher] = await bosonExchangeHandler.getExchange(exchangeId);
          expect(exists).to.be.equal(true);
          expect(exchange.state).to.equal(3); // Redeemed
          expect(voucher.committedDate).to.not.equal(0);
          expect(voucher.redeemedDate).to.equal(voucher.committedDate); // commit and redeem should happen at the same time

          const newBosonProtocolBalance = await mockToken.balanceOf(bosonProtocolAddress);
          expect(newBosonProtocolBalance).to.equal(bosonProtocolBalance + sellerDeposit + minimalPrice);

          // FermionFNFT:
          expect(await fermionWrapper.tokenState(tokenId)).to.equal(TokenState.Unverified);
          expect(await fermionWrapper.ownerOf(tokenId)).to.equal(defaultSigner.address);

          // OpenSea balance should remain the same
          const newOpenSeaBalance = await mockToken.balanceOf(openSeaAddress);
          expect(newOpenSeaBalance).to.equal(openSeaBalance);
        });

        it("Facilitator can unwrap", async function () {
          await mockToken.approve(fermionProtocolAddress, sellerDeposit);
          await fundsFacet.depositFunds(sellerId, exchangeToken, sellerDeposit);

          await mockToken.mint(facilitator.address, minimalPrice);
          await mockToken.connect(facilitator).approve(fermionProtocolAddress, minimalPrice);
          const tx = await offerFacet.connect(facilitator).unwrapNFTToSelf(tokenId, minimalPrice);

          // events:
          // fermion
          const blockTimestamp = BigInt((await tx.getBlock()).timestamp);
          const itemVerificationTimeout = blockTimestamp + fermionConfig.protocolParameters.defaultVerificationTimeout;
          const itemMaxVerificationTimeout = blockTimestamp + fermionConfig.protocolParameters.maxVerificationTimeout;
          await expect(tx)
            .to.emit(offerFacet, "VerificationInitiated")
            .withArgs(bosonOfferId, verifierId, tokenId, itemVerificationTimeout, itemMaxVerificationTimeout);
          await expect(tx).to.emit(offerFacet, "ItemPriceObserved").withArgs(tokenId, minimalPrice);
        });

        context("Boson seller deposit covered from the available funds", function () {
          it("Fully covered", async function () {
            await mockToken.approve(fermionProtocolAddress, sellerDeposit);
            await fundsFacet.depositFunds(sellerId, exchangeToken, sellerDeposit);

            const sellerAvailableFunds = await fundsFacet.getAvailableFunds(bosonSellerId, exchangeToken);

            await mockToken.approve(fermionProtocolAddress, minimalPrice);
            const tx = await offerFacet.unwrapNFTToSelf(tokenId, minimalPrice);

            // events:
            // fermion
            const blockTimestamp = BigInt((await tx.getBlock()).timestamp);
            const itemVerificationTimeout =
              blockTimestamp + fermionConfig.protocolParameters.defaultVerificationTimeout;
            const itemMaxVerificationTimeout = blockTimestamp + fermionConfig.protocolParameters.maxVerificationTimeout;
            await expect(tx)
              .to.emit(offerFacet, "VerificationInitiated")
              .withArgs(bosonOfferId, verifierId, tokenId, itemVerificationTimeout, itemMaxVerificationTimeout);
            await expect(tx).to.emit(offerFacet, "ItemPriceObserved").withArgs(tokenId, minimalPrice);

            // Boson:
            await expect(tx)
              .to.emit(bosonExchangeHandler, "FundsEncumbered")
              .withArgs(bosonSellerId, exchangeToken, sellerDeposit, defaultCollectionAddress);

            // State:
            // Fermion
            expect(await fundsFacet.getAvailableFunds(sellerId, exchangeToken)).to.equal(
              sellerAvailableFunds - sellerDeposit,
            );

            // Boson
            const newBosonProtocolBalance = await mockToken.balanceOf(bosonProtocolAddress);
            expect(newBosonProtocolBalance).to.equal(bosonProtocolBalance + sellerDeposit + minimalPrice);
          });

          it("Partially covered", async function () {
            const remainder = sellerDeposit / 10n;
            await mockToken.approve(fermionProtocolAddress, sellerDeposit - remainder);
            await fundsFacet.depositFunds(sellerId, exchangeToken, sellerDeposit - remainder);

            await mockToken.approve(fermionProtocolAddress, remainder + minimalPrice);
            const tx = await offerFacet.unwrapNFTToSelf(tokenId, minimalPrice);

            // events:
            // fermion
            const blockTimestamp = BigInt((await tx.getBlock()).timestamp);
            const itemVerificationTimeout =
              blockTimestamp + fermionConfig.protocolParameters.defaultVerificationTimeout;
            const itemMaxVerificationTimeout = blockTimestamp + fermionConfig.protocolParameters.maxVerificationTimeout;
            await expect(tx)
              .to.emit(offerFacet, "VerificationInitiated")
              .withArgs(bosonOfferId, verifierId, tokenId, itemVerificationTimeout, itemMaxVerificationTimeout);
            await expect(tx).to.emit(offerFacet, "ItemPriceObserved").withArgs(tokenId, minimalPrice);

            // Boson:
            await expect(tx)
              .to.emit(bosonExchangeHandler, "FundsEncumbered")
              .withArgs(bosonSellerId, exchangeToken, sellerDeposit, defaultCollectionAddress);

            // State:
            // Fermion
            expect(await fundsFacet.getAvailableFunds(sellerId, exchangeToken)).to.equal(0);

            // Boson
            const newBosonProtocolBalance = await mockToken.balanceOf(bosonProtocolAddress);
            expect(newBosonProtocolBalance).to.equal(bosonProtocolBalance + sellerDeposit + minimalPrice);
          });
        });

        context("offer with native currency", function () {
          // Although support for offers in native currency is not complete, this is a test for the future
          const bosonOfferId = "2";
          const exchangeId = quantity + 1n;
          const tokenId = deriveTokenId(bosonOfferId, exchangeId).toString();
          const verifierFee = 0n;

          beforeEach(async function () {
            const fermionOffer = {
              sellerId: "1",
              sellerDeposit,
              verifierId,
              verifierFee,
              custodianId: "3",
              custodianFee,
              facilitatorId: sellerId,
              facilitatorFeePercent: "0",
              exchangeToken: ZeroAddress,
              metadataURI: "https://example.com/offer-metadata.json",
              metadataHash: ZeroHash,
            };

            await offerFacet.createOffer(fermionOffer);
            await offerFacet.mintAndWrapNFTs(bosonOfferId, quantity);

            bosonProtocolBalance = await ethers.provider.getBalance(bosonProtocolAddress);
          });

          it("Fully covered by available funds", async function () {
            await fundsFacet.depositFunds(sellerId, ZeroAddress, sellerDeposit, {
              value: sellerDeposit,
            });

            const tx = await offerFacet.unwrapNFTToSelf(tokenId, 0, { value: 0n });

            // events:
            // fermion
            const blockTimestamp = BigInt((await tx.getBlock()).timestamp);
            const itemVerificationTimeout =
              blockTimestamp + fermionConfig.protocolParameters.defaultVerificationTimeout;
            const itemMaxVerificationTimeout = blockTimestamp + fermionConfig.protocolParameters.maxVerificationTimeout;
            await expect(tx)
              .to.emit(offerFacet, "VerificationInitiated")
              .withArgs(bosonOfferId, verifierId, tokenId, itemVerificationTimeout, itemMaxVerificationTimeout);
            await expect(tx).to.emit(offerFacet, "ItemPriceObserved").withArgs(tokenId, 0);

            // Boson:
            await expect(tx)
              .to.emit(bosonExchangeHandler, "FundsEncumbered")
              .withArgs(bosonSellerId, ZeroAddress, sellerDeposit, defaultCollectionAddress);

            // State:
            const newBosonProtocolBalance = await ethers.provider.getBalance(bosonProtocolAddress);
            expect(newBosonProtocolBalance).to.equal(bosonProtocolBalance + sellerDeposit);
            expect(await fundsFacet.getAvailableFunds(sellerId, ZeroAddress)).to.equal(0);
          });
        });

        it("Set custom verification timeout", async function () {
          const blockTimestamp = BigInt((await ethers.provider.getBlock("latest")).timestamp);
          const customItemVerificationTimeout = blockTimestamp + 24n * 60n * 60n * 15n; // 15 days
          await mockToken.approve(fermionProtocolAddress, sellerDeposit);
          await fundsFacet.depositFunds(sellerId, exchangeToken, sellerDeposit);

          await mockToken.approve(fermionProtocolAddress, minimalPrice);
          const tx = await offerFacet.unwrapNFTToSelfAndSetVerificationTimeout(
            tokenId,
            customItemVerificationTimeout,
            minimalPrice,
          );
          const itemMaxVerificationTimeout =
            BigInt((await tx.getBlock()).timestamp) + fermionConfig.protocolParameters.maxVerificationTimeout;

          // events:
          // fermion
          await expect(tx)
            .to.emit(offerFacet, "VerificationInitiated")
            .withArgs(bosonOfferId, verifierId, tokenId, customItemVerificationTimeout, itemMaxVerificationTimeout);
          await expect(tx).to.emit(offerFacet, "ItemPriceObserved").withArgs(tokenId, minimalPrice);

          // State:
          expect(await verificationFacet.getItemVerificationTimeout(tokenId)).to.equal(customItemVerificationTimeout);
        });

        context("Revert reasons", function () {
          it("Offer region is paused", async function () {
            await pauseFacet.pause([PausableRegion.Offer]);

            await expect(offerFacet.unwrapNFTToSelf(tokenId, minimalPrice))
              .to.be.revertedWithCustomError(fermionErrors, "RegionPaused")
              .withArgs(PausableRegion.Offer);
          });

          it("Caller is not the seller's assistant", async function () {
            await verifySellerAssistantRole("unwrapNFTToSelf", [tokenId, minimalPrice]);
          });

          it("Caller is not the facilitator defined in the offer", async function () {
            await expect(offerFacet.connect(facilitator2).unwrapNFTToSelf(tokenId, minimalPrice))
              .to.be.revertedWithCustomError(fermionErrors, "AccountHasNoRole")
              .withArgs(sellerId, facilitator2.address, EntityRole.Seller, AccountRole.Assistant);
          });

          context("Boson deposit not covered", async function () {
            it("Zero available funds", async function () {
              // ERC20 offer - insufficient allowance
              await mockToken.approve(fermionProtocolAddress, sellerDeposit - 1n);

              await expect(offerFacet.unwrapNFTToSelf(tokenId, minimalPrice))
                .to.be.revertedWithCustomError(mockToken, "ERC20InsufficientAllowance")
                .withArgs(fermionProtocolAddress, sellerDeposit - 1n, sellerDeposit);

              // ERC20 offer - contract sends insufficient funds
              await mockToken.approve(fermionProtocolAddress, sellerDeposit);
              await mockToken.setBurnAmount(1);
              await expect(offerFacet.unwrapNFTToSelf(tokenId, minimalPrice))
                .to.be.revertedWithCustomError(fermionErrors, "WrongValueReceived")
                .withArgs(sellerDeposit, sellerDeposit - 1n);
              await mockToken.setBurnAmount(0);

              // ERC20 offer - insufficient balance
              const sellerBalance = await mockToken.balanceOf(defaultSigner.address);
              await mockToken.transfer(wallets[4].address, sellerBalance); // transfer all the tokens to another wallet

              await expect(offerFacet.unwrapNFTToSelf(tokenId, minimalPrice))
                .to.be.revertedWithCustomError(mockToken, "ERC20InsufficientBalance")
                .withArgs(defaultSigner.address, 0n, sellerDeposit);

              // Send native currency to ERC20 offer
              await expect(
                offerFacet.unwrapNFTToSelf(tokenId, sellerDeposit, { value: sellerDeposit }),
              ).to.be.revertedWithCustomError(fermionErrors, "NativeNotAllowed");
            });

            it("Partially covered by available funds", async function () {
              const remainder = sellerDeposit / 10n;
              await mockToken.approve(fermionProtocolAddress, sellerDeposit - remainder);
              await fundsFacet.depositFunds(sellerId, await mockToken.getAddress(), sellerDeposit - remainder);

              // ERC20 offer - insufficient allowance
              await mockToken.approve(fermionProtocolAddress, remainder - 1n);

              await expect(offerFacet.unwrapNFTToSelf(tokenId, minimalPrice))
                .to.be.revertedWithCustomError(mockToken, "ERC20InsufficientAllowance")
                .withArgs(fermionProtocolAddress, remainder - 1n, remainder);

              // ERC20 offer - contract sends insufficient funds
              await mockToken.approve(fermionProtocolAddress, remainder);
              await mockToken.setBurnAmount(1);
              await expect(offerFacet.unwrapNFTToSelf(tokenId, minimalPrice))
                .to.be.revertedWithCustomError(fermionErrors, "WrongValueReceived")
                .withArgs(remainder, remainder - 1n);
              await mockToken.setBurnAmount(0);

              // ERC20 offer - insufficient balance
              const sellerBalance = await mockToken.balanceOf(defaultSigner.address);
              await mockToken.transfer(wallets[4].address, sellerBalance); // transfer all the tokens to another wallet

              await expect(offerFacet.unwrapNFTToSelf(tokenId, minimalPrice))
                .to.be.revertedWithCustomError(mockToken, "ERC20InsufficientBalance")
                .withArgs(defaultSigner.address, 0n, remainder);

              // Send native currency to ERC20 offer
              await expect(
                offerFacet.unwrapNFTToSelf(tokenId, minimalPrice, { value: remainder }),
              ).to.be.revertedWithCustomError(fermionErrors, "NativeNotAllowed");
            });

            context("offer with native currency", function () {
              // Although support for offers in native currency is not complete, this is a test for the future
              const bosonOfferId = "2";
              const exchangeId = quantity + 1n;
              const tokenId = deriveTokenId(bosonOfferId, exchangeId).toString();

              beforeEach(async function () {
                const fermionOffer = {
                  sellerId: "1",
                  sellerDeposit,
                  verifierId,
                  verifierFee,
                  custodianId: "3",
                  custodianFee,
                  facilitatorId: sellerId,
                  facilitatorFeePercent: "0",
                  exchangeToken: ZeroAddress,
                  metadataURI: "https://example.com/offer-metadata.json",
                  metadataHash: ZeroHash,
                };

                await offerFacet.createOffer(fermionOffer);
                await offerFacet.mintAndWrapNFTs(bosonOfferId, quantity);
              });

              it("Cannot deposit native - zero available funds", async function () {
                await expect(
                  offerFacet.unwrapNFTToSelf(tokenId, sellerDeposit, { value: sellerDeposit }),
                ).to.be.revertedWithCustomError(fermionErrors, "NativeNotAllowed");
              });

              it("Cannot deposit native -  partially covered by available funds", async function () {
                const remainder = sellerDeposit / 10n;
                await fundsFacet.depositFunds(sellerId, ZeroAddress, sellerDeposit - remainder, {
                  value: sellerDeposit - remainder,
                });

                await expect(
                  offerFacet.unwrapNFTToSelf(tokenId, remainder, { value: remainder }),
                ).to.be.revertedWithCustomError(fermionErrors, "NativeNotAllowed");
              });

              it.skip("Zero available funds", async function () {
                // If we allow back the native currency offers, this test should be enabled

                // Native currency offer - insufficient funds
                await expect(
                  offerFacet.unwrapNFTToSelf(tokenId, { value: sellerDeposit - 1n }),
                ).to.be.revertedWithCustomError(fermionErrors, "WrongValueReceived");

                // Native currency offer - too much sent
                await expect(
                  offerFacet.unwrapNFTToSelf(tokenId, { value: sellerDeposit + 1n }),
                ).to.be.revertedWithCustomError(fermionErrors, "WrongValueReceived");
              });

              it.skip("Partially covered by available funds", async function () {
                // If we allow back the native currency offers, this test should be enabled

                const remainder = sellerDeposit / 10n;
                await fundsFacet.depositFunds(sellerId, ZeroAddress, sellerDeposit - remainder, {
                  value: sellerDeposit - remainder,
                });

                // Native currency offer - insufficient funds
                await expect(
                  offerFacet.unwrapNFTToSelf(tokenId, remainder - 1n, { value: remainder - 1n }),
                ).to.be.revertedWithCustomError(fermionErrors, "WrongValueReceived");

                // Native currency offer - too much sent
                await expect(
                  offerFacet.unwrapNFTToSelf(tokenId, remainder + 1n, { value: remainder + 1n }),
                ).to.be.revertedWithCustomError(fermionErrors, "WrongValueReceived");
              });
            });
          });

          it("Price does not cover the verifier fee", async function () {
            await mockToken.approve(fermionProtocolAddress, sellerDeposit);
            await fundsFacet.depositFunds(sellerId, exchangeToken, sellerDeposit);

            // insufficient allowance
            await mockToken.approve(fermionProtocolAddress, minimalPrice - 1n);
            await expect(offerFacet.unwrapNFTToSelf(tokenId, minimalPrice))
              .to.be.revertedWithCustomError(mockToken, "ERC20InsufficientAllowance")
              .withArgs(fermionProtocolAddress, minimalPrice - 1n, minimalPrice);

            // Contract sends insufficient funds. In this case, the depositing to boson fails before fermion fails
            const bosonFundsHandler = await getBosonHandler("IBosonFundsHandler");
            await mockToken.approve(fermionProtocolAddress, minimalPrice);
            await mockToken.setBurnAmount(1);
            await expect(offerFacet.unwrapNFTToSelf(tokenId, minimalPrice)).to.be.revertedWithCustomError(
              bosonFundsHandler,
              "InsufficientValueReceived",
            );
            await mockToken.setBurnAmount(0);

            // Insufficient balance
            const sellerBalance = await mockToken.balanceOf(defaultSigner.address);
            await mockToken.transfer(wallets[4].address, sellerBalance); // transfer all the tokens to another wallet
            await expect(offerFacet.unwrapNFTToSelf(tokenId, minimalPrice))
              .to.be.revertedWithCustomError(mockToken, "ERC20InsufficientBalance")
              .withArgs(defaultSigner.address, 0n, minimalPrice);
          });

          it("Price does not cover the verifier fee [BOSON]", async function () {
            const bosonOfferId = "2";
            const bosonExchangeId = quantity + 1n;
            const tokenId = deriveTokenId(bosonOfferId, bosonExchangeId).toString();

            await offerFacet.addSupportedToken(bosonTokenAddress);
            const bosonConfigHandler = await getBosonHandler("IBosonConfigHandler");
            const bosonProtocolFlatFee = parseEther("0"); // ToDo: after boson v2.4.2, this could be higher than 0
            await bosonConfigHandler.setProtocolFeeFlatBoson(bosonProtocolFlatFee);

            const fermionOffer = {
              sellerId: "1",
              sellerDeposit: "0",
              verifierId,
              verifierFee,
              custodianId: "3",
              custodianFee,
              facilitatorId: sellerId,
              facilitatorFeePercent: "0",
              exchangeToken: bosonTokenAddress,
              metadataURI: "https://example.com/offer-metadata.json",
              metadataHash: ZeroHash,
            };

            await offerFacet.createOffer(fermionOffer);
            await offerFacet.mintAndWrapNFTs(bosonOfferId, "1");

            const minimalPrice = calculateMinimalPrice(
              verifierFee,
              fermionOffer.facilitatorFeePercent,
              0,
              fermionConfig.protocolParameters.protocolFeePercentage,
            );
            // insufficient allowanc
            await mockBosonToken.approve(fermionProtocolAddress, minimalPrice - 1n);
            await expect(offerFacet.unwrapNFTToSelf(tokenId, minimalPrice)).to.be.revertedWith(
              "ERC20: insufficient allowance",
            ); // old error style

            // Insufficient balance
            await mockBosonToken.approve(fermionProtocolAddress, minimalPrice);
            const sellerBalance = await mockBosonToken.balanceOf(defaultSigner.address);
            await mockBosonToken.transfer(wallets[4].address, sellerBalance); // transfer all the tokens to another wallet
            await expect(offerFacet.unwrapNFTToSelf(tokenId, minimalPrice)).to.be.revertedWith(
              "ERC20: transfer amount exceeds balance",
            ); // old error style
          });

          it("Custom verification timeout too long", async function () {
            const nextBlockTimestamp = BigInt((await ethers.provider.getBlock("latest")).timestamp) + 10n;
            const customItemVerificationTimeout =
              nextBlockTimestamp + fermionConfig.protocolParameters.maxVerificationTimeout + 10n;

            await mockToken.approve(fermionProtocolAddress, sellerDeposit);
            await fundsFacet.depositFunds(sellerId, exchangeToken, sellerDeposit);
            await mockToken.approve(fermionProtocolAddress, minimalPrice);

            await setNextBlockTimestamp(String(nextBlockTimestamp));

            await expect(
              offerFacet.unwrapNFTToSelfAndSetVerificationTimeout(tokenId, customItemVerificationTimeout, minimalPrice),
            )
              .to.be.revertedWithCustomError(fermionErrors, "VerificationTimeoutTooLong")
              .withArgs(
                customItemVerificationTimeout,
                nextBlockTimestamp + fermionConfig.protocolParameters.maxVerificationTimeout,
              );
          });
        });
      });
    });

    context("Zero seller deposit", function () {
      const sellerDeposit = 0n;

      beforeEach(async function () {
        const fermionOffer = {
          sellerId: "1",
          sellerDeposit,
          verifierId,
          verifierFee,
          custodianId: "3",
          custodianFee,
          facilitatorId: sellerId,
          facilitatorFeePercent: "0",
          exchangeToken,
          metadataURI: "https://example.com/offer-metadata.json",
          metadataHash: ZeroHash,
        };

        await offerFacet.createOffer(fermionOffer);
        await offerFacet.mintAndWrapNFTs(bosonOfferId, quantity);

        const buyer = wallets[4];
        const openSea = wallets[5]; // a mock OS address
        openSeaAddress = openSea.address;
        buyerAddress = buyer.address;
        seaport = new Seaport(buyer, { overrides: { seaportVersion: "1.6", contractAddress: seaportAddress } });

        await mockToken.mint(buyerAddress, fullPrice);

        const { executeAllActions } = await seaport.createOrder(
          {
            offer: [
              {
                itemType: ItemType.ERC20,
                token: exchangeToken,
                amount: fullPrice.toString(),
              },
            ],
            consideration: [
              {
                itemType: ItemType.ERC721,
                token: wrapperAddress,
                identifier: tokenId,
              },
              {
                itemType: ItemType.ERC20,
                token: exchangeToken,
                amount: openSeaFee.toString(),
                recipient: openSeaAddress,
              },
            ],
          },
          buyerAddress,
        );

        const buyerOrder = await executeAllActions();

        buyerAdvancedOrder = {
          ...buyerOrder,
          numerator: 1n,
          denominator: 1n,
          extraData: "0x",
        };

        bosonProtocolBalance = await mockToken.balanceOf(bosonProtocolAddress);
        openSeaBalance = await mockToken.balanceOf(openSeaAddress);
      });

      context("unwrap (with OS auction)", function () {
        it("Unwrapping", async function () {
          const tx = await offerFacet.unwrapNFT(tokenId, buyerAdvancedOrder);

          // events:
          // fermion
          const blockTimestamp = BigInt((await tx.getBlock()).timestamp);
          const itemVerificationTimeout = blockTimestamp + fermionConfig.protocolParameters.defaultVerificationTimeout;
          const itemMaxVerificationTimeout = blockTimestamp + fermionConfig.protocolParameters.maxVerificationTimeout;
          await expect(tx)
            .to.emit(offerFacet, "VerificationInitiated")
            .withArgs(bosonOfferId, verifierId, tokenId, itemVerificationTimeout, itemMaxVerificationTimeout);
          await expect(tx).to.emit(offerFacet, "ItemPriceObserved").withArgs(tokenId, priceSubOSFee);

          // Boson:
          await expect(tx)
            .to.emit(bosonExchangeHandler, "FundsEncumbered")
            .withArgs(bosonSellerId, exchangeToken, sellerDeposit, defaultCollectionAddress);

          // State:
          const newBosonProtocolBalance = await mockToken.balanceOf(bosonProtocolAddress);
          expect(newBosonProtocolBalance).to.equal(bosonProtocolBalance + fullPrice - openSeaFee);
        });
      });

      context("unwrapToSelf", function () {
        const minimalPrice = calculateMinimalPrice(
          verifierFee,
          0,
          bosonProtocolFeePercentage,
          fermionConfig.protocolParameters.protocolFeePercentage,
        );

        it("Unwrapping", async function () {
          await mockToken.approve(fermionProtocolAddress, minimalPrice);
          const tx = await offerFacet.unwrapNFTToSelf(tokenId, minimalPrice);

          // events:
          // fermion
          const blockTimestamp = BigInt((await tx.getBlock()).timestamp);
          const itemVerificationTimeout = blockTimestamp + fermionConfig.protocolParameters.defaultVerificationTimeout;
          const itemMaxVerificationTimeout = blockTimestamp + fermionConfig.protocolParameters.maxVerificationTimeout;

          await expect(tx)
            .to.emit(offerFacet, "VerificationInitiated")
            .withArgs(bosonOfferId, verifierId, tokenId, itemVerificationTimeout, itemMaxVerificationTimeout);
          await expect(tx).to.emit(offerFacet, "ItemPriceObserved").withArgs(tokenId, minimalPrice);

          // Boson:
          await expect(tx)
            .to.emit(bosonExchangeHandler, "FundsEncumbered")
            .withArgs(bosonBuyerId, exchangeToken, minimalPrice, fermionProtocolAddress);

          // State:
          // Boson
          const newBosonProtocolBalance = await mockToken.balanceOf(bosonProtocolAddress);
          expect(newBosonProtocolBalance).to.equal(bosonProtocolBalance + minimalPrice);
        });

        it("Unwrapping - native", async function () {
          const bosonOfferId = "2";
          const exchangeId = quantity + 1n;
          const tokenId = deriveTokenId(bosonOfferId, exchangeId).toString();

          const fermionOffer = {
            sellerId: "1",
            sellerDeposit,
            verifierId,
            verifierFee,
            custodianId: "3",
            custodianFee,
            facilitatorId: sellerId,
            facilitatorFeePercent: "0",
            exchangeToken: ZeroAddress,
            metadataURI: "https://example.com/offer-metadata.json",
            metadataHash: ZeroHash,
          };

          await offerFacet.createOffer(fermionOffer);
          await offerFacet.mintAndWrapNFTs(bosonOfferId, quantity);

          bosonProtocolBalance = await ethers.provider.getBalance(bosonProtocolAddress);

          // await mockToken.approve(fermionProtocolAddress, minimalPrice);
          const tx = await offerFacet.unwrapNFTToSelf(tokenId, minimalPrice, { value: minimalPrice });

          // events:
          // fermion
          const blockTimestamp = BigInt((await tx.getBlock()).timestamp);
          const itemVerificationTimeout = blockTimestamp + fermionConfig.protocolParameters.defaultVerificationTimeout;
          const itemMaxVerificationTimeout = blockTimestamp + fermionConfig.protocolParameters.maxVerificationTimeout;
          await expect(tx)
            .to.emit(offerFacet, "VerificationInitiated")
            .withArgs(bosonOfferId, verifierId, tokenId, itemVerificationTimeout, itemMaxVerificationTimeout);
          await expect(tx).to.emit(offerFacet, "ItemPriceObserved").withArgs(tokenId, minimalPrice);

          // Boson:
          await expect(tx)
            .to.emit(bosonExchangeHandler, "FundsEncumbered")
            .withArgs(bosonBuyerId, ZeroAddress, minimalPrice, fermionProtocolAddress);

          // State:
          // Boson
          const newBosonProtocolBalance = await ethers.provider.getBalance(bosonProtocolAddress);
          expect(newBosonProtocolBalance).to.equal(bosonProtocolBalance + minimalPrice);
        });

        context("Revert reasons", function () {
          it("Price does not cover the verifier fee", async function () {
            // Contract sends insufficient funds. In this case, the depositing to boson fails before fermion fails
            await mockToken.approve(fermionProtocolAddress, minimalPrice);
            await mockToken.setBurnAmount(1);
            await expect(offerFacet.unwrapNFTToSelf(tokenId, minimalPrice))
              .to.be.revertedWithCustomError(fermionErrors, "WrongValueReceived")
              .withArgs(minimalPrice, minimalPrice - 1n);
            await mockToken.setBurnAmount(0);
          });
        });
      });
    });
  });

  context("addSupportedToken", function () {
    let accountHandler: Contract;

    before(async function () {
      accountHandler = await getBosonHandler("IBosonAccountHandler");
    });

    it("Anyone can add a new supported token", async function () {
      const [mockToken2] = await deployMockTokens(["ERC20"]);
      const mockToken2Address = await mockToken2.getAddress();

      await expect(offerFacet.connect(wallets[4]).addSupportedToken(mockToken2))
        .to.emit(accountHandler, "DisputeResolverFeesAdded")
        .withArgs("3", [[mockToken2Address, "", 0n]], fermionProtocolAddress);

      const [, , disputeResolverFees] = await accountHandler.getDisputeResolverByAddress(fermionProtocolAddress);
      expect(disputeResolverFees).to.eql([
        [await mockToken.getAddress(), "", 0n],
        [ZeroAddress, "", 0n],
        [mockToken2Address, "", 0n],
      ]); // mockToken and zero address (native currency) are there from the setup
    });

    context("Revert reasons", function () {
      it("Offer region is paused", async function () {
        await pauseFacet.pause([PausableRegion.Offer]);

        await expect(offerFacet.addSupportedToken(ZeroAddress))
          .to.be.revertedWithCustomError(fermionErrors, "RegionPaused")
          .withArgs(PausableRegion.Offer);
      });

      it("Adding existing token fail", async function () {
        await expect(offerFacet.addSupportedToken(await mockToken.getAddress())).to.be.revertedWithCustomError(
          accountHandler,
          "DuplicateDisputeResolverFees",
        );
      });
    });
  });
});
