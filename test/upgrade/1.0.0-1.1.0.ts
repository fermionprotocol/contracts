import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployFermionProtocolFixture, deployMockTokens } from "../utils/common";
import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, parseEther, keccak256, toBeHex, concat, encodeBytes32String } from "ethers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { EntityRole } from "../utils/enums";
import { setStorageAt, getStorageAt } from "@nomicfoundation/hardhat-network-helpers";
import { executeBackfillingDiamondCut } from "../../scripts/upgrade-hooks/1.1.0";

const version = encodeBytes32String("v1.1.0");
const protocolLookupsSlot = "0x769aa294c8d03dc2ae011ff448d15e722e87cfb823b4b4d6339267d1c690d900";
const offerLookupsSlot = BigInt(protocolLookupsSlot) + 6n;
const tokenLookupsSlot = BigInt(protocolLookupsSlot) + 7n;

function getMappingStorageSlot(mappingSlot: string | bigint, key: string | bigint): string {
  const paddedKey = toBeHex(BigInt(key), 32);
  const paddedMappingSlot = toBeHex(BigInt(mappingSlot), 32);
  const concatenated = concat([paddedKey, paddedMappingSlot]);
  return keccak256(concatenated);
}

/**
 *  The upgrade process should apply necessary state backfilling through correctly
 *  delegatecall to the backfilling facet through the initialization facet.
 */
describe("Upgrade from 1.0.1 to 1.1.0", function () {
  // Test configuration
  const sellerId = "1";
  const verifierId = "2";
  const custodianId = "3";
  const facilitatorId = "4";
  const offerId = 1n;

  const sellerDeposit = 100;
  const verifierFee = 10;
  const custodianFee = {
    amount: parseEther("0.05"),
    period: 30n * 24n * 60n * 60n, // 30 days
  };
  // Contract instances
  let offerFacet: Contract;
  let entityFacet: Contract;
  let initializationFacetImplementationAddress: string;
  let mockToken: Contract;
  let fermionProtocolAddress: string;
  let wallets: HardhatEthersSigner[];
  let defaultSigner: HardhatEthersSigner;
  let facilitator: HardhatEthersSigner;
  let backfillingFacet: Contract;
  let tokenId: bigint;
  // Test state
  let exchangeToken: string;
  let tokenIdStorageSlot: bigint;
  // Storage slots
  let offerItemQuantitySlot: bigint;
  let offerFirstTokenIdSlot: bigint;
  let itemPriceTokenLocation: bigint;
  let bosonProtocolFeeTokenLocation: bigint;
  let fermionFeeAmountTokenLocation: bigint;
  let verifierFeeTokenLocation: bigint;
  let facilitatorFeeAmountTokenLocation: bigint;
  beforeEach(async function () {
    // Load the fixture and assign all variables using destructuring
    ({
      diamondAddress: fermionProtocolAddress,
      facets: { EntityFacet: entityFacet, OfferFacet: offerFacet },
      implementationAddresses: { InitializationFacet: initializationFacetImplementationAddress },
      wallets,
      defaultSigner,
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

    [mockToken] = await deployMockTokens(["ERC20"]);
    mockToken = mockToken.connect(defaultSigner);
    await mockToken.mint(defaultSigner.address, parseEther("1000"));

    await offerFacet.addSupportedToken(await mockToken.getAddress());
    exchangeToken = await mockToken.getAddress();

    const offerMetadataURI = "https://example.com/offer1-metadata.json";
    const fermionOffer1 = {
      sellerId,
      sellerDeposit,
      verifierId,
      verifierFee,
      custodianId,
      custodianFee,
      facilitatorId,
      facilitatorFeePercent: "500",
      exchangeToken,
      withPhygital: false,
      metadata: {
        URI: offerMetadataURI,
        hash: ethers.id(offerMetadataURI),
      },
      royaltyInfo: { recipients: [], bps: [] },
    };

    await offerFacet.createOffer(fermionOffer1);

    const mintTx = await offerFacet.mintAndWrapNFTs(offerId, 1, { name: "Token", symbol: "TKN" });
    const mintReceipt = await mintTx.wait();
    const nftMintedEvent = mintReceipt.logs.find((log: any) => log.fragment && log.fragment.name === "NFTsMinted");
    tokenId = nftMintedEvent.args[1];

    const minimalPrice = 1000n;
    const customItemPrice = 10000n;
    const selfSaleData = ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256", "uint256"],
      [minimalPrice, customItemPrice],
    );

    const selfSaleWrapType = 0;
    await mockToken.approve(fermionProtocolAddress, minimalPrice * 5n);
    await offerFacet.unwrapNFT(tokenId, selfSaleWrapType, selfSaleData);

    // Calculate storage slots
    const offerStorageSlot = getMappingStorageSlot(offerLookupsSlot, offerId);
    offerItemQuantitySlot = BigInt(offerStorageSlot) + 10n;
    offerFirstTokenIdSlot = BigInt(offerStorageSlot) + 11n;

    tokenIdStorageSlot = BigInt(getMappingStorageSlot(tokenLookupsSlot, tokenId));
    itemPriceTokenLocation = tokenIdStorageSlot;
    bosonProtocolFeeTokenLocation = tokenIdStorageSlot + 7n;
    fermionFeeAmountTokenLocation = tokenIdStorageSlot + 8n;
    verifierFeeTokenLocation = tokenIdStorageSlot + 9n;
    facilitatorFeeAmountTokenLocation = tokenIdStorageSlot + 10n;
  });

  context("Backfilling", function () {
    it("should backfill token fees and offer data during upgrade", async function () {
      const itemPriceBeforeBackfill = await getStorageAt(fermionProtocolAddress, itemPriceTokenLocation);
      // make sure token fees are not 0
      expect(await getStorageAt(fermionProtocolAddress, bosonProtocolFeeTokenLocation)).to.not.equal(0n);
      expect(await getStorageAt(fermionProtocolAddress, fermionFeeAmountTokenLocation)).to.not.equal(0n);
      expect(await getStorageAt(fermionProtocolAddress, verifierFeeTokenLocation)).to.not.equal(0n);
      expect(await getStorageAt(fermionProtocolAddress, facilitatorFeeAmountTokenLocation)).to.not.equal(0n);

      // set all fees to 0
      await setStorageAt(fermionProtocolAddress, bosonProtocolFeeTokenLocation, BigInt(0));
      await setStorageAt(fermionProtocolAddress, fermionFeeAmountTokenLocation, BigInt(0));
      await setStorageAt(fermionProtocolAddress, verifierFeeTokenLocation, BigInt(0));
      await setStorageAt(fermionProtocolAddress, facilitatorFeeAmountTokenLocation, BigInt(0));

      // make sure item quantity and first token id are not 0
      expect(await getStorageAt(fermionProtocolAddress, offerItemQuantitySlot)).to.not.equal(0n);
      expect(await getStorageAt(fermionProtocolAddress, offerFirstTokenIdSlot)).to.not.equal(0n);

      // set them to 0
      await setStorageAt(fermionProtocolAddress, offerItemQuantitySlot, BigInt(0));
      await setStorageAt(fermionProtocolAddress, offerFirstTokenIdSlot, BigInt(0));

      const offerData = [
        {
          offerId: offerId,
          itemQuantity: "1",
          firstTokenId: tokenId,
        },
      ];

      const backFillOfferCalldata = backfillingFacet.interface.encodeFunctionData("backFillOfferData", [offerData]);

      const tokenFeesData = [
        {
          tokenId: tokenId,
          bosonProtocolFee: 10,
          fermionFeeAmount: 20,
          verifierFee: 50,
          facilitatorFeeAmount: 10,
        },
      ];
      const backFillTokenCalldata = backfillingFacet.interface.encodeFunctionData("backFillTokenFees", [tokenFeesData]);

      await executeBackfillingDiamondCut(
        fermionProtocolAddress,
        backfillingFacet,
        backFillOfferCalldata,
        backFillTokenCalldata,
        initializationFacetImplementationAddress,
        version,
      );
      const itemPriceAfterBackfill = await getStorageAt(fermionProtocolAddress, itemPriceTokenLocation);
      // Verify token fee values have been set correctly
      expect(await getStorageAt(fermionProtocolAddress, bosonProtocolFeeTokenLocation)).to.equal(
        toBeHex(tokenFeesData[0].bosonProtocolFee, 32),
      );
      expect(await getStorageAt(fermionProtocolAddress, fermionFeeAmountTokenLocation)).to.equal(
        toBeHex(tokenFeesData[0].fermionFeeAmount, 32),
      );
      expect(await getStorageAt(fermionProtocolAddress, verifierFeeTokenLocation)).to.equal(
        toBeHex(tokenFeesData[0].verifierFee, 32),
      );
      expect(await getStorageAt(fermionProtocolAddress, facilitatorFeeAmountTokenLocation)).to.equal(
        toBeHex(tokenFeesData[0].facilitatorFeeAmount, 32),
      );

      // Verify offer values have been set correctly
      expect(await getStorageAt(fermionProtocolAddress, offerItemQuantitySlot)).to.equal(
        toBeHex(offerData[0].itemQuantity, 32),
      );
      expect(await getStorageAt(fermionProtocolAddress, offerFirstTokenIdSlot)).to.equal(offerData[0].firstTokenId);
      expect(BigInt(itemPriceAfterBackfill)).to.equal(
        BigInt(itemPriceBeforeBackfill) + BigInt(tokenFeesData[0].bosonProtocolFee),
      );
    });
  });
});
