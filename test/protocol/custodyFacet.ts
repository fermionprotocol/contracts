import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployFermionProtocolFixture, deployMockTokens, deriveTokenId } from "../utils/common";
import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, ZeroAddress, ZeroHash } from "ethers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { EntityRole, CheckoutRequestStatus, TokenState, VerificationStatus, WalletRole } from "../utils/enums";
import { Seaport } from "@opensea/seaport-js";
import { ItemType } from "@opensea/seaport-js/lib/constants";
import { getBosonProtocolFees } from "../utils/boson-protocol";

const { parseEther } = ethers;

describe("Custody", function () {
  let offerFacet: Contract, entityFacet: Contract, verificationFacet: Contract, custodyFacet: Contract;
  let mockToken: Contract;
  let fermionErrors: Contract;
  let fermionProtocolAddress: string;
  let wallets: HardhatEthersSigner[];
  let defaultSigner: HardhatEthersSigner;
  let custodian: HardhatEthersSigner;
  let buyer: HardhatEthersSigner;
  let seaportAddress: string;
  const sellerId = "1";
  const verifierId = "2";
  const custodianId = "3";
  const verifierFee = parseEther("0.1");
  const sellerDeposit = parseEther("0.05");
  const exchange = { tokenId: "", custodianId: "", payout: 0n, offerId: "", exchangeId: "" };
  const exchangeSelfSale = { tokenId: "", custodianId: "", payout: 0n, offerId: "", exchangeId: "" };
  const exchangeSelfCustody = { tokenId: "", custodianId: "", payout: 0n, offerId: "", exchangeId: "" };

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
    await mockToken.approve(fermionProtocolAddress, 3n * sellerDeposit);
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

    const { buyerAdvancedOrder, tokenId, encumberedAmount } = await createBuyerAdvancedOrder(
      buyer,
      offerId,
      exchangeId,
    );
    await offerFacet.unwrapNFT(tokenId, buyerAdvancedOrder);

    const {
      buyerAdvancedOrder: buyerAdvancedOrderSelfCustody,
      tokenId: tokenIdSelfCustody,
      encumberedAmount: encumberedAmountSelfCustody,
    } = await createBuyerAdvancedOrder(buyer, offerIdSelfCustody, exchangeIdSelfCustody);
    await offerFacet.unwrapNFT(tokenIdSelfCustody, buyerAdvancedOrderSelfCustody);

    // unwrap to self
    const tokenIdSelf = deriveTokenId(offerIdSelfSale, exchangeIdSelf).toString();
    const { percentage: bosonProtocolFeePercentage } = getBosonProtocolFees();
    const minimalPrice = (10000n * verifierFee) / (10000n - BigInt(bosonProtocolFeePercentage));
    await mockToken.approve(fermionProtocolAddress, minimalPrice);
    await offerFacet.unwrapNFTToSelf(tokenIdSelf);

    exchange.offerId = offerId;
    exchange.exchangeId = exchangeId;
    exchange.tokenId = tokenId;
    exchange.custodianId = custodianId;
    exchange.payout =
      encumberedAmount - (encumberedAmount * BigInt(bosonProtocolFeePercentage)) / 10000n - verifierFee + sellerDeposit;

    // Self sale
    exchangeSelfSale.tokenId = tokenIdSelf;
    exchangeSelfSale.custodianId = custodianId;
    exchangeSelfSale.offerId = offerIdSelfSale;
    exchangeSelfSale.exchangeId = exchangeIdSelf;
    exchangeSelfSale.payout = 0n;

    // Self verification
    exchangeSelfCustody.tokenId = tokenIdSelfCustody;
    exchangeSelfCustody.custodianId = sellerId;
    exchangeSelfCustody.offerId = offerIdSelfCustody;
    exchangeSelfCustody.exchangeId = exchangeIdSelfCustody;
    exchangeSelfCustody.payout =
      encumberedAmountSelfCustody -
      (encumberedAmountSelfCustody * BigInt(bosonProtocolFeePercentage)) / 10000n +
      sellerDeposit;

    // Submit verdicts
    await verificationFacet.connect(verifier).submitVerdict(tokenId, VerificationStatus.Verified);
    await verificationFacet.connect(verifier).submitVerdict(tokenIdSelf, VerificationStatus.Verified);
    await verificationFacet.submitVerdict(tokenIdSelfCustody, VerificationStatus.Verified);
  }

  async function createBuyerAdvancedOrder(buyer: HardhatEthersSigner, offerId: string, exchangeId: string) {
    const fullPrice = parseEther("1");
    const openSeaFee = (fullPrice * 2n) / 100n;
    const openSea = wallets[5]; // a mock OS address
    const seaport = new Seaport(buyer, { overrides: { seaportVersion: "1.6", contractAddress: seaportAddress } });

    await mockToken.mint(buyer.address, fullPrice);

    const exchangeToken = await mockToken.getAddress();
    const tokenId = deriveTokenId(offerId, exchangeId).toString();
    const wrapperAddress = await offerFacet.predictFermionWrapperAddress(tokenId);
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
            recipient: openSea.address,
          },
        ],
      },
      buyer.address,
    );

    const buyerOrder = await executeAllActions();
    const buyerAdvancedOrder = {
      ...buyerOrder,
      numerator: 1n,
      denominator: 1n,
      extraData: "0x",
    };

    const encumberedAmount = fullPrice - openSeaFee;

    return { buyerAdvancedOrder, tokenId, encumberedAmount };
  }

  before(async function () {
    ({
      diamondAddress: fermionProtocolAddress,
      facets: {
        EntityFacet: entityFacet,
        OfferFacet: offerFacet,
        VerificationFacet: verificationFacet,
        CustodyFacet: custodyFacet,
      },
      fermionErrors,
      wallets,
      defaultSigner,
      seaportAddress,
    } = await loadFixture(deployFermionProtocolFixture));

    await loadFixture(setupCustodyTest);
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
      const wrapperAddress = await offerFacet.predictFermionWrapperAddress(exchange.tokenId);
      const wrapper = await ethers.getContractAt("FermionWrapper", wrapperAddress);
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
      const wrapperAddress = await offerFacet.predictFermionWrapperAddress(exchangeSelfSale.tokenId);
      const wrapper = await ethers.getContractAt("FermionWrapper", wrapperAddress);
      await expect(tx).to.emit(wrapper, "TokenStateChange").withArgs(exchangeSelfSale.tokenId, TokenState.CheckedIn);

      // State
      // Wrapper
      expect(await wrapper.tokenState(exchangeSelfSale.tokenId)).to.equal(TokenState.CheckedIn);
      expect(await wrapper.ownerOf(exchangeSelfSale.tokenId)).to.equal(defaultSigner.address);
    });

    it("Self custody", async function () {
      const tx = await custodyFacet.checkIn(exchangeSelfCustody.tokenId);

      // Events
      // Fermion
      await expect(tx).to.emit(custodyFacet, "CheckedIn").withArgs(sellerId, exchangeSelfCustody.tokenId);

      // Wrapper
      const wrapperAddress = await offerFacet.predictFermionWrapperAddress(exchangeSelfCustody.tokenId);
      const wrapper = await ethers.getContractAt("FermionWrapper", wrapperAddress);
      await expect(tx).to.emit(wrapper, "TokenStateChange").withArgs(exchangeSelfCustody.tokenId, TokenState.CheckedIn);

      // State
      // Wrapper
      expect(await wrapper.tokenState(exchangeSelfCustody.tokenId)).to.equal(TokenState.CheckedIn);
      expect(await wrapper.ownerOf(exchangeSelfCustody.tokenId)).to.equal(buyer.address);
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

        let wrapper: Contract;
        before(async function () {
          wrapper = await ethers.getContractAt("FermionWrapper", ZeroAddress);
        });

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
          await custodyFacet.connect(buyer).requestCheckOut(exchange.tokenId);

          await expect(custodyFacet.connect(custodian).checkIn(exchange.tokenId))
            .to.be.revertedWithCustomError(fermionErrors, "InvalidCheckoutRequestStatus")
            .withArgs(exchange.tokenId, CheckoutRequestStatus.None, CheckoutRequestStatus.CheckOutRequested);
        });
      });
    });
  });

  context("requestCheckOut", function () {
    before(async function () {});

    it("F-NFT Owner can request checkout", async function () {
      await custodyFacet.connect(custodian).checkIn(exchange.tokenId);

      const tx = await custodyFacet.connect(buyer).requestCheckOut(exchange.tokenId);

      // Events
      // Fermion
      await expect(tx)
        .to.emit(custodyFacet, "CheckoutRequested")
        .withArgs(exchange.custodianId, exchange.tokenId, sellerId, buyer.address);

      // Wrapper
      const wrapperAddress = await offerFacet.predictFermionWrapperAddress(exchange.tokenId);
      const wrapper = await ethers.getContractAt("FermionWrapper", wrapperAddress);
      await expect(tx).to.not.emit(wrapper, "TokenStateChange");

      // State
      // Wrapper
      expect(await wrapper.tokenState(exchange.tokenId)).to.equal(TokenState.CheckedIn);
      expect(await wrapper.ownerOf(exchange.tokenId)).to.equal(buyer.address);
    });

    it("Self sale", async function () {
      await custodyFacet.connect(custodian).checkIn(exchangeSelfSale.tokenId);

      const tx = await custodyFacet.requestCheckOut(exchangeSelfSale.tokenId);

      // Events
      // Fermion
      await expect(tx)
        .to.emit(custodyFacet, "CheckoutRequested")
        .withArgs(exchangeSelfSale.custodianId, exchangeSelfSale.tokenId, sellerId, defaultSigner.address);

      // Wrapper
      const wrapperAddress = await offerFacet.predictFermionWrapperAddress(exchangeSelfSale.tokenId);
      const wrapper = await ethers.getContractAt("FermionWrapper", wrapperAddress);
      await expect(tx).to.not.emit(wrapper, "TokenStateChange");

      // State
      // Wrapper
      expect(await wrapper.tokenState(exchangeSelfSale.tokenId)).to.equal(TokenState.CheckedIn);
      expect(await wrapper.ownerOf(exchangeSelfSale.tokenId)).to.equal(defaultSigner.address);
    });

    it("Self custody", async function () {
      await custodyFacet.checkIn(exchangeSelfCustody.tokenId);

      const tx = await custodyFacet.connect(buyer).requestCheckOut(exchangeSelfCustody.tokenId);

      // Events
      // Fermion
      await expect(tx)
        .to.emit(custodyFacet, "CheckoutRequested")
        .withArgs(sellerId, exchangeSelfCustody.tokenId, sellerId, buyer.address);

      // Wrapper
      const wrapperAddress = await offerFacet.predictFermionWrapperAddress(exchangeSelfCustody.tokenId);
      const wrapper = await ethers.getContractAt("FermionWrapper", wrapperAddress);
      await expect(tx).to.not.emit(wrapper, "TokenStateChange");

      // State
      // Wrapper
      expect(await wrapper.tokenState(exchangeSelfCustody.tokenId)).to.equal(TokenState.CheckedIn);
      expect(await wrapper.ownerOf(exchangeSelfCustody.tokenId)).to.equal(buyer.address);
    });

    context("Revert reasons", function () {
      it("Caller is not the buyer", async function () {
        await custodyFacet.connect(custodian).checkIn(exchange.tokenId);

        const wallet = wallets[9];

        // completely random wallet
        await expect(custodyFacet.connect(wallet).requestCheckOut(exchange.tokenId))
          .to.be.revertedWithCustomError(fermionErrors, "NotTokenOwner")
          .withArgs(exchange.tokenId, buyer.address, wallet.address);

        // seller
        await expect(custodyFacet.requestCheckOut(exchange.tokenId))
          .to.be.revertedWithCustomError(fermionErrors, "NotTokenOwner")
          .withArgs(exchange.tokenId, buyer.address, defaultSigner.address);

        // custodian
        await expect(custodyFacet.connect(custodian).requestCheckOut(exchange.tokenId))
          .to.be.revertedWithCustomError(fermionErrors, "NotTokenOwner")
          .withArgs(exchange.tokenId, buyer.address, custodian.address);
      });

      context("Invalid state", function () {
        const tokenId = deriveTokenId("3", "4"); // token that was wrapped but not unwrapped yet

        it("Cannot request check-out twice", async function () {
          await custodyFacet.connect(custodian).checkIn(exchange.tokenId);

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
          await offerFacet.unwrapNFTToSelf(tokenId);
          await verificationFacet.submitVerdict(tokenId, VerificationStatus.Verified);

          // Unwrapped but not verified
          await expect(custodyFacet.requestCheckOut(tokenId))
            .to.be.revertedWithCustomError(fermionErrors, "InvalidCheckoutRequestStatus")
            .withArgs(tokenId, CheckoutRequestStatus.CheckedIn, CheckoutRequestStatus.None);
        });
      });
    });
  });
});
