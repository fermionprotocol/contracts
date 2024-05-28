import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployFermionProtocolFixture, deployMockTokens, deriveTokenId } from "../utils/common";
import { getBosonHandler, getBosonVoucher } from "../utils/boson-protocol";
import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, ZeroHash } from "ethers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { EntityRole, TokenState, WalletRole } from "../utils/enums";
import { FermionTypes } from "../../typechain-types/contracts/protocol/facets/Offer.sol/OfferFacet";
import { Seaport } from "@opensea/seaport-js";
import { ItemType } from "@opensea/seaport-js/lib/constants";
import { AdvancedOrder } from "@opensea/seaport-js/lib/types";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { getBosonProtocolFees } from "../utils/boson-protocol";

const { id, MaxUint256, ZeroAddress, parseEther } = ethers;
const { percentage: bosonProtocolFeePercentage } = getBosonProtocolFees();

describe("Offer", function () {
  let offerFacet: Contract, entityFacet: Contract;
  let mockToken: Contract, mockBosonToken: Contract;
  let fermionErrors: Contract;
  let fermionProtocolAddress: string;
  let wallets: HardhatEthersSigner[];
  let defaultSigner: HardhatEthersSigner;
  let seaportAddress: string;
  let bosonProtocolAddress: string;
  let seaportContract: Contract;
  let bosonTokenAddress: string;

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
    await mockToken.mint(defaultSigner.address, parseEther("1000"));

    await offerFacet.addSupportedToken(await mockToken.getAddress());
    await offerFacet.addSupportedToken(ZeroAddress);

    mockBosonToken = await ethers.getContractAt("MockERC20", bosonTokenAddress, defaultSigner);
    await mockBosonToken.mint(defaultSigner.address, parseEther("1000"));
  }

  // Used to test methods that can be called by the Seller's Assistant only
  async function verifySellerAssistantRole(method: string, args: any[]) {
    const wallet = wallets[4];
    const sellerId = "1";

    // completely random wallet
    await expect(offerFacet.connect(wallet)[method](...args))
      .to.be.revertedWithCustomError(fermionErrors, "WalletHasNoRole")
      .withArgs(sellerId, wallet.address, EntityRole.Seller, WalletRole.Assistant);

    // an entity-wide Treasury or admin wallet (not Assistant)
    await entityFacet.addEntityWallets(sellerId, [wallet], [[]], [[[WalletRole.Treasury, WalletRole.Admin]]]);
    await expect(offerFacet.connect(wallet)[method](...args))
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
    await expect(offerFacet.connect(wallet2)[method](...args))
      .to.be.revertedWithCustomError(fermionErrors, "WalletHasNoRole")
      .withArgs(sellerId, wallet2.address, EntityRole.Seller, WalletRole.Assistant);

    // an Assistant of another role than Seller
    await entityFacet.addEntityWallets(sellerId, [wallet2], [[EntityRole.Verifier]], [[[WalletRole.Assistant]]]);
    await expect(offerFacet.connect(wallet2)[method](...args))
      .to.be.revertedWithCustomError(fermionErrors, "WalletHasNoRole")
      .withArgs(sellerId, wallet2.address, EntityRole.Seller, WalletRole.Assistant);
  }

  before(async function () {
    ({
      diamondAddress: fermionProtocolAddress,
      facets: { EntityFacet: entityFacet, OfferFacet: offerFacet },
      fermionErrors,
      wallets,
      defaultSigner,
      seaportAddress,
      bosonProtocolAddress,
      seaportContract,
      bosonTokenAddress,
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

      expect(offerFees.protocolFee).to.equal(0); // until the price is determined, the fees are unknown
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

  context("mintAndWrapNFTs", function () {
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

    it("Minting and wrapping", async function () {
      const bosonSellerId = "1";
      const bosonOfferHandler = await getBosonHandler("IBosonOfferHandler");
      const bosonExchangeHandler = await getBosonHandler("IBosonExchangeHandler");
      const bosonAccountHandler = await getBosonHandler("IBosonAccountHandler");
      const [defaultCollectionAddress] = await bosonAccountHandler.getSellersCollections(bosonSellerId);
      const bosonVoucher = await getBosonVoucher(defaultCollectionAddress);

      const totalSellerDeposit = sellerDeposit * quantity;
      const nextBosonExchangeId = await bosonExchangeHandler.getNextExchangeId();
      const startingTokenId = deriveTokenId(bosonOfferId, nextBosonExchangeId);
      const predictedWrapperAddress = await offerFacet.predictFermionWrapperAddress(startingTokenId);

      // ERC20 offer
      await mockToken.approve(fermionProtocolAddress, totalSellerDeposit);
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
      const fermionWrapper = await ethers.getContractAt("FermionWrapper", predictedWrapperAddress);
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
      const tx2 = await offerFacet.mintAndWrapNFTs(bosonOfferId2, quantity, { value: totalSellerDeposit });
      const predictedWrapperAddress2 = await offerFacet.predictFermionWrapperAddress(startingTokenId2);

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

      const fermionWrapper2 = await ethers.getContractAt("FermionWrapper", predictedWrapperAddress2);
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
      await expect(offerFacet.connect(entityAssistant).mintAndWrapNFTs(bosonOfferId, quantity)).to.emit(
        offerFacet,
        "NFTsMinted",
      );

      await expect(
        offerFacet.connect(sellerAssistant).mintAndWrapNFTs(bosonOfferId + 1n, quantity, { value: totalSellerDeposit }),
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
      await expect(offerFacet.mintAndWrapNFTs(3n, quantity)).to.emit(offerFacet, "NFTsMinted");
    });

    context("Revert reasons", function () {
      it("Caller is not the seller's assistant", async function () {
        await verifySellerAssistantRole("mintAndWrapNFTs", [bosonOfferId, quantity]);
      });

      it("Quantity is zero", async function () {
        await expect(offerFacet.mintAndWrapNFTs(bosonOfferId, 0n))
          .to.be.revertedWithCustomError(fermionErrors, "InvalidQuantity")
          .withArgs(0);
      });

      it("Funds related errors", async function () {
        // ERC20 offer - insufficient allowance
        const totalSellerDeposit = sellerDeposit * quantity;
        await mockToken.approve(fermionProtocolAddress, totalSellerDeposit - 1n);

        await expect(offerFacet.mintAndWrapNFTs(bosonOfferId, quantity))
          .to.be.revertedWithCustomError(mockToken, "ERC20InsufficientAllowance")
          .withArgs(fermionProtocolAddress, totalSellerDeposit - 1n, totalSellerDeposit);

        // ERC20 offer - contract sends insufficient funds
        await mockToken.approve(fermionProtocolAddress, totalSellerDeposit);
        await mockToken.setBurnAmount(1);
        await expect(offerFacet.mintAndWrapNFTs(bosonOfferId, quantity))
          .to.be.revertedWithCustomError(fermionErrors, "WrongValueReceived")
          .withArgs(totalSellerDeposit, totalSellerDeposit - 1n);
        await mockToken.setBurnAmount(0);

        // ERC20 offer - insufficient balance
        const sellerBalance = await mockToken.balanceOf(defaultSigner.address);
        await mockToken.transfer(wallets[4].address, sellerBalance); // transfer all the tokens to another wallet

        await expect(offerFacet.mintAndWrapNFTs(bosonOfferId, quantity))
          .to.be.revertedWithCustomError(mockToken, "ERC20InsufficientBalance")
          .withArgs(defaultSigner.address, 0n, totalSellerDeposit);

        // Native currency offer - insufficient funds
        await expect(offerFacet.mintAndWrapNFTs(bosonOfferId + 1n, quantity, { value: totalSellerDeposit - 1n }))
          .to.be.revertedWithCustomError(fermionErrors, "WrongValueReceived")
          .withArgs(totalSellerDeposit, totalSellerDeposit - 1n);

        // Native currency offer - too much sent
        await expect(offerFacet.mintAndWrapNFTs(bosonOfferId + 1n, quantity, { value: totalSellerDeposit + 1n }))
          .to.be.revertedWithCustomError(fermionErrors, "WrongValueReceived")
          .withArgs(totalSellerDeposit, totalSellerDeposit + 1n);

        // Send native currency to ERC20 offer
        await expect(
          offerFacet.mintAndWrapNFTs(bosonOfferId, quantity, { value: totalSellerDeposit }),
        ).to.be.revertedWithCustomError(fermionErrors, "NativeNotAllowed");
      });
    });
  });

  context("unwrapping", function () {
    const bosonOfferId = 1n;
    const sellerDeposit = parseEther("1");
    const quantity = 15n;
    const verifierId = "2";
    const verifierFee = parseEther("0.01");
    const bosonSellerId = "1"; // Fermion's seller id inside Boson
    const bosonBuyerId = "2"; // Fermion's buyer id inside Boson
    const exchangeId = 1n;
    const tokenId = deriveTokenId(bosonOfferId, exchangeId).toString();
    const fullPrice = parseEther("10");
    const openSeaFee = (fullPrice * 2n) / 100n;
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

      wrapperAddress = await offerFacet.predictFermionWrapperAddress(tokenId);
      fermionWrapper = await ethers.getContractAt("FermionWrapper", wrapperAddress);
    });

    beforeEach(async function () {
      const fermionOffer = {
        sellerId: "1",
        sellerDeposit,
        verifierId,
        verifierFee,
        custodianId: "3",
        exchangeToken: await mockToken.getAddress(),
        metadataURI: "https://example.com/offer-metadata.json",
        metadataHash: ZeroHash,
      };

      // erc20 offer
      await offerFacet.createOffer(fermionOffer);

      // mint and wrap
      const totalSellerDeposit = sellerDeposit * quantity;
      await mockToken.approve(fermionProtocolAddress, totalSellerDeposit);
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
        await expect(tx).to.emit(offerFacet, "VerificationInitiated").withArgs(bosonOfferId, verifierId, tokenId);

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

        // FermionWrapper
        // - Transfer to buyer (2step seller->wrapper->buyer)
        await expect(tx).to.emit(fermionWrapper, "Transfer").withArgs(defaultSigner.address, wrapperAddress, tokenId);
        await expect(tx).to.emit(fermionWrapper, "Transfer").withArgs(wrapperAddress, buyerAddress, tokenId);

        // State:
        // Boson
        const [exists, exchange, voucher] = await bosonExchangeHandler.getExchange(exchangeId);
        expect(exists).to.be.true;
        expect(exchange.state).to.equal(3); // Redeemed
        expect(voucher.committedDate).to.not.equal(0);
        expect(voucher.redeemedDate).to.equal(voucher.committedDate); // commit and redeem should happen at the same time

        const newBosonProtocolBalance = await mockToken.balanceOf(bosonProtocolAddress);
        expect(newBosonProtocolBalance).to.equal(bosonProtocolBalance + fullPrice - openSeaFee);

        // FermionWrapper:
        expect(await fermionWrapper.tokenState(tokenId)).to.equal(TokenState.Unverified);
        expect(await fermionWrapper.ownerOf(tokenId)).to.equal(buyerAddress);

        // OpenSea balance should be updated
        const newOpenSeaBalance = await mockToken.balanceOf(openSeaAddress);
        expect(newOpenSeaBalance).to.equal(openSeaBalance + openSeaFee);
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
            exchangeToken: await mockToken.getAddress(),
            metadataURI: "https://example.com/offer-metadata.json",
            metadataHash: ZeroHash,
          };

          // erc20 offer
          await offerFacet.createOffer(fermionOffer);

          // mint and wrap
          await offerFacet.mintAndWrapNFTs(bosonOfferId, "1");

          wrapperAddress = await offerFacet.predictFermionWrapperAddress(tokenId);
          fermionWrapper = await ethers.getContractAt("FermionWrapper", wrapperAddress);
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
          await expect(tx).to.emit(offerFacet, "VerificationInitiated").withArgs(bosonOfferId, verifierId, tokenId);

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
          await expect(tx).to.emit(bosonVoucher, "Transfer").withArgs(wrapperAddress, fermionProtocolAddress, tokenId);

          // - burned
          await expect(tx).to.emit(bosonVoucher, "Transfer").withArgs(fermionProtocolAddress, ZeroAddress, tokenId);

          // FermionWrapper
          // - Transfer to buyer (2step seller->wrapper->buyer)
          await expect(tx).to.emit(fermionWrapper, "Transfer").withArgs(defaultSigner.address, wrapperAddress, tokenId);
          await expect(tx).to.emit(fermionWrapper, "Transfer").withArgs(wrapperAddress, buyerAddress, tokenId);

          // State:
          // Boson
          const [exists, exchange, voucher] = await bosonExchangeHandler.getExchange(exchangeId);
          expect(exists).to.be.true;
          expect(exchange.state).to.equal(3); // Redeemed
          expect(voucher.committedDate).to.not.equal(0);
          expect(voucher.redeemedDate).to.equal(voucher.committedDate); // commit and redeem should happen at the same time

          const newBosonProtocolBalance = await mockToken.balanceOf(bosonProtocolAddress);
          expect(newBosonProtocolBalance).to.equal(bosonProtocolBalance + fullPrice - openSeaFee);

          // FermionWrapper:
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
          await expect(tx).to.emit(offerFacet, "VerificationInitiated").withArgs(bosonOfferId, verifierId, tokenId);

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
          await expect(tx).to.emit(bosonVoucher, "Transfer").withArgs(wrapperAddress, fermionProtocolAddress, tokenId);

          // - burned
          await expect(tx).to.emit(bosonVoucher, "Transfer").withArgs(fermionProtocolAddress, ZeroAddress, tokenId);

          // FermionWrapper
          // - Transfer to buyer (1step seller->buyer)
          await expect(tx).to.emit(fermionWrapper, "Transfer").withArgs(defaultSigner.address, buyerAddress, tokenId);

          // State:
          // Boson
          const [exists, exchange, voucher] = await bosonExchangeHandler.getExchange(exchangeId);
          expect(exists).to.be.true;
          expect(exchange.state).to.equal(3); // Redeemed
          expect(voucher.committedDate).to.not.equal(0);
          expect(voucher.redeemedDate).to.equal(voucher.committedDate); // commit and redeem should happen at the same time

          const newBosonProtocolBalance = await mockToken.balanceOf(bosonProtocolAddress);
          expect(newBosonProtocolBalance).to.equal(bosonProtocolBalance); // no change expected

          // FermionWrapper:
          expect(await fermionWrapper.tokenState(tokenId)).to.equal(TokenState.Unverified);
          expect(await fermionWrapper.ownerOf(tokenId)).to.equal(buyerAddress);

          // OpenSea balance should remain the same
          const newOpenSeaBalance = await mockToken.balanceOf(openSeaAddress);
          expect(newOpenSeaBalance).to.equal(openSeaBalance);
        });
      });

      context("Revert reasons", function () {
        it("Caller is not the seller's assistant", async function () {
          await verifySellerAssistantRole("unwrapNFT", [tokenId, buyerAdvancedOrder]);
        });

        it("Price does not cover the verifier fee", async function () {
          const minimalPrice = (10000n * verifierFee) / (10000n - BigInt(bosonProtocolFeePercentage));
          buyerAdvancedOrder.parameters.offer[0].startAmount = minimalPrice.toString();
          buyerAdvancedOrder.parameters.consideration[1].startAmount = "1"; // openSea fee. In total, the protocol gets minimalPrice-1
          await expect(offerFacet.unwrapNFT(tokenId, buyerAdvancedOrder))
            .to.be.revertedWithCustomError(fermionErrors, "PriceTooLow")
            .withArgs(minimalPrice - 1n, minimalPrice);
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
            exchangeToken: bosonTokenAddress,
            metadataURI: "https://example.com/offer-metadata.json",
            metadataHash: ZeroHash,
          };

          await offerFacet.createOffer(fermionOffer);
          await offerFacet.mintAndWrapNFTs(bosonOfferId, "1");

          const minimalPrice = verifierFee + BigInt(bosonProtocolFlatFee);
          buyerAdvancedOrder.parameters.offer[0].startAmount = minimalPrice.toString();
          buyerAdvancedOrder.parameters.consideration[1].startAmount = "1"; // openSea fee. In total, the protocol gets minimalPrice-1
          await expect(offerFacet.unwrapNFT(tokenId, buyerAdvancedOrder))
            .to.be.revertedWithCustomError(fermionErrors, "PriceTooLow")
            .withArgs(minimalPrice - 1n, minimalPrice);
        });

        it("OS fee is greater than the price", async function () {
          buyerAdvancedOrder.parameters.offer[0].startAmount = verifierFee.toString();
          buyerAdvancedOrder.parameters.consideration[1].startAmount = (verifierFee + 1n).toString();
          await expect(offerFacet.unwrapNFT(tokenId, buyerAdvancedOrder)).to.be.revertedWithCustomError(
            fermionErrors,
            "InvalidOrder",
          );
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
      const minimalPrice = (10000n * verifierFee) / (10000n - BigInt(bosonProtocolFeePercentage));

      it("Unwrapping", async function () {
        await mockToken.approve(fermionProtocolAddress, minimalPrice);
        const tx = await offerFacet.unwrapNFTToSelf(tokenId);

        // events:
        // fermion
        await expect(tx).to.emit(offerFacet, "VerificationInitiated").withArgs(bosonOfferId, verifierId, tokenId);

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

        // FermionWrapper
        // - No transfer should happen, since the seller is the buyer
        await expect(tx).to.not.emit(fermionWrapper, "Transfer");

        // State:
        // Boson
        const [exists, exchange, voucher] = await bosonExchangeHandler.getExchange(exchangeId);
        expect(exists).to.be.true;
        expect(exchange.state).to.equal(3); // Redeemed
        expect(voucher.committedDate).to.not.equal(0);
        expect(voucher.redeemedDate).to.equal(voucher.committedDate); // commit and redeem should happen at the same time

        const newBosonProtocolBalance = await mockToken.balanceOf(bosonProtocolAddress);
        expect(newBosonProtocolBalance).to.equal(bosonProtocolBalance + minimalPrice);

        // FermionWrapper:
        expect(await fermionWrapper.tokenState(tokenId)).to.equal(TokenState.Unverified);
        expect(await fermionWrapper.ownerOf(tokenId)).to.equal(defaultSigner.address);

        // OpenSea balance should remain the same
        const newOpenSeaBalance = await mockToken.balanceOf(openSeaAddress);
        expect(newOpenSeaBalance).to.equal(openSeaBalance);
      });

      context("Revert reasons", function () {
        it("Caller is not the seller's assistant", async function () {
          await verifySellerAssistantRole("unwrapNFTToSelf", [tokenId]);
        });

        it("Price does not cover the verifier fee", async function () {
          // insufficient allowance
          await mockToken.approve(fermionProtocolAddress, minimalPrice - 1n);
          await expect(offerFacet.unwrapNFTToSelf(tokenId))
            .to.be.revertedWithCustomError(mockToken, "ERC20InsufficientAllowance")
            .withArgs(fermionProtocolAddress, minimalPrice - 1n, minimalPrice);

          // Contract sends insufficient funds
          await mockToken.approve(fermionProtocolAddress, minimalPrice);
          await mockToken.setBurnAmount(1);
          await expect(offerFacet.unwrapNFTToSelf(tokenId))
            .to.be.revertedWithCustomError(fermionErrors, "WrongValueReceived")
            .withArgs(minimalPrice, minimalPrice - 1n);
          await mockToken.setBurnAmount(0);

          // Insufficient balance
          const sellerBalance = await mockToken.balanceOf(defaultSigner.address);
          await mockToken.transfer(wallets[4].address, sellerBalance); // transfer all the tokens to another wallet
          await expect(offerFacet.unwrapNFTToSelf(tokenId))
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
            exchangeToken: bosonTokenAddress,
            metadataURI: "https://example.com/offer-metadata.json",
            metadataHash: ZeroHash,
          };

          await offerFacet.createOffer(fermionOffer);
          await offerFacet.mintAndWrapNFTs(bosonOfferId, "1");

          const minimalPrice = verifierFee + BigInt(bosonProtocolFlatFee);
          // insufficient allowance
          await mockBosonToken.approve(fermionProtocolAddress, minimalPrice - 1n);
          await expect(offerFacet.unwrapNFTToSelf(tokenId)).to.be.revertedWith("ERC20: insufficient allowance"); // old error style

          // Insufficient balance
          await mockBosonToken.approve(fermionProtocolAddress, minimalPrice);
          const sellerBalance = await mockBosonToken.balanceOf(defaultSigner.address);
          await mockBosonToken.transfer(wallets[4].address, sellerBalance); // transfer all the tokens to another wallet
          await expect(offerFacet.unwrapNFTToSelf(tokenId)).to.be.revertedWith(
            "ERC20: transfer amount exceeds balance",
          ); // old error style
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

    it("Adding existing token fail", async function () {
      await expect(offerFacet.addSupportedToken(await mockToken.getAddress())).to.be.revertedWithCustomError(
        accountHandler,
        "DuplicateDisputeResolverFees",
      );
    });
  });
});
