import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployFermionProtocolFixture, deployMockTokens } from "../utils/common";
import { getBosonHandler } from "../utils/boson-protocol";
import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract } from "ethers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { EntityRole } from "../utils/enums";
import { FermionTypes } from "../../typechain-types/contracts/protocol/facets/Offer.sol/OfferFacet";

const { id, MaxUint256 } = ethers;

describe("Offer", function () {
  let offerFacet: Contract, entityFacet: Contract;
  let mockToken: Contract;
  // let fermionErrors: Contract;
  // let fermionProtocolAddress: string;
  let wallets: HardhatEthersSigner[];

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

    await offerFacet.addSupportedToken(await mockToken.getAddress());
  }

  before(async function () {
    ({
      // diamondAddress: fermionProtocolAddress,
      facets: { EntityFacet: entityFacet, OfferFacet: offerFacet },
      // fermionErrors,
      wallets,
    } = await loadFixture(deployFermionProtocolFixture));

    await loadFixture(setupOfferTest);
  });

  afterEach(async function () {
    await loadFixture(setupOfferTest);
  });

  describe("List offer", function () {
    const entityId = "1";
    const verifierId = "2";
    const custodianId = "3";

    it("Boson Offer is created", async function () {
      const sellerDeposit = 100;
      const verifierFee = 10;
      const exchangeToken = await mockToken.getAddress();
      const metadataURI = "https://example.com/offer-metadata.json";

      const fermionOffer: FermionTypes.OfferStruct = {
        exchangeToken,
        sellerDeposit,
        verifierId,
        verifierFee,
        custodianId,
        metadataURI,
        metadataHash: id(metadataURI),
      };

      const tx = await offerFacet.createOffer(entityId, fermionOffer);

      const offerHandler = await getBosonHandler("IBosonOfferHandler");
      await expect(tx).to.emit(offerHandler, "OfferCreated");

      const [exists, offer, offerDates, offerDurations, disputeResolutionTerms, offerFees] =
        await offerHandler.getOffer(1n);
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
  });
});
