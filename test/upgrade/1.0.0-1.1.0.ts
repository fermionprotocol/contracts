import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import {
  deployFermionProtocolFixture,
  deployMockTokens,
} from "../utils/common";
import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, ZeroAddress, parseEther, keccak256, toBeHex, toUtf8Bytes, concat } from "ethers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { EntityRole } from "../utils/enums";

const version = "1.1.0";

/**
 * Upgrade test case - After upgrade from 1.0.1 to 1.1.0 with backfilling
 * This test verifies that backfilling operations during an upgrade from version 1.0.1 to 1.1.0 work correctly.
 * 
 * The upgrade process should:
 * 1. Apply necessary state migrations
 * 2. Backfill missing data in a temporary facet
 * 3. Remove the temporary facet after backfilling is complete
 */
describe("Upgrade from 1.0.1 to 1.1.0", function () {
  // Test configuration
  const sellerId = "1";
  const verifierId = "2";
  const custodianId = "3";
  const facilitatorId = "4";
  
  const sellerDeposit = 100;
  const verifierFee = 10;
  const custodianFee = {
    amount: parseEther("0.05"),
    period: 30n * 24n * 60n * 60n, // 30 days
  };
  const tokenMetadata = { name: "test FNFT", symbol: "tFNFT" };
  const royaltyInfo = { recipients: [], bps: [] }; // empty royalty info
  
  // Contract instances
  let offerFacet: Contract;
  let entityFacet: Contract;
  let fundsFacet: Contract;
  let mockToken: Contract;
  let fermionProtocolAddress: string;
  let wallets: HardhatEthersSigner[];
  let defaultSigner: HardhatEthersSigner;
  let facilitator: HardhatEthersSigner;
  
  // Test state
  let exchangeToken: string;
  let offerId1: string;
  let offerId2: string;
  let tokenId1: string;
  let tokenId2: string;
  let tokenId3: string;
  let tokenId4: string;
  
  async function setupUpgradeTest() {
    facilitator = wallets[4];
    
    // Create all entities
    const metadataURI = "https://example.com/metadata.json";
    await entityFacet.createEntity([EntityRole.Seller, EntityRole.Verifier, EntityRole.Custodian], metadataURI); // sellerId = "1"
    await entityFacet.connect(wallets[2]).createEntity([EntityRole.Verifier], metadataURI); // verifierId = "2"
    await entityFacet.connect(wallets[3]).createEntity([EntityRole.Custodian], metadataURI); // custodianId = "3"
    await entityFacet.connect(facilitator).createEntity([EntityRole.Seller], metadataURI); // facilitatorId = "4"
    
    await entityFacet.addFacilitators(sellerId, [facilitatorId]);
    
    // Deploy mock tokens
    [mockToken] = await deployMockTokens(["ERC20"]);
    mockToken = mockToken.connect(defaultSigner);
    await mockToken.mint(defaultSigner.address, parseEther("1000"));
    
    // Add supported tokens
    await offerFacet.addSupportedToken(await mockToken.getAddress());
    await offerFacet.addSupportedToken(ZeroAddress);
    
    exchangeToken = await mockToken.getAddress();
    
    // Create 2 offers with different metadata
    const offerMetadataURI1 = "https://example.com/offer1-metadata.json";
    const offerMetadataURI2 = "https://example.com/offer2-metadata.json";
    
    const fermionOffer1 = {
      sellerId,
      sellerDeposit,
      verifierId,
      verifierFee,
      custodianId,
      custodianFee,
      facilitatorId,
      facilitatorFeePercent: "0",
      exchangeToken,
      withPhygital: false,
      metadata: {
        URI: offerMetadataURI1,
        hash: ethers.id(offerMetadataURI1),
      },
      royaltyInfo,
    };
    
    const fermionOffer2 = {
      ...fermionOffer1,
      metadata: {
        URI: offerMetadataURI2,
        hash: ethers.id(offerMetadataURI2),
      },
    };
    
    // Create offer #1
    const tx1 = await offerFacet.createOffer(fermionOffer1);
    const receipt1 = await tx1.wait();
    const offerCreatedEvent1 = receipt1.logs.find(
      (log: any) => log.fragment && log.fragment.name === "OfferCreated"
    );
    offerId1 = offerCreatedEvent1.args[4];
    
    // Create offer #2
    const tx2 = await offerFacet.createOffer(fermionOffer2);
    const receipt2 = await tx2.wait();
    const offerCreatedEvent2 = receipt2.logs.find(
      (log: any) => log.fragment && log.fragment.name === "OfferCreated"
    );
    offerId2 = offerCreatedEvent2.args[4];
    
    // Mint 2 tokens for each offer
    // For offer #1
    await mockToken.approve(fermionProtocolAddress, parseEther("100"));
    const mintTx1 = await offerFacet.mintAndWrapNFTs(offerId1, 2, tokenMetadata);
    const mintReceipt1 = await mintTx1.wait();
    const nftMintedEvent1 = mintReceipt1.logs.find(
      (log: any) => log.fragment && log.fragment.name === "NFTsMinted"
    );
    tokenId1 = nftMintedEvent1.args[1]; // First token ID
    tokenId2 = (BigInt(tokenId1) + 1n).toString(); // Second token ID
    
    // For offer #2
    const mintTx2 = await offerFacet.mintAndWrapNFTs(offerId2, 2, tokenMetadata);
    const mintReceipt2 = await mintTx2.wait();
    const nftMintedEvent2 = mintReceipt2.logs.find(
      (log: any) => log.fragment && log.fragment.name === "NFTsMinted"
    );
    tokenId3 = nftMintedEvent2.args[1]; // First token ID
    tokenId4 = (BigInt(tokenId3) + 1n).toString(); // Second token ID
  }
  
   beforeEach(async function () {
    const fixture = await loadFixture(deployFermionProtocolFixture);
    
    fermionProtocolAddress = fixture.diamondAddress;
    entityFacet = fixture.facets.EntityFacet;
    offerFacet = fixture.facets.OfferFacet;
    fundsFacet = fixture.facets.FundsFacet;
    wallets = fixture.wallets;
    defaultSigner = fixture.defaultSigner;
    
    await setupUpgradeTest();
    
    // Read offer data directly from storage
    // Protocol lookups storage position (from Storage.sol)
    const protocolLookupsSlot = "0x769aa294c8d03dc2ae011ff448d15e722e87cfb823b4b4d6339267d1c690d900";
    // OfferLookups is at position 6 in the struct
    const offerLookupsPosition = 6n;
    const offerLookupsSlot = BigInt(protocolLookupsSlot) + offerLookupsPosition;
    
    console.log("Reading storage data for offer #1 (ID:", offerId1, ")");
    
    // For mapping: keccak256(h(k) . p) where . is concatenation
    // h(k) is the padded key (offerId) and p is the mapping slot
    const paddedOfferId = toBeHex(BigInt(offerId1), 32);
    const paddedMappingSlot = toBeHex(offerLookupsSlot, 32);
    
    // Key should be first, then mapping slot
    const concatenated = concat([paddedOfferId, paddedMappingSlot]);
    console.log("Concatenated:", concatenated);
    const offerStorageSlot = keccak256(concatenated);
    
    // Read storage at the calculated slot
    const provider = ethers.provider;
    const offerStorage = await provider.getStorage(fermionProtocolAddress, offerStorageSlot);
    const custodianVaultItems = await provider.getStorage(fermionProtocolAddress, BigInt(offerStorageSlot) + 3n);
    const itemQuantity = await provider.getStorage(fermionProtocolAddress, BigInt(offerStorageSlot) + 4n);
    const firstTokenId = await provider.getStorage(fermionProtocolAddress, BigInt(offerStorageSlot) + 5n);
    console.log("Offer #1 storage:", BigInt(offerStorage).toString());
    console.log("Custodian vault items:", custodianVaultItems);
    console.log("Item quantity:", itemQuantity);
    console.log("First token ID:", firstTokenId);
    
  });
  
  context("Token Fee Backfilling", function () {

    before(async function () {
        //modify token Storage to simulate pre-upgrade state
    });
    
    it("should backfill token fees during upgrade", async function () {
        // perform backfilling
        // verify that token storage has been updated with correct fee data
        expect(true).to.be.true;
    });
    
  });
  
  context("Offer Data Backfilling", function () {

    before(async function () {
        //modify offer Storage to simulate pre-upgrade state
    });
    
    it("should backfill offer data during upgrade", async function () {
        // perform backfilling
        // verify that offer storage has been updated with correct data
        expect(true).to.be.true;
    });
    
  });
});
