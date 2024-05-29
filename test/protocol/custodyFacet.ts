import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import {
  deployFermionProtocolFixture,
  deployMockTokens,
  deriveTokenId,
  verifySellerAssistantRoleClosure,
} from "../utils/common";
import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, ZeroAddress, ZeroHash } from "ethers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { EntityRole, CheckoutRequestStatus, TokenState, VerificationStatus, WalletRole } from "../utils/enums";
import { getBosonProtocolFees } from "../utils/boson-protocol";
import { createBuyerAdvancedOrderClosure } from "../utils/seaport";

const { parseEther } = ethers;

describe("Custody", function () {
  let offerFacet: Contract,
    entityFacet: Contract,
    verificationFacet: Contract,
    custodyFacet: Contract,
    fundsFacet: Contract;
  let mockToken: Contract;
  let fermionErrors: Contract;
  let fermionProtocolAddress: string;
  let wallets: HardhatEthersSigner[];
  let defaultSigner: HardhatEthersSigner;
  let custodian: HardhatEthersSigner;
  let buyer: HardhatEthersSigner;
  let seaportAddress: string;
  let wrapper: Contract, wrapperSelfSale: Contract, wrapperSelfCustody: Contract;
  const sellerId = "1";
  const verifierId = "2";
  const custodianId = "3";
  const verifierFee = parseEther("0.1");
  const sellerDeposit = parseEther("0.05");
  const exchange = { tokenId: "", custodianId: "" };
  const exchangeSelfSale = { tokenId: "", custodianId: "" };
  const exchangeSelfCustody = { tokenId: "", custodianId: "" };
  let verifySellerAssistantRole: ReturnType<typeof verifySellerAssistantRoleClosure>;

  async function setupCustodyTest() {
    // Create three entities
    // Seller, Verifier, Custodian combined
    // Verifier only
    // Custodian only
    const metadataURI = "https://example.com/seller-metadata.json";
    const verifier = wallets[2];
    custodian = wallets[3];
    await entityFacet.createEntity([EntityRole.Seller, EntityRole.Verifier, EntityRole.Custodian], metadataURI); // "1"
    await entityFacet.connect(verifier).createEntity([EntityRole.Verifier], metadataURI); // "2"
    await entityFacet.connect(custodian).createEntity([EntityRole.Custodian], metadataURI); // "3"

    [mockToken] = await deployMockTokens(["ERC20"]);
    mockToken = mockToken.connect(defaultSigner);
    await mockToken.mint(defaultSigner.address, parseEther("1000"));

    await offerFacet.addSupportedToken(await mockToken.getAddress());

    // Create offer
    const fermionOffer = {
      sellerId,
      sellerDeposit,
      verifierId,
      verifierFee,
      custodianId: "3",
      exchangeToken: await mockToken.getAddress(),
      metadataURI: "https://example.com/offer-metadata.json",
      metadataHash: ZeroHash,
    };

    // Make three offers one for normal sale, one of self sale and one for self custody
    const offerId = "1"; // buyer != seller, custodian != seller
    const offerIdSelfSale = "2"; // buyer = seller, custodian != seller
    const offerIdSelfCustody = "3"; // buyer != seller, custodian = seller
    await offerFacet.createOffer(fermionOffer);
    await offerFacet.createOffer({ ...fermionOffer, sellerDeposit: "0" });
    await offerFacet.createOffer({ ...fermionOffer, verifierId: "1", custodianId: "1", verifierFee: "0" });

    // Mint and wrap some NFTs
    const quantity = "1";
    await offerFacet.mintAndWrapNFTs(offerIdSelfSale, quantity); // offerId = 2; exchangeId = 1
    await offerFacet.mintAndWrapNFTs(offerId, quantity); // offerId = 1; exchangeId = 2
    await offerFacet.mintAndWrapNFTs(offerIdSelfCustody, "2"); // offerId = 3; exchangeId = 3
    const exchangeIdSelf = "1";
    const exchangeId = "2";
    const exchangeIdSelfCustody = "3";

    // Unwrap some NFTs - normal sale and sale with self-custody
    buyer = wallets[4];

    await mockToken.approve(fermionProtocolAddress, 2n * sellerDeposit);
    const createBuyerAdvancedOrder = createBuyerAdvancedOrderClosure(wallets, seaportAddress, mockToken, offerFacet);
    const { buyerAdvancedOrder, tokenId } = await createBuyerAdvancedOrder(buyer, offerId, exchangeId);
    await offerFacet.unwrapNFT(tokenId, buyerAdvancedOrder);

    const { buyerAdvancedOrder: buyerAdvancedOrderSelfCustody, tokenId: tokenIdSelfCustody } =
      await createBuyerAdvancedOrder(buyer, offerIdSelfCustody, exchangeIdSelfCustody);
    await offerFacet.unwrapNFT(tokenIdSelfCustody, buyerAdvancedOrderSelfCustody);

    // unwrap to self
    const tokenIdSelf = deriveTokenId(offerIdSelfSale, exchangeIdSelf).toString();
    const { percentage: bosonProtocolFeePercentage } = getBosonProtocolFees();
    const minimalPrice = (10000n * verifierFee) / (10000n - BigInt(bosonProtocolFeePercentage));
    await mockToken.approve(fermionProtocolAddress, minimalPrice);
    await offerFacet.unwrapNFTToSelf(tokenIdSelf);

    exchange.tokenId = tokenId;
    exchange.custodianId = custodianId;

    // Self sale
    exchangeSelfSale.tokenId = tokenIdSelf;
    exchangeSelfSale.custodianId = custodianId;

    // Self verification
    exchangeSelfCustody.tokenId = tokenIdSelfCustody;
    exchangeSelfCustody.custodianId = sellerId;

    // Submit verdicts
    await verificationFacet.connect(verifier).submitVerdict(tokenId, VerificationStatus.Verified);
    await verificationFacet.connect(verifier).submitVerdict(tokenIdSelf, VerificationStatus.Verified);
    await verificationFacet.submitVerdict(tokenIdSelfCustody, VerificationStatus.Verified);

    const wrapperAddress = await offerFacet.predictFermionWrapperAddress(exchange.tokenId);
    wrapper = await ethers.getContractAt("FermionWrapper", wrapperAddress);

    const wrapperAddressSelfSale = await offerFacet.predictFermionWrapperAddress(exchangeSelfSale.tokenId);
    wrapperSelfSale = await ethers.getContractAt("FermionWrapper", wrapperAddressSelfSale);

    const wrapperAddressSelfCustody = await offerFacet.predictFermionWrapperAddress(exchangeSelfCustody.tokenId);
    wrapperSelfCustody = await ethers.getContractAt("FermionWrapper", wrapperAddressSelfCustody);
  }

  before(async function () {
    ({
      diamondAddress: fermionProtocolAddress,
      facets: {
        EntityFacet: entityFacet,
        OfferFacet: offerFacet,
        VerificationFacet: verificationFacet,
        CustodyFacet: custodyFacet,
        FundsFacet: fundsFacet,
      },
      fermionErrors,
      wallets,
      defaultSigner,
      seaportAddress,
    } = await loadFixture(deployFermionProtocolFixture));

    await loadFixture(setupCustodyTest);

    verifySellerAssistantRole = verifySellerAssistantRoleClosure(custodyFacet, wallets, entityFacet, fermionErrors);
  });

  afterEach(async function () {
    await loadFixture(setupCustodyTest);
  });

  context("checkIn", function () {
    it("Custodian can check item in", async function () {
      const tx = await custodyFacet.connect(custodian).checkIn(exchange.tokenId);

      // Events
      // Fermion
      await expect(tx).to.emit(custodyFacet, "CheckedIn").withArgs(exchange.custodianId, exchange.tokenId);

      // Wrapper
      await expect(tx).to.emit(wrapper, "TokenStateChange").withArgs(exchange.tokenId, TokenState.CheckedIn);

      // State
      // Wrapper
      expect(await wrapper.tokenState(exchange.tokenId)).to.equal(TokenState.CheckedIn);
      expect(await wrapper.ownerOf(exchange.tokenId)).to.equal(buyer.address);
    });

    it("Self sale", async function () {
      const tx = await custodyFacet.connect(custodian).checkIn(exchangeSelfSale.tokenId);

      // Events
      // Fermion
      await expect(tx)
        .to.emit(custodyFacet, "CheckedIn")
        .withArgs(exchangeSelfSale.custodianId, exchangeSelfSale.tokenId);

      // Wrapper
      await expect(tx)
        .to.emit(wrapperSelfSale, "TokenStateChange")
        .withArgs(exchangeSelfSale.tokenId, TokenState.CheckedIn);

      // State
      // Wrapper
      expect(await wrapperSelfSale.tokenState(exchangeSelfSale.tokenId)).to.equal(TokenState.CheckedIn);
      expect(await wrapperSelfSale.ownerOf(exchangeSelfSale.tokenId)).to.equal(defaultSigner.address);
    });

    it("Self custody", async function () {
      const tx = await custodyFacet.checkIn(exchangeSelfCustody.tokenId);

      // Events
      // Fermion
      await expect(tx).to.emit(custodyFacet, "CheckedIn").withArgs(sellerId, exchangeSelfCustody.tokenId);

      // Wrapper
      await expect(tx)
        .to.emit(wrapperSelfCustody, "TokenStateChange")
        .withArgs(exchangeSelfCustody.tokenId, TokenState.CheckedIn);

      // State
      // Wrapper
      expect(await wrapperSelfCustody.tokenState(exchangeSelfCustody.tokenId)).to.equal(TokenState.CheckedIn);
      expect(await wrapperSelfCustody.ownerOf(exchangeSelfCustody.tokenId)).to.equal(buyer.address);
    });

    context("Revert reasons", function () {
      it("Caller is not the custodian's assistant", async function () {
        const wallet = wallets[9];

        // completely random wallet
        await expect(custodyFacet.connect(wallet).checkIn(exchange.tokenId))
          .to.be.revertedWithCustomError(fermionErrors, "WalletHasNoRole")
          .withArgs(custodianId, wallet.address, EntityRole.Custodian, WalletRole.Assistant);

        // seller
        await expect(custodyFacet.checkIn(exchange.tokenId))
          .to.be.revertedWithCustomError(fermionErrors, "WalletHasNoRole")
          .withArgs(custodianId, defaultSigner.address, EntityRole.Custodian, WalletRole.Assistant);

        // an entity-wide Treasury or admin wallet (not Assistant)
        await entityFacet
          .connect(custodian)
          .addEntityWallets(custodianId, [wallet], [[]], [[[WalletRole.Treasury, WalletRole.Admin]]]);
        await expect(custodyFacet.connect(wallet).checkIn(exchange.tokenId))
          .to.be.revertedWithCustomError(fermionErrors, "WalletHasNoRole")
          .withArgs(custodianId, wallet.address, EntityRole.Custodian, WalletRole.Assistant);

        // a Custodian specific Treasury or Admin wallet
        const wallet2 = wallets[10];
        await entityFacet
          .connect(custodian)
          .addEntityWallets(
            custodianId,
            [wallet2],
            [[EntityRole.Custodian]],
            [[[WalletRole.Treasury, WalletRole.Admin]]],
          );
        await expect(custodyFacet.connect(wallet2).checkIn(exchange.tokenId))
          .to.be.revertedWithCustomError(fermionErrors, "WalletHasNoRole")
          .withArgs(custodianId, wallet2.address, EntityRole.Custodian, WalletRole.Assistant);

        // an Assistant of another role than Custodian
        await entityFacet.connect(custodian).updateEntity(custodianId, [EntityRole.Verifier, EntityRole.Custodian], "");
        await entityFacet
          .connect(custodian)
          .addEntityWallets(custodianId, [wallet2], [[EntityRole.Verifier]], [[[WalletRole.Assistant]]]);
        await expect(custodyFacet.connect(wallet2).checkIn(exchange.tokenId))
          .to.be.revertedWithCustomError(fermionErrors, "WalletHasNoRole")
          .withArgs(custodianId, wallet2.address, EntityRole.Custodian, WalletRole.Assistant);
      });

      context("Invalid state", function () {
        const tokenId = deriveTokenId("3", "4"); // token that was wrapped but not unwrapped yet

        it("Cannot check-in twice", async function () {
          await custodyFacet.connect(custodian).checkIn(exchange.tokenId);

          await expect(custodyFacet.connect(custodian).checkIn(exchange.tokenId))
            .to.be.revertedWithCustomError(fermionErrors, "InvalidCheckoutRequestStatus")
            .withArgs(exchange.tokenId, CheckoutRequestStatus.None, CheckoutRequestStatus.CheckedIn);
        });

        it("Cannot check-in before it's unwrapped", async function () {
          await expect(custodyFacet.checkIn(tokenId))
            .to.be.revertedWithCustomError(wrapper, "InvalidStateOrCaller")
            .withArgs(tokenId, fermionProtocolAddress, TokenState.Wrapped);
        });

        it("Cannot check-in if not verified or rejected", async function () {
          await offerFacet.unwrapNFTToSelf(tokenId);

          // Unwrapped but not verified
          await expect(custodyFacet.checkIn(tokenId))
            .to.be.revertedWithCustomError(wrapper, "InvalidStateOrCaller")
            .withArgs(tokenId, fermionProtocolAddress, TokenState.Unverified);

          await verificationFacet.submitVerdict(tokenId, VerificationStatus.Rejected);

          // Unwrapped and rejected
          await expect(custodyFacet.checkIn(tokenId))
            .to.be.revertedWithCustomError(wrapper, "InvalidStateOrCaller")
            .withArgs(tokenId, fermionProtocolAddress, TokenState.Burned);
        });

        it("Cannot check-in if checkout already requested", async function () {
          await custodyFacet.connect(custodian).checkIn(exchange.tokenId);
          await wrapper.connect(buyer).approve(fermionProtocolAddress, exchange.tokenId);
          await custodyFacet.connect(buyer).requestCheckOut(exchange.tokenId);

          await expect(custodyFacet.connect(custodian).checkIn(exchange.tokenId))
            .to.be.revertedWithCustomError(fermionErrors, "InvalidCheckoutRequestStatus")
            .withArgs(exchange.tokenId, CheckoutRequestStatus.None, CheckoutRequestStatus.CheckOutRequested);
        });

        it("Cannot check-in if checkout request already cleared", async function () {
          await custodyFacet.connect(custodian).checkIn(exchange.tokenId);
          await wrapper.connect(buyer).approve(fermionProtocolAddress, exchange.tokenId);
          await custodyFacet.connect(buyer).requestCheckOut(exchange.tokenId);
          await custodyFacet.clearCheckoutRequest(exchange.tokenId);

          await expect(custodyFacet.connect(custodian).checkIn(exchange.tokenId))
            .to.be.revertedWithCustomError(fermionErrors, "InvalidCheckoutRequestStatus")
            .withArgs(exchange.tokenId, CheckoutRequestStatus.None, CheckoutRequestStatus.CheckOutRequestCleared);
        });

        it("Cannot check-in if already checked-out", async function () {
          await custodyFacet.connect(custodian).checkIn(exchange.tokenId);
          await wrapper.connect(buyer).approve(fermionProtocolAddress, exchange.tokenId);
          await custodyFacet.connect(buyer).requestCheckOut(exchange.tokenId);
          await custodyFacet.clearCheckoutRequest(exchange.tokenId);
          await custodyFacet.connect(custodian).checkOut(exchange.tokenId);

          await expect(custodyFacet.connect(custodian).checkIn(exchange.tokenId))
            .to.be.revertedWithCustomError(fermionErrors, "InvalidCheckoutRequestStatus")
            .withArgs(exchange.tokenId, CheckoutRequestStatus.None, CheckoutRequestStatus.CheckedOut);
        });
      });
    });
  });

  context("requestCheckOut", function () {
    it("F-NFT Owner can request checkout", async function () {
      await custodyFacet.connect(custodian).checkIn(exchange.tokenId);
      await wrapper.connect(buyer).approve(fermionProtocolAddress, exchange.tokenId);

      const tx = await custodyFacet.connect(buyer).requestCheckOut(exchange.tokenId);

      // Events
      // Fermion
      await expect(tx)
        .to.emit(custodyFacet, "CheckoutRequested")
        .withArgs(exchange.custodianId, exchange.tokenId, sellerId, buyer.address);

      // Wrapper
      await expect(tx).to.not.emit(wrapper, "TokenStateChange");
      await expect(tx).to.emit(wrapper, "Transfer").withArgs(buyer.address, fermionProtocolAddress, exchange.tokenId);

      // State
      // Wrapper
      expect(await wrapper.tokenState(exchange.tokenId)).to.equal(TokenState.CheckedIn);
      expect(await wrapper.ownerOf(exchange.tokenId)).to.equal(fermionProtocolAddress);
    });

    it("Self sale", async function () {
      await custodyFacet.connect(custodian).checkIn(exchangeSelfSale.tokenId);
      await wrapperSelfSale.connect(defaultSigner).approve(fermionProtocolAddress, exchangeSelfSale.tokenId);

      const tx = await custodyFacet.requestCheckOut(exchangeSelfSale.tokenId);

      // Events
      // Fermion
      await expect(tx)
        .to.emit(custodyFacet, "CheckoutRequested")
        .withArgs(exchangeSelfSale.custodianId, exchangeSelfSale.tokenId, sellerId, defaultSigner.address);

      // Wrapper
      await expect(tx).to.not.emit(wrapperSelfSale, "TokenStateChange");
      await expect(tx)
        .to.emit(wrapperSelfSale, "Transfer")
        .withArgs(defaultSigner.address, fermionProtocolAddress, exchangeSelfSale.tokenId);

      // State
      // Wrapper
      expect(await wrapperSelfSale.tokenState(exchangeSelfSale.tokenId)).to.equal(TokenState.CheckedIn);
      expect(await wrapperSelfSale.ownerOf(exchangeSelfSale.tokenId)).to.equal(fermionProtocolAddress);
    });

    it("Self custody", async function () {
      await custodyFacet.checkIn(exchangeSelfCustody.tokenId);
      await wrapperSelfCustody.connect(buyer).approve(fermionProtocolAddress, exchangeSelfCustody.tokenId);

      const tx = await custodyFacet.connect(buyer).requestCheckOut(exchangeSelfCustody.tokenId);

      // Events
      // Fermion
      await expect(tx)
        .to.emit(custodyFacet, "CheckoutRequested")
        .withArgs(sellerId, exchangeSelfCustody.tokenId, sellerId, buyer.address);

      // Wrapper
      await expect(tx).to.not.emit(wrapperSelfCustody, "TokenStateChange");
      await expect(tx)
        .to.emit(wrapperSelfCustody, "Transfer")
        .withArgs(buyer.address, fermionProtocolAddress, exchangeSelfCustody.tokenId);

      // State
      // Wrapper
      expect(await wrapperSelfCustody.tokenState(exchangeSelfCustody.tokenId)).to.equal(TokenState.CheckedIn);
      expect(await wrapperSelfCustody.ownerOf(exchangeSelfCustody.tokenId)).to.equal(fermionProtocolAddress);
    });

    context("Revert reasons", function () {
      it("Caller is not the buyer", async function () {
        await custodyFacet.connect(custodian).checkIn(exchange.tokenId);

        const wallet = wallets[9];

        // completely random wallet
        await expect(custodyFacet.connect(wallet).requestCheckOut(exchange.tokenId))
          .to.be.revertedWithCustomError(wrapper, "ERC721InsufficientApproval")
          .withArgs(fermionProtocolAddress, exchange.tokenId);

        // seller
        await expect(custodyFacet.requestCheckOut(exchange.tokenId))
          .to.be.revertedWithCustomError(wrapper, "ERC721InsufficientApproval")
          .withArgs(fermionProtocolAddress, exchange.tokenId);

        // custodian
        await expect(custodyFacet.connect(custodian).requestCheckOut(exchange.tokenId))
          .to.be.revertedWithCustomError(wrapper, "ERC721InsufficientApproval")
          .withArgs(fermionProtocolAddress, exchange.tokenId);
      });

      context("Invalid state", function () {
        const tokenId = deriveTokenId("3", "4"); // token that was wrapped but not unwrapped yet

        it("Cannot request check-out twice", async function () {
          await custodyFacet.connect(custodian).checkIn(exchange.tokenId);
          await wrapper.connect(buyer).approve(fermionProtocolAddress, exchange.tokenId);

          await custodyFacet.connect(buyer).requestCheckOut(exchange.tokenId);

          await expect(custodyFacet.connect(buyer).requestCheckOut(exchange.tokenId))
            .to.be.revertedWithCustomError(fermionErrors, "InvalidCheckoutRequestStatus")
            .withArgs(exchange.tokenId, CheckoutRequestStatus.CheckedIn, CheckoutRequestStatus.CheckOutRequested);
        });

        it("Cannot request check-out before it's unwrapped", async function () {
          await expect(custodyFacet.requestCheckOut(tokenId))
            .to.be.revertedWithCustomError(fermionErrors, "InvalidCheckoutRequestStatus")
            .withArgs(tokenId, CheckoutRequestStatus.CheckedIn, CheckoutRequestStatus.None);
        });

        it("Cannot request check-out if not verified or rejected", async function () {
          await offerFacet.unwrapNFTToSelf(tokenId);

          // Unwrapped but not verified
          await expect(custodyFacet.requestCheckOut(tokenId))
            .to.be.revertedWithCustomError(fermionErrors, "InvalidCheckoutRequestStatus")
            .withArgs(tokenId, CheckoutRequestStatus.CheckedIn, CheckoutRequestStatus.None);

          await verificationFacet.submitVerdict(tokenId, VerificationStatus.Rejected);

          // Unwrapped and rejected
          await expect(custodyFacet.requestCheckOut(tokenId))
            .to.be.revertedWithCustomError(fermionErrors, "InvalidCheckoutRequestStatus")
            .withArgs(tokenId, CheckoutRequestStatus.CheckedIn, CheckoutRequestStatus.None);
        });

        it("Cannot request check-out if not checked in", async function () {
          // Verified but not checked in
          await expect(custodyFacet.connect(buyer).requestCheckOut(exchange.tokenId))
            .to.be.revertedWithCustomError(fermionErrors, "InvalidCheckoutRequestStatus")
            .withArgs(exchange.tokenId, CheckoutRequestStatus.CheckedIn, CheckoutRequestStatus.None);
        });

        it("Cannot request check-out if checkout request already cleared", async function () {
          await custodyFacet.connect(custodian).checkIn(exchange.tokenId);
          await wrapper.connect(buyer).approve(fermionProtocolAddress, exchange.tokenId);
          await custodyFacet.connect(buyer).requestCheckOut(exchange.tokenId);
          await custodyFacet.clearCheckoutRequest(exchange.tokenId);

          await expect(custodyFacet.connect(buyer).requestCheckOut(exchange.tokenId))
            .to.be.revertedWithCustomError(fermionErrors, "InvalidCheckoutRequestStatus")
            .withArgs(exchange.tokenId, CheckoutRequestStatus.CheckedIn, CheckoutRequestStatus.CheckOutRequestCleared);
        });

        it("Cannot request check-out if checkout already checked-out", async function () {
          await custodyFacet.connect(custodian).checkIn(exchange.tokenId);
          await wrapper.connect(buyer).approve(fermionProtocolAddress, exchange.tokenId);
          await custodyFacet.connect(buyer).requestCheckOut(exchange.tokenId);
          await custodyFacet.clearCheckoutRequest(exchange.tokenId);
          await custodyFacet.connect(custodian).checkOut(exchange.tokenId);

          await expect(custodyFacet.connect(buyer).requestCheckOut(exchange.tokenId))
            .to.be.revertedWithCustomError(fermionErrors, "InvalidCheckoutRequestStatus")
            .withArgs(exchange.tokenId, CheckoutRequestStatus.CheckedIn, CheckoutRequestStatus.CheckedOut);
        });
      });
    });
  });

  context("submitTaxAmount", function () {
    const taxAmount = parseEther("0.2");

    it("Seller can add tax amount", async function () {
      await custodyFacet.connect(custodian).checkIn(exchange.tokenId);
      await wrapper.connect(buyer).approve(fermionProtocolAddress, exchange.tokenId);
      await custodyFacet.connect(buyer).requestCheckOut(exchange.tokenId);

      const tx = await custodyFacet.submitTaxAmount(exchange.tokenId, taxAmount);

      // Events
      // Fermion
      await expect(tx).to.emit(custodyFacet, "TaxAmountSubmitted").withArgs(exchange.tokenId, sellerId, taxAmount);

      // Wrapper
      await expect(tx).to.not.emit(wrapper, "TokenStateChange");

      // State
      // Fermion
      expect(await custodyFacet.getTaxAmount(exchange.tokenId)).to.equal(taxAmount);

      // Wrapper
      expect(await wrapper.tokenState(exchange.tokenId)).to.equal(TokenState.CheckedIn);
      expect(await wrapper.ownerOf(exchange.tokenId)).to.equal(fermionProtocolAddress);
    });

    it("Self custody", async function () {
      await custodyFacet.checkIn(exchangeSelfCustody.tokenId);
      await wrapperSelfCustody.connect(buyer).approve(fermionProtocolAddress, exchangeSelfCustody.tokenId);
      await custodyFacet.connect(buyer).requestCheckOut(exchangeSelfCustody.tokenId);

      const tx = await custodyFacet.submitTaxAmount(exchangeSelfCustody.tokenId, taxAmount);

      // Events
      // Fermion
      await expect(tx)
        .to.emit(custodyFacet, "TaxAmountSubmitted")
        .withArgs(exchangeSelfCustody.tokenId, sellerId, taxAmount);

      // Wrapper
      await expect(tx).to.not.emit(wrapperSelfCustody, "TokenStateChange");

      // State
      // Fermion
      expect(await custodyFacet.getTaxAmount(exchangeSelfCustody.tokenId)).to.equal(taxAmount);

      // Wrapper
      expect(await wrapperSelfCustody.tokenState(exchangeSelfCustody.tokenId)).to.equal(TokenState.CheckedIn);
      expect(await wrapperSelfCustody.ownerOf(exchangeSelfCustody.tokenId)).to.equal(fermionProtocolAddress);
    });

    it("Tax amount can be updated", async function () {
      await custodyFacet.connect(custodian).checkIn(exchange.tokenId);
      await wrapper.connect(buyer).approve(fermionProtocolAddress, exchange.tokenId);
      await custodyFacet.connect(buyer).requestCheckOut(exchange.tokenId);
      await custodyFacet.submitTaxAmount(exchange.tokenId, taxAmount);

      const newTaxAmount = parseEther("0.3");
      await expect(custodyFacet.submitTaxAmount(exchange.tokenId, newTaxAmount))
        .to.emit(custodyFacet, "TaxAmountSubmitted")
        .withArgs(exchange.tokenId, sellerId, newTaxAmount);

      expect(await custodyFacet.getTaxAmount(exchange.tokenId)).to.equal(newTaxAmount);
    });

    context("Revert reasons", function () {
      it("Caller is not the seller's assistant", async function () {
        await custodyFacet.connect(custodian).checkIn(exchange.tokenId);
        await wrapper.connect(buyer).approve(fermionProtocolAddress, exchange.tokenId);
        await custodyFacet.connect(buyer).requestCheckOut(exchange.tokenId);

        await verifySellerAssistantRole("submitTaxAmount", [exchange.tokenId, taxAmount]);
      });

      it("Tax amount is 0", async function () {
        await custodyFacet.connect(custodian).checkIn(exchange.tokenId);
        await wrapper.connect(buyer).approve(fermionProtocolAddress, exchange.tokenId);
        await custodyFacet.connect(buyer).requestCheckOut(exchange.tokenId);

        const taxAmount = "0";
        await expect(custodyFacet.submitTaxAmount(exchange.tokenId, taxAmount)).to.be.revertedWithCustomError(
          fermionErrors,
          "InvalidTaxAmount",
        );
      });

      context("Invalid state", function () {
        const tokenId = deriveTokenId("3", "4"); // token that was wrapped but not unwrapped yet

        it("Cannot submit tax amount before it's unwrapped", async function () {
          await expect(custodyFacet.submitTaxAmount(exchange.tokenId, taxAmount))
            .to.be.revertedWithCustomError(fermionErrors, "InvalidCheckoutRequestStatus")
            .withArgs(exchange.tokenId, CheckoutRequestStatus.CheckOutRequested, CheckoutRequestStatus.None);
        });

        it("Cannot submit tax amount if not verified or rejected", async function () {
          await offerFacet.unwrapNFTToSelf(tokenId);

          // Unwrapped but not verified
          await expect(custodyFacet.submitTaxAmount(tokenId, taxAmount))
            .to.be.revertedWithCustomError(fermionErrors, "InvalidCheckoutRequestStatus")
            .withArgs(tokenId, CheckoutRequestStatus.CheckOutRequested, CheckoutRequestStatus.None);

          await verificationFacet.submitVerdict(tokenId, VerificationStatus.Rejected);

          // Unwrapped and rejected
          await expect(custodyFacet.submitTaxAmount(tokenId, taxAmount))
            .to.be.revertedWithCustomError(fermionErrors, "InvalidCheckoutRequestStatus")
            .withArgs(tokenId, CheckoutRequestStatus.CheckOutRequested, CheckoutRequestStatus.None);
        });

        it("Cannot submit tax amount if not checked in", async function () {
          // Verified but not checked in
          await expect(custodyFacet.submitTaxAmount(exchange.tokenId, taxAmount))
            .to.be.revertedWithCustomError(fermionErrors, "InvalidCheckoutRequestStatus")
            .withArgs(exchange.tokenId, CheckoutRequestStatus.CheckOutRequested, CheckoutRequestStatus.None);
        });

        it("Cannot submit tax amount if checkout not requested", async function () {
          await custodyFacet.connect(custodian).checkIn(exchange.tokenId);

          // Checked in but checkout not requested
          await expect(custodyFacet.submitTaxAmount(exchange.tokenId, taxAmount))
            .to.be.revertedWithCustomError(fermionErrors, "InvalidCheckoutRequestStatus")
            .withArgs(exchange.tokenId, CheckoutRequestStatus.CheckOutRequested, CheckoutRequestStatus.CheckedIn);
        });

        it("Cannot submit tax amount if checkout request already cleared", async function () {
          await custodyFacet.connect(custodian).checkIn(exchange.tokenId);
          await wrapper.connect(buyer).approve(fermionProtocolAddress, exchange.tokenId);
          await custodyFacet.connect(buyer).requestCheckOut(exchange.tokenId);
          await custodyFacet.clearCheckoutRequest(exchange.tokenId);

          await expect(custodyFacet.submitTaxAmount(exchange.tokenId, taxAmount))
            .to.be.revertedWithCustomError(fermionErrors, "InvalidCheckoutRequestStatus")
            .withArgs(
              exchange.tokenId,
              CheckoutRequestStatus.CheckOutRequested,
              CheckoutRequestStatus.CheckOutRequestCleared,
            );
        });

        it("Cannot submit tax amount if already checked-out", async function () {
          await custodyFacet.connect(custodian).checkIn(exchange.tokenId);
          await wrapper.connect(buyer).approve(fermionProtocolAddress, exchange.tokenId);
          await custodyFacet.connect(buyer).requestCheckOut(exchange.tokenId);
          await custodyFacet.clearCheckoutRequest(exchange.tokenId);
          await custodyFacet.connect(custodian).checkOut(exchange.tokenId);

          await expect(custodyFacet.submitTaxAmount(exchange.tokenId, taxAmount))
            .to.be.revertedWithCustomError(fermionErrors, "InvalidCheckoutRequestStatus")
            .withArgs(exchange.tokenId, CheckoutRequestStatus.CheckOutRequested, CheckoutRequestStatus.CheckedOut);
        });
      });
    });
  });

  context("clearCheckoutRequest", function () {
    context("With tax amount [buyer clears]", function () {
      const taxAmount = parseEther("0.2");

      it("Buyer clears checkout request", async function () {
        await custodyFacet.connect(custodian).checkIn(exchange.tokenId);
        await wrapper.connect(buyer).approve(fermionProtocolAddress, exchange.tokenId);
        await custodyFacet.connect(buyer).requestCheckOut(exchange.tokenId);
        await custodyFacet.submitTaxAmount(exchange.tokenId, taxAmount);

        const exchangeToken = await mockToken.getAddress();
        const sellerAvailableFunds = await fundsFacet.getAvailableFunds(sellerId, exchangeToken);
        const protocolBalance = await mockToken.balanceOf(fermionProtocolAddress);

        await mockToken.mint(buyer.address, taxAmount);
        await mockToken.connect(buyer).approve(fermionProtocolAddress, taxAmount);
        const tx = await custodyFacet.connect(buyer).clearCheckoutRequest(exchange.tokenId);

        // Events
        // Fermion
        await expect(tx).to.emit(custodyFacet, "CheckOutRequestCleared").withArgs(custodianId, exchange.tokenId);
        await expect(tx).to.emit(custodyFacet, "AvailableFundsIncreased").withArgs(sellerId, exchangeToken, taxAmount);

        // Wrapper
        await expect(tx).to.not.emit(wrapper, "TokenStateChange");

        // State
        // Fermion
        expect(await fundsFacet.getAvailableFunds(sellerId, exchangeToken)).to.equal(sellerAvailableFunds + taxAmount);
        expect(await mockToken.balanceOf(fermionProtocolAddress)).to.equal(protocolBalance + taxAmount);

        // Wrapper
        expect(await wrapper.tokenState(exchange.tokenId)).to.equal(TokenState.CheckedIn);
        expect(await wrapper.ownerOf(exchange.tokenId)).to.equal(fermionProtocolAddress);
      });

      it("Self custody", async function () {
        await custodyFacet.checkIn(exchangeSelfCustody.tokenId);
        await wrapperSelfCustody.connect(buyer).approve(fermionProtocolAddress, exchangeSelfCustody.tokenId);
        await custodyFacet.connect(buyer).requestCheckOut(exchangeSelfCustody.tokenId);
        await custodyFacet.submitTaxAmount(exchangeSelfCustody.tokenId, taxAmount);

        const exchangeToken = await mockToken.getAddress();
        const sellerAvailableFunds = await fundsFacet.getAvailableFunds(sellerId, exchangeToken);
        const protocolBalance = await mockToken.balanceOf(fermionProtocolAddress);

        await mockToken.mint(buyer.address, taxAmount);
        await mockToken.connect(buyer).approve(fermionProtocolAddress, taxAmount);
        const tx = await custodyFacet.connect(buyer).clearCheckoutRequest(exchangeSelfCustody.tokenId);

        // Events
        // Fermion
        await expect(tx)
          .to.emit(custodyFacet, "CheckOutRequestCleared")
          .withArgs(sellerId, exchangeSelfCustody.tokenId);
        await expect(tx).to.emit(custodyFacet, "AvailableFundsIncreased").withArgs(sellerId, exchangeToken, taxAmount);

        // Wrapper
        await expect(tx).to.not.emit(wrapperSelfCustody, "TokenStateChange");

        // State
        // Fermion
        expect(await fundsFacet.getAvailableFunds(sellerId, exchangeToken)).to.equal(sellerAvailableFunds + taxAmount);
        expect(await mockToken.balanceOf(fermionProtocolAddress)).to.equal(protocolBalance + taxAmount);

        // Wrapper
        expect(await wrapperSelfCustody.tokenState(exchangeSelfCustody.tokenId)).to.equal(TokenState.CheckedIn);
        expect(await wrapperSelfCustody.ownerOf(exchangeSelfCustody.tokenId)).to.equal(fermionProtocolAddress);
      });

      context("Revert reasons", function () {
        it("Caller is not the buyer", async function () {
          await custodyFacet.connect(custodian).checkIn(exchange.tokenId);
          await wrapper.connect(buyer).approve(fermionProtocolAddress, exchange.tokenId);
          await custodyFacet.connect(buyer).requestCheckOut(exchange.tokenId);
          await custodyFacet.submitTaxAmount(exchange.tokenId, taxAmount);

          const wallet = wallets[9];

          // completely random wallet
          await expect(custodyFacet.connect(wallet).clearCheckoutRequest(exchange.tokenId))
            .to.be.revertedWithCustomError(fermionErrors, "NotTokenBuyer")
            .withArgs(exchange.tokenId, buyer.address, wallet.address);

          // seller
          await expect(custodyFacet.clearCheckoutRequest(exchange.tokenId))
            .to.be.revertedWithCustomError(fermionErrors, "NotTokenBuyer")
            .withArgs(exchange.tokenId, buyer.address, defaultSigner.address);

          // custodian
          await expect(custodyFacet.connect(custodian).clearCheckoutRequest(exchange.tokenId))
            .to.be.revertedWithCustomError(fermionErrors, "NotTokenBuyer")
            .withArgs(exchange.tokenId, buyer.address, custodian.address);
        });

        it("Funds related errors", async function () {
          await custodyFacet.connect(custodian).checkIn(exchange.tokenId);
          await wrapper.connect(buyer).approve(fermionProtocolAddress, exchange.tokenId);
          await custodyFacet.connect(buyer).requestCheckOut(exchange.tokenId);
          await custodyFacet.submitTaxAmount(exchange.tokenId, taxAmount);

          await mockToken.mint(buyer.address, taxAmount);

          // ERC20 offer - insufficient allowance
          await mockToken.connect(buyer).approve(fermionProtocolAddress, taxAmount - 1n);

          await expect(custodyFacet.connect(buyer).clearCheckoutRequest(exchange.tokenId))
            .to.be.revertedWithCustomError(mockToken, "ERC20InsufficientAllowance")
            .withArgs(fermionProtocolAddress, taxAmount - 1n, taxAmount);

          // ERC20 offer - contract sends insufficient funds
          await mockToken.connect(buyer).approve(fermionProtocolAddress, taxAmount);
          await mockToken.setBurnAmount(1);
          await expect(custodyFacet.connect(buyer).clearCheckoutRequest(exchange.tokenId))
            .to.be.revertedWithCustomError(fermionErrors, "WrongValueReceived")
            .withArgs(taxAmount, taxAmount - 1n);
          await mockToken.setBurnAmount(0);

          // ERC20 offer - insufficient balance
          const buyerBalance = await mockToken.balanceOf(buyer.address);
          await mockToken.connect(buyer).transfer(wallets[9].address, buyerBalance); // transfer all the tokens to another wallet

          await expect(custodyFacet.connect(buyer).clearCheckoutRequest(exchange.tokenId))
            .to.be.revertedWithCustomError(mockToken, "ERC20InsufficientBalance")
            .withArgs(buyer.address, 0n, taxAmount);

          // Send native currency to ERC20 offer
          await expect(
            custodyFacet.connect(buyer).clearCheckoutRequest(exchange.tokenId, { value: taxAmount }),
          ).to.be.revertedWithCustomError(fermionErrors, "NativeNotAllowed");
        });

        context("Invalid state", function () {
          const tokenId = deriveTokenId("3", "4"); // token that was wrapped but not unwrapped yet

          it("Cannot clear checkout request twice", async function () {
            await custodyFacet.connect(custodian).checkIn(exchange.tokenId);
            await wrapper.connect(buyer).approve(fermionProtocolAddress, exchange.tokenId);
            await custodyFacet.connect(buyer).requestCheckOut(exchange.tokenId);
            await custodyFacet.submitTaxAmount(exchange.tokenId, taxAmount);

            await mockToken.mint(buyer.address, taxAmount);
            await mockToken.connect(buyer).approve(fermionProtocolAddress, taxAmount);
            await custodyFacet.connect(buyer).clearCheckoutRequest(exchange.tokenId);

            await expect(custodyFacet.connect(buyer).clearCheckoutRequest(exchange.tokenId))
              .to.be.revertedWithCustomError(fermionErrors, "InvalidCheckoutRequestStatus")
              .withArgs(
                exchange.tokenId,
                CheckoutRequestStatus.CheckOutRequested,
                CheckoutRequestStatus.CheckOutRequestCleared,
              );
          });

          it("Cannot clear checkout request before it's unwrapped", async function () {
            await expect(custodyFacet.connect(buyer).clearCheckoutRequest(tokenId))
              .to.be.revertedWithCustomError(fermionErrors, "InvalidCheckoutRequestStatus")
              .withArgs(tokenId, CheckoutRequestStatus.CheckOutRequested, CheckoutRequestStatus.None);
          });

          it("Cannot clear checkout request if not verified or rejected", async function () {
            await offerFacet.unwrapNFTToSelf(tokenId);

            // Unwrapped but not verified
            await expect(custodyFacet.connect(buyer).clearCheckoutRequest(tokenId))
              .to.be.revertedWithCustomError(fermionErrors, "InvalidCheckoutRequestStatus")
              .withArgs(tokenId, CheckoutRequestStatus.CheckOutRequested, CheckoutRequestStatus.None);

            await verificationFacet.submitVerdict(tokenId, VerificationStatus.Rejected);

            // Unwrapped and rejected
            await expect(custodyFacet.connect(buyer).clearCheckoutRequest(tokenId))
              .to.be.revertedWithCustomError(fermionErrors, "InvalidCheckoutRequestStatus")
              .withArgs(tokenId, CheckoutRequestStatus.CheckOutRequested, CheckoutRequestStatus.None);
          });

          it("Cannot clear checkout request if not checked in", async function () {
            // Verified but not checked in
            await expect(custodyFacet.connect(buyer).clearCheckoutRequest(exchange.tokenId))
              .to.be.revertedWithCustomError(fermionErrors, "InvalidCheckoutRequestStatus")
              .withArgs(exchange.tokenId, CheckoutRequestStatus.CheckOutRequested, CheckoutRequestStatus.None);
          });

          it("Cannot clear checkout request if checkout not requested", async function () {
            await custodyFacet.connect(custodian).checkIn(exchange.tokenId);

            // Checked in but checkout not requested
            await expect(custodyFacet.connect(buyer).clearCheckoutRequest(exchange.tokenId))
              .to.be.revertedWithCustomError(fermionErrors, "InvalidCheckoutRequestStatus")
              .withArgs(exchange.tokenId, CheckoutRequestStatus.CheckOutRequested, CheckoutRequestStatus.CheckedIn);
          });

          it("Cannot clear checkout request if already checked-out", async function () {
            await custodyFacet.connect(custodian).checkIn(exchange.tokenId);
            await wrapper.connect(buyer).approve(fermionProtocolAddress, exchange.tokenId);
            await custodyFacet.connect(buyer).requestCheckOut(exchange.tokenId);
            await custodyFacet.clearCheckoutRequest(exchange.tokenId);
            await custodyFacet.connect(custodian).checkOut(exchange.tokenId);

            // Already checked out
            await expect(custodyFacet.connect(buyer).clearCheckoutRequest(exchange.tokenId))
              .to.be.revertedWithCustomError(fermionErrors, "InvalidCheckoutRequestStatus")
              .withArgs(exchange.tokenId, CheckoutRequestStatus.CheckOutRequested, CheckoutRequestStatus.CheckedOut);
          });

          it("Buyer cannot clear checkout request if no tax information provided", async function () {
            await custodyFacet.connect(custodian).checkIn(exchange.tokenId);
            await wrapper.connect(buyer).approve(fermionProtocolAddress, exchange.tokenId);
            await custodyFacet.connect(buyer).requestCheckOut(exchange.tokenId);

            // Checked in but checkout not requested
            await expect(custodyFacet.connect(buyer).clearCheckoutRequest(exchange.tokenId))
              .to.be.revertedWithCustomError(fermionErrors, "WalletHasNoRole")
              .withArgs(sellerId, buyer.address, EntityRole.Seller, WalletRole.Assistant);
          });
        });
      });
    });

    context("Without tax amount [seller clears]", function () {
      it("Seller clears checkout request", async function () {
        await custodyFacet.connect(custodian).checkIn(exchange.tokenId);
        await wrapper.connect(buyer).approve(fermionProtocolAddress, exchange.tokenId);
        await custodyFacet.connect(buyer).requestCheckOut(exchange.tokenId);

        const exchangeToken = await mockToken.getAddress();
        const sellerAvailableFunds = await fundsFacet.getAvailableFunds(sellerId, exchangeToken);
        const protocolBalance = await mockToken.balanceOf(fermionProtocolAddress);

        const tx = await custodyFacet.clearCheckoutRequest(exchange.tokenId);

        // Events
        // Fermion
        await expect(tx).to.emit(custodyFacet, "CheckOutRequestCleared").withArgs(custodianId, exchange.tokenId);
        await expect(tx).to.not.emit(custodyFacet, "AvailableFundsIncreased");

        // Wrapper
        await expect(tx).to.not.emit(wrapper, "TokenStateChange");

        // State
        // Fermion
        expect(await fundsFacet.getAvailableFunds(sellerId, exchangeToken)).to.equal(sellerAvailableFunds);
        expect(await mockToken.balanceOf(fermionProtocolAddress)).to.equal(protocolBalance);

        // Wrapper
        expect(await wrapper.tokenState(exchange.tokenId)).to.equal(TokenState.CheckedIn);
        expect(await wrapper.ownerOf(exchange.tokenId)).to.equal(fermionProtocolAddress);
      });

      it("Self custody", async function () {
        await custodyFacet.checkIn(exchangeSelfCustody.tokenId);
        await wrapperSelfCustody.connect(buyer).approve(fermionProtocolAddress, exchangeSelfCustody.tokenId);
        await custodyFacet.connect(buyer).requestCheckOut(exchangeSelfCustody.tokenId);

        const exchangeToken = await mockToken.getAddress();
        const sellerAvailableFunds = await fundsFacet.getAvailableFunds(sellerId, exchangeToken);
        const protocolBalance = await mockToken.balanceOf(fermionProtocolAddress);

        const tx = await custodyFacet.clearCheckoutRequest(exchangeSelfCustody.tokenId);

        // Events
        // Fermion
        await expect(tx)
          .to.emit(custodyFacet, "CheckOutRequestCleared")
          .withArgs(sellerId, exchangeSelfCustody.tokenId);
        await expect(tx).to.not.emit(custodyFacet, "AvailableFundsIncreased");

        // Wrapper
        await expect(tx).to.not.emit(wrapperSelfCustody, "TokenStateChange");

        // State
        // Fermion
        expect(await fundsFacet.getAvailableFunds(sellerId, exchangeToken)).to.equal(sellerAvailableFunds);
        expect(await mockToken.balanceOf(fermionProtocolAddress)).to.equal(protocolBalance);

        // Wrapper
        expect(await wrapperSelfCustody.tokenState(exchangeSelfCustody.tokenId)).to.equal(TokenState.CheckedIn);
        expect(await wrapperSelfCustody.ownerOf(exchangeSelfCustody.tokenId)).to.equal(fermionProtocolAddress);
      });

      context("Revert reasons", function () {
        it("Caller is not the seller's assistant", async function () {
          await custodyFacet.connect(custodian).checkIn(exchange.tokenId);
          await wrapper.connect(buyer).approve(fermionProtocolAddress, exchange.tokenId);
          await custodyFacet.connect(buyer).requestCheckOut(exchange.tokenId);

          await verifySellerAssistantRole("clearCheckoutRequest", [exchange.tokenId]);
        });

        context("Invalid state", function () {
          const tokenId = deriveTokenId("3", "4"); // token that was wrapped but not unwrapped yet

          it("Cannot clear checkout request twice", async function () {
            await custodyFacet.connect(custodian).checkIn(exchange.tokenId);
            await wrapper.connect(buyer).approve(fermionProtocolAddress, exchange.tokenId);
            await custodyFacet.connect(buyer).requestCheckOut(exchange.tokenId);

            await custodyFacet.clearCheckoutRequest(exchange.tokenId);

            await expect(custodyFacet.clearCheckoutRequest(exchange.tokenId))
              .to.be.revertedWithCustomError(fermionErrors, "InvalidCheckoutRequestStatus")
              .withArgs(
                exchange.tokenId,
                CheckoutRequestStatus.CheckOutRequested,
                CheckoutRequestStatus.CheckOutRequestCleared,
              );
          });

          it("Cannot clear checkout request before it's unwrapped", async function () {
            await expect(custodyFacet.clearCheckoutRequest(tokenId))
              .to.be.revertedWithCustomError(fermionErrors, "InvalidCheckoutRequestStatus")
              .withArgs(tokenId, CheckoutRequestStatus.CheckOutRequested, CheckoutRequestStatus.None);
          });

          it("Cannot clear checkout request if not verified or rejected", async function () {
            await offerFacet.unwrapNFTToSelf(tokenId);

            // Unwrapped but not verified
            await expect(custodyFacet.clearCheckoutRequest(tokenId))
              .to.be.revertedWithCustomError(fermionErrors, "InvalidCheckoutRequestStatus")
              .withArgs(tokenId, CheckoutRequestStatus.CheckOutRequested, CheckoutRequestStatus.None);

            await verificationFacet.submitVerdict(tokenId, VerificationStatus.Rejected);

            // Unwrapped and rejected
            await expect(custodyFacet.clearCheckoutRequest(tokenId))
              .to.be.revertedWithCustomError(fermionErrors, "InvalidCheckoutRequestStatus")
              .withArgs(tokenId, CheckoutRequestStatus.CheckOutRequested, CheckoutRequestStatus.None);
          });

          it("Cannot clear checkout request if not checked in", async function () {
            // Verified but not checked in
            await expect(custodyFacet.clearCheckoutRequest(exchange.tokenId))
              .to.be.revertedWithCustomError(fermionErrors, "InvalidCheckoutRequestStatus")
              .withArgs(exchange.tokenId, CheckoutRequestStatus.CheckOutRequested, CheckoutRequestStatus.None);
          });

          it("Cannot clear checkout request if checkout not requested", async function () {
            await custodyFacet.connect(custodian).checkIn(exchange.tokenId);

            // Checked in but checkout not requested
            await expect(custodyFacet.clearCheckoutRequest(exchange.tokenId))
              .to.be.revertedWithCustomError(fermionErrors, "InvalidCheckoutRequestStatus")
              .withArgs(exchange.tokenId, CheckoutRequestStatus.CheckOutRequested, CheckoutRequestStatus.CheckedIn);
          });

          it("Cannot clear checkout request if already checked-out", async function () {
            await custodyFacet.connect(custodian).checkIn(exchange.tokenId);
            await wrapper.connect(buyer).approve(fermionProtocolAddress, exchange.tokenId);
            await custodyFacet.connect(buyer).requestCheckOut(exchange.tokenId);
            await custodyFacet.clearCheckoutRequest(exchange.tokenId);
            await custodyFacet.connect(custodian).checkOut(exchange.tokenId);

            // Checked in but checkout not requested
            await expect(custodyFacet.clearCheckoutRequest(exchange.tokenId))
              .to.be.revertedWithCustomError(fermionErrors, "InvalidCheckoutRequestStatus")
              .withArgs(exchange.tokenId, CheckoutRequestStatus.CheckOutRequested, CheckoutRequestStatus.CheckedOut);
          });
        });
      });
    });
  });

  context("checkOut", function () {
    it("Custodian can check item out", async function () {
      await custodyFacet.connect(custodian).checkIn(exchange.tokenId);
      await wrapper.connect(buyer).approve(fermionProtocolAddress, exchange.tokenId);
      await custodyFacet.connect(buyer).requestCheckOut(exchange.tokenId);
      await custodyFacet.clearCheckoutRequest(exchange.tokenId);

      const tx = await custodyFacet.connect(custodian).checkOut(exchange.tokenId);

      // Events
      // Fermion
      await expect(tx).to.emit(custodyFacet, "CheckedOut").withArgs(exchange.custodianId, exchange.tokenId);

      // Wrapper
      await expect(tx).to.emit(wrapper, "TokenStateChange").withArgs(exchange.tokenId, TokenState.CheckedOut);
      await expect(tx).to.emit(wrapper, "Transfer").withArgs(fermionProtocolAddress, ZeroAddress, exchange.tokenId);

      // State
      // Wrapper
      expect(await wrapper.tokenState(exchange.tokenId)).to.equal(TokenState.CheckedOut);
      await expect(wrapper.ownerOf(exchange.tokenId))
        .to.be.revertedWithCustomError(wrapper, "ERC721NonexistentToken")
        .withArgs(exchange.tokenId);
    });

    it("Self custody", async function () {
      await custodyFacet.checkIn(exchangeSelfCustody.tokenId);
      await wrapperSelfCustody.connect(buyer).approve(fermionProtocolAddress, exchangeSelfCustody.tokenId);
      await custodyFacet.connect(buyer).requestCheckOut(exchangeSelfCustody.tokenId);
      await custodyFacet.clearCheckoutRequest(exchangeSelfCustody.tokenId);

      const tx = await custodyFacet.checkOut(exchangeSelfCustody.tokenId);

      // Events
      // Fermion
      await expect(tx).to.emit(custodyFacet, "CheckedOut").withArgs(sellerId, exchangeSelfCustody.tokenId);

      // Wrapper
      await expect(tx)
        .to.emit(wrapperSelfCustody, "TokenStateChange")
        .withArgs(exchangeSelfCustody.tokenId, TokenState.CheckedOut);
      await expect(tx)
        .to.emit(wrapperSelfCustody, "Transfer")
        .withArgs(fermionProtocolAddress, ZeroAddress, exchangeSelfCustody.tokenId);

      // State
      // Wrapper
      expect(await wrapperSelfCustody.tokenState(exchangeSelfCustody.tokenId)).to.equal(TokenState.CheckedOut);
      await expect(wrapperSelfCustody.ownerOf(exchangeSelfCustody.tokenId))
        .to.be.revertedWithCustomError(wrapperSelfCustody, "ERC721NonexistentToken")
        .withArgs(exchangeSelfCustody.tokenId);
    });

    context("Revert reasons", function () {
      it("Caller is not the custodian's assistant", async function () {
        await custodyFacet.connect(custodian).checkIn(exchange.tokenId);
        await wrapper.connect(buyer).approve(fermionProtocolAddress, exchange.tokenId);
        await custodyFacet.connect(buyer).requestCheckOut(exchange.tokenId);
        await custodyFacet.clearCheckoutRequest(exchange.tokenId);

        const wallet = wallets[9];

        // completely random wallet
        await expect(custodyFacet.connect(wallet).checkOut(exchange.tokenId))
          .to.be.revertedWithCustomError(fermionErrors, "WalletHasNoRole")
          .withArgs(custodianId, wallet.address, EntityRole.Custodian, WalletRole.Assistant);

        // seller
        await expect(custodyFacet.checkOut(exchange.tokenId))
          .to.be.revertedWithCustomError(fermionErrors, "WalletHasNoRole")
          .withArgs(custodianId, defaultSigner.address, EntityRole.Custodian, WalletRole.Assistant);

        // an entity-wide Treasury or admin wallet (not Assistant)
        await entityFacet
          .connect(custodian)
          .addEntityWallets(custodianId, [wallet], [[]], [[[WalletRole.Treasury, WalletRole.Admin]]]);
        await expect(custodyFacet.connect(wallet).checkOut(exchange.tokenId))
          .to.be.revertedWithCustomError(fermionErrors, "WalletHasNoRole")
          .withArgs(custodianId, wallet.address, EntityRole.Custodian, WalletRole.Assistant);

        // a Custodian specific Treasury or Admin wallet
        const wallet2 = wallets[10];
        await entityFacet
          .connect(custodian)
          .addEntityWallets(
            custodianId,
            [wallet2],
            [[EntityRole.Custodian]],
            [[[WalletRole.Treasury, WalletRole.Admin]]],
          );
        await expect(custodyFacet.connect(wallet2).checkOut(exchange.tokenId))
          .to.be.revertedWithCustomError(fermionErrors, "WalletHasNoRole")
          .withArgs(custodianId, wallet2.address, EntityRole.Custodian, WalletRole.Assistant);

        // an Assistant of another role than Custodian
        await entityFacet.connect(custodian).updateEntity(custodianId, [EntityRole.Verifier, EntityRole.Custodian], "");
        await entityFacet
          .connect(custodian)
          .addEntityWallets(custodianId, [wallet2], [[EntityRole.Verifier]], [[[WalletRole.Assistant]]]);
        await expect(custodyFacet.connect(wallet2).checkOut(exchange.tokenId))
          .to.be.revertedWithCustomError(fermionErrors, "WalletHasNoRole")
          .withArgs(custodianId, wallet2.address, EntityRole.Custodian, WalletRole.Assistant);
      });

      context("Invalid state", function () {
        const tokenId = deriveTokenId("3", "4"); // token that was wrapped but not unwrapped yet

        it("Cannot check item out twice", async function () {
          await custodyFacet.connect(custodian).checkIn(exchange.tokenId);
          await wrapper.connect(buyer).approve(fermionProtocolAddress, exchange.tokenId);
          await custodyFacet.connect(buyer).requestCheckOut(exchange.tokenId);
          await custodyFacet.clearCheckoutRequest(exchange.tokenId);

          await custodyFacet.connect(custodian).checkOut(exchange.tokenId);

          await expect(custodyFacet.connect(custodian).checkOut(exchange.tokenId))
            .to.be.revertedWithCustomError(fermionErrors, "InvalidCheckoutRequestStatus")
            .withArgs(exchange.tokenId, CheckoutRequestStatus.CheckOutRequestCleared, CheckoutRequestStatus.CheckedOut);
        });

        it("Cannot check item out before it's unwrapped", async function () {
          await expect(custodyFacet.checkOut(tokenId))
            .to.be.revertedWithCustomError(fermionErrors, "InvalidCheckoutRequestStatus")
            .withArgs(tokenId, CheckoutRequestStatus.CheckOutRequestCleared, CheckoutRequestStatus.None);
        });

        it("Cannot check item out if not verified or rejected", async function () {
          await offerFacet.unwrapNFTToSelf(tokenId);

          // Unwrapped but not verified
          await expect(custodyFacet.checkOut(tokenId))
            .to.be.revertedWithCustomError(fermionErrors, "InvalidCheckoutRequestStatus")
            .withArgs(tokenId, CheckoutRequestStatus.CheckOutRequestCleared, CheckoutRequestStatus.None);

          await verificationFacet.submitVerdict(tokenId, VerificationStatus.Rejected);

          // Unwrapped and rejected
          await expect(custodyFacet.checkOut(tokenId))
            .to.be.revertedWithCustomError(fermionErrors, "InvalidCheckoutRequestStatus")
            .withArgs(tokenId, CheckoutRequestStatus.CheckOutRequestCleared, CheckoutRequestStatus.None);
        });

        it("Cannot check item out if not checked in", async function () {
          // Verified but not checked in
          await expect(custodyFacet.connect(custodian).checkOut(exchange.tokenId))
            .to.be.revertedWithCustomError(fermionErrors, "InvalidCheckoutRequestStatus")
            .withArgs(exchange.tokenId, CheckoutRequestStatus.CheckOutRequestCleared, CheckoutRequestStatus.None);
        });

        it("Cannot check item out if checkout not requested", async function () {
          await custodyFacet.connect(custodian).checkIn(exchange.tokenId);

          // Checked in but checkout not requested
          await expect(custodyFacet.connect(custodian).checkOut(exchange.tokenId))
            .to.be.revertedWithCustomError(fermionErrors, "InvalidCheckoutRequestStatus")
            .withArgs(exchange.tokenId, CheckoutRequestStatus.CheckOutRequestCleared, CheckoutRequestStatus.CheckedIn);
        });

        it("Cannot check item out if checkout request not cleared", async function () {
          await custodyFacet.connect(custodian).checkIn(exchange.tokenId);
          await wrapper.connect(buyer).approve(fermionProtocolAddress, exchange.tokenId);

          await custodyFacet.connect(buyer).requestCheckOut(exchange.tokenId);

          // Checkout request but not cleared
          await expect(custodyFacet.connect(custodian).checkOut(exchange.tokenId))
            .to.be.revertedWithCustomError(fermionErrors, "InvalidCheckoutRequestStatus")
            .withArgs(
              exchange.tokenId,
              CheckoutRequestStatus.CheckOutRequestCleared,
              CheckoutRequestStatus.CheckOutRequested,
            );
        });
      });
    });
  });
});
