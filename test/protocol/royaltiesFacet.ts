import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import {
  applyPercentage,
  deployFermionProtocolFixture,
  deployMockTokens,
  deriveTokenId,
  verifySellerAssistantRoleClosure,
} from "../utils/common";
import { getBosonHandler } from "../utils/boson-protocol";
import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, id, ZeroAddress, parseEther } from "ethers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { EntityRole, PausableRegion, AccountRole } from "../utils/enums";
import { FermionTypes } from "../../typechain-types/contracts/protocol/facets/Offer.sol/OfferFacet";

describe("Royalties", function () {
  const sellerId = "1";
  const facilitatorId = "2";
  const royaltyRecipientId = "3";
  const royaltyRecipient2Id = "4";

  let offerFacet: Contract,
    entityFacet: Contract,
    pauseFacet: Contract,
    configFacet: Contract,
    royaltiesFacet: Contract;
  let mockToken: Contract, mockBosonToken: Contract;
  let fermionErrors: Contract;
  let wallets: HardhatEthersSigner[];
  let defaultSigner: HardhatEthersSigner;
  let facilitator: HardhatEthersSigner;
  let royaltyRecipient: HardhatEthersSigner, royaltyRecipient2: HardhatEthersSigner;
  let bosonTokenAddress: string;
  let verifySellerAssistantRole: any;

  async function setupOfferTest() {
    facilitator = wallets[4];
    royaltyRecipient = wallets[6];
    royaltyRecipient2 = wallets[7];

    // Create all entities
    // Seller, Verifier, Custodian combined
    // 1 Facilitator
    // 2 Royalty Recipients
    const metadataURI = "https://example.com/seller-metadata.json";
    await entityFacet.createEntity([EntityRole.Seller, EntityRole.Verifier, EntityRole.Custodian], metadataURI); // "1"
    await entityFacet.connect(facilitator).createEntity([EntityRole.Seller], metadataURI); // "2"
    await entityFacet.connect(royaltyRecipient).createEntity([EntityRole.RoyaltyRecipient], metadataURI); // "3"
    await entityFacet.connect(royaltyRecipient2).createEntity([EntityRole.RoyaltyRecipient], metadataURI); // "4"

    await entityFacet.addFacilitators(sellerId, [facilitatorId]);

    [mockToken] = await deployMockTokens(["ERC20"]);
    mockToken = mockToken.connect(defaultSigner);
    await mockToken.mint(defaultSigner.address, parseEther("1000"));

    await offerFacet.addSupportedToken(await mockToken.getAddress());
    await offerFacet.addSupportedToken(ZeroAddress);

    mockBosonToken = await ethers.getContractAt("MockERC20", bosonTokenAddress, defaultSigner);
    await mockBosonToken.mint(defaultSigner.address, parseEther("1000"));

    // allowlist the royalty recipient
    await entityFacet.addRoyaltyRecipients(sellerId, [royaltyRecipientId, royaltyRecipient2Id]);
  }

  before(async function () {
    ({
      facets: {
        EntityFacet: entityFacet,
        OfferFacet: offerFacet,
        PauseFacet: pauseFacet,
        ConfigFacet: configFacet,
        RoyaltiesFacet: royaltiesFacet,
      },
      fermionErrors,
      wallets,
      defaultSigner,
      bosonTokenAddress,
    } = await loadFixture(deployFermionProtocolFixture));

    await loadFixture(setupOfferTest);

    verifySellerAssistantRole = verifySellerAssistantRoleClosure(royaltiesFacet, wallets, entityFacet, fermionErrors);
  });

  afterEach(async function () {
    await loadFixture(setupOfferTest);
  });

  context("updateOfferRoyaltyRecipients", function () {
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
    const withPhygital = false;
    let initialRoyaltyInfo: FermionTypes.RoyaltyInfoStruct[];
    let royaltyInfo: FermionTypes.RoyaltyInfoStruct;

    before(async function () {
      const initialRoyalties1 = 8_00n;
      const initialRoyalties2 = 5_00n;
      const initialSellerRoyalties = 1_00n;
      initialRoyaltyInfo = [
        {
          recipients: [royaltyRecipient.address, royaltyRecipient2.address, defaultSigner.address],
          bps: [initialRoyalties1, initialRoyalties2, initialSellerRoyalties],
        },
      ];
      exchangeToken = await mockToken.getAddress();

      fermionOffer = {
        sellerId,
        sellerDeposit,
        verifierId: sellerId,
        verifierFee,
        custodianId: sellerId,
        custodianFee,
        facilitatorId,
        facilitatorFeePercent: "0",
        exchangeToken,
        withPhygital,
        metadataURI,
        metadataHash: id(metadataURI),
        royaltyInfo: initialRoyaltyInfo,
      };

      const royalties1 = 2_00n;
      const royalties2 = 3_00n;
      const sellerRoyalties = 4_00n;
      royaltyInfo = {
        recipients: [royaltyRecipient.address, royaltyRecipient2.address, defaultSigner.address],
        bps: [royalties1, royalties2, sellerRoyalties],
      };
    });

    beforeEach(async function () {
      await offerFacet.createOffer(fermionOffer);
    });

    it("Update single offer (change percent)", async function () {
      // test event
      await expect(royaltiesFacet.updateOfferRoyaltyRecipients([bosonOfferId], royaltyInfo))
        .to.emit(royaltiesFacet, "OfferRoyaltyInfoUpdated")
        .withArgs(bosonOfferId, sellerId, Object.values(royaltyInfo));

      // verify state
      const offer = await offerFacet.getOffer(bosonOfferId);
      expect(offer.royaltyInfo).to.eql([Object.values(initialRoyaltyInfo[0]), Object.values(royaltyInfo)]);
    });

    it("Update multiple offers (remove from one, add to another)", async function () {
      // create another offer with no royalties
      const bosonOfferId2 = "2";
      await offerFacet.createOffer({ ...fermionOffer, royaltyInfo: [{ recipients: [], bps: [] }] });

      const royalties1 = 1_00n;
      const royalties2 = 9_00n;
      const royaltyInfo = {
        recipients: [royaltyRecipient.address, royaltyRecipient2.address],
        bps: [royalties1, royalties2],
      };

      // test event
      const tx = await royaltiesFacet.updateOfferRoyaltyRecipients([bosonOfferId, bosonOfferId2], royaltyInfo);
      await expect(tx)
        .to.emit(royaltiesFacet, "OfferRoyaltyInfoUpdated")
        .withArgs(bosonOfferId, sellerId, Object.values(royaltyInfo));
      await expect(tx)
        .to.emit(royaltiesFacet, "OfferRoyaltyInfoUpdated")
        .withArgs(bosonOfferId2, sellerId, Object.values(royaltyInfo));

      // verify state
      const offer = await offerFacet.getOffer(bosonOfferId);
      expect(offer.royaltyInfo).to.eql([Object.values(initialRoyaltyInfo[0]), Object.values(royaltyInfo)]);
      const offer2 = await offerFacet.getOffer(bosonOfferId2);
      expect(offer2.royaltyInfo).to.eql([[[], []], Object.values(royaltyInfo)]);
    });

    it("Remove all royalties", async function () {
      const royaltyInfo = {
        recipients: [],
        bps: [],
      };

      // test event
      await expect(royaltiesFacet.updateOfferRoyaltyRecipients([bosonOfferId], royaltyInfo))
        .to.emit(royaltiesFacet, "OfferRoyaltyInfoUpdated")
        .withArgs(bosonOfferId, sellerId, Object.values(royaltyInfo));

      // verify state
      const offer = await offerFacet.getOffer(bosonOfferId);
      expect(offer.royaltyInfo).to.eql([Object.values(initialRoyaltyInfo[0]), Object.values(royaltyInfo)]);
    });

    it("Assistant wallets can update the royalties", async function () {
      const entityAssistant = wallets[4]; // entity-wide Assistant
      const sellerAssistant = wallets[5]; // Seller-specific Assistant

      await entityFacet.addEntityAccounts(
        sellerId,
        [entityAssistant, sellerAssistant],
        [[], [EntityRole.Seller]],
        [[[AccountRole.Assistant]], [[AccountRole.Assistant]]],
      );

      // test event
      await expect(royaltiesFacet.connect(entityAssistant).updateOfferRoyaltyRecipients([bosonOfferId], royaltyInfo))
        .to.emit(royaltiesFacet, "OfferRoyaltyInfoUpdated")
        .withArgs(bosonOfferId, sellerId, Object.values(royaltyInfo));

      await expect(royaltiesFacet.connect(sellerAssistant).updateOfferRoyaltyRecipients([bosonOfferId], royaltyInfo))
        .to.emit(royaltiesFacet, "OfferRoyaltyInfoUpdated")
        .withArgs(bosonOfferId, sellerId, Object.values(royaltyInfo));
    });

    it("Facilitator wallets can create the offer", async function () {
      const facilitatorAssistant = wallets[5]; // Facilitator-specific Assistant

      await entityFacet
        .connect(facilitator)
        .addEntityAccounts(facilitatorId, [facilitatorAssistant], [[EntityRole.Seller]], [[[AccountRole.Assistant]]]);

      // test event
      await expect(royaltiesFacet.connect(facilitator).updateOfferRoyaltyRecipients([bosonOfferId], royaltyInfo))
        .to.emit(royaltiesFacet, "OfferRoyaltyInfoUpdated")
        .withArgs(bosonOfferId, sellerId, Object.values(royaltyInfo));

      await expect(
        royaltiesFacet.connect(facilitatorAssistant).updateOfferRoyaltyRecipients([bosonOfferId], royaltyInfo),
      )
        .to.emit(royaltiesFacet, "OfferRoyaltyInfoUpdated")
        .withArgs(bosonOfferId, sellerId, Object.values(royaltyInfo));
    });

    context("Revert reasons", function () {
      it("Offer region is paused", async function () {
        await pauseFacet.pause([PausableRegion.Offer]);

        await expect(royaltiesFacet.updateOfferRoyaltyRecipients([bosonOfferId], royaltyInfo))
          .to.be.revertedWithCustomError(fermionErrors, "RegionPaused")
          .withArgs(PausableRegion.Offer);
      });

      it("Caller is not the seller's assistant", async function () {
        await verifySellerAssistantRole("updateOfferRoyaltyRecipients", [[bosonOfferId], royaltyInfo]);
      });

      it("Number of recipients and bps does not match", async function () {
        // multiple recipients over the limit
        const royalties1 = 8_00;
        const royalties2 = 7_01;

        let royaltyInfo = { recipients: [royaltyRecipient.address], bps: [royalties1, royalties2] };
        await expect(royaltiesFacet.updateOfferRoyaltyRecipients([bosonOfferId], royaltyInfo))
          .to.be.revertedWithCustomError(fermionErrors, "ArrayLengthMismatch")
          .withArgs(1, 2);

        royaltyInfo = { recipients: [royaltyRecipient.address, royaltyRecipient2.address], bps: [royalties1] };
        await expect(royaltiesFacet.updateOfferRoyaltyRecipients([bosonOfferId], royaltyInfo))
          .to.be.revertedWithCustomError(fermionErrors, "ArrayLengthMismatch")
          .withArgs(2, 1);
      });

      it("Royalty percentage is over the limit", async function () {
        // set max royalty percentage
        await configFacet.setMaxRoyaltyPercentage(15_00); //15%

        // single recipient over the limit
        const royalties = 15_01;
        let royaltyInfo = { recipients: [royaltyRecipient.address], bps: [royalties] };
        await expect(royaltiesFacet.updateOfferRoyaltyRecipients([bosonOfferId], royaltyInfo))
          .to.be.revertedWithCustomError(fermionErrors, "InvalidRoyaltyPercentage")
          .withArgs(royalties);

        // multiple recipients over the limit
        const royalties1 = 8_00;
        const royalties2 = 7_01;
        royaltyInfo = {
          recipients: [royaltyRecipient.address, royaltyRecipient2.address],
          bps: [royalties1, royalties2],
        };
        await expect(royaltiesFacet.updateOfferRoyaltyRecipients([bosonOfferId], royaltyInfo))
          .to.be.revertedWithCustomError(fermionErrors, "InvalidRoyaltyPercentage")
          .withArgs(royalties1 + royalties2);
      });

      it("Royalty recipient is not allowlisted", async function () {
        const royalties = 10_00;

        // existing entity, but not allowlisted
        let royaltyInfo = { recipients: [facilitator.address], bps: [royalties] };
        await expect(royaltiesFacet.updateOfferRoyaltyRecipients([bosonOfferId], royaltyInfo))
          .to.be.revertedWithCustomError(fermionErrors, "InvalidRoyaltyRecipient")
          .withArgs(facilitator.address);

        // non-existing entity, but not allowlisted
        const rando = wallets[10];
        royaltyInfo = { recipients: [rando.address], bps: [royalties] };
        await expect(royaltiesFacet.updateOfferRoyaltyRecipients([bosonOfferId], royaltyInfo))
          .to.be.revertedWithCustomError(fermionErrors, "InvalidRoyaltyRecipient")
          .withArgs(rando.address);
      });
    });
  });

  context("getRoyalties/getEIP2981Royalties", function () {
    const sellerDeposit = 100;
    const verifierFee = 10;
    const custodianFee = {
      amount: parseEther("0.05"),
      period: 30n * 24n * 60n * 60n, // 30 days
    };
    const metadataURI = "https://example.com/offer-metadata.json";
    const bosonOfferId = "1";
    const withPhygital = false;
    const quantity = 5n;
    const royalties1 = 8_00n;
    const royalties2 = 5_00n;
    const sellerRoyalties = 1_00n;
    const sellerRoyalties2 = 2_00n;
    const price = parseEther("0.1");

    let exchangeToken: string;
    let fermionOffer: FermionTypes.OfferStruct;
    let royaltyInfo: FermionTypes.RoyaltyInfoStruct;
    let fermionFNFT: Contract;
    let startingTokenId: bigint;
    let predictedWrapperAddress: string;

    before(async function () {
      royaltyInfo = {
        recipients: [royaltyRecipient.address, royaltyRecipient2.address, ZeroAddress, defaultSigner.address],
        bps: [royalties1, royalties2, sellerRoyalties, sellerRoyalties2],
      };

      exchangeToken = await mockToken.getAddress();

      fermionOffer = {
        sellerId,
        sellerDeposit,
        verifierId: sellerId,
        verifierFee,
        custodianId: sellerId,
        custodianFee,
        facilitatorId,
        facilitatorFeePercent: "0",
        exchangeToken,
        withPhygital,
        metadataURI,
        metadataHash: id(metadataURI),
        royaltyInfo: [royaltyInfo],
      };

      const bosonExchangeHandler = await getBosonHandler("IBosonExchangeHandler");
      const nextBosonExchangeId = await bosonExchangeHandler.getNextExchangeId();
      startingTokenId = deriveTokenId(bosonOfferId, nextBosonExchangeId);
      predictedWrapperAddress = await offerFacet.predictFermionFNFTAddress(bosonOfferId);
      fermionFNFT = await ethers.getContractAt("FermionFNFT", predictedWrapperAddress);
    });

    beforeEach(async function () {
      await offerFacet.createOffer(fermionOffer);
      await offerFacet.mintAndWrapNFTs(bosonOfferId, quantity);
    });

    it("Get offer royalties", async function () {
      const totalRoyalties = royalties1 + royalties2 + sellerRoyalties + sellerRoyalties2;
      const expectedRoyalties = applyPercentage(price, totalRoyalties);
      for (let i = 0n; i < quantity; i++) {
        const EIP2981Royalties = await royaltiesFacet.getEIP2981Royalties(startingTokenId + i);
        const royalties = await royaltiesFacet.getRoyalties(startingTokenId + i);

        expect(EIP2981Royalties.receiver).to.equal(royaltyInfo.recipients[0]);
        expect(EIP2981Royalties.royaltyPercentage).to.equal(totalRoyalties);
        expect(royalties.recipients).to.eql(
          royaltyInfo.recipients.map((r) => (r == ZeroAddress ? defaultSigner.address : r)),
        );
        expect(royalties.bps).to.eql(royaltyInfo.bps);

        // fermion FNFT
        const [receiver, royaltyAmount] = await fermionFNFT.royaltyInfo(startingTokenId + i, price);
        expect(receiver).to.equal(royaltyInfo.recipients[0]);
        expect(royaltyAmount).to.equal(expectedRoyalties);
      }
    });

    it("If offer is updated, the last royalties are used", async function () {
      const royalties1 = 1_00n;
      const royalties2 = 9_00n;
      const royaltyInfo = {
        recipients: [royaltyRecipient.address, royaltyRecipient2.address],
        bps: [royalties1, royalties2],
      };
      const totalRoyalties = royalties1 + royalties2;

      await royaltiesFacet.updateOfferRoyaltyRecipients([bosonOfferId], royaltyInfo);

      const expectedRoyalties = applyPercentage(price, totalRoyalties);
      for (let i = 0n; i < quantity; i++) {
        const EIP2981Royalties = await royaltiesFacet.getEIP2981Royalties(startingTokenId + i);
        const royalties = await royaltiesFacet.getRoyalties(startingTokenId + i);

        expect(EIP2981Royalties.receiver).to.equal(royaltyInfo.recipients[0]);
        expect(EIP2981Royalties.royaltyPercentage).to.equal(totalRoyalties);
        expect(royalties.recipients).to.eql(royaltyInfo.recipients);
        expect(royalties.bps).to.eql(royaltyInfo.bps);

        // fermion FNFT
        const [receiver, royaltyAmount] = await fermionFNFT.royaltyInfo(startingTokenId + i, price);
        expect(receiver).to.equal(royaltyInfo.recipients[0]);
        expect(royaltyAmount).to.equal(expectedRoyalties);
      }
    });

    it("Offer with no royalties", async function () {
      const royaltyInfo = {
        recipients: [],
        bps: [],
      };
      const totalRoyalties = 0n;

      await royaltiesFacet.updateOfferRoyaltyRecipients([bosonOfferId], royaltyInfo);

      const expectedRoyalties = 0n;
      for (let i = 0n; i < quantity; i++) {
        const EIP2981Royalties = await royaltiesFacet.getEIP2981Royalties(startingTokenId + i);
        const royalties = await royaltiesFacet.getRoyalties(startingTokenId + i);

        expect(EIP2981Royalties.receiver).to.equal(ZeroAddress);
        expect(EIP2981Royalties.royaltyPercentage).to.equal(totalRoyalties);
        expect(royalties.recipients).to.eql(royaltyInfo.recipients);
        expect(royalties.bps).to.eql(royaltyInfo.bps);

        // fermion FNFT
        const [receiver, royaltyAmount] = await fermionFNFT.royaltyInfo(startingTokenId + i, price);
        expect(receiver).to.equal(ZeroAddress);
        expect(royaltyAmount).to.equal(expectedRoyalties);
      }
    });

    context("Revert reasons", function () {
      it("Token id does not exist", async function () {
        let invalidTokenId = startingTokenId + quantity + 1n;
        await expect(royaltiesFacet.getEIP2981Royalties(invalidTokenId))
          .to.be.revertedWithCustomError(fermionErrors, "InvalidTokenId")
          .withArgs(predictedWrapperAddress, invalidTokenId);
        await expect(royaltiesFacet.getRoyalties(invalidTokenId))
          .to.be.revertedWithCustomError(fermionErrors, "InvalidTokenId")
          .withArgs(predictedWrapperAddress, invalidTokenId);

        invalidTokenId = 0n;
        await expect(royaltiesFacet.getEIP2981Royalties(invalidTokenId))
          .to.be.revertedWithCustomError(fermionErrors, "InvalidTokenId")
          .withArgs(ZeroAddress, invalidTokenId);
        await expect(royaltiesFacet.getRoyalties(invalidTokenId))
          .to.be.revertedWithCustomError(fermionErrors, "InvalidTokenId")
          .withArgs(ZeroAddress, invalidTokenId);
      });
    });
  });
});
