import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployFermionProtocolFixture, deployMockTokens, deriveTokenId } from "../utils/common";
import { getBosonHandler, getBosonVoucher } from "../utils/boson-protocol";
import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, ZeroHash } from "ethers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { EntityRole, WalletRole } from "../utils/enums";
import { FermionTypes } from "../../typechain-types/contracts/protocol/facets/Offer.sol/OfferFacet";

const { id, MaxUint256, ZeroAddress } = ethers;

describe("Offer", function () {
  let offerFacet: Contract, entityFacet: Contract;
  let mockToken: Contract;
  let fermionErrors: Contract;
  let fermionProtocolAddress: string;
  let wallets: HardhatEthersSigner[];
  let defaultSigner: HardhatEthersSigner;

  async function setupOfferTest() {
    // Create three entities
    // Seller, Verifier, Custodian combined
    // Verifier only
    // Custodian only
    const metadataURI = "https://example.com/seller-metadata.json";
    await entityFacet.createEntity([EntityRole.Seller, EntityRole.Verifier, EntityRole.Custodian], metadataURI); // "1"
    await entityFacet.connect(wallets[2]).createEntity([EntityRole.Verifier], metadataURI); // "2"
    await entityFacet.connect(wallets[3]).createEntity([EntityRole.Custodian], metadataURI); // "3"

    [mockToken] = await deployMockTokens(["ERC20"]);
    mockToken = mockToken.connect(defaultSigner);
    await mockToken.mint(defaultSigner.address, "1000000");

    await offerFacet.addSupportedToken(await mockToken.getAddress());
    await offerFacet.addSupportedToken(ZeroAddress);
  }

  before(async function () {
    ({
      diamondAddress: fermionProtocolAddress,
      facets: { EntityFacet: entityFacet, OfferFacet: offerFacet },
      fermionErrors,
      wallets,
      defaultSigner,
    } = await loadFixture(deployFermionProtocolFixture));

    await loadFixture(setupOfferTest);
  });

  afterEach(async function () {
    await loadFixture(setupOfferTest);
  });

  context("createOffer", function () {
    const sellerId = "1";
    const verifierId = "2";
    const custodianId = "3";
    const sellerDeposit = 100;
    const verifierFee = 10;
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
        exchangeToken,
        metadataURI,
        metadataHash: id(metadataURI),
      };
    });

    it("Create fermion offer", async function () {
      // test event
      await expect(offerFacet.createOffer(fermionOffer))
        .to.emit(offerFacet, "OfferCreated")
        .withArgs(sellerId, verifierId, custodianId, Object.values(fermionOffer), bosonOfferId);

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
      expect(exists).to.be.true;
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
      expect(offer.voided).to.be.false;
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

      // expect(offerFees.protocolFee).to.equal(verifierFee*50/10000); // 0.5% of the verifier fee
      expect(offerFees.protocolFee).to.equal(0); // change after boson v2.4.2
      expect(offerFees.agentFee).to.equal(0);
    });

    it("Create fermion offer with self verification and self custody", async function () {
      const fermionOffer2 = { ...fermionOffer, verifierId: sellerId, custodianId: sellerId };

      // test event
      await expect(offerFacet.createOffer(fermionOffer2))
        .to.emit(offerFacet, "OfferCreated")
        .withArgs(sellerId, sellerId, sellerId, Object.values(fermionOffer2), bosonOfferId);

      // verify state
      const offer = await offerFacet.getOffer(bosonOfferId);
      expect(offer.verifierId).to.equal(sellerId);
      expect(offer.custodianId).to.equal(sellerId);
    });

    it("Assistant wallets can create the offer", async function () {
      const entityAssistant = wallets[4]; // entity-wide Assistant
      const sellerAssistant = wallets[5]; // Seller-specific Assistant

      await entityFacet.addEntityWallets(
        sellerId,
        [entityAssistant, sellerAssistant],
        [[], [EntityRole.Seller]],
        [[[WalletRole.Assistant]], [[WalletRole.Assistant]]],
      );

      // test event
      await expect(offerFacet.connect(entityAssistant).createOffer(fermionOffer))
        .to.emit(offerFacet, "OfferCreated")
        .withArgs(sellerId, verifierId, custodianId, Object.values(fermionOffer), bosonOfferId);

      await expect(offerFacet.connect(sellerAssistant).createOffer(fermionOffer))
        .to.emit(offerFacet, "OfferCreated")
        .withArgs(sellerId, verifierId, custodianId, Object.values(fermionOffer), "2");
    });

    context("Revert reasons", function () {
      it("Caller is not the seller's assistant", async function () {
        const wallet = wallets[4];

        // completely random wallet
        await expect(offerFacet.connect(wallet).createOffer(fermionOffer))
          .to.be.revertedWithCustomError(fermionErrors, "WalletHasNoRole")
          .withArgs(sellerId, wallet.address, EntityRole.Seller, WalletRole.Assistant);

        // an entity-wide Treasury or admin wallet (not Assistant)
        await entityFacet.addEntityWallets(sellerId, [wallet], [[]], [[[WalletRole.Treasury, WalletRole.Admin]]]);
        await expect(offerFacet.connect(wallet).createOffer(fermionOffer))
          .to.be.revertedWithCustomError(fermionErrors, "WalletHasNoRole")
          .withArgs(sellerId, wallet.address, EntityRole.Seller, WalletRole.Assistant);

        // a Seller specific Treasury or Admin wallet
        const wallet2 = wallets[5];
        await entityFacet.addEntityWallets(
          sellerId,
          [wallet2],
          [[EntityRole.Seller]],
          [[[WalletRole.Treasury, WalletRole.Admin]]],
        );
        await expect(offerFacet.connect(wallet2).createOffer(fermionOffer))
          .to.be.revertedWithCustomError(fermionErrors, "WalletHasNoRole")
          .withArgs(sellerId, wallet2.address, EntityRole.Seller, WalletRole.Assistant);

        // an Assistant of another role than Seller
        await entityFacet.addEntityWallets(sellerId, [wallet2], [[EntityRole.Verifier]], [[[WalletRole.Assistant]]]);
        await expect(offerFacet.connect(wallet2).createOffer(fermionOffer))
          .to.be.revertedWithCustomError(fermionErrors, "WalletHasNoRole")
          .withArgs(sellerId, wallet2.address, EntityRole.Seller, WalletRole.Assistant);
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
    });
  });

  context("getOffer", function () {
    it("Get offer", async function () {
      const bosonOfferId = "1";
      const exchangeToken = await mockToken.getAddress();
      const sellerDeposit = 100;
      const sellerId = "1";
      const verifierId = "2";
      const verifierFee = 10;
      const custodianId = "3";
      const metadataURI = "https://example.com/offer-metadata.json";

      const fermionOffer = {
        sellerId,
        sellerDeposit,
        verifierId,
        verifierFee,
        custodianId,
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

  context("mintNFTs", function () {
    const sellerId = "1";
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

    it("Mint NFTs", async function () {
      const bosonSellerId = "1";
      const bosonOfferHandler = await getBosonHandler("IBosonOfferHandler");
      const bosonExchangeHandler = await getBosonHandler("IBosonExchangeHandler");
      const bosonAccountHandler = await getBosonHandler("IBosonAccountHandler");
      const [defaultCollectionAddress] = await bosonAccountHandler.getSellersCollections(bosonSellerId);
      const bosonVoucher = await getBosonVoucher(defaultCollectionAddress);

      const totalSellerDeposit = sellerDeposit * quantity;
      const nextBosonExchangeId = await bosonExchangeHandler.getNextExchangeId();
      const startingTokenId = deriveTokenId(bosonOfferId, nextBosonExchangeId);

      // ERC20 offer
      await mockToken.approve(fermionProtocolAddress, totalSellerDeposit);
      const tx = await offerFacet.mintNFTs(bosonOfferId, quantity);

      // test events
      // fermion
      await expect(tx).to.emit(offerFacet, "NFTsMinted").withArgs(bosonOfferId, startingTokenId, quantity);

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

      // Native currency offer
      const bosonOfferId2 = bosonOfferId + 1n;
      const nextBosonExchangeId2 = nextBosonExchangeId + quantity;
      const startingTokenId2 = deriveTokenId(bosonOfferId2, nextBosonExchangeId2);
      const tx2 = await offerFacet.mintNFTs(bosonOfferId2, quantity, { value: totalSellerDeposit });

      // test events
      // fermion
      await expect(tx2).to.emit(offerFacet, "NFTsMinted").withArgs(bosonOfferId2, startingTokenId2, quantity);

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

      // not checking the state, since the no fermion state is changed
      // state change of other contracts is guaranteed by the events, the state itself is checked in the boson-protocol tests
    });

    it("Assistant wallets can mint NFTs", async function () {
      const entityAssistant = wallets[4]; // entity-wide Assistant
      const sellerAssistant = wallets[5]; // Seller-specific Assistant

      await entityFacet.addEntityWallets(
        sellerId,
        [entityAssistant, sellerAssistant],
        [[], [EntityRole.Seller]],
        [[[WalletRole.Assistant]], [[WalletRole.Assistant]]],
      );

      const totalSellerDeposit = sellerDeposit * quantity;
      await mockToken.mint(entityAssistant.address, totalSellerDeposit);
      await mockToken.connect(entityAssistant).approve(fermionProtocolAddress, totalSellerDeposit);

      // test event
      await expect(offerFacet.connect(entityAssistant).mintNFTs(bosonOfferId, quantity)).to.emit(
        offerFacet,
        "NFTsMinted",
      );

      await expect(
        offerFacet.connect(sellerAssistant).mintNFTs(bosonOfferId + 1n, quantity, { value: totalSellerDeposit }),
      ).to.emit(offerFacet, "NFTsMinted");
    });

    it("Zero deposit offer", async function () {
      const fermionOffer = {
        sellerId: "1",
        sellerDeposit: 0n,
        verifierId: "2",
        verifierFee: 10,
        custodianId: "3",
        exchangeToken: await mockToken.getAddress(),
        metadataURI: "https://example.com/offer-metadata.json",
        metadataHash: ZeroHash,
      };

      // erc20 offer
      await offerFacet.createOffer(fermionOffer);

      // test event
      await expect(offerFacet.mintNFTs(3n, quantity)).to.emit(offerFacet, "NFTsMinted");
    });

    context("Revert reasons", function () {
      it("Caller is not the seller's assistant", async function () {
        const wallet = wallets[4];

        // completely random wallet
        await expect(offerFacet.connect(wallet).mintNFTs(bosonOfferId, quantity))
          .to.be.revertedWithCustomError(fermionErrors, "WalletHasNoRole")
          .withArgs(sellerId, wallet.address, EntityRole.Seller, WalletRole.Assistant);

        // an entity-wide Treasury or admin wallet (not Assistant)
        await entityFacet.addEntityWallets(sellerId, [wallet], [[]], [[[WalletRole.Treasury, WalletRole.Admin]]]);
        await expect(offerFacet.connect(wallet).mintNFTs(bosonOfferId, quantity))
          .to.be.revertedWithCustomError(fermionErrors, "WalletHasNoRole")
          .withArgs(sellerId, wallet.address, EntityRole.Seller, WalletRole.Assistant);

        // a Seller specific Treasury or Admin wallet
        const wallet2 = wallets[5];
        await entityFacet.addEntityWallets(
          sellerId,
          [wallet2],
          [[EntityRole.Seller]],
          [[[WalletRole.Treasury, WalletRole.Admin]]],
        );
        await expect(offerFacet.connect(wallet2).mintNFTs(bosonOfferId, quantity))
          .to.be.revertedWithCustomError(fermionErrors, "WalletHasNoRole")
          .withArgs(sellerId, wallet2.address, EntityRole.Seller, WalletRole.Assistant);

        // an Assistant of another role than Seller
        await entityFacet.addEntityWallets(sellerId, [wallet2], [[EntityRole.Verifier]], [[[WalletRole.Assistant]]]);
        await expect(offerFacet.connect(wallet2).mintNFTs(bosonOfferId, quantity))
          .to.be.revertedWithCustomError(fermionErrors, "WalletHasNoRole")
          .withArgs(sellerId, wallet2.address, EntityRole.Seller, WalletRole.Assistant);
      });

      it("Quantity is zero", async function () {
        await expect(offerFacet.mintNFTs(bosonOfferId, 0n))
          .to.be.revertedWithCustomError(fermionErrors, "InvalidQuantity")
          .withArgs(0);
      });

      it("Funds related errors", async function () {
        // ERC20 offer - insufficient allowance
        const totalSellerDeposit = sellerDeposit * quantity;
        await mockToken.approve(fermionProtocolAddress, totalSellerDeposit - 1n);

        await expect(offerFacet.mintNFTs(bosonOfferId, quantity))
          .to.be.revertedWithCustomError(mockToken, "ERC20InsufficientAllowance")
          .withArgs(fermionProtocolAddress, totalSellerDeposit - 1n, totalSellerDeposit);

        // ERC20 offer - insufficient balacne
        await mockToken.approve(fermionProtocolAddress, totalSellerDeposit);
        const sellerBalance = await mockToken.balanceOf(defaultSigner.address);
        await mockToken.transfer(wallets[4].address, sellerBalance); // transfer all the tokens to another wallet

        await expect(offerFacet.mintNFTs(bosonOfferId, quantity))
          .to.be.revertedWithCustomError(mockToken, "ERC20InsufficientBalance")
          .withArgs(defaultSigner.address, 0n, totalSellerDeposit);

        // Native currency offer - insufficient funds
        await expect(offerFacet.mintNFTs(bosonOfferId + 1n, quantity, { value: totalSellerDeposit - 1n }))
          .to.be.revertedWithCustomError(fermionErrors, "InsufficientValueReceived")
          .withArgs(totalSellerDeposit, totalSellerDeposit - 1n);

        // Native currency offer - too much sent
        await expect(offerFacet.mintNFTs(bosonOfferId + 1n, quantity, { value: totalSellerDeposit + 1n }))
          .to.be.revertedWithCustomError(fermionErrors, "InsufficientValueReceived")
          .withArgs(totalSellerDeposit, totalSellerDeposit + 1n);

        // Send native currency to ERC20 offer
        await expect(
          offerFacet.mintNFTs(bosonOfferId, quantity, { value: totalSellerDeposit }),
        ).to.be.revertedWithCustomError(fermionErrors, "NativeNotAllowed");
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

    it("Adding existing token fail", async function () {
      await expect(offerFacet.addSupportedToken(await mockToken.getAddress())).to.be.revertedWithCustomError(
        accountHandler,
        "DuplicateDisputeResolverFees",
      );
    });
  });
});
