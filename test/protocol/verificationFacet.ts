import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployFermionProtocolFixture, deployMockTokens, deriveTokenId } from "../utils/common";
import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, ZeroHash } from "ethers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { EntityRole } from "../utils/enums";
import { Seaport } from "@opensea/seaport-js";
import { ItemType } from "@opensea/seaport-js/lib/constants";

const { parseEther } = ethers;

describe("Offer", function () {
  let offerFacet: Contract, entityFacet: Contract, verificationFacet: Contract;
  let mockToken: Contract;
  let fermionErrors: Contract;
  let fermionProtocolAddress: string;
  let wallets: HardhatEthersSigner[];
  let defaultSigner: HardhatEthersSigner;
  let seaportAddress: string;
  const verifierId = "2";
  const verifierFee = parseEther("0.1");

  async function setupVerificationTest() {
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

    // Create offer
    const fermionOffer = {
      sellerId: "1",
      sellerDeposit: "0",
      verifierId,
      verifierFee,
      custodianId: "3",
      exchangeToken: await mockToken.getAddress(),
      metadataURI: "https://example.com/offer-metadata.json",
      metadataHash: ZeroHash,
    };

    // Make two offers one for normal sale, one of self sale
    const offerId = "1";
    const offerIdSelf = "2";
    await offerFacet.createOffer(fermionOffer);
    await offerFacet.createOffer({ ...fermionOffer, verifierId: "1", custodianId: "1" });

    // Mint and wrap some NFTs
    const quantity = "1";
    await offerFacet.mintAndWrapNFTs(offerIdSelf, quantity); // offerId = 2; exchangeId = 1
    await offerFacet.mintAndWrapNFTs(offerId, quantity); // offerId = 1; exchangeId = 2
    const exchangeIdSelf = "1";
    const exchangeId = "2";

    // Unwrap some NFTs - normal sale
    const fullPrice = parseEther("1");
    const openSeaFee = (fullPrice * 2n) / 100n;
    const buyer = wallets[4];
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

    await offerFacet.unwrapNFT(tokenId, buyerAdvancedOrder);

    // unwrap to self
    const tokenIdSelf = deriveTokenId(offerIdSelf, exchangeIdSelf).toString();
    await mockToken.approve(fermionProtocolAddress, verifierFee + verifierFee);
    await offerFacet.unwrapNFTToSelf(tokenIdSelf);
  }

  before(async function () {
    ({
      diamondAddress: fermionProtocolAddress,
      facets: { EntityFacet: entityFacet, OfferFacet: offerFacet, VerificationFacet: verificationFacet },
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
    before(async function () {});

    it.only("Verified", async function () {
    });

    context.skip("Revert reasons", function () {
      it("Caller is not the verifiers's assistant", async function () {
      });
    });
  });
});
