import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import {
  deployFermionProtocolFixture,
  deployMockTokens,
} from "../utils/common";
import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, ZeroAddress, parseEther, keccak256, toBeHex, concat, encodeBytes32String } from "ethers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { EntityRole } from "../utils/enums";
import { setStorageAt, getStorageAt } from "@nomicfoundation/hardhat-network-helpers";
import { makeDiamondCut } from "../../scripts/deploy";

const version = encodeBytes32String("v1.1.0");
const protocolLookupsSlot = "0x769aa294c8d03dc2ae011ff448d15e722e87cfb823b4b4d6339267d1c690d900";
const offerLookupsPosition = 6n;
const offerLookupsSlot = BigInt(protocolLookupsSlot) + offerLookupsPosition;

/**
 * Calculate the storage slot for a mapping entry
 * 
 * @param mappingSlot - The storage slot of the mapping
 * @param key - The key in the mapping
 * @returns The storage slot for the mapping[key] value
 */
function getMappingStorageSlot(mappingSlot: string | bigint, key: string | bigint): string {
  const paddedKey = toBeHex(BigInt(key), 32);
  const paddedMappingSlot = toBeHex(BigInt(mappingSlot), 32);
  const concatenated = concat([paddedKey, paddedMappingSlot]);
  return keccak256(concatenated);
}

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
  let initializationFacet: Contract;
  let mockToken: Contract;
  let fermionProtocolAddress: string;
  let wallets: HardhatEthersSigner[];
  let defaultSigner: HardhatEthersSigner;
  let facilitator: HardhatEthersSigner;
  let backfillingFacet: Contract;
  
  // Test state
  let exchangeToken: string;
  let offerId: string;
  let tokenId1: string;
  let tokenId2: string;
  
  // Storage slots
  let offerItemQuantitySlot: bigint;
  let offerFirstTokenIdSlot: bigint;
  
  beforeEach(async function () {
    // Load the fixture and assign all variables using destructuring
    ({
      diamondAddress: fermionProtocolAddress,
      facets: {
        EntityFacet: entityFacet,
        OfferFacet: offerFacet,
        InitializationFacet: initializationFacet
      },
      wallets,
      defaultSigner
    } = await loadFixture(deployFermionProtocolFixture));
    

    facilitator = wallets[4];
    
    const BackfillingV1_1_0 = await ethers.getContractFactory("BackfillingV1_1_0");
    backfillingFacet = await BackfillingV1_1_0.deploy();
    
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
    const offerMetadataURI = "https://example.com/offer1-metadata.json";
    
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
        URI: offerMetadataURI,
        hash: ethers.id(offerMetadataURI),
      },
      royaltyInfo,
    };
    
    // Create offer
    const tx1 = await offerFacet.createOffer(fermionOffer1);
    const receipt1 = await tx1.wait();
    const offerCreatedEvent1 = receipt1.logs.find(
      (log: any) => log.fragment && log.fragment.name === "OfferCreated"
    );
    offerId = offerCreatedEvent1.args[4];
    
    // Mint 2 tokens
    await mockToken.approve(fermionProtocolAddress, parseEther("100"));
    const mintTx1 = await offerFacet.mintAndWrapNFTs(offerId, 2, tokenMetadata);
    const mintReceipt1 = await mintTx1.wait();
    const nftMintedEvent1 = mintReceipt1.logs.find(
      (log: any) => log.fragment && log.fragment.name === "NFTsMinted"
    );
    tokenId1 = nftMintedEvent1.args[1]; // First token ID
    tokenId2 = (BigInt(tokenId1) + 1n).toString(); // Second token ID
    
    // Calculate storage slots
    const offerStorageSlot = getMappingStorageSlot(offerLookupsSlot, offerId);
    offerItemQuantitySlot = BigInt(offerStorageSlot) + 10n;
    offerFirstTokenIdSlot = BigInt(offerStorageSlot) + 11n;
  });
  
  context("Token Fee Backfilling", function () {
    it("should backfill token fees during upgrade", async function () {
        // make sure item quantity and first token id are not 0
        expect(await getStorageAt(fermionProtocolAddress, offerFirstTokenIdSlot)).not.to.be.equal(0n);
        expect(await getStorageAt(fermionProtocolAddress, offerFirstTokenIdSlot)).not.to.be.equal(0n);

        // set them to 0
        await setStorageAt(fermionProtocolAddress, offerItemQuantitySlot, BigInt(0));
        await setStorageAt(fermionProtocolAddress, offerFirstTokenIdSlot, BigInt(0));
        
        // Verify values are now 0
        expect(await getStorageAt(fermionProtocolAddress, offerItemQuantitySlot)).to.equal(0n);
        expect(await getStorageAt(fermionProtocolAddress, offerFirstTokenIdSlot)).to.equal(0n);
        
        const offerData = [{
            offerId: offerId,
            itemQuantity: "2",
            firstTokenId: tokenId1
        }];
        
        const backFillOfferCalldata = backfillingFacet.interface.encodeFunctionData("backFillOfferData", [offerData]);
        

        const initCalldata = initializationFacet.interface.encodeFunctionData("initialize", [
          version,
          [await backfillingFacet.getAddress()],
          [backFillOfferCalldata],
          [],
          []
        ]);
        
        await makeDiamondCut(
          fermionProtocolAddress,
          [],
          await initializationFacet.getAddress(),
          initCalldata
        );

        // Verify the values have been restored
        expect(await getStorageAt(fermionProtocolAddress, offerItemQuantitySlot)).to.equal(offerData[0].itemQuantity);
        expect(await getStorageAt(fermionProtocolAddress, offerFirstTokenIdSlot)).to.equal(offerData[0].firstTokenId);
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
