import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import {
  deployFermionProtocolFixture,
  deployMockTokens,
  deriveTokenId,
  applyPercentage,
  setNextBlockTimestamp,
  verifySellerAssistantRoleClosure,
  calculateMinimalPrice,
} from "../utils/common";
import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, ZeroHash, parseEther, keccak256, id, toBeHex, MaxUint256 } from "ethers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { EntityRole, PausableRegion, TokenState, VerificationStatus, AccountRole, WrapType } from "../utils/enums";
import { getBosonProtocolFees } from "../utils/boson-protocol";
import { getBosonHandler } from "../utils/boson-protocol";
import { createBuyerAdvancedOrderClosure } from "../utils/seaport";
import fermionConfig from "./../../fermion.config";
import { prepareDataSignatureParameters } from "../../scripts/libraries/metaTransaction";

const abiCoder = new ethers.AbiCoder();

describe("Verification", function () {
  let offerFacet: Contract,
    entityFacet: Contract,
    verificationFacet: Contract,
    fundsFacet: Contract,
    pauseFacet: Contract,
    custodyFacet: Contract,
    configFacet: Contract;
  let mockToken: Contract;
  let mockPhygital1: Contract, mockPhygital2: Contract;
  let fermionErrors: Contract;
  let fermionProtocolAddress: string;
  let wallets: HardhatEthersSigner[];
  let defaultSigner: HardhatEthersSigner;
  let verifier: HardhatEthersSigner, custodian: HardhatEthersSigner;
  let buyer: HardhatEthersSigner;
  let seaportAddress: string;
  let exchangeToken: string;
  let verifySellerAssistantRole: ReturnType<typeof verifySellerAssistantRoleClosure>;
  const bosonBuyerId = "2"; // Fermion buyer id in Boson
  let bosonExchangeHandler: Contract;
  const protocolId = "0";
  const sellerId = "1";
  const verifierId = "2";
  const facilitatorId = "4";
  const verifierFee = parseEther("0.1");
  const facilitatorFeePercent = 200n; // 2%
  const sellerDeposit = parseEther("0.05");
  const exchange = {
    tokenId: "",
    verifierId: "",
    payout: { remainder: 0n, fermionFeeAmount: 0n, facilitatorFeeAmount: 0n },
    offerId: "",
    exchangeId: "",
    encumberedAmount: 0n,
  };
  const exchangeSelfSale = {
    tokenId: "",
    verifierId: "",
    payout: { remainder: 0n, fermionFeeAmount: 0n, facilitatorFeeAmount: 0n },
    offerId: "",
    exchangeId: "",
  };
  const exchangeSelfVerification = {
    tokenId: "",
    verifierId: "",
    payout: { remainder: 0n, fermionFeeAmount: 0n, facilitatorFeeAmount: 0n },
    offerId: "",
    exchangeId: "",
  };
  const exchangeSelfSaleSelfVerification = {
    tokenId: "",
    verifierId: "",
    payout: { remainder: 0n, fermionFeeAmount: 0n, facilitatorFeeAmount: 0n },
    offerId: "",
    exchangeId: "",
  };

  let itemVerificationTimeout: string;
  let itemMaxVerificationTimeout: bigint;
  const { protocolFeePercentage: bosonProtocolFeePercentage } = getBosonProtocolFees();
  const defaultFermionFee = BigInt(fermionConfig.protocolParameters.protocolFeePercentage);

  async function setupVerificationTest() {
    // Create three entities
    // Seller, Verifier, Custodian combined
    // Verifier only
    // Custodian only
    const metadataURI = "https://example.com/seller-metadata.json";
    verifier = wallets[2];
    custodian = wallets[3];
    await entityFacet.createEntity([EntityRole.Seller, EntityRole.Verifier, EntityRole.Custodian], metadataURI); // "1"
    await entityFacet.connect(verifier).createEntity([EntityRole.Verifier], metadataURI); // "2"
    await entityFacet.connect(custodian).createEntity([EntityRole.Custodian], metadataURI); // "3"
    await entityFacet.connect(wallets[4]).createEntity([EntityRole.Seller], metadataURI); // "4" // facilitator
    await entityFacet.addFacilitators(sellerId, [facilitatorId]);

    [mockToken, mockPhygital1, mockPhygital2] = (await deployMockTokens(["ERC20", "ERC721", "ERC721"])).map(
      (contract) => contract.connect(defaultSigner),
    );
    await mockToken.mint(defaultSigner.address, parseEther("1000"));

    await offerFacet.addSupportedToken(await mockToken.getAddress());

    // Create offer
    const fermionOffer = {
      sellerId,
      sellerDeposit,
      verifierId,
      verifierFee,
      custodianId: "3",
      custodianFee: {
        amount: parseEther("0.05"),
        period: 30n * 24n * 60n * 60n, // 30 days
      },
      facilitatorId: sellerId,
      facilitatorFeePercent: "0",
      exchangeToken: await mockToken.getAddress(),
      withPhygital: false,
      metadataURI: "https://example.com/offer-metadata.json",
      metadataHash: ZeroHash,
    };

    // Make three offers one for normal sale, one of self sale and one for self verification
    // Normal sale has non-zero facilitator fee
    const offerId = "1"; // buyer != seller, verifier != seller
    const offerIdSelfSale = "2"; // buyer = seller, verifier != seller
    const offerIdSelfVerification = "3"; // buyer != seller, verifier = seller
    const offerIdSelfSaleSelfVerification = "4"; // buyer = seller, verifier = seller
    await offerFacet.createOffer({ ...fermionOffer, withPhygital: true, facilitatorId, facilitatorFeePercent });
    await offerFacet.createOffer({ ...fermionOffer, sellerDeposit: "0" });
    await offerFacet.createOffer({ ...fermionOffer, verifierId: "1", custodianId: "1", verifierFee: "0" });
    await offerFacet.createOffer({
      ...fermionOffer,
      sellerDeposit: "0",
      verifierId: "1",
      custodianId: "1",
      verifierFee: "0",
    });

    // Mint and wrap some NFTs
    const quantity = "1";
    await offerFacet.mintAndWrapNFTs(offerIdSelfSale, quantity); // offerId = 2; exchangeId = 1
    await offerFacet.mintAndWrapNFTs(offerId, quantity); // offerId = 1; exchangeId = 2
    await offerFacet.mintAndWrapNFTs(offerIdSelfVerification, "2"); // offerId = 3; exchangeId = 3
    await offerFacet.mintAndWrapNFTs(offerIdSelfSaleSelfVerification, quantity); // offerId = 4; exchangeId = 5
    const exchangeIdSelf = "1";
    const exchangeId = "2";
    const exchangeIdSelfVerification = "3";
    const exchangeIdSelfSaleSelfVerification = "5";

    // Unwrap some NFTs - normal sale and sale with self-verification
    buyer = wallets[5];

    await mockToken.approve(fermionProtocolAddress, 2n * sellerDeposit); // approve to transfer seller deposit during the unwrapping
    const createBuyerAdvancedOrder = createBuyerAdvancedOrderClosure(wallets, seaportAddress, mockToken, offerFacet);
    const { buyerAdvancedOrder, tokenId, encumberedAmount } = await createBuyerAdvancedOrder(
      buyer,
      offerId,
      exchangeId,
    );
    await offerFacet.unwrapNFT(tokenId, WrapType.OS_AUCTION, buyerAdvancedOrder);

    const {
      buyerAdvancedOrder: buyerAdvancedOrderSelfVerification,
      tokenId: tokenIdSelfVerification,
      encumberedAmount: encumberedAmountSelfVerification,
    } = await createBuyerAdvancedOrder(buyer, offerIdSelfVerification, exchangeIdSelfVerification);
    await offerFacet.unwrapNFT(tokenIdSelfVerification, WrapType.OS_AUCTION, buyerAdvancedOrderSelfVerification);

    const feeRanges = [parseEther("1").toString(), parseEther("5").toString(), parseEther("10").toString()];
    const feePercentages = [750, 1000, 1500]; // 7.5%, 10%, 15%
    // Set the protocol FeeTable for the exchange token
    await configFacet.setProtocolFeeTable(await mockToken.getAddress(), feeRanges, feePercentages);

    // unwrap to self #1
    const selfSaleFermionPercentage = BigInt(feePercentages[0]); // 7.5%
    const tokenIdSelf = deriveTokenId(offerIdSelfSale, exchangeIdSelf).toString();
    const { protocolFeePercentage: bosonProtocolFeePercentage } = getBosonProtocolFees();
    const minimalPrice = calculateMinimalPrice(
      verifierFee,
      fermionOffer.facilitatorFeePercent,
      bosonProtocolFeePercentage,
      selfSaleFermionPercentage,
    );
    await mockToken.approve(fermionProtocolAddress, minimalPrice);
    const customItemPrice = 1;
    let selfSaleData = ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256", "uint256"],
      [minimalPrice, customItemPrice],
    );
    await offerFacet.unwrapNFT(tokenIdSelf, WrapType.SELF_SALE, selfSaleData);

    // unwrap to self #2
    const tokenIdSelfSaleSelfVerification = deriveTokenId(
      offerIdSelfSaleSelfVerification,
      exchangeIdSelfSaleSelfVerification,
    ).toString();
    const minimalPriceSelfVerification = calculateMinimalPrice(
      0,
      fermionOffer.facilitatorFeePercent,
      bosonProtocolFeePercentage,
      defaultFermionFee,
    );
    selfSaleData = ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256", "uint256"],
      [minimalPriceSelfVerification, customItemPrice],
    );
    const tx = await offerFacet.unwrapNFT(tokenIdSelfSaleSelfVerification, WrapType.SELF_SALE, selfSaleData);
    const timestamp = BigInt((await tx.getBlock()).timestamp);
    itemVerificationTimeout = String(timestamp + fermionConfig.protocolParameters.defaultVerificationTimeout);
    itemMaxVerificationTimeout = timestamp + fermionConfig.protocolParameters.maxVerificationTimeout;

    exchange.offerId = offerId;
    exchange.exchangeId = exchangeId;
    exchange.tokenId = tokenId;
    exchange.verifierId = verifierId;
    exchange.payout = payoutFeeCalculation(
      encumberedAmount,
      bosonProtocolFeePercentage,
      verifierFee,
      facilitatorFeePercent,
      sellerDeposit,
      defaultFermionFee,
    );
    exchange.encumberedAmount = encumberedAmount;

    // Self sale
    exchangeSelfSale.tokenId = tokenIdSelf;
    exchangeSelfSale.verifierId = verifierId;
    exchangeSelfSale.offerId = offerIdSelfSale;
    exchangeSelfSale.exchangeId = exchangeIdSelf;
    exchangeSelfSale.payout = payoutFeeCalculation(
      minimalPrice,
      bosonProtocolFeePercentage,
      verifierFee,
      0n,
      0n,
      selfSaleFermionPercentage,
    );

    // Self verification
    exchangeSelfVerification.tokenId = tokenIdSelfVerification;
    exchangeSelfVerification.verifierId = sellerId;
    exchangeSelfVerification.offerId = offerIdSelfVerification;
    exchangeSelfVerification.exchangeId = exchangeIdSelfVerification;
    exchangeSelfVerification.payout = payoutFeeCalculation(
      encumberedAmountSelfVerification,
      bosonProtocolFeePercentage,
      0n,
      0n,
      sellerDeposit,
      defaultFermionFee,
    );

    // Self sale and self verification
    exchangeSelfSaleSelfVerification.tokenId = tokenIdSelfSaleSelfVerification;
    exchangeSelfSaleSelfVerification.verifierId = sellerId;
    exchangeSelfSaleSelfVerification.offerId = offerIdSelfSaleSelfVerification;
    exchangeSelfSaleSelfVerification.exchangeId = exchangeIdSelfSaleSelfVerification;

    exchangeToken = await mockToken.getAddress();
    bosonExchangeHandler = await getBosonHandler("IBosonExchangeHandler");

    // reset the protocol fee table
    await configFacet.setProtocolFeeTable(await mockToken.getAddress(), [], []);
  }

  function payoutFeeCalculation(
    escrowAmount: bigint,
    bosonProtocolFeePercentage: number,
    verifierFee: bigint,
    facilitatorFeePercent: bigint,
    sellerDeposit: bigint = 0n,
    fermionFeePercentage: bigint,
    revisedBuyerPercentage: bigint = 0n,
  ) {
    const bosonFeeAmount = applyPercentage(escrowAmount, bosonProtocolFeePercentage);
    const revisedBuyerPayout = applyPercentage(escrowAmount, revisedBuyerPercentage);
    escrowAmount -= revisedBuyerPayout;
    const fermionFeeAmount = applyPercentage(escrowAmount, fermionFeePercentage);
    const facilitatorFeeAmount = applyPercentage(escrowAmount, facilitatorFeePercent);
    const feeSum = bosonFeeAmount + fermionFeeAmount + facilitatorFeeAmount + verifierFee;
    const remainder = escrowAmount + sellerDeposit - feeSum;

    return { remainder, fermionFeeAmount, facilitatorFeeAmount, revisedBuyerPayout };
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
        CustodyFacet: custodyFacet,
        ConfigFacet: configFacet,
      },
      fermionErrors,
      wallets,
      defaultSigner,
      seaportAddress,
    } = await loadFixture(deployFermionProtocolFixture));

    await loadFixture(setupVerificationTest);

    verifySellerAssistantRole = verifySellerAssistantRoleClosure(
      verificationFacet,
      wallets,
      entityFacet,
      fermionErrors,
    );
  });

  afterEach(async function () {
    await loadFixture(setupVerificationTest);
  });

  context("submitVerdict", function () {
    context("Verified", function () {
      it("Normal sale", async function () {
        const digest = ethers.keccak256(abiCoder.encode(["tuple(address,uint256)[]"], [[]]));
        await verificationFacet.connect(verifier).verifyPhygitals(exchange.tokenId, digest);

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
          .withArgs(facilitatorId, exchangeToken, exchange.payout.facilitatorFeeAmount);
        await expect(tx)
          .to.emit(verificationFacet, "AvailableFundsIncreased")
          .withArgs(sellerId, exchangeToken, exchange.payout.remainder);
        await expect(tx)
          .to.emit(verificationFacet, "AvailableFundsIncreased")
          .withArgs(protocolId, exchangeToken, exchange.payout.fermionFeeAmount);
        await expect(tx).to.not.emit(entityFacet, "EntityStored"); // no buyer is created in happy path

        // Wrapper
        const wrapperAddress = await offerFacet.predictFermionFNFTAddress(exchange.offerId);
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
        expect(await fundsFacet.getAvailableFunds(facilitatorId, exchangeToken)).to.equal(
          exchange.payout.facilitatorFeeAmount,
        );
        expect(await fundsFacet.getAvailableFunds(sellerId, exchangeToken)).to.equal(exchange.payout.remainder);
        expect(await fundsFacet.getAvailableFunds(protocolId, exchangeToken)).to.equal(
          exchange.payout.fermionFeeAmount,
        ); // fermion protocol fees

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
        await expect(tx).to.not.emit(entityFacet, "EntityStored"); // no buyer is created in happy path
        await expect(tx)
          .to.emit(verificationFacet, "AvailableFundsIncreased")
          .withArgs(protocolId, exchangeToken, exchangeSelfSale.payout.fermionFeeAmount);

        // Wrapper
        const wrapperAddress = await offerFacet.predictFermionFNFTAddress(exchangeSelfSale.offerId);
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
        expect(await fundsFacet.getAvailableFunds(facilitatorId, exchangeToken)).to.equal(0);
        expect(await fundsFacet.getAvailableFunds(sellerId, exchangeToken)).to.equal(0);
        expect(await fundsFacet.getAvailableFunds(protocolId, exchangeToken)).to.equal(
          exchangeSelfSale.payout.fermionFeeAmount,
        );

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
          .withArgs(sellerId, exchangeToken, exchangeSelfVerification.payout.remainder);
        await expect(tx)
          .to.emit(verificationFacet, "AvailableFundsIncreased")
          .withArgs(protocolId, exchangeToken, exchangeSelfVerification.payout.fermionFeeAmount);
        await expect(tx).to.not.emit(entityFacet, "EntityStored"); // no buyer is created in happy path

        // Wrapper
        const wrapperAddress = await offerFacet.predictFermionFNFTAddress(exchangeSelfVerification.offerId);
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
        expect(await fundsFacet.getAvailableFunds(sellerId, exchangeToken)).to.equal(
          exchangeSelfVerification.payout.remainder,
        );
        expect(await fundsFacet.getAvailableFunds(facilitatorId, exchangeToken)).to.equal(
          exchangeSelfVerification.payout.facilitatorFeeAmount,
        );
        expect(await fundsFacet.getAvailableFunds(protocolId, exchangeToken)).to.equal(
          exchangeSelfVerification.payout.fermionFeeAmount,
        );

        // Wrapper
        expect(await wrapper.tokenState(exchangeSelfVerification.tokenId)).to.equal(TokenState.Verified);
        expect(await wrapper.ownerOf(exchangeSelfVerification.tokenId)).to.equal(buyer.address);
      });

      it("Self sale, self verification", async function () {
        const tx = await verificationFacet.submitVerdict(
          exchangeSelfSaleSelfVerification.tokenId,
          VerificationStatus.Verified,
        );

        // Events
        // Fermion
        await expect(tx)
          .to.emit(verificationFacet, "VerdictSubmitted")
          .withArgs(sellerId, exchangeSelfSaleSelfVerification.tokenId, VerificationStatus.Verified);
        await expect(tx).to.not.emit(verificationFacet, "AvailableFundsIncreased");
        await expect(tx).to.not.emit(entityFacet, "EntityStored"); // no buyer is created in happy path

        // Wrapper
        const wrapperAddress = await offerFacet.predictFermionFNFTAddress(exchangeSelfSaleSelfVerification.offerId);
        const wrapper = await ethers.getContractAt("FermionFNFT", wrapperAddress);
        await expect(tx)
          .to.emit(wrapper, "TokenStateChange")
          .withArgs(exchangeSelfSaleSelfVerification.tokenId, TokenState.Verified);

        // Boson
        await expect(tx)
          .to.emit(bosonExchangeHandler, "ExchangeCompleted")
          .withArgs(
            exchangeSelfSaleSelfVerification.offerId,
            bosonBuyerId,
            exchangeSelfSaleSelfVerification.exchangeId,
            fermionProtocolAddress,
          );

        // State
        // Fermion
        // Available funds
        expect(await fundsFacet.getAvailableFunds(sellerId, exchangeToken)).to.equal(
          exchangeSelfSaleSelfVerification.payout.remainder,
        );
        expect(await fundsFacet.getAvailableFunds(facilitatorId, exchangeToken)).to.equal(
          exchangeSelfSaleSelfVerification.payout.facilitatorFeeAmount,
        );
        expect(await fundsFacet.getAvailableFunds(protocolId, exchangeToken)).to.equal(
          exchangeSelfSaleSelfVerification.payout.fermionFeeAmount,
        );

        // Wrapper
        expect(await wrapper.tokenState(exchangeSelfSaleSelfVerification.tokenId)).to.equal(TokenState.Verified);
        expect(await wrapper.ownerOf(exchangeSelfSaleSelfVerification.tokenId)).to.equal(defaultSigner.address);
      });

      it("Can verify after after the timeout if the timeout was not called yet ", async function () {
        const digest = ethers.keccak256(abiCoder.encode(["tuple(address,uint256)[]"], [[]]));
        await verificationFacet.connect(verifier).verifyPhygitals(exchange.tokenId, digest);

        await setNextBlockTimestamp(itemVerificationTimeout);

        await expect(verificationFacet.connect(verifier).submitVerdict(exchange.tokenId, VerificationStatus.Verified))
          .to.emit(verificationFacet, "VerdictSubmitted")
          .withArgs(exchange.verifierId, exchange.tokenId, VerificationStatus.Verified);
      });
    });

    context("Rejected", function () {
      const buyerId = "5"; // new buyer in fermion
      it("Normal sale - verified phygitals", async function () {
        const digest = ethers.keccak256(abiCoder.encode(["tuple(address,uint256)[]"], [[]]));
        await verificationFacet.connect(verifier).verifyPhygitals(exchange.tokenId, digest);

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
          .withArgs(buyerId, exchangeToken, exchange.payout.remainder + exchange.payout.facilitatorFeeAmount); // buyer gets the remainder and facilitator fee back
        await expect(tx)
          .to.emit(verificationFacet, "AvailableFundsIncreased")
          .withArgs(protocolId, exchangeToken, exchange.payout.fermionFeeAmount);

        // Wrapper
        const wrapperAddress = await offerFacet.predictFermionFNFTAddress(exchange.offerId);
        const wrapper = await ethers.getContractAt("FermionFNFT", wrapperAddress);
        await expect(tx).to.emit(wrapper, "TokenStateChange").withArgs(exchange.tokenId, TokenState.Burned);
        await expect(tx).to.not.emit(wrapper, "FixedPriceSale");

        // Boson
        await expect(tx)
          .to.emit(bosonExchangeHandler, "ExchangeCompleted")
          .withArgs(exchange.offerId, bosonBuyerId, exchange.exchangeId, fermionProtocolAddress);

        // State
        // Fermion
        // Available funds
        expect(await fundsFacet.getAvailableFunds(exchange.verifierId, exchangeToken)).to.equal(verifierFee);
        expect(await fundsFacet.getAvailableFunds(facilitatorId, exchangeToken)).to.equal(0n); // facilitator not paid if rejected
        expect(await fundsFacet.getAvailableFunds(buyerId, exchangeToken)).to.equal(
          exchange.payout.remainder + exchange.payout.facilitatorFeeAmount,
        );
        expect(await fundsFacet.getAvailableFunds(sellerId, exchangeToken)).to.equal(0n);
        expect(await fundsFacet.getAvailableFunds(protocolId, exchangeToken)).to.equal(
          exchange.payout.fermionFeeAmount,
        );

        // Wrapper
        expect(await wrapper.tokenState(exchange.tokenId)).to.equal(TokenState.Burned);
        await expect(wrapper.ownerOf(exchange.tokenId))
          .to.be.revertedWithCustomError(wrapper, "ERC721NonexistentToken")
          .withArgs(exchange.tokenId);
      });

      it("Normal sale - unverified phygitals", async function () {
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
          .withArgs(buyerId, exchangeToken, exchange.payout.remainder + exchange.payout.facilitatorFeeAmount); // buyer gets the remainder and facilitator fee back
        await expect(tx)
          .to.emit(verificationFacet, "AvailableFundsIncreased")
          .withArgs(protocolId, exchangeToken, exchange.payout.fermionFeeAmount);
        await expect(tx).to.emit(entityFacet, "EntityStored").withArgs(buyerId, buyer.address, [EntityRole.Buyer], "");

        // Wrapper
        const wrapperAddress = await offerFacet.predictFermionFNFTAddress(exchange.offerId);
        const wrapper = await ethers.getContractAt("FermionFNFT", wrapperAddress);
        await expect(tx).to.emit(wrapper, "TokenStateChange").withArgs(exchange.tokenId, TokenState.Burned);
        await expect(tx).to.not.emit(wrapper, "FixedPriceSale");

        // Boson
        await expect(tx)
          .to.emit(bosonExchangeHandler, "ExchangeCompleted")
          .withArgs(exchange.offerId, bosonBuyerId, exchange.exchangeId, fermionProtocolAddress);

        // State
        // Fermion
        // Available funds
        expect(await fundsFacet.getAvailableFunds(exchange.verifierId, exchangeToken)).to.equal(verifierFee);
        expect(await fundsFacet.getAvailableFunds(facilitatorId, exchangeToken)).to.equal(0n); // facilitator not paid if rejected
        expect(await fundsFacet.getAvailableFunds(buyerId, exchangeToken)).to.equal(
          exchange.payout.remainder + exchange.payout.facilitatorFeeAmount,
        );
        expect(await fundsFacet.getAvailableFunds(sellerId, exchangeToken)).to.equal(0n);
        expect(await fundsFacet.getAvailableFunds(protocolId, exchangeToken)).to.equal(
          exchange.payout.fermionFeeAmount,
        );

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
        await expect(tx).to.not.emit(entityFacet, "EntityStored"); // no buyer is created, since the entity exist already
        await expect(tx)
          .to.emit(verificationFacet, "AvailableFundsIncreased")
          .withArgs(protocolId, exchangeToken, exchangeSelfSale.payout.fermionFeeAmount);

        // Wrapper
        const wrapperAddress = await offerFacet.predictFermionFNFTAddress(exchangeSelfSale.offerId);
        const wrapper = await ethers.getContractAt("FermionFNFT", wrapperAddress);
        await expect(tx).to.emit(wrapper, "TokenStateChange").withArgs(exchangeSelfSale.tokenId, TokenState.Burned);
        await expect(tx).to.not.emit(wrapper, "FixedPriceSale");

        // Boson
        await expect(tx)
          .to.emit(bosonExchangeHandler, "ExchangeCompleted")
          .withArgs(exchangeSelfSale.offerId, bosonBuyerId, exchangeSelfSale.exchangeId, fermionProtocolAddress);

        // State
        // Fermion
        // Available funds
        expect(await fundsFacet.getAvailableFunds(exchangeSelfSale.verifierId, exchangeToken)).to.equal(verifierFee);
        expect(await fundsFacet.getAvailableFunds(facilitatorId, exchangeToken)).to.equal(0);
        expect(await fundsFacet.getAvailableFunds(sellerId, exchangeToken)).to.equal(0);
        expect(await fundsFacet.getAvailableFunds(protocolId, exchangeToken)).to.equal(
          exchangeSelfSale.payout.fermionFeeAmount,
        );

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
          .withArgs(
            buyerId,
            exchangeToken,
            exchangeSelfVerification.payout.remainder + exchangeSelfVerification.payout.facilitatorFeeAmount,
          );
        await expect(tx)
          .to.emit(verificationFacet, "AvailableFundsIncreased")
          .withArgs(protocolId, exchangeToken, exchangeSelfVerification.payout.fermionFeeAmount);
        await expect(tx).to.emit(entityFacet, "EntityStored").withArgs(buyerId, buyer.address, [EntityRole.Buyer], "");

        // Wrapper
        const wrapperAddress = await offerFacet.predictFermionFNFTAddress(exchangeSelfVerification.offerId);
        const wrapper = await ethers.getContractAt("FermionFNFT", wrapperAddress);
        await expect(tx)
          .to.emit(wrapper, "TokenStateChange")
          .withArgs(exchangeSelfVerification.tokenId, TokenState.Burned);
        await expect(tx).to.not.emit(wrapper, "FixedPriceSale");

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
        expect(await fundsFacet.getAvailableFunds(buyerId, exchangeToken)).to.equal(
          exchangeSelfVerification.payout.remainder + exchangeSelfVerification.payout.facilitatorFeeAmount,
        ); // buyer gets the remainder and facilitator fee back
        expect(await fundsFacet.getAvailableFunds(sellerId, exchangeToken)).to.equal(0n);
        expect(await fundsFacet.getAvailableFunds(protocolId, exchangeToken)).to.equal(
          exchangeSelfVerification.payout.fermionFeeAmount,
        );

        // Wrapper
        expect(await wrapper.tokenState(exchangeSelfVerification.tokenId)).to.equal(TokenState.Burned);
        await expect(wrapper.ownerOf(exchangeSelfVerification.tokenId))
          .to.be.revertedWithCustomError(wrapper, "ERC721NonexistentToken")
          .withArgs(exchangeSelfVerification.tokenId);
      });

      it("Self sale, self verification", async function () {
        const tx = await verificationFacet.submitVerdict(
          exchangeSelfSaleSelfVerification.tokenId,
          VerificationStatus.Rejected,
        );

        // Events
        // Fermion
        await expect(tx)
          .to.emit(verificationFacet, "VerdictSubmitted")
          .withArgs(sellerId, exchangeSelfSaleSelfVerification.tokenId, VerificationStatus.Rejected);
        await expect(tx).to.not.emit(verificationFacet, "AvailableFundsIncreased");

        // Wrapper
        const wrapperAddress = await offerFacet.predictFermionFNFTAddress(exchangeSelfSaleSelfVerification.offerId);
        const wrapper = await ethers.getContractAt("FermionFNFT", wrapperAddress);
        await expect(tx)
          .to.emit(wrapper, "TokenStateChange")
          .withArgs(exchangeSelfSaleSelfVerification.tokenId, TokenState.Burned);
        await expect(tx).to.not.emit(wrapper, "FixedPriceSale");

        // Boson
        await expect(tx)
          .to.emit(bosonExchangeHandler, "ExchangeCompleted")
          .withArgs(
            exchangeSelfSaleSelfVerification.offerId,
            bosonBuyerId,
            exchangeSelfSaleSelfVerification.exchangeId,
            fermionProtocolAddress,
          );

        // State
        // Fermion
        // Available funds
        expect(await fundsFacet.getAvailableFunds(buyerId, exchangeToken)).to.equal(
          exchangeSelfSaleSelfVerification.payout.remainder +
            exchangeSelfSaleSelfVerification.payout.facilitatorFeeAmount,
        ); // buyer gets the remainder and facilitator fee back
        expect(await fundsFacet.getAvailableFunds(sellerId, exchangeToken)).to.equal(0n);
        expect(await fundsFacet.getAvailableFunds(protocolId, exchangeToken)).to.equal(
          exchangeSelfSaleSelfVerification.payout.fermionFeeAmount,
        );

        // Wrapper
        expect(await wrapper.tokenState(exchangeSelfSaleSelfVerification.tokenId)).to.equal(TokenState.Burned);
        await expect(wrapper.ownerOf(exchangeSelfSaleSelfVerification.tokenId))
          .to.be.revertedWithCustomError(wrapper, "ERC721NonexistentToken")
          .withArgs(exchangeSelfSaleSelfVerification.tokenId);
      });

      it("If buyer exists, it's not created anew and funds are added", async function () {
        await expect(verificationFacet.connect(verifier).submitVerdict(exchange.tokenId, VerificationStatus.Rejected))
          .to.emit(entityFacet, "EntityStored")
          .withArgs(buyerId, buyer.address, [EntityRole.Buyer], "");

        expect(await fundsFacet.getAvailableFunds(buyerId, exchangeToken)).to.equal(
          exchange.payout.remainder + exchange.payout.facilitatorFeeAmount,
        );

        await expect(
          verificationFacet.submitVerdict(exchangeSelfVerification.tokenId, VerificationStatus.Rejected),
        ).to.not.emit(entityFacet, "EntityStored");

        expect(await fundsFacet.getAvailableFunds(buyerId, exchangeToken)).to.equal(
          exchange.payout.remainder +
            exchange.payout.facilitatorFeeAmount +
            exchangeSelfVerification.payout.remainder +
            exchangeSelfVerification.payout.facilitatorFeeAmount,
        );
      });

      it("Can reject after after the timeout if the timeout was not called yet", async function () {
        await setNextBlockTimestamp(itemVerificationTimeout);

        // Events
        // Fermion
        await expect(verificationFacet.connect(verifier).submitVerdict(exchange.tokenId, VerificationStatus.Rejected))
          .to.emit(verificationFacet, "VerdictSubmitted")
          .withArgs(exchange.verifierId, exchange.tokenId, VerificationStatus.Rejected);
      });
    });

    context("Revert reasons", function () {
      it("Verification region is paused", async function () {
        await pauseFacet.pause([PausableRegion.Verification]);

        await expect(verificationFacet.submitVerdict(exchange.tokenId, VerificationStatus.Verified))
          .to.be.revertedWithCustomError(fermionErrors, "RegionPaused")
          .withArgs(PausableRegion.Verification);
      });

      it("Phygitals are not verified", async function () {
        await expect(verificationFacet.connect(verifier).submitVerdict(exchange.tokenId, VerificationStatus.Verified))
          .to.be.revertedWithCustomError(fermionErrors, "PhygitalsVerificationMissing")
          .withArgs(exchange.tokenId);
      });

      it("Caller is not the verifiers's assistant", async function () {
        const wallet = wallets[9];

        // completely random wallet
        await expect(verificationFacet.connect(wallet).submitVerdict(exchange.tokenId, VerificationStatus.Verified))
          .to.be.revertedWithCustomError(fermionErrors, "AccountHasNoRole")
          .withArgs(verifierId, wallet.address, EntityRole.Verifier, AccountRole.Assistant);

        // seller
        await expect(verificationFacet.submitVerdict(exchange.tokenId, VerificationStatus.Verified))
          .to.be.revertedWithCustomError(fermionErrors, "AccountHasNoRole")
          .withArgs(verifierId, defaultSigner.address, EntityRole.Verifier, AccountRole.Assistant);

        // an entity-wide Treasury or Manager wallet (not Assistant)
        await entityFacet
          .connect(verifier)
          .addEntityAccounts(verifierId, [wallet], [[]], [[[AccountRole.Treasury, AccountRole.Manager]]]);
        await expect(verificationFacet.connect(wallet).submitVerdict(exchange.tokenId, VerificationStatus.Verified))
          .to.be.revertedWithCustomError(fermionErrors, "AccountHasNoRole")
          .withArgs(verifierId, wallet.address, EntityRole.Verifier, AccountRole.Assistant);

        // a Verifier specific Treasury or Manager wallet
        const wallet2 = wallets[10];
        await entityFacet
          .connect(verifier)
          .addEntityAccounts(
            verifierId,
            [wallet2],
            [[EntityRole.Verifier]],
            [[[AccountRole.Treasury, AccountRole.Manager]]],
          );
        await expect(verificationFacet.connect(wallet2).submitVerdict(exchange.tokenId, VerificationStatus.Verified))
          .to.be.revertedWithCustomError(fermionErrors, "AccountHasNoRole")
          .withArgs(verifierId, wallet2.address, EntityRole.Verifier, AccountRole.Assistant);

        // an Assistant of another role than Verifier
        await entityFacet.connect(verifier).updateEntity(verifierId, [EntityRole.Verifier, EntityRole.Custodian], "");
        await entityFacet
          .connect(verifier)
          .addEntityAccounts(verifierId, [wallet2], [[EntityRole.Custodian]], [[[AccountRole.Assistant]]]);
        await expect(verificationFacet.connect(wallet2).submitVerdict(exchange.tokenId, VerificationStatus.Verified))
          .to.be.revertedWithCustomError(fermionErrors, "AccountHasNoRole")
          .withArgs(verifierId, wallet2.address, EntityRole.Verifier, AccountRole.Assistant);
      });

      it("Cannot verify twice", async function () {
        const digest = ethers.keccak256(abiCoder.encode(["tuple(address,uint256)[]"], [[]]));
        await verificationFacet.connect(verifier).verifyPhygitals(exchange.tokenId, digest);

        await verificationFacet.connect(verifier).submitVerdict(exchange.tokenId, VerificationStatus.Verified);

        await expect(
          verificationFacet.connect(verifier).submitVerdict(exchange.tokenId, VerificationStatus.Verified),
        ).to.be.revertedWithCustomError(bosonExchangeHandler, "InvalidState");
      });

      it("Cannot verify after revised metadata submitted", async function () {
        const newMetadataURI = "https://example.com/new-metadata.json";
        await verificationFacet.connect(verifier).submitRevisedMetadata(exchange.tokenId, newMetadataURI);

        await expect(
          verificationFacet.connect(verifier).submitVerdict(exchange.tokenId, VerificationStatus.Verified),
        ).to.be.revertedWithCustomError(bosonExchangeHandler, "InvalidState");
      });

      it("Cannot reject after revised metadata submitted", async function () {
        const newMetadataURI = "https://example.com/new-metadata.json";
        await verificationFacet.connect(verifier).submitRevisedMetadata(exchange.tokenId, newMetadataURI);

        await expect(
          verificationFacet.connect(verifier).submitVerdict(exchange.tokenId, VerificationStatus.Rejected),
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

  context("removeRevisedMetadataAndSubmitVerdict", function () {
    const newMetadataURI = "https://example.com/new-metadata.json";

    context("Verified", function () {
      it("Normal sale", async function () {
        const digest = ethers.keccak256(abiCoder.encode(["tuple(address,uint256)[]"], [[]]));
        await verificationFacet.connect(verifier).verifyPhygitals(exchange.tokenId, digest);

        await verificationFacet.connect(verifier).submitRevisedMetadata(exchange.tokenId, newMetadataURI);

        const tx = await verificationFacet
          .connect(verifier)
          .removeRevisedMetadataAndSubmitVerdict(exchange.tokenId, VerificationStatus.Verified);

        // Events
        // Fermion
        await expect(tx)
          .to.emit(verificationFacet, "VerdictSubmitted")
          .withArgs(exchange.verifierId, exchange.tokenId, VerificationStatus.Verified);
        await expect(tx)
          .to.emit(verificationFacet, "AvailableFundsIncreased")
          .withArgs(facilitatorId, exchangeToken, exchange.payout.facilitatorFeeAmount);
        await expect(tx)
          .to.emit(verificationFacet, "AvailableFundsIncreased")
          .withArgs(sellerId, exchangeToken, exchange.payout.remainder);
        await expect(tx)
          .to.emit(verificationFacet, "AvailableFundsIncreased")
          .withArgs(protocolId, exchangeToken, exchange.payout.fermionFeeAmount);
        await expect(tx).to.not.emit(entityFacet, "EntityStored"); // no buyer is created in happy path
        await expect(tx).to.emit(verificationFacet, "RevisedMetadataSubmitted").withArgs(exchange.tokenId, "");

        // Wrapper
        const wrapperAddress = await offerFacet.predictFermionFNFTAddress(exchange.offerId);
        const wrapper = await ethers.getContractAt("FermionFNFT", wrapperAddress);
        await expect(tx).to.emit(wrapper, "TokenStateChange").withArgs(exchange.tokenId, TokenState.Verified);

        // Boson
        await expect(tx).to.not.emit(bosonExchangeHandler, "ExchangeCompleted");

        // State
        // Fermion
        // Available funds
        expect(await fundsFacet.getAvailableFunds(exchange.verifierId, exchangeToken)).to.equal(verifierFee);
        expect(await fundsFacet.getAvailableFunds(facilitatorId, exchangeToken)).to.equal(
          exchange.payout.facilitatorFeeAmount,
        );
        expect(await fundsFacet.getAvailableFunds(sellerId, exchangeToken)).to.equal(exchange.payout.remainder);
        expect(await fundsFacet.getAvailableFunds(protocolId, exchangeToken)).to.equal(
          exchange.payout.fermionFeeAmount,
        ); // fermion protocol fees

        // Wrapper
        expect(await wrapper.tokenState(exchange.tokenId)).to.equal(TokenState.Verified);
        expect(await wrapper.ownerOf(exchange.tokenId)).to.equal(buyer.address);
      });

      it("Self sale", async function () {
        await verificationFacet.connect(verifier).submitRevisedMetadata(exchangeSelfSale.tokenId, newMetadataURI);

        const tx = await verificationFacet
          .connect(verifier)
          .removeRevisedMetadataAndSubmitVerdict(exchangeSelfSale.tokenId, VerificationStatus.Verified);

        // Events
        // Fermion
        // Note: verifier fee is not paid in this tx, since it was already paid in submitRevisedMetadata
        await expect(tx)
          .to.emit(verificationFacet, "VerdictSubmitted")
          .withArgs(exchangeSelfSale.verifierId, exchangeSelfSale.tokenId, VerificationStatus.Verified);
        await expect(tx)
          .to.emit(verificationFacet, "AvailableFundsIncreased")
          .withArgs(protocolId, exchangeToken, exchangeSelfSale.payout.fermionFeeAmount);
        await expect(tx).to.not.emit(entityFacet, "EntityStored"); // no buyer is created in happy path
        await expect(tx).to.emit(verificationFacet, "RevisedMetadataSubmitted").withArgs(exchangeSelfSale.tokenId, "");

        // Wrapper
        const wrapperAddress = await offerFacet.predictFermionFNFTAddress(exchangeSelfSale.offerId);
        const wrapper = await ethers.getContractAt("FermionFNFT", wrapperAddress);
        await expect(tx).to.emit(wrapper, "TokenStateChange").withArgs(exchangeSelfSale.tokenId, TokenState.Verified);

        // Boson
        await expect(tx).to.not.emit(bosonExchangeHandler, "ExchangeCompleted");

        // State
        // Fermion
        // Available funds
        expect(await fundsFacet.getAvailableFunds(exchangeSelfSale.verifierId, exchangeToken)).to.equal(verifierFee);
        expect(await fundsFacet.getAvailableFunds(facilitatorId, exchangeToken)).to.equal(0);
        expect(await fundsFacet.getAvailableFunds(sellerId, exchangeToken)).to.equal(0);
        expect(await fundsFacet.getAvailableFunds(protocolId, exchangeToken)).to.equal(
          exchangeSelfSale.payout.fermionFeeAmount,
        );

        // Wrapper
        expect(await wrapper.tokenState(exchangeSelfSale.tokenId)).to.equal(TokenState.Verified);
        expect(await wrapper.ownerOf(exchangeSelfSale.tokenId)).to.equal(defaultSigner.address);
      });

      it("Self verification", async function () {
        await verificationFacet.submitRevisedMetadata(exchangeSelfVerification.tokenId, newMetadataURI);

        const tx = await verificationFacet.removeRevisedMetadataAndSubmitVerdict(
          exchangeSelfVerification.tokenId,
          VerificationStatus.Verified,
        );

        // Events
        // Fermion
        await expect(tx)
          .to.emit(verificationFacet, "VerdictSubmitted")
          .withArgs(sellerId, exchangeSelfVerification.tokenId, VerificationStatus.Verified);
        await expect(tx)
          .to.emit(verificationFacet, "AvailableFundsIncreased")
          .withArgs(sellerId, exchangeToken, exchangeSelfVerification.payout.remainder);
        await expect(tx)
          .to.emit(verificationFacet, "AvailableFundsIncreased")
          .withArgs(protocolId, exchangeToken, exchangeSelfVerification.payout.fermionFeeAmount);
        await expect(tx).to.not.emit(entityFacet, "EntityStored"); // no buyer is created in happy path
        await expect(tx)
          .to.emit(verificationFacet, "RevisedMetadataSubmitted")
          .withArgs(exchangeSelfVerification.tokenId, "");

        // Wrapper
        const wrapperAddress = await offerFacet.predictFermionFNFTAddress(exchangeSelfVerification.offerId);
        const wrapper = await ethers.getContractAt("FermionFNFT", wrapperAddress);
        await expect(tx)
          .to.emit(wrapper, "TokenStateChange")
          .withArgs(exchangeSelfVerification.tokenId, TokenState.Verified);

        // Boson
        await expect(tx).to.not.emit(bosonExchangeHandler, "ExchangeCompleted");

        // State
        // Fermion
        // Available funds
        expect(await fundsFacet.getAvailableFunds(sellerId, exchangeToken)).to.equal(
          exchangeSelfVerification.payout.remainder,
        );
        expect(await fundsFacet.getAvailableFunds(facilitatorId, exchangeToken)).to.equal(
          exchangeSelfVerification.payout.facilitatorFeeAmount,
        );
        expect(await fundsFacet.getAvailableFunds(protocolId, exchangeToken)).to.equal(
          exchangeSelfVerification.payout.fermionFeeAmount,
        );

        // Wrapper
        expect(await wrapper.tokenState(exchangeSelfVerification.tokenId)).to.equal(TokenState.Verified);
        expect(await wrapper.ownerOf(exchangeSelfVerification.tokenId)).to.equal(buyer.address);
      });

      it("Self sale, self verification", async function () {
        await verificationFacet.submitRevisedMetadata(exchangeSelfSaleSelfVerification.tokenId, newMetadataURI);

        const tx = await verificationFacet.removeRevisedMetadataAndSubmitVerdict(
          exchangeSelfSaleSelfVerification.tokenId,
          VerificationStatus.Verified,
        );

        // Events
        // Fermion
        await expect(tx)
          .to.emit(verificationFacet, "VerdictSubmitted")
          .withArgs(sellerId, exchangeSelfSaleSelfVerification.tokenId, VerificationStatus.Verified);
        await expect(tx).to.not.emit(verificationFacet, "AvailableFundsIncreased");
        await expect(tx).to.not.emit(entityFacet, "EntityStored"); // no buyer is created in happy path
        await expect(tx)
          .to.emit(verificationFacet, "RevisedMetadataSubmitted")
          .withArgs(exchangeSelfSaleSelfVerification.tokenId, "");

        // Wrapper
        const wrapperAddress = await offerFacet.predictFermionFNFTAddress(exchangeSelfSaleSelfVerification.offerId);
        const wrapper = await ethers.getContractAt("FermionFNFT", wrapperAddress);
        await expect(tx)
          .to.emit(wrapper, "TokenStateChange")
          .withArgs(exchangeSelfSaleSelfVerification.tokenId, TokenState.Verified);

        // Boson
        await expect(tx).to.not.emit(bosonExchangeHandler, "ExchangeCompleted");

        // State
        // Fermion
        // Available funds
        expect(await fundsFacet.getAvailableFunds(sellerId, exchangeToken)).to.equal(
          exchangeSelfSaleSelfVerification.payout.remainder,
        );
        expect(await fundsFacet.getAvailableFunds(facilitatorId, exchangeToken)).to.equal(
          exchangeSelfSaleSelfVerification.payout.facilitatorFeeAmount,
        );
        expect(await fundsFacet.getAvailableFunds(protocolId, exchangeToken)).to.equal(
          exchangeSelfSaleSelfVerification.payout.fermionFeeAmount,
        );

        // Wrapper
        expect(await wrapper.tokenState(exchangeSelfSaleSelfVerification.tokenId)).to.equal(TokenState.Verified);
        expect(await wrapper.ownerOf(exchangeSelfSaleSelfVerification.tokenId)).to.equal(defaultSigner.address);
      });

      it("Can verify after after the timeout if the timeout was not called yet ", async function () {
        const digest = ethers.keccak256(abiCoder.encode(["tuple(address,uint256)[]"], [[]]));
        await verificationFacet.connect(verifier).verifyPhygitals(exchange.tokenId, digest);

        await verificationFacet.connect(verifier).submitRevisedMetadata(exchange.tokenId, newMetadataURI);

        await setNextBlockTimestamp(itemVerificationTimeout);

        await expect(
          verificationFacet
            .connect(verifier)
            .removeRevisedMetadataAndSubmitVerdict(exchange.tokenId, VerificationStatus.Verified),
        )
          .to.emit(verificationFacet, "VerdictSubmitted")
          .withArgs(exchange.verifierId, exchange.tokenId, VerificationStatus.Verified);
      });

      it("Some proposals exist", async function () {
        const digest = ethers.keccak256(abiCoder.encode(["tuple(address,uint256)[]"], [[]]));
        await verificationFacet.connect(verifier).verifyPhygitals(exchange.tokenId, digest);

        await verificationFacet.connect(verifier).submitRevisedMetadata(exchange.tokenId, newMetadataURI);

        const metadataDigest = id(newMetadataURI);
        const buyerProposal = 20_00n; // 20%
        await verificationFacet.connect(buyer).submitProposal(exchange.tokenId, buyerProposal, metadataDigest);

        const tx = await verificationFacet
          .connect(verifier)
          .removeRevisedMetadataAndSubmitVerdict(exchange.tokenId, VerificationStatus.Verified);

        // Events
        // Fermion
        await expect(tx)
          .to.emit(verificationFacet, "VerdictSubmitted")
          .withArgs(exchange.verifierId, exchange.tokenId, VerificationStatus.Verified);
        await expect(tx)
          .to.emit(verificationFacet, "AvailableFundsIncreased")
          .withArgs(facilitatorId, exchangeToken, exchange.payout.facilitatorFeeAmount);
        await expect(tx)
          .to.emit(verificationFacet, "AvailableFundsIncreased")
          .withArgs(sellerId, exchangeToken, exchange.payout.remainder);
        await expect(tx)
          .to.emit(verificationFacet, "AvailableFundsIncreased")
          .withArgs(protocolId, exchangeToken, exchange.payout.fermionFeeAmount);
        await expect(tx).to.not.emit(entityFacet, "EntityStored"); // no buyer is created in happy path
        await expect(tx).to.emit(verificationFacet, "RevisedMetadataSubmitted").withArgs(exchange.tokenId, "");

        // Wrapper
        const wrapperAddress = await offerFacet.predictFermionFNFTAddress(exchange.offerId);
        const wrapper = await ethers.getContractAt("FermionFNFT", wrapperAddress);
        await expect(tx).to.emit(wrapper, "TokenStateChange").withArgs(exchange.tokenId, TokenState.Verified);

        // Boson
        await expect(tx).to.not.emit(bosonExchangeHandler, "ExchangeCompleted");

        // State
        // Fermion
        // Available funds
        expect(await fundsFacet.getAvailableFunds(exchange.verifierId, exchangeToken)).to.equal(verifierFee);
        expect(await fundsFacet.getAvailableFunds(facilitatorId, exchangeToken)).to.equal(
          exchange.payout.facilitatorFeeAmount,
        );
        expect(await fundsFacet.getAvailableFunds(sellerId, exchangeToken)).to.equal(exchange.payout.remainder);
        expect(await fundsFacet.getAvailableFunds(protocolId, exchangeToken)).to.equal(
          exchange.payout.fermionFeeAmount,
        ); // fermion protocol fees

        // Wrapper
        expect(await wrapper.tokenState(exchange.tokenId)).to.equal(TokenState.Verified);
        expect(await wrapper.ownerOf(exchange.tokenId)).to.equal(buyer.address);
      });
    });

    context("Rejected", function () {
      const buyerId = "5"; // new buyer in fermion
      it("Normal sale", async function () {
        await verificationFacet.connect(verifier).submitRevisedMetadata(exchange.tokenId, newMetadataURI);

        const tx = await verificationFacet
          .connect(verifier)
          .removeRevisedMetadataAndSubmitVerdict(exchange.tokenId, VerificationStatus.Rejected);

        // Events
        // Fermion
        await expect(tx)
          .to.emit(verificationFacet, "VerdictSubmitted")
          .withArgs(exchange.verifierId, exchange.tokenId, VerificationStatus.Rejected);
        await expect(tx)
          .to.emit(verificationFacet, "AvailableFundsIncreased")
          .withArgs(buyerId, exchangeToken, exchange.payout.remainder + exchange.payout.facilitatorFeeAmount); // buyer gets the remainder and facilitator fee back
        await expect(tx)
          .to.emit(verificationFacet, "AvailableFundsIncreased")
          .withArgs(protocolId, exchangeToken, exchange.payout.fermionFeeAmount);
        await expect(tx).to.emit(entityFacet, "EntityStored").withArgs(buyerId, buyer.address, [EntityRole.Buyer], "");
        await expect(tx).to.emit(verificationFacet, "RevisedMetadataSubmitted").withArgs(exchange.tokenId, "");

        // Wrapper
        const wrapperAddress = await offerFacet.predictFermionFNFTAddress(exchange.offerId);
        const wrapper = await ethers.getContractAt("FermionFNFT", wrapperAddress);
        await expect(tx).to.emit(wrapper, "TokenStateChange").withArgs(exchange.tokenId, TokenState.Burned);
        await expect(tx).to.not.emit(wrapper, "FixedPriceSale");

        // Boson
        await expect(tx).to.not.emit(bosonExchangeHandler, "ExchangeCompleted");

        // State
        // Fermion
        // Available funds
        expect(await fundsFacet.getAvailableFunds(exchange.verifierId, exchangeToken)).to.equal(verifierFee);
        expect(await fundsFacet.getAvailableFunds(facilitatorId, exchangeToken)).to.equal(0n); // facilitator not paid if rejected
        expect(await fundsFacet.getAvailableFunds(buyerId, exchangeToken)).to.equal(
          exchange.payout.remainder + exchange.payout.facilitatorFeeAmount,
        );
        expect(await fundsFacet.getAvailableFunds(sellerId, exchangeToken)).to.equal(0n);
        expect(await fundsFacet.getAvailableFunds(protocolId, exchangeToken)).to.equal(
          exchange.payout.fermionFeeAmount,
        );

        // Wrapper
        expect(await wrapper.tokenState(exchange.tokenId)).to.equal(TokenState.Burned);
        await expect(wrapper.ownerOf(exchange.tokenId))
          .to.be.revertedWithCustomError(wrapper, "ERC721NonexistentToken")
          .withArgs(exchange.tokenId);
      });

      it("Self sale", async function () {
        await verificationFacet.connect(verifier).submitRevisedMetadata(exchangeSelfSale.tokenId, newMetadataURI);

        const tx = await verificationFacet
          .connect(verifier)
          .removeRevisedMetadataAndSubmitVerdict(exchangeSelfSale.tokenId, VerificationStatus.Rejected);

        // Events
        // Fermion
        // Note: verifier fee is not paid in this tx, since it was already paid in submitRevisedMetadata
        await expect(tx)
          .to.emit(verificationFacet, "VerdictSubmitted")
          .withArgs(exchangeSelfSale.verifierId, exchangeSelfSale.tokenId, VerificationStatus.Rejected);
        await expect(tx)
          .to.emit(verificationFacet, "AvailableFundsIncreased")
          .withArgs(protocolId, exchangeToken, exchangeSelfSale.payout.fermionFeeAmount);
        await expect(tx).to.not.emit(entityFacet, "EntityStored"); // no buyer is created, since the entity exist already
        await expect(tx).to.emit(verificationFacet, "RevisedMetadataSubmitted").withArgs(exchangeSelfSale.tokenId, "");

        // Wrapper
        const wrapperAddress = await offerFacet.predictFermionFNFTAddress(exchangeSelfSale.offerId);
        const wrapper = await ethers.getContractAt("FermionFNFT", wrapperAddress);
        await expect(tx).to.emit(wrapper, "TokenStateChange").withArgs(exchangeSelfSale.tokenId, TokenState.Burned);
        await expect(tx).to.not.emit(wrapper, "FixedPriceSale");

        // Boson
        await expect(tx).to.not.emit(bosonExchangeHandler, "ExchangeCompleted");

        // State
        // Fermion
        // Available funds
        expect(await fundsFacet.getAvailableFunds(exchangeSelfSale.verifierId, exchangeToken)).to.equal(verifierFee);
        expect(await fundsFacet.getAvailableFunds(facilitatorId, exchangeToken)).to.equal(0);
        expect(await fundsFacet.getAvailableFunds(sellerId, exchangeToken)).to.equal(0);
        expect(await fundsFacet.getAvailableFunds(protocolId, exchangeToken)).to.equal(
          exchangeSelfSale.payout.fermionFeeAmount,
        );

        // Wrapper
        expect(await wrapper.tokenState(exchangeSelfSale.tokenId)).to.equal(TokenState.Burned);
        await expect(wrapper.ownerOf(exchangeSelfSale.tokenId))
          .to.be.revertedWithCustomError(wrapper, "ERC721NonexistentToken")
          .withArgs(exchangeSelfSale.tokenId);
      });

      it("Self verification", async function () {
        await verificationFacet.submitRevisedMetadata(exchangeSelfVerification.tokenId, newMetadataURI);

        const tx = await verificationFacet.removeRevisedMetadataAndSubmitVerdict(
          exchangeSelfVerification.tokenId,
          VerificationStatus.Rejected,
        );

        // Events
        // Fermion
        await expect(tx)
          .to.emit(verificationFacet, "VerdictSubmitted")
          .withArgs(sellerId, exchangeSelfVerification.tokenId, VerificationStatus.Rejected);
        await expect(tx)
          .to.emit(verificationFacet, "AvailableFundsIncreased")
          .withArgs(
            buyerId,
            exchangeToken,
            exchangeSelfVerification.payout.remainder + exchangeSelfVerification.payout.facilitatorFeeAmount,
          );
        await expect(tx)
          .to.emit(verificationFacet, "AvailableFundsIncreased")
          .withArgs(protocolId, exchangeToken, exchangeSelfVerification.payout.fermionFeeAmount);
        await expect(tx).to.emit(entityFacet, "EntityStored").withArgs(buyerId, buyer.address, [EntityRole.Buyer], "");
        await expect(tx)
          .to.emit(verificationFacet, "RevisedMetadataSubmitted")
          .withArgs(exchangeSelfVerification.tokenId, "");

        // Wrapper
        const wrapperAddress = await offerFacet.predictFermionFNFTAddress(exchangeSelfVerification.offerId);
        const wrapper = await ethers.getContractAt("FermionFNFT", wrapperAddress);
        await expect(tx)
          .to.emit(wrapper, "TokenStateChange")
          .withArgs(exchangeSelfVerification.tokenId, TokenState.Burned);
        await expect(tx).to.not.emit(wrapper, "FixedPriceSale");

        // Boson
        await expect(tx).to.not.emit(bosonExchangeHandler, "ExchangeCompleted");

        // State
        // Fermion
        // Available funds
        expect(await fundsFacet.getAvailableFunds(buyerId, exchangeToken)).to.equal(
          exchangeSelfVerification.payout.remainder + exchangeSelfVerification.payout.facilitatorFeeAmount,
        ); // buyer gets the remainder and facilitator fee back
        expect(await fundsFacet.getAvailableFunds(sellerId, exchangeToken)).to.equal(0n);
        expect(await fundsFacet.getAvailableFunds(protocolId, exchangeToken)).to.equal(
          exchangeSelfVerification.payout.fermionFeeAmount,
        );

        // Wrapper
        expect(await wrapper.tokenState(exchangeSelfVerification.tokenId)).to.equal(TokenState.Burned);
        await expect(wrapper.ownerOf(exchangeSelfVerification.tokenId))
          .to.be.revertedWithCustomError(wrapper, "ERC721NonexistentToken")
          .withArgs(exchangeSelfVerification.tokenId);
      });

      it("Self sale, self verification", async function () {
        await verificationFacet.submitRevisedMetadata(exchangeSelfSaleSelfVerification.tokenId, newMetadataURI);

        const tx = await verificationFacet.removeRevisedMetadataAndSubmitVerdict(
          exchangeSelfSaleSelfVerification.tokenId,
          VerificationStatus.Rejected,
        );

        // Events
        // Fermion
        await expect(tx)
          .to.emit(verificationFacet, "VerdictSubmitted")
          .withArgs(sellerId, exchangeSelfSaleSelfVerification.tokenId, VerificationStatus.Rejected);
        await expect(tx).to.not.emit(verificationFacet, "AvailableFundsIncreased");
        await expect(tx)
          .to.emit(verificationFacet, "RevisedMetadataSubmitted")
          .withArgs(exchangeSelfSaleSelfVerification.tokenId, "");

        // Wrapper
        const wrapperAddress = await offerFacet.predictFermionFNFTAddress(exchangeSelfSaleSelfVerification.offerId);
        const wrapper = await ethers.getContractAt("FermionFNFT", wrapperAddress);
        await expect(tx)
          .to.emit(wrapper, "TokenStateChange")
          .withArgs(exchangeSelfSaleSelfVerification.tokenId, TokenState.Burned);
        await expect(tx).to.not.emit(wrapper, "FixedPriceSale");

        // Boson
        await expect(tx).to.not.emit(bosonExchangeHandler, "ExchangeCompleted");

        // State
        // Fermion
        // Available funds
        expect(await fundsFacet.getAvailableFunds(buyerId, exchangeToken)).to.equal(
          exchangeSelfSaleSelfVerification.payout.remainder +
            exchangeSelfSaleSelfVerification.payout.facilitatorFeeAmount,
        ); // buyer gets the remainder and facilitator fee back
        expect(await fundsFacet.getAvailableFunds(sellerId, exchangeToken)).to.equal(0n);
        expect(await fundsFacet.getAvailableFunds(protocolId, exchangeToken)).to.equal(
          exchangeSelfSaleSelfVerification.payout.fermionFeeAmount,
        );

        // Wrapper
        expect(await wrapper.tokenState(exchangeSelfSaleSelfVerification.tokenId)).to.equal(TokenState.Burned);
        await expect(wrapper.ownerOf(exchangeSelfSaleSelfVerification.tokenId))
          .to.be.revertedWithCustomError(wrapper, "ERC721NonexistentToken")
          .withArgs(exchangeSelfSaleSelfVerification.tokenId);
      });

      it("Can reject after after the timeout if the timeout was not called yet", async function () {
        await verificationFacet.connect(verifier).submitRevisedMetadata(exchange.tokenId, newMetadataURI);
        await setNextBlockTimestamp(itemVerificationTimeout);

        // Events
        // Fermion
        await expect(
          verificationFacet
            .connect(verifier)
            .removeRevisedMetadataAndSubmitVerdict(exchange.tokenId, VerificationStatus.Rejected),
        )
          .to.emit(verificationFacet, "VerdictSubmitted")
          .withArgs(exchange.verifierId, exchange.tokenId, VerificationStatus.Rejected);
      });

      it("Some proposals exist", async function () {
        await verificationFacet.connect(verifier).submitRevisedMetadata(exchange.tokenId, newMetadataURI);

        const metadataDigest = id(newMetadataURI);
        const buyerProposal = 20_00n; // 20%
        await verificationFacet.connect(buyer).submitProposal(exchange.tokenId, buyerProposal, metadataDigest);

        const tx = await verificationFacet
          .connect(verifier)
          .removeRevisedMetadataAndSubmitVerdict(exchange.tokenId, VerificationStatus.Rejected);

        // Events
        // Fermion
        await expect(tx)
          .to.emit(verificationFacet, "VerdictSubmitted")
          .withArgs(exchange.verifierId, exchange.tokenId, VerificationStatus.Rejected);
        await expect(tx)
          .to.emit(verificationFacet, "AvailableFundsIncreased")
          .withArgs(buyerId, exchangeToken, exchange.payout.remainder + exchange.payout.facilitatorFeeAmount); // buyer gets the remainder and facilitator fee back
        await expect(tx)
          .to.emit(verificationFacet, "AvailableFundsIncreased")
          .withArgs(protocolId, exchangeToken, exchange.payout.fermionFeeAmount);
        await expect(tx).to.emit(entityFacet, "EntityStored").withArgs(buyerId, buyer.address, [EntityRole.Buyer], "");
        await expect(tx).to.emit(verificationFacet, "RevisedMetadataSubmitted").withArgs(exchange.tokenId, "");

        // Wrapper
        const wrapperAddress = await offerFacet.predictFermionFNFTAddress(exchange.offerId);
        const wrapper = await ethers.getContractAt("FermionFNFT", wrapperAddress);
        await expect(tx).to.emit(wrapper, "TokenStateChange").withArgs(exchange.tokenId, TokenState.Burned);
        await expect(tx).to.not.emit(wrapper, "FixedPriceSale");

        // Boson
        await expect(tx).to.not.emit(bosonExchangeHandler, "ExchangeCompleted");

        // State
        // Fermion
        // Available funds
        expect(await fundsFacet.getAvailableFunds(exchange.verifierId, exchangeToken)).to.equal(verifierFee);
        expect(await fundsFacet.getAvailableFunds(facilitatorId, exchangeToken)).to.equal(0n); // facilitator not paid if rejected
        expect(await fundsFacet.getAvailableFunds(buyerId, exchangeToken)).to.equal(
          exchange.payout.remainder + exchange.payout.facilitatorFeeAmount,
        );
        expect(await fundsFacet.getAvailableFunds(sellerId, exchangeToken)).to.equal(0n);
        expect(await fundsFacet.getAvailableFunds(protocolId, exchangeToken)).to.equal(
          exchange.payout.fermionFeeAmount,
        );

        // Wrapper
        expect(await wrapper.tokenState(exchange.tokenId)).to.equal(TokenState.Burned);
        await expect(wrapper.ownerOf(exchange.tokenId))
          .to.be.revertedWithCustomError(wrapper, "ERC721NonexistentToken")
          .withArgs(exchange.tokenId);
      });
    });

    context("Revert reasons", function () {
      beforeEach(async function () {
        await verificationFacet.connect(verifier).submitRevisedMetadata(exchange.tokenId, newMetadataURI);
      });

      it("Verification region is paused", async function () {
        await pauseFacet.pause([PausableRegion.Verification]);

        await expect(
          verificationFacet.removeRevisedMetadataAndSubmitVerdict(exchange.tokenId, VerificationStatus.Verified),
        )
          .to.be.revertedWithCustomError(fermionErrors, "RegionPaused")
          .withArgs(PausableRegion.Verification);
      });

      it("Caller is not the verifiers's assistant", async function () {
        const wallet = wallets[9];

        // completely random wallet
        await expect(
          verificationFacet
            .connect(wallet)
            .removeRevisedMetadataAndSubmitVerdict(exchange.tokenId, VerificationStatus.Verified),
        )
          .to.be.revertedWithCustomError(fermionErrors, "AccountHasNoRole")
          .withArgs(verifierId, wallet.address, EntityRole.Verifier, AccountRole.Assistant);

        // seller
        await expect(
          verificationFacet.removeRevisedMetadataAndSubmitVerdict(exchange.tokenId, VerificationStatus.Verified),
        )
          .to.be.revertedWithCustomError(fermionErrors, "AccountHasNoRole")
          .withArgs(verifierId, defaultSigner.address, EntityRole.Verifier, AccountRole.Assistant);

        // an entity-wide Treasury or Manager wallet (not Assistant)
        await entityFacet
          .connect(verifier)
          .addEntityAccounts(verifierId, [wallet], [[]], [[[AccountRole.Treasury, AccountRole.Manager]]]);
        await expect(
          verificationFacet
            .connect(wallet)
            .removeRevisedMetadataAndSubmitVerdict(exchange.tokenId, VerificationStatus.Verified),
        )
          .to.be.revertedWithCustomError(fermionErrors, "AccountHasNoRole")
          .withArgs(verifierId, wallet.address, EntityRole.Verifier, AccountRole.Assistant);

        // a Verifier specific Treasury or Manager wallet
        const wallet2 = wallets[10];
        await entityFacet
          .connect(verifier)
          .addEntityAccounts(
            verifierId,
            [wallet2],
            [[EntityRole.Verifier]],
            [[[AccountRole.Treasury, AccountRole.Manager]]],
          );
        await expect(
          verificationFacet
            .connect(wallet2)
            .removeRevisedMetadataAndSubmitVerdict(exchange.tokenId, VerificationStatus.Verified),
        )
          .to.be.revertedWithCustomError(fermionErrors, "AccountHasNoRole")
          .withArgs(verifierId, wallet2.address, EntityRole.Verifier, AccountRole.Assistant);

        // an Assistant of another role than Verifier
        await entityFacet.connect(verifier).updateEntity(verifierId, [EntityRole.Verifier, EntityRole.Custodian], "");
        await entityFacet
          .connect(verifier)
          .addEntityAccounts(verifierId, [wallet2], [[EntityRole.Custodian]], [[[AccountRole.Assistant]]]);
        await expect(
          verificationFacet
            .connect(wallet2)
            .removeRevisedMetadataAndSubmitVerdict(exchange.tokenId, VerificationStatus.Verified),
        )
          .to.be.revertedWithCustomError(fermionErrors, "AccountHasNoRole")
          .withArgs(verifierId, wallet2.address, EntityRole.Verifier, AccountRole.Assistant);
      });

      it("Revised metadata does not exist", async function () {
        const digest = ethers.keccak256(abiCoder.encode(["tuple(address,uint256)[]"], [[]]));
        await verificationFacet.connect(verifier).verifyPhygitals(exchange.tokenId, digest);

        // no revision to start with
        await expect(
          verificationFacet
            .connect(verifier)
            .removeRevisedMetadataAndSubmitVerdict(exchangeSelfSale.tokenId, VerificationStatus.Verified),
        ).to.be.revertedWithCustomError(verificationFacet, "EmptyMetadata");

        // revised and removed
        await verificationFacet
          .connect(verifier)
          .removeRevisedMetadataAndSubmitVerdict(exchange.tokenId, VerificationStatus.Verified);

        await expect(
          verificationFacet
            .connect(verifier)
            .removeRevisedMetadataAndSubmitVerdict(exchange.tokenId, VerificationStatus.Verified),
        ).to.be.revertedWithCustomError(verificationFacet, "EmptyMetadata");
      });
    });
  });

  context("submitRevisedMetadata", function () {
    const newMetadataURI = "https://example.com/new-metadata.json";

    it("verifier can submit revised metadata", async function () {
      const tx = await verificationFacet.connect(verifier).submitRevisedMetadata(exchange.tokenId, newMetadataURI);

      // Events
      await expect(tx)
        .to.emit(verificationFacet, "RevisedMetadataSubmitted")
        .withArgs(exchange.tokenId, newMetadataURI);
      await expect(tx)
        .to.emit(verificationFacet, "AvailableFundsIncreased")
        .withArgs(exchange.verifierId, exchangeToken, verifierFee);

      // Wrapper
      const wrapperAddress = await offerFacet.predictFermionFNFTAddress(exchange.offerId);
      const wrapper = await ethers.getContractAt("FermionFNFT", wrapperAddress);

      // Boson
      await expect(tx)
        .to.emit(bosonExchangeHandler, "ExchangeCompleted")
        .withArgs(exchange.offerId, bosonBuyerId, exchange.exchangeId, fermionProtocolAddress);

      // State
      // Fermion
      expect(await verificationFacet.getRevisedMetadata(exchange.tokenId)).to.equal(newMetadataURI);
      // Available funds - only the verifier is paid at this step
      expect(await fundsFacet.getAvailableFunds(exchange.verifierId, exchangeToken)).to.equal(verifierFee);
      expect(await fundsFacet.getAvailableFunds(facilitatorId, exchangeToken)).to.equal(0n);
      expect(await fundsFacet.getAvailableFunds(sellerId, exchangeToken)).to.equal(0n);
      expect(await fundsFacet.getAvailableFunds(protocolId, exchangeToken)).to.equal(0n); // fermion protocol fees

      // Wrapper
      expect(await wrapper.tokenState(exchange.tokenId)).to.equal(TokenState.Unverified);
      expect(await wrapper.ownerOf(exchange.tokenId)).to.equal(buyer.address);
    });

    it("Revised metadata can be updated", async function () {
      await verificationFacet.connect(verifier).submitRevisedMetadata(exchange.tokenId, newMetadataURI);

      const metadataDigest = id(newMetadataURI);
      await verificationFacet.connect(buyer).submitProposal(exchange.tokenId, 20n, metadataDigest);
      await verificationFacet.connect(defaultSigner).submitProposal(exchange.tokenId, 10n, metadataDigest);

      const newMetadataURI2 = "https://example.com/new-metadata2.json";
      const tx = await verificationFacet.connect(verifier).submitRevisedMetadata(exchange.tokenId, newMetadataURI2);

      // Events
      await expect(tx)
        .to.emit(verificationFacet, "RevisedMetadataSubmitted")
        .withArgs(exchange.tokenId, newMetadataURI2);

      // State
      expect(await verificationFacet.getRevisedMetadata(exchange.tokenId)).to.equal(newMetadataURI2);
      expect(await verificationFacet.getProposals(exchange.tokenId)).to.eql([0n, 0n]);
    });

    it("verifier can submit revised metadata after the timeout if the timeout was not called yet", async function () {
      await setNextBlockTimestamp(itemVerificationTimeout);

      // Events
      await expect(await verificationFacet.connect(verifier).submitRevisedMetadata(exchange.tokenId, newMetadataURI))
        .to.emit(verificationFacet, "RevisedMetadataSubmitted")
        .withArgs(exchange.tokenId, newMetadataURI);

      // State
      expect(await verificationFacet.getRevisedMetadata(exchange.tokenId)).to.equal(newMetadataURI);
    });

    context("Revert reasons", function () {
      it("Verification region is paused", async function () {
        await pauseFacet.pause([PausableRegion.Verification]);

        await expect(verificationFacet.submitRevisedMetadata(exchange.tokenId, newMetadataURI))
          .to.be.revertedWithCustomError(fermionErrors, "RegionPaused")
          .withArgs(PausableRegion.Verification);
      });

      it("Caller is not the verifiers's assistant", async function () {
        const wallet = wallets[9];

        // completely random wallet
        await expect(verificationFacet.connect(wallet).submitRevisedMetadata(exchange.tokenId, newMetadataURI))
          .to.be.revertedWithCustomError(fermionErrors, "AccountHasNoRole")
          .withArgs(verifierId, wallet.address, EntityRole.Verifier, AccountRole.Assistant);

        // seller
        await expect(verificationFacet.submitRevisedMetadata(exchange.tokenId, newMetadataURI))
          .to.be.revertedWithCustomError(fermionErrors, "AccountHasNoRole")
          .withArgs(verifierId, defaultSigner.address, EntityRole.Verifier, AccountRole.Assistant);

        // an entity-wide Treasury or Manager wallet (not Assistant)
        await entityFacet
          .connect(verifier)
          .addEntityAccounts(verifierId, [wallet], [[]], [[[AccountRole.Treasury, AccountRole.Manager]]]);
        await expect(verificationFacet.connect(wallet).submitRevisedMetadata(exchange.tokenId, newMetadataURI))
          .to.be.revertedWithCustomError(fermionErrors, "AccountHasNoRole")
          .withArgs(verifierId, wallet.address, EntityRole.Verifier, AccountRole.Assistant);

        // a Verifier specific Treasury or Manager wallet
        const wallet2 = wallets[10];
        await entityFacet
          .connect(verifier)
          .addEntityAccounts(
            verifierId,
            [wallet2],
            [[EntityRole.Verifier]],
            [[[AccountRole.Treasury, AccountRole.Manager]]],
          );
        await expect(verificationFacet.connect(wallet2).submitRevisedMetadata(exchange.tokenId, newMetadataURI))
          .to.be.revertedWithCustomError(fermionErrors, "AccountHasNoRole")
          .withArgs(verifierId, wallet2.address, EntityRole.Verifier, AccountRole.Assistant);

        // an Assistant of another role than Verifier
        await entityFacet.connect(verifier).updateEntity(verifierId, [EntityRole.Verifier, EntityRole.Custodian], "");
        await entityFacet
          .connect(verifier)
          .addEntityAccounts(verifierId, [wallet2], [[EntityRole.Custodian]], [[[AccountRole.Assistant]]]);
        await expect(verificationFacet.connect(wallet2).submitRevisedMetadata(exchange.tokenId, newMetadataURI))
          .to.be.revertedWithCustomError(fermionErrors, "AccountHasNoRole")
          .withArgs(verifierId, wallet2.address, EntityRole.Verifier, AccountRole.Assistant);
      });

      it("Token does not exist", async function () {
        const tokenId = deriveTokenId("15", "4"); // non-existing token -> no associated offer -> entityId = 0 => noSuchEntity

        await expect(verificationFacet.submitRevisedMetadata(tokenId, newMetadataURI)).to.be.revertedWithCustomError(
          fermionErrors,
          "NoSuchEntity",
        );
      });

      it("Submitted empty metadata", async function () {
        await expect(verificationFacet.submitRevisedMetadata(exchange.tokenId, "")).to.be.revertedWithCustomError(
          fermionErrors,
          "EmptyMetadata",
        );
      });

      it("Cannot submit before it's unwrapped", async function () {
        const tokenId = deriveTokenId("3", "4"); // token that was wrapped but not unwrapped yet

        await expect(verificationFacet.submitRevisedMetadata(tokenId, newMetadataURI)).to.be.revertedWithCustomError(
          bosonExchangeHandler,
          "NoSuchExchange",
        );
      });

      it("Verification is timeouted", async function () {
        await setNextBlockTimestamp(itemVerificationTimeout);
        await verificationFacet.verificationTimeout(exchange.tokenId);

        await expect(
          verificationFacet.connect(verifier).submitRevisedMetadata(exchange.tokenId, newMetadataURI),
        ).to.be.revertedWithCustomError(bosonExchangeHandler, "InvalidState");
      });

      it("Verification is timeouted", async function () {
        await verificationFacet.connect(verifier).submitRevisedMetadata(exchange.tokenId, newMetadataURI);

        await setNextBlockTimestamp(itemVerificationTimeout);
        await verificationFacet.verificationTimeout(exchange.tokenId);

        await expect(
          verificationFacet.connect(verifier).submitRevisedMetadata(exchange.tokenId, newMetadataURI),
        ).to.be.revertedWithCustomError(bosonExchangeHandler, "InvalidState");
      });
    });
  });

  context("getRevisedMetadata", function () {
    it("Exchange with revised metadata", async function () {
      const newMetadataURI = "https://example.com/new-metadata.json";

      await verificationFacet.connect(verifier).submitRevisedMetadata(exchange.tokenId, newMetadataURI);

      // State
      expect(await verificationFacet.getRevisedMetadata(exchange.tokenId)).to.equal(newMetadataURI);
    });

    it("Exchange without revised metadata", async function () {
      // State
      expect(await verificationFacet.getRevisedMetadata(exchange.tokenId)).to.equal("");
    });
  });

  context("submitProposal", function () {
    const newMetadataURI = "https://example.com/new-metadata.json";
    const metadataDigest = id(newMetadataURI);
    const buyerProposal = 20_00n; // 20%
    const sellerProposal = 10_00n; // 10%

    beforeEach(async function () {
      await verificationFacet.connect(verifier).submitRevisedMetadata(exchange.tokenId, newMetadataURI);

      const digest = ethers.keccak256(abiCoder.encode(["tuple(address,uint256)[]"], [[]]));
      await verificationFacet.connect(verifier).verifyPhygitals(exchange.tokenId, digest);
    });

    context("Non-matching proposals", function () {
      it("Buyer submits first ", async function () {
        const tx = await verificationFacet
          .connect(buyer)
          .submitProposal(exchange.tokenId, buyerProposal, metadataDigest);

        await expect(tx)
          .to.emit(verificationFacet, "ProposalSubmitted")
          .withArgs(exchange.tokenId, buyerProposal, 0, buyerProposal);
        await expect(tx).to.not.emit(verificationFacet, "VerdictSubmitted");

        expect(await verificationFacet.getProposals(exchange.tokenId)).to.eql([buyerProposal, 0n]);

        const tx2 = await verificationFacet
          .connect(defaultSigner)
          .submitProposal(exchange.tokenId, sellerProposal, metadataDigest);

        await expect(tx2)
          .to.emit(verificationFacet, "ProposalSubmitted")
          .withArgs(exchange.tokenId, buyerProposal, sellerProposal, sellerProposal);
        await expect(tx2).to.not.emit(verificationFacet, "VerdictSubmitted");
      });

      it("Seller submits first", async function () {
        const tx = await verificationFacet
          .connect(defaultSigner)
          .submitProposal(exchange.tokenId, sellerProposal, metadataDigest);

        await expect(tx)
          .to.emit(verificationFacet, "ProposalSubmitted")
          .withArgs(exchange.tokenId, 0, sellerProposal, sellerProposal);
        await expect(tx).to.not.emit(verificationFacet, "VerdictSubmitted");

        expect(await verificationFacet.getProposals(exchange.tokenId)).to.eql([0n, sellerProposal]);

        const tx2 = verificationFacet.connect(buyer).submitProposal(exchange.tokenId, buyerProposal, metadataDigest);
        await expect(tx2)
          .to.emit(verificationFacet, "ProposalSubmitted")
          .withArgs(exchange.tokenId, buyerProposal, sellerProposal, buyerProposal);
        await expect(tx2).to.not.emit(verificationFacet, "VerdictSubmitted");

        expect(await verificationFacet.getProposals(exchange.tokenId)).to.eql([buyerProposal, sellerProposal]);
      });
    });

    context("Matching proposals", function () {
      const buyerId = "5"; // new buyer in fermion

      it("Buyer submits first", async function () {
        await verificationFacet.connect(buyer).submitProposal(exchange.tokenId, buyerProposal, metadataDigest);

        const sellerProposal = buyerProposal + 10n;
        const tx = await verificationFacet
          .connect(defaultSigner)
          .submitProposal(exchange.tokenId, sellerProposal, metadataDigest);

        // Events
        // Fermion
        await expect(tx)
          .to.emit(verificationFacet, "ProposalSubmitted")
          .withArgs(exchange.tokenId, buyerProposal, sellerProposal, sellerProposal);
        await expect(tx)
          .to.emit(verificationFacet, "VerdictSubmitted")
          .withArgs(exchange.verifierId, exchange.tokenId, VerificationStatus.Verified);

        const payout = payoutFeeCalculation(
          exchange.encumberedAmount,
          bosonProtocolFeePercentage,
          verifierFee,
          facilitatorFeePercent,
          sellerDeposit,
          defaultFermionFee,
          sellerProposal,
        );

        await expect(tx)
          .to.emit(verificationFacet, "AvailableFundsIncreased")
          .withArgs(buyerId, exchangeToken, payout.revisedBuyerPayout);
        await expect(tx)
          .to.emit(verificationFacet, "AvailableFundsIncreased")
          .withArgs(protocolId, exchangeToken, payout.fermionFeeAmount);
        await expect(tx)
          .to.emit(verificationFacet, "AvailableFundsIncreased")
          .withArgs(facilitatorId, exchangeToken, payout.facilitatorFeeAmount);
        await expect(tx)
          .to.emit(verificationFacet, "AvailableFundsIncreased")
          .withArgs(sellerId, exchangeToken, payout.remainder);

        await expect(tx).to.emit(entityFacet, "EntityStored").withArgs(buyerId, buyer.address, [EntityRole.Buyer], "");

        // Wrapper
        const wrapperAddress = await offerFacet.predictFermionFNFTAddress(exchange.offerId);
        const wrapper = await ethers.getContractAt("FermionFNFT", wrapperAddress);
        await expect(tx).to.emit(wrapper, "TokenStateChange").withArgs(exchange.tokenId, TokenState.Verified);

        // Boson
        await expect(tx).to.not.emit(bosonExchangeHandler, "ExchangeCompleted");

        // State
        // Fermion
        // Available funds
        expect(await fundsFacet.getAvailableFunds(exchange.verifierId, exchangeToken)).to.equal(verifierFee);
        expect(await fundsFacet.getAvailableFunds(facilitatorId, exchangeToken)).to.equal(payout.facilitatorFeeAmount);
        expect(await fundsFacet.getAvailableFunds(sellerId, exchangeToken)).to.equal(payout.remainder);
        expect(await fundsFacet.getAvailableFunds(buyerId, exchangeToken)).to.equal(payout.revisedBuyerPayout);
        expect(await fundsFacet.getAvailableFunds(protocolId, exchangeToken)).to.equal(payout.fermionFeeAmount); // fermion protocol fees

        // Wrapper
        expect(await wrapper.tokenState(exchange.tokenId)).to.equal(TokenState.Verified);
        expect(await wrapper.ownerOf(exchange.tokenId)).to.equal(buyer.address);
      });

      it("Seller submits first", async function () {
        await verificationFacet.connect(defaultSigner).submitProposal(exchange.tokenId, sellerProposal, metadataDigest);

        const buyerProposal = sellerProposal - 10n;

        const tx = verificationFacet.connect(buyer).submitProposal(exchange.tokenId, buyerProposal, metadataDigest);

        // Events
        // Fermion
        await expect(tx)
          .to.emit(verificationFacet, "ProposalSubmitted")
          .withArgs(exchange.tokenId, buyerProposal, sellerProposal, buyerProposal);
        await expect(tx)
          .to.emit(verificationFacet, "VerdictSubmitted")
          .withArgs(exchange.verifierId, exchange.tokenId, VerificationStatus.Verified);

        const payout = payoutFeeCalculation(
          exchange.encumberedAmount,
          bosonProtocolFeePercentage,
          verifierFee,
          facilitatorFeePercent,
          sellerDeposit,
          defaultFermionFee,
          buyerProposal,
        );

        await expect(tx)
          .to.emit(verificationFacet, "AvailableFundsIncreased")
          .withArgs(buyerId, exchangeToken, payout.revisedBuyerPayout);
        await expect(tx)
          .to.emit(verificationFacet, "AvailableFundsIncreased")
          .withArgs(protocolId, exchangeToken, payout.fermionFeeAmount);
        await expect(tx)
          .to.emit(verificationFacet, "AvailableFundsIncreased")
          .withArgs(facilitatorId, exchangeToken, payout.facilitatorFeeAmount);
        await expect(tx)
          .to.emit(verificationFacet, "AvailableFundsIncreased")
          .withArgs(sellerId, exchangeToken, payout.remainder);

        await expect(tx).to.emit(entityFacet, "EntityStored").withArgs(buyerId, buyer.address, [EntityRole.Buyer], "");

        // Wrapper
        const wrapperAddress = await offerFacet.predictFermionFNFTAddress(exchange.offerId);
        const wrapper = await ethers.getContractAt("FermionFNFT", wrapperAddress);
        await expect(tx).to.emit(wrapper, "TokenStateChange").withArgs(exchange.tokenId, TokenState.Verified);

        // Boson
        await expect(tx).to.not.emit(bosonExchangeHandler, "ExchangeCompleted");

        // State
        // Fermion
        // Available funds
        expect(await fundsFacet.getAvailableFunds(exchange.verifierId, exchangeToken)).to.equal(verifierFee);
        expect(await fundsFacet.getAvailableFunds(facilitatorId, exchangeToken)).to.equal(payout.facilitatorFeeAmount);
        expect(await fundsFacet.getAvailableFunds(sellerId, exchangeToken)).to.equal(payout.remainder);
        expect(await fundsFacet.getAvailableFunds(buyerId, exchangeToken)).to.equal(payout.revisedBuyerPayout);
        expect(await fundsFacet.getAvailableFunds(protocolId, exchangeToken)).to.equal(payout.fermionFeeAmount); // fermion protocol fees

        // Wrapper
        expect(await wrapper.tokenState(exchange.tokenId)).to.equal(TokenState.Verified);
        expect(await wrapper.ownerOf(exchange.tokenId)).to.equal(buyer.address);
      });

      it("Buyer can immediately accept without compensation", async function () {
        const buyerProposal = 0n;

        const tx = verificationFacet.connect(buyer).submitProposal(exchange.tokenId, buyerProposal, metadataDigest);

        // Events
        // Fermion
        await expect(tx)
          .to.emit(verificationFacet, "ProposalSubmitted")
          .withArgs(exchange.tokenId, buyerProposal, 0n, buyerProposal);
        await expect(tx)
          .to.emit(verificationFacet, "VerdictSubmitted")
          .withArgs(exchange.verifierId, exchange.tokenId, VerificationStatus.Verified);

        const payout = payoutFeeCalculation(
          exchange.encumberedAmount,
          bosonProtocolFeePercentage,
          verifierFee,
          facilitatorFeePercent,
          sellerDeposit,
          defaultFermionFee,
          buyerProposal,
        );

        await expect(tx)
          .to.emit(verificationFacet, "AvailableFundsIncreased")
          .withArgs(protocolId, exchangeToken, payout.fermionFeeAmount);
        await expect(tx)
          .to.emit(verificationFacet, "AvailableFundsIncreased")
          .withArgs(facilitatorId, exchangeToken, payout.facilitatorFeeAmount);
        await expect(tx)
          .to.emit(verificationFacet, "AvailableFundsIncreased")
          .withArgs(sellerId, exchangeToken, payout.remainder);

        await expect(tx).to.not.emit(entityFacet, "EntityStored"); // in this case no new buyer is created

        // Wrapper
        const wrapperAddress = await offerFacet.predictFermionFNFTAddress(exchange.offerId);
        const wrapper = await ethers.getContractAt("FermionFNFT", wrapperAddress);
        await expect(tx).to.emit(wrapper, "TokenStateChange").withArgs(exchange.tokenId, TokenState.Verified);

        // Boson
        await expect(tx).to.not.emit(bosonExchangeHandler, "ExchangeCompleted");

        // State
        // Fermion
        // Available funds
        expect(await fundsFacet.getAvailableFunds(exchange.verifierId, exchangeToken)).to.equal(verifierFee);
        expect(await fundsFacet.getAvailableFunds(facilitatorId, exchangeToken)).to.equal(payout.facilitatorFeeAmount);
        expect(await fundsFacet.getAvailableFunds(sellerId, exchangeToken)).to.equal(payout.remainder);
        expect(await fundsFacet.getAvailableFunds(buyerId, exchangeToken)).to.equal(0n);
        expect(await fundsFacet.getAvailableFunds(protocolId, exchangeToken)).to.equal(payout.fermionFeeAmount); // fermion protocol fees

        // Wrapper
        expect(await wrapper.tokenState(exchange.tokenId)).to.equal(TokenState.Verified);
        expect(await wrapper.ownerOf(exchange.tokenId)).to.equal(buyer.address);
      });
    });

    context("Revert reasons", function () {
      it("Verification region is paused", async function () {
        await pauseFacet.pause([PausableRegion.Verification]);

        await expect(verificationFacet.connect(buyer).submitProposal(exchange.tokenId, buyerProposal, metadataDigest))
          .to.be.revertedWithCustomError(fermionErrors, "RegionPaused")
          .withArgs(PausableRegion.Verification);
      });

      it("Invalid percentage", async function () {
        const buyerProposal = 100_01n; // 100.01%

        await expect(verificationFacet.connect(buyer).submitProposal(exchange.tokenId, buyerProposal, metadataDigest))
          .to.be.revertedWithCustomError(fermionErrors, "InvalidPercentage")
          .withArgs(buyerProposal);
      });

      it("Invalid metadata digest", async function () {
        const wrongMetadataDigest = id("https://example.com/wrong-metadata.json");

        await expect(
          verificationFacet.connect(buyer).submitProposal(exchange.tokenId, buyerProposal, wrongMetadataDigest),
        )
          .to.be.revertedWithCustomError(fermionErrors, "DigestMismatch")
          .withArgs(metadataDigest, wrongMetadataDigest);
      });

      it("Token does not exist", async function () {
        const tokenId = deriveTokenId("15", "4");

        await expect(
          verificationFacet.connect(buyer).submitProposal(tokenId, buyerProposal, metadataDigest),
        ).to.be.revertedWithCustomError(fermionErrors, "EmptyMetadata");
      });

      it("Cannot submit before it's unwrapped", async function () {
        const tokenId = deriveTokenId("3", "4"); // token that was wrapped but not unwrapped yet

        await expect(
          verificationFacet.connect(buyer).submitProposal(tokenId, buyerProposal, metadataDigest),
        ).to.be.revertedWithCustomError(verificationFacet, "EmptyMetadata");
      });

      it("Verification is timeouted", async function () {
        await verificationFacet.connect(buyer).submitProposal(exchange.tokenId, buyerProposal, metadataDigest);

        await setNextBlockTimestamp(itemVerificationTimeout);
        await verificationFacet.verificationTimeout(exchange.tokenId);

        await expect(
          verificationFacet.connect(buyer).submitProposal(exchange.tokenId, buyerProposal, metadataDigest),
        ).to.be.revertedWithCustomError(verificationFacet, "EmptyMetadata");
      });

      it("Verification is timeouted", async function () {
        await setNextBlockTimestamp(itemVerificationTimeout);
        await verificationFacet.verificationTimeout(exchange.tokenId);

        await expect(
          verificationFacet.connect(buyer).submitProposal(exchange.tokenId, buyerProposal, metadataDigest),
        ).to.be.revertedWithCustomError(verificationFacet, "EmptyMetadata");
      });

      it("Caller is not the buyer nor the seller", async function () {
        const wallet = wallets[9];
        await expect(verificationFacet.connect(wallet).submitProposal(exchange.tokenId, buyerProposal, metadataDigest))
          .to.be.revertedWithCustomError(fermionErrors, "AccountHasNoRole")
          .withArgs(sellerId, wallet.address, EntityRole.Seller, AccountRole.Assistant);
      });
    });
  });

  context("submitSignedProposal", function () {
    const newMetadataURI = "https://example.com/new-metadata.json";
    const metadataDigest = id(newMetadataURI);
    const buyerProposal = 20_00n; // 20%
    const sellerProposal = 10_00n; // 10%
    const signedProposalType = [
      { name: "tokenId", type: "uint256" },
      { name: "buyerPercent", type: "uint16" },
      { name: "metadataURIDigest", type: "bytes32" },
    ];
    let message: any;

    beforeEach(async function () {
      await verificationFacet.connect(verifier).submitRevisedMetadata(exchange.tokenId, newMetadataURI);

      message = {
        tokenId: String(exchange.tokenId),
        buyerPercent: String(sellerProposal),
        metadataURIDigest: metadataDigest,
      };

      const digest = ethers.keccak256(abiCoder.encode(["tuple(address,uint256)[]"], [[]]));
      await verificationFacet.connect(verifier).verifyPhygitals(exchange.tokenId, digest);
    });

    context("Matching proposals", function () {
      const buyerId = "5"; // new buyer in fermion

      it("Buyer submits seller's signed proposal first", async function () {
        const { r, s, v } = await prepareDataSignatureParameters(
          defaultSigner,
          {
            SignedProposal: signedProposalType,
          },
          "SignedProposal",
          message,
          await verificationFacet.getAddress(),
        );

        const tx = await verificationFacet
          .connect(buyer)
          .submitSignedProposal(exchange.tokenId, sellerProposal, metadataDigest, defaultSigner.address, { r, s, v });

        // Events
        // Fermion
        await expect(tx)
          .to.emit(verificationFacet, "ProposalSubmitted")
          .withArgs(exchange.tokenId, sellerProposal, sellerProposal, sellerProposal);
        await expect(tx)
          .to.emit(verificationFacet, "VerdictSubmitted")
          .withArgs(exchange.verifierId, exchange.tokenId, VerificationStatus.Verified);

        const payout = payoutFeeCalculation(
          exchange.encumberedAmount,
          bosonProtocolFeePercentage,
          verifierFee,
          facilitatorFeePercent,
          sellerDeposit,
          defaultFermionFee,
          sellerProposal,
        );

        await expect(tx)
          .to.emit(verificationFacet, "AvailableFundsIncreased")
          .withArgs(buyerId, exchangeToken, payout.revisedBuyerPayout);
        await expect(tx)
          .to.emit(verificationFacet, "AvailableFundsIncreased")
          .withArgs(protocolId, exchangeToken, payout.fermionFeeAmount);
        await expect(tx)
          .to.emit(verificationFacet, "AvailableFundsIncreased")
          .withArgs(facilitatorId, exchangeToken, payout.facilitatorFeeAmount);
        await expect(tx)
          .to.emit(verificationFacet, "AvailableFundsIncreased")
          .withArgs(sellerId, exchangeToken, payout.remainder);

        await expect(tx).to.emit(entityFacet, "EntityStored").withArgs(buyerId, buyer.address, [EntityRole.Buyer], "");

        // Wrapper
        const wrapperAddress = await offerFacet.predictFermionFNFTAddress(exchange.offerId);
        const wrapper = await ethers.getContractAt("FermionFNFT", wrapperAddress);
        await expect(tx).to.emit(wrapper, "TokenStateChange").withArgs(exchange.tokenId, TokenState.Verified);

        // Boson
        await expect(tx).to.not.emit(bosonExchangeHandler, "ExchangeCompleted");

        // State
        // Fermion
        // Available funds
        expect(await fundsFacet.getAvailableFunds(exchange.verifierId, exchangeToken)).to.equal(verifierFee);
        expect(await fundsFacet.getAvailableFunds(facilitatorId, exchangeToken)).to.equal(payout.facilitatorFeeAmount);
        expect(await fundsFacet.getAvailableFunds(sellerId, exchangeToken)).to.equal(payout.remainder);
        expect(await fundsFacet.getAvailableFunds(buyerId, exchangeToken)).to.equal(payout.revisedBuyerPayout);
        expect(await fundsFacet.getAvailableFunds(protocolId, exchangeToken)).to.equal(payout.fermionFeeAmount); // fermion protocol fees

        // Wrapper
        expect(await wrapper.tokenState(exchange.tokenId)).to.equal(TokenState.Verified);
        expect(await wrapper.ownerOf(exchange.tokenId)).to.equal(buyer.address);
      });

      it("Seller submits buyer's signed proposal", async function () {
        message.buyerPercent = String(buyerProposal);

        const { r, s, v } = await prepareDataSignatureParameters(
          buyer,
          {
            SignedProposal: signedProposalType,
          },
          "SignedProposal",
          message,
          await verificationFacet.getAddress(),
        );

        const tx = await verificationFacet
          .connect(defaultSigner)
          .submitSignedProposal(exchange.tokenId, buyerProposal, metadataDigest, buyer.address, { r, s, v });

        // Events
        // Fermion
        await expect(tx)
          .to.emit(verificationFacet, "ProposalSubmitted")
          .withArgs(exchange.tokenId, buyerProposal, buyerProposal, buyerProposal);
        await expect(tx)
          .to.emit(verificationFacet, "VerdictSubmitted")
          .withArgs(exchange.verifierId, exchange.tokenId, VerificationStatus.Verified);

        const payout = payoutFeeCalculation(
          exchange.encumberedAmount,
          bosonProtocolFeePercentage,
          verifierFee,
          facilitatorFeePercent,
          sellerDeposit,
          defaultFermionFee,
          buyerProposal,
        );

        await expect(tx)
          .to.emit(verificationFacet, "AvailableFundsIncreased")
          .withArgs(buyerId, exchangeToken, payout.revisedBuyerPayout);
        await expect(tx)
          .to.emit(verificationFacet, "AvailableFundsIncreased")
          .withArgs(protocolId, exchangeToken, payout.fermionFeeAmount);
        await expect(tx)
          .to.emit(verificationFacet, "AvailableFundsIncreased")
          .withArgs(facilitatorId, exchangeToken, payout.facilitatorFeeAmount);
        await expect(tx)
          .to.emit(verificationFacet, "AvailableFundsIncreased")
          .withArgs(sellerId, exchangeToken, payout.remainder);

        await expect(tx).to.emit(entityFacet, "EntityStored").withArgs(buyerId, buyer.address, [EntityRole.Buyer], "");

        // Wrapper
        const wrapperAddress = await offerFacet.predictFermionFNFTAddress(exchange.offerId);
        const wrapper = await ethers.getContractAt("FermionFNFT", wrapperAddress);
        await expect(tx).to.emit(wrapper, "TokenStateChange").withArgs(exchange.tokenId, TokenState.Verified);

        // Boson
        await expect(tx).to.not.emit(bosonExchangeHandler, "ExchangeCompleted");

        // State
        // Fermion
        // Available funds
        expect(await fundsFacet.getAvailableFunds(exchange.verifierId, exchangeToken)).to.equal(verifierFee);
        expect(await fundsFacet.getAvailableFunds(facilitatorId, exchangeToken)).to.equal(payout.facilitatorFeeAmount);
        expect(await fundsFacet.getAvailableFunds(sellerId, exchangeToken)).to.equal(payout.remainder);
        expect(await fundsFacet.getAvailableFunds(buyerId, exchangeToken)).to.equal(payout.revisedBuyerPayout);
        expect(await fundsFacet.getAvailableFunds(protocolId, exchangeToken)).to.equal(payout.fermionFeeAmount); // fermion protocol fees

        // Wrapper
        expect(await wrapper.tokenState(exchange.tokenId)).to.equal(TokenState.Verified);
        expect(await wrapper.ownerOf(exchange.tokenId)).to.equal(buyer.address);
      });
    });

    context("Revert reasons", function () {
      it("Verification region is paused", async function () {
        const { r, s, v } = await prepareDataSignatureParameters(
          defaultSigner,
          {
            SignedProposal: signedProposalType,
          },
          "SignedProposal",
          message,
          await verificationFacet.getAddress(),
        );

        await pauseFacet.pause([PausableRegion.Verification]);

        await expect(
          verificationFacet
            .connect(buyer)
            .submitSignedProposal(exchange.tokenId, sellerProposal, metadataDigest, defaultSigner.address, { r, s, v }),
        )
          .to.be.revertedWithCustomError(fermionErrors, "RegionPaused")
          .withArgs(PausableRegion.Verification);
      });

      it("Invalid percentage", async function () {
        const sellerProposal = 100_01n; // 100.01%
        message.buyerPercent = String(sellerProposal);

        const { r, s, v } = await prepareDataSignatureParameters(
          defaultSigner,
          {
            SignedProposal: signedProposalType,
          },
          "SignedProposal",
          message,
          await verificationFacet.getAddress(),
        );

        await expect(
          verificationFacet
            .connect(buyer)
            .submitSignedProposal(exchange.tokenId, sellerProposal, metadataDigest, defaultSigner.address, { r, s, v }),
        )
          .to.be.revertedWithCustomError(fermionErrors, "InvalidPercentage")
          .withArgs(sellerProposal);
      });

      it("Invalid metadata digest", async function () {
        const wrongMetadataDigest = id("https://example.com/wrong-metadata.json");
        message.metadataURIDigest = wrongMetadataDigest;

        const { r, s, v } = await prepareDataSignatureParameters(
          defaultSigner,
          {
            SignedProposal: signedProposalType,
          },
          "SignedProposal",
          message,
          await verificationFacet.getAddress(),
        );

        await expect(
          verificationFacet
            .connect(buyer)
            .submitSignedProposal(exchange.tokenId, sellerProposal, wrongMetadataDigest, defaultSigner.address, {
              r,
              s,
              v,
            }),
        )
          .to.be.revertedWithCustomError(fermionErrors, "DigestMismatch")
          .withArgs(metadataDigest, wrongMetadataDigest);
      });

      it("Token does not exist", async function () {
        const tokenId = deriveTokenId("15", "4");
        message.tokenId = String(tokenId);

        const { r, s, v } = await prepareDataSignatureParameters(
          defaultSigner,
          {
            SignedProposal: signedProposalType,
          },
          "SignedProposal",
          message,
          await verificationFacet.getAddress(),
        );

        await expect(
          verificationFacet
            .connect(buyer)
            .submitSignedProposal(tokenId, sellerProposal, metadataDigest, defaultSigner.address, { r, s, v }),
        ).to.be.revertedWithCustomError(fermionErrors, "EmptyMetadata");
      });

      it("Cannot submit before it's unwrapped", async function () {
        const tokenId = deriveTokenId("3", "4"); // token that was wrapped but not unwrapped yet
        message.tokenId = String(tokenId);

        const { r, s, v } = await prepareDataSignatureParameters(
          defaultSigner,
          {
            SignedProposal: signedProposalType,
          },
          "SignedProposal",
          message,
          await verificationFacet.getAddress(),
        );

        await expect(
          verificationFacet
            .connect(buyer)
            .submitSignedProposal(tokenId, sellerProposal, metadataDigest, defaultSigner.address, { r, s, v }),
        ).to.be.revertedWithCustomError(verificationFacet, "EmptyMetadata");
      });

      it("Verification is timeouted", async function () {
        await setNextBlockTimestamp(itemVerificationTimeout);
        await verificationFacet.verificationTimeout(exchange.tokenId);

        const { r, s, v } = await prepareDataSignatureParameters(
          defaultSigner,
          {
            SignedProposal: signedProposalType,
          },
          "SignedProposal",
          message,
          await verificationFacet.getAddress(),
        );

        await expect(
          verificationFacet
            .connect(buyer)
            .submitSignedProposal(exchange.tokenId, sellerProposal, metadataDigest, defaultSigner.address, { r, s, v }),
        ).to.be.revertedWithCustomError(verificationFacet, "EmptyMetadata");
      });

      it("Caller is not the buyer nor the seller", async function () {
        const { r, s, v } = await prepareDataSignatureParameters(
          defaultSigner,
          {
            SignedProposal: signedProposalType,
          },
          "SignedProposal",
          message,
          await verificationFacet.getAddress(),
        );

        const wallet = wallets[9];
        await expect(
          verificationFacet
            .connect(wallet)
            .submitSignedProposal(exchange.tokenId, sellerProposal, metadataDigest, defaultSigner.address, { r, s, v }),
        )
          .to.be.revertedWithCustomError(fermionErrors, "AccountHasNoRole")
          .withArgs(sellerId, wallet.address, EntityRole.Seller, AccountRole.Assistant);
      });

      it("Sender does not match the recovered signer", async function () {
        const { r, s, v } = await prepareDataSignatureParameters(
          defaultSigner,
          {
            SignedProposal: signedProposalType,
          },
          "SignedProposal",
          message,
          await verificationFacet.getAddress(),
        );

        // wrong address
        await expect(
          verificationFacet
            .connect(buyer)
            .submitSignedProposal(exchange.tokenId, sellerProposal, metadataDigest, wallets[9].address, { r, s, v }),
        ).to.be.revertedWithCustomError(fermionErrors, "SignatureValidationFailed");

        // wrong tokenId
        await expect(
          verificationFacet
            .connect(buyer)
            .submitSignedProposal(deriveTokenId(999, 999), sellerProposal, metadataDigest, defaultSigner.address, {
              r,
              s,
              v,
            }),
        ).to.be.revertedWithCustomError(fermionErrors, "SignatureValidationFailed");

        // wrong percentage
        await expect(
          verificationFacet
            .connect(buyer)
            .submitSignedProposal(exchange.tokenId, buyerProposal, metadataDigest, defaultSigner.address, { r, s, v }),
        ).to.be.revertedWithCustomError(fermionErrors, "SignatureValidationFailed");

        // wrong metadata
        await expect(
          verificationFacet
            .connect(buyer)
            .submitSignedProposal(
              exchange.tokenId,
              sellerProposal,
              id("https://example.com/wrong-metadata.json"),
              defaultSigner.address,
              { r, s, v },
            ),
        ).to.be.revertedWithCustomError(fermionErrors, "SignatureValidationFailed");
      });

      it("Signature is invalid", async function () {
        const { r, s, v } = await prepareDataSignatureParameters(
          defaultSigner,
          {
            SignedProposal: signedProposalType,
          },
          "SignedProposal",
          message,
          await verificationFacet.getAddress(),
        );

        await expect(
          verificationFacet
            .connect(buyer)
            .submitSignedProposal(exchange.tokenId, sellerProposal, metadataDigest, defaultSigner.address, {
              r,
              s: toBeHex(MaxUint256),
              v,
            }),
        ).to.be.revertedWithCustomError(fermionErrors, "InvalidSignature");

        await expect(
          verificationFacet
            .connect(buyer)
            .submitSignedProposal(exchange.tokenId, sellerProposal, metadataDigest, defaultSigner.address, {
              r,
              s: toBeHex(0n, 32),
              v,
            }),
        ).to.be.revertedWithCustomError(fermionErrors, "InvalidSignature");

        await expect(
          verificationFacet
            .connect(buyer)
            .submitSignedProposal(exchange.tokenId, sellerProposal, metadataDigest, defaultSigner.address, {
              r,
              s,
              v: 32,
            }),
        ).to.be.revertedWithCustomError(fermionErrors, "InvalidSignature");
      });

      it("Buyer submits a proposal, not signed by the seller", async function () {
        message.buyerPercent = String(buyerProposal);

        const { r, s, v } = await prepareDataSignatureParameters(
          buyer,
          {
            SignedProposal: signedProposalType,
          },
          "SignedProposal",
          message,
          await verificationFacet.getAddress(),
        );

        await expect(
          verificationFacet
            .connect(buyer)
            .submitSignedProposal(exchange.tokenId, buyerProposal, metadataDigest, buyer.address, { r, s, v }),
        )
          .to.be.revertedWithCustomError(fermionErrors, "AccountHasNoRole")
          .withArgs(sellerId, buyer.address, EntityRole.Seller, AccountRole.Assistant);
      });

      it("Seller submits a proposal, not signed by the buyer", async function () {
        const { r, s, v } = await prepareDataSignatureParameters(
          defaultSigner,
          {
            SignedProposal: signedProposalType,
          },
          "SignedProposal",
          message,
          await verificationFacet.getAddress(),
        );

        await expect(
          verificationFacet.submitSignedProposal(
            exchange.tokenId,
            sellerProposal,
            metadataDigest,
            defaultSigner.address,
            { r, s, v },
          ),
        )
          .to.be.revertedWithCustomError(fermionErrors, "InvalidSigner")
          .withArgs(buyer.address, defaultSigner.address);
      });
    });
  });

  context("verificationTimeout", function () {
    let randomWallet: HardhatEthersSigner;

    before(async function () {
      randomWallet = wallets[9];
    });

    beforeEach(async function () {
      await setNextBlockTimestamp(itemVerificationTimeout);
    });

    context("Anyone can timeout if the verifier is inactive", function () {
      const buyerId = "5"; // new buyer in fermion
      it("Normal sale", async function () {
        const tx = await verificationFacet.connect(randomWallet).verificationTimeout(exchange.tokenId);

        // Events
        // Fermion
        await expect(tx)
          .to.emit(verificationFacet, "VerdictSubmitted")
          .withArgs(exchange.verifierId, exchange.tokenId, VerificationStatus.Rejected);
        await expect(tx)
          .to.emit(verificationFacet, "AvailableFundsIncreased")
          .withArgs(
            buyerId,
            exchangeToken,
            exchange.payout.remainder + exchange.payout.facilitatorFeeAmount + verifierFee,
          );
        await expect(tx)
          .to.emit(verificationFacet, "AvailableFundsIncreased")
          .withArgs(protocolId, exchangeToken, exchange.payout.fermionFeeAmount);
        await expect(tx).to.emit(entityFacet, "EntityStored").withArgs(buyerId, buyer.address, [EntityRole.Buyer], "");

        // Wrapper
        const wrapperAddress = await offerFacet.predictFermionFNFTAddress(exchange.offerId);
        const wrapper = await ethers.getContractAt("FermionFNFT", wrapperAddress);
        await expect(tx).to.emit(wrapper, "TokenStateChange").withArgs(exchange.tokenId, TokenState.Burned);
        await expect(tx).to.not.emit(wrapper, "FixedPriceSale");

        // Boson
        await expect(tx)
          .to.emit(bosonExchangeHandler, "ExchangeCompleted")
          .withArgs(exchange.offerId, bosonBuyerId, exchange.exchangeId, fermionProtocolAddress);

        // State
        // Fermion
        // Available funds
        expect(await fundsFacet.getAvailableFunds(exchange.verifierId, exchangeToken)).to.equal(0n);
        expect(await fundsFacet.getAvailableFunds(facilitatorId, exchangeToken)).to.equal(0n);
        expect(await fundsFacet.getAvailableFunds(buyerId, exchangeToken)).to.equal(
          exchange.payout.remainder + exchange.payout.facilitatorFeeAmount + verifierFee,
        );
        expect(await fundsFacet.getAvailableFunds(sellerId, exchangeToken)).to.equal(0n);
        expect(await fundsFacet.getAvailableFunds(protocolId, exchangeToken)).to.equal(
          exchange.payout.fermionFeeAmount,
        );

        // Wrapper
        expect(await wrapper.tokenState(exchange.tokenId)).to.equal(TokenState.Burned);
        await expect(wrapper.ownerOf(exchange.tokenId))
          .to.be.revertedWithCustomError(wrapper, "ERC721NonexistentToken")
          .withArgs(exchange.tokenId);
      });

      it("Self sale", async function () {
        const tx = await verificationFacet.connect(randomWallet).verificationTimeout(exchangeSelfSale.tokenId);

        // Events
        // Fermion
        await expect(tx)
          .to.emit(verificationFacet, "VerdictSubmitted")
          .withArgs(exchangeSelfSale.verifierId, exchangeSelfSale.tokenId, VerificationStatus.Rejected);
        await expect(tx)
          .to.emit(verificationFacet, "AvailableFundsIncreased")
          .withArgs(protocolId, exchangeToken, exchangeSelfSale.payout.fermionFeeAmount);
        await expect(tx)
          .to.emit(verificationFacet, "AvailableFundsIncreased")
          .withArgs(sellerId, exchangeToken, verifierFee);
        await expect(tx).to.not.emit(entityFacet, "EntityStored"); // no buyer is created, since the entity exist already

        // Wrapper
        const wrapperAddress = await offerFacet.predictFermionFNFTAddress(exchangeSelfSale.offerId);
        const wrapper = await ethers.getContractAt("FermionFNFT", wrapperAddress);
        await expect(tx).to.emit(wrapper, "TokenStateChange").withArgs(exchangeSelfSale.tokenId, TokenState.Burned);
        await expect(tx).to.not.emit(wrapper, "FixedPriceSale");

        // Boson
        await expect(tx)
          .to.emit(bosonExchangeHandler, "ExchangeCompleted")
          .withArgs(exchangeSelfSale.offerId, bosonBuyerId, exchangeSelfSale.exchangeId, fermionProtocolAddress);

        // State
        // Fermion
        // Available funds
        expect(await fundsFacet.getAvailableFunds(exchangeSelfSale.verifierId, exchangeToken)).to.equal(0);
        expect(await fundsFacet.getAvailableFunds(facilitatorId, exchangeToken)).to.equal(0);
        expect(await fundsFacet.getAvailableFunds(sellerId, exchangeToken)).to.equal(verifierFee);
        expect(await fundsFacet.getAvailableFunds(protocolId, exchangeToken)).to.equal(
          exchangeSelfSale.payout.fermionFeeAmount,
        );

        // Wrapper
        expect(await wrapper.tokenState(exchangeSelfSale.tokenId)).to.equal(TokenState.Burned);
        await expect(wrapper.ownerOf(exchangeSelfSale.tokenId))
          .to.be.revertedWithCustomError(wrapper, "ERC721NonexistentToken")
          .withArgs(exchangeSelfSale.tokenId);
      });

      it("Self verification", async function () {
        const tx = await verificationFacet.connect(randomWallet).verificationTimeout(exchangeSelfVerification.tokenId);

        // Events
        // Fermion
        await expect(tx)
          .to.emit(verificationFacet, "VerdictSubmitted")
          .withArgs(sellerId, exchangeSelfVerification.tokenId, VerificationStatus.Rejected);
        await expect(tx)
          .to.emit(verificationFacet, "AvailableFundsIncreased")
          .withArgs(
            buyerId,
            exchangeToken,
            exchangeSelfVerification.payout.remainder + exchangeSelfVerification.payout.facilitatorFeeAmount,
          ); // verifier fee is 0, so it's not added
        await expect(tx)
          .to.emit(verificationFacet, "AvailableFundsIncreased")
          .withArgs(protocolId, exchangeToken, exchangeSelfVerification.payout.fermionFeeAmount);
        await expect(tx).to.emit(entityFacet, "EntityStored").withArgs(buyerId, buyer.address, [EntityRole.Buyer], "");

        // Wrapper
        const wrapperAddress = await offerFacet.predictFermionFNFTAddress(exchangeSelfVerification.offerId);
        const wrapper = await ethers.getContractAt("FermionFNFT", wrapperAddress);
        await expect(tx)
          .to.emit(wrapper, "TokenStateChange")
          .withArgs(exchangeSelfVerification.tokenId, TokenState.Burned);
        await expect(tx).to.not.emit(wrapper, "FixedPriceSale");

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
        expect(await fundsFacet.getAvailableFunds(buyerId, exchangeToken)).to.equal(
          exchangeSelfVerification.payout.remainder + exchangeSelfVerification.payout.facilitatorFeeAmount,
        ); // verifier fee is 0, so it's not added
        expect(await fundsFacet.getAvailableFunds(sellerId, exchangeToken)).to.equal(0n);
        expect(await fundsFacet.getAvailableFunds(protocolId, exchangeToken)).to.equal(
          exchangeSelfVerification.payout.fermionFeeAmount,
        );

        // Wrapper
        expect(await wrapper.tokenState(exchangeSelfVerification.tokenId)).to.equal(TokenState.Burned);
        await expect(wrapper.ownerOf(exchangeSelfVerification.tokenId))
          .to.be.revertedWithCustomError(wrapper, "ERC721NonexistentToken")
          .withArgs(exchangeSelfVerification.tokenId);
      });

      it("Self sale self verification", async function () {
        const tx = await verificationFacet
          .connect(randomWallet)
          .verificationTimeout(exchangeSelfSaleSelfVerification.tokenId);

        // Events
        // Fermion
        await expect(tx)
          .to.emit(verificationFacet, "VerdictSubmitted")
          .withArgs(sellerId, exchangeSelfSaleSelfVerification.tokenId, VerificationStatus.Rejected);
        await expect(tx).to.not.emit(verificationFacet, "AvailableFundsIncreased");

        // Wrapper
        const wrapperAddress = await offerFacet.predictFermionFNFTAddress(exchangeSelfSaleSelfVerification.offerId);
        const wrapper = await ethers.getContractAt("FermionFNFT", wrapperAddress);
        await expect(tx)
          .to.emit(wrapper, "TokenStateChange")
          .withArgs(exchangeSelfSaleSelfVerification.tokenId, TokenState.Burned);
        await expect(tx).to.not.emit(wrapper, "FixedPriceSale");

        // Boson
        await expect(tx)
          .to.emit(bosonExchangeHandler, "ExchangeCompleted")
          .withArgs(
            exchangeSelfSaleSelfVerification.offerId,
            bosonBuyerId,
            exchangeSelfSaleSelfVerification.exchangeId,
            fermionProtocolAddress,
          );

        // State
        // Fermion
        // Available funds
        expect(await fundsFacet.getAvailableFunds(buyerId, exchangeToken)).to.equal(
          exchangeSelfSaleSelfVerification.payout.remainder +
            exchangeSelfSaleSelfVerification.payout.facilitatorFeeAmount,
        ); // verifier fee is 0, so it's not added
        expect(await fundsFacet.getAvailableFunds(sellerId, exchangeToken)).to.equal(0n);
        expect(await fundsFacet.getAvailableFunds(protocolId, exchangeToken)).to.equal(
          exchangeSelfSaleSelfVerification.payout.fermionFeeAmount,
        );

        // Wrapper
        expect(await wrapper.tokenState(exchangeSelfSaleSelfVerification.tokenId)).to.equal(TokenState.Burned);
        await expect(wrapper.ownerOf(exchangeSelfSaleSelfVerification.tokenId))
          .to.be.revertedWithCustomError(wrapper, "ERC721NonexistentToken")
          .withArgs(exchangeSelfSaleSelfVerification.tokenId);
      });

      it.skip("Works even if the item was revised, but the verifier gets paid", async function () {});
    });

    context("Revert reasons", function () {
      it("Verification region is paused", async function () {
        await pauseFacet.pause([PausableRegion.Verification]);

        await expect(verificationFacet.verificationTimeout(exchange.tokenId))
          .to.be.revertedWithCustomError(fermionErrors, "RegionPaused")
          .withArgs(PausableRegion.Verification);
      });

      it("Cannot verify twice", async function () {
        await verificationFacet.connect(randomWallet).verificationTimeout(exchange.tokenId);

        await expect(
          verificationFacet.connect(randomWallet).verificationTimeout(exchange.tokenId),
        ).to.be.revertedWithCustomError(bosonExchangeHandler, "InvalidState");
      });

      it("Cannot verify before the timeout is over", async function () {
        const newTimeout = BigInt(itemVerificationTimeout) + 24n * 60n * 60n * 10n;
        const nextBlockTimestamp = newTimeout - 1000n;

        await verificationFacet.changeVerificationTimeout(exchange.tokenId, newTimeout);

        await setNextBlockTimestamp(String(nextBlockTimestamp));

        await expect(verificationFacet.connect(randomWallet).verificationTimeout(exchange.tokenId))
          .to.be.revertedWithCustomError(verificationFacet, "VerificationTimeoutNotPassed")
          .withArgs(newTimeout, nextBlockTimestamp);
      });
    });
  });

  context("verifyPhygitals", function () {
    let phygital1: { contractAddress: string; tokenId: bigint },
      phygital2: { contractAddress: string; tokenId: bigint };
    const phygitalTokenId = 10n,
      phygitalTokenId2 = 112n;
    let digest: string;

    before(async function () {
      phygital1 = { contractAddress: await mockPhygital1.getAddress(), tokenId: phygitalTokenId };
      phygital2 = { contractAddress: await mockPhygital2.getAddress(), tokenId: phygitalTokenId2 };
      digest = keccak256(
        abiCoder.encode(["tuple(address,uint256)[]"], [[Object.values(phygital1), Object.values(phygital2)]]),
      );
    });

    beforeEach(async function () {
      await mockPhygital1.mint(defaultSigner.address, phygitalTokenId, 1n);
      await mockPhygital1.approve(fermionProtocolAddress, phygitalTokenId);

      await mockPhygital2.mint(defaultSigner.address, phygitalTokenId2, 1n);
      await mockPhygital2.approve(fermionProtocolAddress, phygitalTokenId2);

      await fundsFacet.depositPhygitals([exchange.tokenId], [[phygital1, phygital2]]);
    });

    it("Verifier can verify phygitals", async function () {
      const tx = await verificationFacet.connect(verifier).verifyPhygitals(exchange.tokenId, digest);

      await expect(tx).to.emit(verificationFacet, "PhygitalsVerified").withArgs(exchange.tokenId, verifier.address);
    });

    it("Buyer can verify phygitals", async function () {
      const tx = await verificationFacet.connect(buyer).verifyPhygitals(exchange.tokenId, digest);

      await expect(tx).to.emit(verificationFacet, "PhygitalsVerified").withArgs(exchange.tokenId, buyer.address);
    });

    it("It's possible to verify empty phygitals", async function () {
      await fundsFacet
        .connect(defaultSigner)
        ["withdrawPhygitals(uint256[],(address,uint256)[][])"]([exchange.tokenId], [[phygital1, phygital2]]);

      const digest = keccak256(abiCoder.encode(["tuple(address,uint256)[]"], [[]]));
      const tx = await verificationFacet.connect(buyer).verifyPhygitals(exchange.tokenId, digest);

      await expect(tx).to.emit(verificationFacet, "PhygitalsVerified").withArgs(exchange.tokenId, buyer.address);
    });

    context("Revert reasons", function () {
      it("Verification region is paused", async function () {
        await pauseFacet.pause([PausableRegion.Verification]);

        await expect(verificationFacet.connect(verifier).verifyPhygitals(exchange.tokenId, digest))
          .to.be.revertedWithCustomError(fermionErrors, "RegionPaused")
          .withArgs(PausableRegion.Verification);
      });

      it("Offer is without phygitals", async function () {
        await expect(verificationFacet.connect(verifier).verifyPhygitals(exchangeSelfSale.tokenId, digest))
          .to.be.revertedWithCustomError(fermionErrors, "NoPhygitalOffer")
          .withArgs(exchangeSelfSale.tokenId);
      });

      it("Phygitals are already verified", async function () {
        await verificationFacet.connect(verifier).verifyPhygitals(exchange.tokenId, digest);

        await expect(verificationFacet.connect(verifier).verifyPhygitals(exchange.tokenId, digest))
          .to.be.revertedWithCustomError(fermionErrors, "PhygitalsAlreadyVerified")
          .withArgs(exchange.tokenId);
      });

      it("The caller is not the verifier or the buyer", async function () {
        const randomWallet = wallets[9];

        await expect(verificationFacet.connect(randomWallet).verifyPhygitals(exchange.tokenId, digest))
          .to.be.revertedWithCustomError(fermionErrors, "AccessDenied")
          .withArgs(randomWallet.address);
      });

      it("The digest does not match the expected digest", async function () {
        // Seller withdraws one phygital, the digest changes
        await fundsFacet
          .connect(defaultSigner)
          ["withdrawPhygitals(uint256[],(address,uint256)[][])"]([exchange.tokenId], [[phygital1]]);

        const newDigest = keccak256(abiCoder.encode(["tuple(address,uint256)[]"], [[Object.values(phygital2)]]));

        await expect(verificationFacet.connect(verifier).verifyPhygitals(exchange.tokenId, digest))
          .to.be.revertedWithCustomError(fermionErrors, "PhygitalsDigestMismatch")
          .withArgs(exchange.tokenId, newDigest, digest);
      });

      it("Cannot verify once the phygitals are withdrawn", async function () {
        await verificationFacet.connect(verifier).verifyPhygitals(exchange.tokenId, digest);
        await verificationFacet.connect(verifier).submitVerdict(exchange.tokenId, VerificationStatus.Verified);
        await custodyFacet.connect(custodian).checkIn(exchange.tokenId);
        const fermionFnftAddress = await offerFacet.predictFermionFNFTAddress(exchange.offerId);
        const fermionFnft = await ethers.getContractAt("FermionFNFT", fermionFnftAddress);
        await fermionFnft.connect(buyer).approve(fermionProtocolAddress, exchange.tokenId);
        await custodyFacet.connect(buyer).requestCheckOut(exchange.tokenId);
        await custodyFacet.clearCheckoutRequest(exchange.tokenId);
        await fundsFacet.connect(buyer)["withdrawPhygitals(uint256[],address)"]([exchange.tokenId], buyer.address);

        await expect(verificationFacet.connect(verifier).verifyPhygitals(exchange.tokenId, digest))
          .to.be.revertedWithCustomError(fermionErrors, "PhygitalsAlreadyVerified")
          .withArgs(exchange.tokenId);
      });

      it("FNFT is not in unverified state", async function () {
        const offerId = await (await getBosonHandler("IBosonOfferHandler")).getNextOfferId();
        const exchangeId = await bosonExchangeHandler.getNextExchangeId();

        const tokenId = deriveTokenId(offerId, exchangeId);
        // Create offer
        const fermionOffer = {
          sellerId,
          sellerDeposit,
          verifierId,
          verifierFee,
          custodianId: sellerId,
          custodianFee: {
            amount: parseEther("0.05"),
            period: 30n * 24n * 60n * 60n, // 30 days
          },
          facilitatorId: sellerId,
          facilitatorFeePercent: "0",
          exchangeToken: await mockToken.getAddress(),
          withPhygital: true,
          metadataURI: "https://example.com/offer-metadata.json",
          metadataHash: ZeroHash,
        };

        await offerFacet.createOffer(fermionOffer);
        await offerFacet.mintAndWrapNFTs(offerId, 1n);

        // Inexistent FNFT
        await expect(verificationFacet.connect(verifier).verifyPhygitals(tokenId + 1n, digest))
          .to.be.revertedWithCustomError(fermionErrors, "InvalidTokenState")
          .withArgs(tokenId + 1n, TokenState.Inexistent);

        // Wrapped
        await expect(verificationFacet.connect(verifier).verifyPhygitals(tokenId, digest))
          .to.be.revertedWithCustomError(fermionErrors, "InvalidTokenState")
          .withArgs(tokenId, TokenState.Wrapped);

        await mockToken.approve(fermionProtocolAddress, sellerDeposit); // approve to transfer seller deposit during the unwrapping
        const createBuyerAdvancedOrder = createBuyerAdvancedOrderClosure(
          wallets,
          seaportAddress,
          mockToken,
          offerFacet,
        );
        const { buyerAdvancedOrder } = await createBuyerAdvancedOrder(buyer, offerId.toString(), exchangeId);
        await offerFacet.unwrapNFT(tokenId, WrapType.OS_AUCTION, buyerAdvancedOrder);

        await fundsFacet
          .connect(defaultSigner)
          ["withdrawPhygitals(uint256[],(address,uint256)[][])"]([exchange.tokenId], [[phygital1]]);
        await mockPhygital1.approve(fermionProtocolAddress, phygitalTokenId);
        await fundsFacet.depositPhygitals([tokenId], [[phygital1]]);
        const newDigest = keccak256(abiCoder.encode(["tuple(address,uint256)[]"], [[Object.values(phygital1)]]));
        await verificationFacet.connect(verifier).verifyPhygitals(tokenId, newDigest);
        await verificationFacet.connect(verifier).submitVerdict(tokenId, VerificationStatus.Verified);

        // Verified
        await expect(verificationFacet.connect(verifier).verifyPhygitals(tokenId, newDigest))
          .to.be.revertedWithCustomError(fermionErrors, "PhygitalsAlreadyVerified")
          .withArgs(tokenId);

        // CheckedIn
        await custodyFacet.checkIn(tokenId);
        await expect(verificationFacet.connect(verifier).verifyPhygitals(tokenId, newDigest))
          .to.be.revertedWithCustomError(fermionErrors, "PhygitalsAlreadyVerified")
          .withArgs(tokenId);

        // CheckedOut
        const fermionFNFTAddress = await offerFacet.predictFermionFNFTAddress(offerId);
        const fermionFNFT = await ethers.getContractAt("FermionFNFT", fermionFNFTAddress);
        await fermionFNFT.connect(buyer).approve(await custodyFacet.getAddress(), tokenId);
        await custodyFacet.connect(buyer).requestCheckOut(tokenId);
        await custodyFacet.clearCheckoutRequest(tokenId);
        await custodyFacet.checkOut(tokenId);
        await expect(verificationFacet.connect(verifier).verifyPhygitals(tokenId, newDigest))
          .to.be.revertedWithCustomError(fermionErrors, "PhygitalsAlreadyVerified")
          .withArgs(tokenId);

        // Burned
        await verificationFacet.connect(verifier).submitVerdict(exchange.tokenId, VerificationStatus.Rejected);
        await expect(verificationFacet.connect(verifier).verifyPhygitals(exchange.tokenId, newDigest))
          .to.be.revertedWithCustomError(fermionErrors, "InvalidTokenState")
          .withArgs(exchange.tokenId, TokenState.Burned);
      });
    });
  });

  context("changeVerificationTimeout", function () {
    it("seller can change the verification timeout", async function () {
      const newTimeout = BigInt(itemVerificationTimeout) + 24n * 60n * 60n * 10n;
      const tx = await verificationFacet.changeVerificationTimeout(exchange.tokenId, newTimeout);

      await expect(tx)
        .to.emit(verificationFacet, "ItemVerificationTimeoutChanged")
        .withArgs(exchange.tokenId, newTimeout);

      expect(await verificationFacet.getItemVerificationTimeout(exchange.tokenId)).to.equal(newTimeout);
    });

    context("Revert reasons", function () {
      it("Verification region is paused", async function () {
        await pauseFacet.pause([PausableRegion.Verification]);

        await expect(verificationFacet.changeVerificationTimeout(exchange.tokenId, itemVerificationTimeout))
          .to.be.revertedWithCustomError(fermionErrors, "RegionPaused")
          .withArgs(PausableRegion.Verification);
      });

      it("Caller is not the seller's assistant", async function () {
        const newTimeout = BigInt(itemVerificationTimeout) + 24n * 60n * 60n * 10n;
        await verifySellerAssistantRole("changeVerificationTimeout", [exchange.tokenId, newTimeout]);
      });

      it("New timeout is greater than the maximum timeout", async function () {
        const newTimeout = itemMaxVerificationTimeout + 1n;

        await expect(verificationFacet.changeVerificationTimeout(exchangeSelfSaleSelfVerification.tokenId, newTimeout))
          .to.be.revertedWithCustomError(fermionErrors, "VerificationTimeoutTooLong")
          .withArgs(newTimeout, itemMaxVerificationTimeout);
      });
    });
  });
});
