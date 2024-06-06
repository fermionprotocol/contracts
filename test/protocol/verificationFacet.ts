import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployFermionProtocolFixture, deployMockTokens, deriveTokenId } from "../utils/common";
import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, ZeroHash } from "ethers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { EntityRole, PausableRegion, TokenState, VerificationStatus, WalletRole } from "../utils/enums";
import { getBosonProtocolFees } from "../utils/boson-protocol";
import { getBosonHandler } from "../utils/boson-protocol";
import { createBuyerAdvancedOrderClosure } from "../utils/seaport";

const { parseEther } = ethers;

describe("Verification", function () {
  let offerFacet: Contract,
    entityFacet: Contract,
    verificationFacet: Contract,
    fundsFacet: Contract,
    pauseFacet: Contract;
  let mockToken: Contract;
  let fermionErrors: Contract;
  let fermionProtocolAddress: string;
  let wallets: HardhatEthersSigner[];
  let defaultSigner: HardhatEthersSigner;
  let verifier: HardhatEthersSigner;
  let buyer: HardhatEthersSigner;
  let seaportAddress: string;
  const sellerId = "1";
  const verifierId = "2";
  const verifierFee = parseEther("0.1");
  const sellerDeposit = parseEther("0.05");
  const exchange = { tokenId: "", verifierId: "", payout: 0n, offerId: "", exchangeId: "" };
  const exchangeSelfSale = { tokenId: "", verifierId: "", payout: 0n, offerId: "", exchangeId: "" };
  const exchangeSelfVerification = { tokenId: "", verifierId: "", payout: 0n, offerId: "", exchangeId: "" };

  async function setupVerificationTest() {
    // Create three entities
    // Seller, Verifier, Custodian combined
    // Verifier only
    // Custodian only
    const metadataURI = "https://example.com/seller-metadata.json";
    verifier = wallets[2];
    await entityFacet.createEntity([EntityRole.Seller, EntityRole.Verifier, EntityRole.Custodian], metadataURI); // "1"
    await entityFacet.connect(verifier).createEntity([EntityRole.Verifier], metadataURI); // "2"
    await entityFacet.connect(wallets[3]).createEntity([EntityRole.Custodian], metadataURI); // "3"

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

    // Make three offers one for normal sale, one of self sale and one for self verification
    const offerId = "1"; // buyer != seller, verifier != seller
    const offerIdSelfSale = "2"; // buyer = seller, verifier != seller
    const offerIdSelfVerification = "3"; // buyer != seller, verifier = seller
    await offerFacet.createOffer(fermionOffer);
    await offerFacet.createOffer({ ...fermionOffer, sellerDeposit: "0" });
    await offerFacet.createOffer({ ...fermionOffer, verifierId: "1", custodianId: "1", verifierFee: "0" });

    // Mint and wrap some NFTs
    const quantity = "1";
    await offerFacet.mintAndWrapNFTs(offerIdSelfSale, quantity); // offerId = 2; exchangeId = 1
    await offerFacet.mintAndWrapNFTs(offerId, quantity); // offerId = 1; exchangeId = 2
    await offerFacet.mintAndWrapNFTs(offerIdSelfVerification, "2"); // offerId = 3; exchangeId = 3
    const exchangeIdSelf = "1";
    const exchangeId = "2";
    const exchangeIdSelfVerification = "3";

    // Unwrap some NFTs - normal sale and sale with self-verification
    buyer = wallets[4];

    await mockToken.approve(fermionProtocolAddress, 2n * sellerDeposit); // approve to transfer seller deposit during the unwrapping
    const createBuyerAdvancedOrder = createBuyerAdvancedOrderClosure(wallets, seaportAddress, mockToken, offerFacet);
    const { buyerAdvancedOrder, tokenId, encumberedAmount } = await createBuyerAdvancedOrder(
      buyer,
      offerId,
      exchangeId,
    );
    await offerFacet.unwrapNFT(tokenId, buyerAdvancedOrder);

    const {
      buyerAdvancedOrder: buyerAdvancedOrderSelfVerification,
      tokenId: tokenIdSelfVerification,
      encumberedAmount: encumberedAmountSelfVerification,
    } = await createBuyerAdvancedOrder(buyer, offerIdSelfVerification, exchangeIdSelfVerification);
    await offerFacet.unwrapNFT(tokenIdSelfVerification, buyerAdvancedOrderSelfVerification);

    // unwrap to self
    const tokenIdSelf = deriveTokenId(offerIdSelfSale, exchangeIdSelf).toString();
    const { percentage: bosonProtocolFeePercentage } = getBosonProtocolFees();
    const minimalPrice = (10000n * verifierFee) / (10000n - BigInt(bosonProtocolFeePercentage));
    await mockToken.approve(fermionProtocolAddress, minimalPrice);
    await offerFacet.unwrapNFTToSelf(tokenIdSelf);

    exchange.offerId = offerId;
    exchange.exchangeId = exchangeId;
    exchange.tokenId = tokenId;
    exchange.verifierId = verifierId;
    exchange.payout =
      encumberedAmount - (encumberedAmount * BigInt(bosonProtocolFeePercentage)) / 10000n - verifierFee + sellerDeposit;

    // Self sale
    exchangeSelfSale.tokenId = tokenIdSelf;
    exchangeSelfSale.verifierId = verifierId;
    exchangeSelfSale.offerId = offerIdSelfSale;
    exchangeSelfSale.exchangeId = exchangeIdSelf;
    exchangeSelfSale.payout = 0n;

    // Self verification
    exchangeSelfVerification.tokenId = tokenIdSelfVerification;
    exchangeSelfVerification.verifierId = sellerId;
    exchangeSelfVerification.offerId = offerIdSelfVerification;
    exchangeSelfVerification.exchangeId = exchangeIdSelfVerification;
    exchangeSelfVerification.payout =
      encumberedAmountSelfVerification -
      (encumberedAmountSelfVerification * BigInt(bosonProtocolFeePercentage)) / 10000n +
      sellerDeposit;
  }

  before(async function () {
    ({
      diamondAddress: fermionProtocolAddress,
      facets: {
        EntityFacet: entityFacet,
        OfferFacet: offerFacet,
        VerificationFacet: verificationFacet,
        FundsFacet: fundsFacet,
        PauseFacet: pauseFacet,
      },
      fermionErrors,
      wallets,
      defaultSigner,
      seaportAddress,
    } = await loadFixture(deployFermionProtocolFixture));

    await loadFixture(setupVerificationTest);
  });

  afterEach(async function () {
    await loadFixture(setupVerificationTest);
  });

  context("submitVerdict", function () {
    let exchangeToken: string;
    const bosonBuyerId = "2"; // Fermion buyer id in Boson
    let bosonExchangeHandler: Contract;

    before(async function () {
      exchangeToken = await mockToken.getAddress();
      bosonExchangeHandler = await getBosonHandler("IBosonExchangeHandler");
    });

    context("Verified", function () {
      it("Normal sale", async function () {
        const tx = await verificationFacet
          .connect(verifier)
          .submitVerdict(exchange.tokenId, VerificationStatus.Verified);

        // Events
        // Fermion
        await expect(tx)
          .to.emit(verificationFacet, "VerdictSubmitted")
          .withArgs(exchange.verifierId, exchange.tokenId, VerificationStatus.Verified);
        await expect(tx)
          .to.emit(verificationFacet, "AvailableFundsIncreased")
          .withArgs(exchange.verifierId, exchangeToken, verifierFee);
        await expect(tx)
          .to.emit(verificationFacet, "AvailableFundsIncreased")
          .withArgs(sellerId, exchangeToken, exchange.payout);
        // ToDo: add fermion protocol fees test once they are implemented
        await expect(tx).to.not.emit(entityFacet, "EntityStored"); // no buyer is created in happy path

        // Wrapper
        const wrapperAddress = await offerFacet.predictFermionWrapperAddress(exchange.tokenId);
        const wrapper = await ethers.getContractAt("FermionFNFT", wrapperAddress);
        await expect(tx).to.emit(wrapper, "TokenStateChange").withArgs(exchange.tokenId, TokenState.Verified);

        // Boson
        await expect(tx)
          .to.emit(bosonExchangeHandler, "ExchangeCompleted")
          .withArgs(exchange.offerId, bosonBuyerId, exchange.exchangeId, fermionProtocolAddress);

        // State
        // Fermion
        // Available funds
        expect(await fundsFacet.getAvailableFunds(exchange.verifierId, exchangeToken)).to.equal(verifierFee);
        expect(await fundsFacet.getAvailableFunds(sellerId, exchangeToken)).to.equal(exchange.payout);
        expect(await fundsFacet.getAvailableFunds(0, exchangeToken)).to.equal(0); // fermion protocol fees

        // Wrapper
        expect(await wrapper.tokenState(exchange.tokenId)).to.equal(TokenState.Verified);
        expect(await wrapper.ownerOf(exchange.tokenId)).to.equal(buyer.address);
      });

      it("Self sale", async function () {
        const tx = await verificationFacet
          .connect(verifier)
          .submitVerdict(exchangeSelfSale.tokenId, VerificationStatus.Verified);

        // Events
        // Fermion
        await expect(tx)
          .to.emit(verificationFacet, "VerdictSubmitted")
          .withArgs(exchangeSelfSale.verifierId, exchangeSelfSale.tokenId, VerificationStatus.Verified);
        await expect(tx)
          .to.emit(verificationFacet, "AvailableFundsIncreased")
          .withArgs(exchangeSelfSale.verifierId, exchangeToken, verifierFee);
        // ToDo: add fermion protocol fees test once they are implemented
        await expect(tx).to.not.emit(entityFacet, "EntityStored"); // no buyer is created in happy path

        // Wrapper
        const wrapperAddress = await offerFacet.predictFermionWrapperAddress(exchangeSelfSale.tokenId);
        const wrapper = await ethers.getContractAt("FermionFNFT", wrapperAddress);
        await expect(tx).to.emit(wrapper, "TokenStateChange").withArgs(exchangeSelfSale.tokenId, TokenState.Verified);

        // Boson
        await expect(tx)
          .to.emit(bosonExchangeHandler, "ExchangeCompleted")
          .withArgs(exchangeSelfSale.offerId, bosonBuyerId, exchangeSelfSale.exchangeId, fermionProtocolAddress);

        // State
        // Fermion
        // Available funds
        expect(await fundsFacet.getAvailableFunds(exchangeSelfSale.verifierId, exchangeToken)).to.equal(verifierFee);
        expect(await fundsFacet.getAvailableFunds(sellerId, exchangeToken)).to.equal(0);
        expect(await fundsFacet.getAvailableFunds(0, exchangeToken)).to.equal(0); // fermion protocol fees

        // Wrapper
        expect(await wrapper.tokenState(exchangeSelfSale.tokenId)).to.equal(TokenState.Verified);
        expect(await wrapper.ownerOf(exchangeSelfSale.tokenId)).to.equal(defaultSigner.address);
      });

      it("Self verification", async function () {
        const tx = await verificationFacet.submitVerdict(exchangeSelfVerification.tokenId, VerificationStatus.Verified);

        // Events
        // Fermion
        await expect(tx)
          .to.emit(verificationFacet, "VerdictSubmitted")
          .withArgs(sellerId, exchangeSelfVerification.tokenId, VerificationStatus.Verified);
        await expect(tx)
          .to.emit(verificationFacet, "AvailableFundsIncreased")
          .withArgs(sellerId, exchangeToken, exchangeSelfVerification.payout);
        // ToDo: add fermion protocol fees test once they are implemented
        await expect(tx).to.not.emit(entityFacet, "EntityStored"); // no buyer is created in happy path

        // Wrapper
        const wrapperAddress = await offerFacet.predictFermionWrapperAddress(exchangeSelfVerification.tokenId);
        const wrapper = await ethers.getContractAt("FermionFNFT", wrapperAddress);
        await expect(tx)
          .to.emit(wrapper, "TokenStateChange")
          .withArgs(exchangeSelfVerification.tokenId, TokenState.Verified);

        // Boson
        await expect(tx)
          .to.emit(bosonExchangeHandler, "ExchangeCompleted")
          .withArgs(
            exchangeSelfVerification.offerId,
            bosonBuyerId,
            exchangeSelfVerification.exchangeId,
            fermionProtocolAddress,
          );

        // State
        // Fermion
        // Available funds
        expect(await fundsFacet.getAvailableFunds(sellerId, exchangeToken)).to.equal(exchangeSelfVerification.payout);
        expect(await fundsFacet.getAvailableFunds(0, exchangeToken)).to.equal(0); // fermion protocol fees

        // Wrapper
        expect(await wrapper.tokenState(exchangeSelfVerification.tokenId)).to.equal(TokenState.Verified);
        expect(await wrapper.ownerOf(exchangeSelfVerification.tokenId)).to.equal(buyer.address);
      });
    });

    context("Rejected", function () {
      const buyerId = "4"; // new buyer in fermion
      it("Normal sale", async function () {
        const tx = await verificationFacet
          .connect(verifier)
          .submitVerdict(exchange.tokenId, VerificationStatus.Rejected);

        // Events
        // Fermion
        await expect(tx)
          .to.emit(verificationFacet, "VerdictSubmitted")
          .withArgs(exchange.verifierId, exchange.tokenId, VerificationStatus.Rejected);
        await expect(tx)
          .to.emit(verificationFacet, "AvailableFundsIncreased")
          .withArgs(exchange.verifierId, exchangeToken, verifierFee);
        await expect(tx)
          .to.emit(verificationFacet, "AvailableFundsIncreased")
          .withArgs(buyerId, exchangeToken, exchange.payout);
        // ToDo: add fermion protocol fees test once they are implemented
        await expect(tx).to.emit(entityFacet, "EntityStored").withArgs(buyerId, buyer.address, [EntityRole.Buyer], "");

        // Wrapper
        const wrapperAddress = await offerFacet.predictFermionWrapperAddress(exchange.tokenId);
        const wrapper = await ethers.getContractAt("FermionFNFT", wrapperAddress);
        await expect(tx).to.emit(wrapper, "TokenStateChange").withArgs(exchange.tokenId, TokenState.Burned);

        // Boson
        await expect(tx)
          .to.emit(bosonExchangeHandler, "ExchangeCompleted")
          .withArgs(exchange.offerId, bosonBuyerId, exchange.exchangeId, fermionProtocolAddress);

        // State
        // Fermion
        // Available funds
        expect(await fundsFacet.getAvailableFunds(exchange.verifierId, exchangeToken)).to.equal(verifierFee);
        expect(await fundsFacet.getAvailableFunds(buyerId, exchangeToken)).to.equal(exchange.payout);
        expect(await fundsFacet.getAvailableFunds(sellerId, exchangeToken)).to.equal(0n);
        expect(await fundsFacet.getAvailableFunds(0, exchangeToken)).to.equal(0); // fermion protocol fees

        // Wrapper
        expect(await wrapper.tokenState(exchange.tokenId)).to.equal(TokenState.Burned);
        await expect(wrapper.ownerOf(exchange.tokenId))
          .to.be.revertedWithCustomError(wrapper, "ERC721NonexistentToken")
          .withArgs(exchange.tokenId);
      });

      it("Self sale", async function () {
        const tx = await verificationFacet
          .connect(verifier)
          .submitVerdict(exchangeSelfSale.tokenId, VerificationStatus.Rejected);

        // Events
        // Fermion
        await expect(tx)
          .to.emit(verificationFacet, "VerdictSubmitted")
          .withArgs(exchangeSelfSale.verifierId, exchangeSelfSale.tokenId, VerificationStatus.Rejected);
        await expect(tx)
          .to.emit(verificationFacet, "AvailableFundsIncreased")
          .withArgs(exchangeSelfSale.verifierId, exchangeToken, verifierFee);
        // ToDo: add fermion protocol fees test once they are implemented
        await expect(tx).to.not.emit(entityFacet, "EntityStored"); // no buyer is created, since the entity exist already

        // Wrapper
        const wrapperAddress = await offerFacet.predictFermionWrapperAddress(exchangeSelfSale.tokenId);
        const wrapper = await ethers.getContractAt("FermionFNFT", wrapperAddress);
        await expect(tx).to.emit(wrapper, "TokenStateChange").withArgs(exchangeSelfSale.tokenId, TokenState.Burned);

        // Boson
        await expect(tx)
          .to.emit(bosonExchangeHandler, "ExchangeCompleted")
          .withArgs(exchangeSelfSale.offerId, bosonBuyerId, exchangeSelfSale.exchangeId, fermionProtocolAddress);

        // State
        // Fermion
        // Available funds
        expect(await fundsFacet.getAvailableFunds(exchangeSelfSale.verifierId, exchangeToken)).to.equal(verifierFee);
        expect(await fundsFacet.getAvailableFunds(sellerId, exchangeToken)).to.equal(0);
        expect(await fundsFacet.getAvailableFunds(0, exchangeToken)).to.equal(0); // fermion protocol fees

        // Wrapper
        expect(await wrapper.tokenState(exchangeSelfSale.tokenId)).to.equal(TokenState.Burned);
        await expect(wrapper.ownerOf(exchangeSelfSale.tokenId))
          .to.be.revertedWithCustomError(wrapper, "ERC721NonexistentToken")
          .withArgs(exchangeSelfSale.tokenId);
      });

      it("Self verification", async function () {
        const tx = await verificationFacet.submitVerdict(exchangeSelfVerification.tokenId, VerificationStatus.Rejected);

        // Events
        // Fermion
        await expect(tx)
          .to.emit(verificationFacet, "VerdictSubmitted")
          .withArgs(sellerId, exchangeSelfVerification.tokenId, VerificationStatus.Rejected);
        await expect(tx)
          .to.emit(verificationFacet, "AvailableFundsIncreased")
          .withArgs(buyerId, exchangeToken, exchangeSelfVerification.payout);
        // ToDo: add fermion protocol fees test once they are implemented
        await expect(tx).to.emit(entityFacet, "EntityStored").withArgs(buyerId, buyer.address, [EntityRole.Buyer], "");

        // Wrapper
        const wrapperAddress = await offerFacet.predictFermionWrapperAddress(exchangeSelfVerification.tokenId);
        const wrapper = await ethers.getContractAt("FermionFNFT", wrapperAddress);
        await expect(tx)
          .to.emit(wrapper, "TokenStateChange")
          .withArgs(exchangeSelfVerification.tokenId, TokenState.Burned);

        // Boson
        await expect(tx)
          .to.emit(bosonExchangeHandler, "ExchangeCompleted")
          .withArgs(
            exchangeSelfVerification.offerId,
            bosonBuyerId,
            exchangeSelfVerification.exchangeId,
            fermionProtocolAddress,
          );

        // State
        // Fermion
        // Available funds
        expect(await fundsFacet.getAvailableFunds(buyerId, exchangeToken)).to.equal(exchangeSelfVerification.payout);
        expect(await fundsFacet.getAvailableFunds(sellerId, exchangeToken)).to.equal(0n);
        expect(await fundsFacet.getAvailableFunds(0, exchangeToken)).to.equal(0); // fermion protocol fees

        // Wrapper
        expect(await wrapper.tokenState(exchangeSelfVerification.tokenId)).to.equal(TokenState.Burned);
        await expect(wrapper.ownerOf(exchangeSelfVerification.tokenId))
          .to.be.revertedWithCustomError(wrapper, "ERC721NonexistentToken")
          .withArgs(exchangeSelfVerification.tokenId);
      });

      it("If buyer exists, it's not created anew and funds are added", async function () {
        await expect(verificationFacet.connect(verifier).submitVerdict(exchange.tokenId, VerificationStatus.Rejected))
          .to.emit(entityFacet, "EntityStored")
          .withArgs(buyerId, buyer.address, [EntityRole.Buyer], "");

        expect(await fundsFacet.getAvailableFunds(buyerId, exchangeToken)).to.equal(exchange.payout);

        await expect(
          verificationFacet.submitVerdict(exchangeSelfVerification.tokenId, VerificationStatus.Rejected),
        ).to.not.emit(entityFacet, "EntityStored");

        expect(await fundsFacet.getAvailableFunds(buyerId, exchangeToken)).to.equal(
          exchange.payout + exchangeSelfVerification.payout,
        );
      });
    });

    context("Revert reasons", function () {
      it("Verification region is paused", async function () {
        await pauseFacet.pause([PausableRegion.Verification]);

        await expect(verificationFacet.submitVerdict(exchange.tokenId, VerificationStatus.Verified))
          .to.be.revertedWithCustomError(fermionErrors, "RegionPaused")
          .withArgs(PausableRegion.Verification);
      });

      it("Caller is not the verifiers's assistant", async function () {
        const wallet = wallets[9];

        // completely random wallet
        await expect(verificationFacet.connect(wallet).submitVerdict(exchange.tokenId, VerificationStatus.Verified))
          .to.be.revertedWithCustomError(fermionErrors, "WalletHasNoRole")
          .withArgs(verifierId, wallet.address, EntityRole.Verifier, WalletRole.Assistant);

        // seller
        await expect(verificationFacet.submitVerdict(exchange.tokenId, VerificationStatus.Verified))
          .to.be.revertedWithCustomError(fermionErrors, "WalletHasNoRole")
          .withArgs(verifierId, defaultSigner.address, EntityRole.Verifier, WalletRole.Assistant);

        // an entity-wide Treasury or admin wallet (not Assistant)
        await entityFacet
          .connect(verifier)
          .addEntityWallets(verifierId, [wallet], [[]], [[[WalletRole.Treasury, WalletRole.Admin]]]);
        await expect(verificationFacet.connect(wallet).submitVerdict(exchange.tokenId, VerificationStatus.Verified))
          .to.be.revertedWithCustomError(fermionErrors, "WalletHasNoRole")
          .withArgs(verifierId, wallet.address, EntityRole.Verifier, WalletRole.Assistant);

        // a Verifier specific Treasury or Admin wallet
        const wallet2 = wallets[10];
        await entityFacet
          .connect(verifier)
          .addEntityWallets(
            verifierId,
            [wallet2],
            [[EntityRole.Verifier]],
            [[[WalletRole.Treasury, WalletRole.Admin]]],
          );
        await expect(verificationFacet.connect(wallet2).submitVerdict(exchange.tokenId, VerificationStatus.Verified))
          .to.be.revertedWithCustomError(fermionErrors, "WalletHasNoRole")
          .withArgs(verifierId, wallet2.address, EntityRole.Verifier, WalletRole.Assistant);

        // an Assistant of another role than Verifier
        await entityFacet.connect(verifier).updateEntity(verifierId, [EntityRole.Verifier, EntityRole.Custodian], "");
        await entityFacet
          .connect(verifier)
          .addEntityWallets(verifierId, [wallet2], [[EntityRole.Custodian]], [[[WalletRole.Assistant]]]);
        await expect(verificationFacet.connect(wallet2).submitVerdict(exchange.tokenId, VerificationStatus.Verified))
          .to.be.revertedWithCustomError(fermionErrors, "WalletHasNoRole")
          .withArgs(verifierId, wallet2.address, EntityRole.Verifier, WalletRole.Assistant);
      });

      it("Cannot verify twice", async function () {
        await verificationFacet.connect(verifier).submitVerdict(exchange.tokenId, VerificationStatus.Verified);

        await expect(
          verificationFacet.connect(verifier).submitVerdict(exchange.tokenId, VerificationStatus.Verified),
        ).to.be.revertedWithCustomError(bosonExchangeHandler, "InvalidState");
      });

      it("Cannot verify before it's unwrapped", async function () {
        const tokenId = deriveTokenId("3", "4"); // token that was wrapped but not unwrapped yet

        await expect(
          verificationFacet.submitVerdict(tokenId, VerificationStatus.Verified),
        ).to.be.revertedWithCustomError(bosonExchangeHandler, "NoSuchExchange");
      });
    });
  });
});
