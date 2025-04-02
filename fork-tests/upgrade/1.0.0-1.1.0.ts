import { expect } from "chai";
import { ethers } from "hardhat";
import { keccak256, toBeHex, concat } from "ethers";
import { getStorageAt } from "@nomicfoundation/hardhat-network-helpers";
import { upgradeFacets } from "../../scripts/upgrade/upgrade-facets";
import { createClient, fetchExchange } from "@urql/core";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { readContracts } from "../../scripts/libraries/utils";
import { prepareTokenFeeBackfillData, prepareOfferBackfillData } from "../../scripts/upgrade-hooks/1.1.0";

const protocolLookupsSlot = "0x769aa294c8d03dc2ae011ff448d15e722e87cfb823b4b4d6339267d1c690d900";
const offerLookupsSlot = BigInt(protocolLookupsSlot) + 6n;
const tokenLookupsSlot = BigInt(protocolLookupsSlot) + 7n;
const env = "test";

function getMappingStorageSlot(mappingSlot: string | bigint, key: string | bigint): string {
  const paddedKey = toBeHex(BigInt(key), 32);
  const paddedMappingSlot = toBeHex(BigInt(mappingSlot), 32);
  const concatenated = concat([paddedKey, paddedMappingSlot]);
  return keccak256(concatenated);
}

// Skip by default, but can be run directly with --grep "fork"
describe("Fork Upgrade from 1.0.1 to 1.1.0", function () {
  let fermionProtocolAddress: string;
  let graphQLClient: any;

  beforeEach(async function () {
    const originalNetwork = await ethers.provider.getNetwork();
    const originalChainId = originalNetwork.chainId.toString();

    const contractsFile = await readContracts(env);
    const contracts = contractsFile?.contracts;

    if (!contracts) {
      throw new Error("No contracts found in contracts file");
    }

    // Get protocol address and contract instances
    fermionProtocolAddress = contracts.find((c: any) => c.name === "FermionDiamond")?.address;
    if (!fermionProtocolAddress) {
      throw new Error("Protocol address not found");
    }

    // Setup GraphQL client
    const subgraphConfig = JSON.parse(
      fs.readFileSync(path.join(__dirname, "../../scripts/upgrade-hooks/subgraph_config.json"), "utf8"),
    );
    const graphQLUrl = subgraphConfig[env][originalChainId].subgraphUrl;
    graphQLClient = createClient({
      url: graphQLUrl,
      exchanges: [fetchExchange],
      fetch: fetch as any,
    });
  });

  context("Backfilling", function () {
    it("should backfill token fees and offer data during upgrade", async function () {
      // Get data from subgraph
      const feeDataList = await prepareTokenFeeBackfillData(graphQLClient);
      const offerDataList = await prepareOfferBackfillData(graphQLClient);

      // Execute upgrade
      await upgradeFacets(env, "1.1.0", true, true);

      // Get final storage values
      const finalValues = await Promise.all(
        feeDataList.map(async (feeData) => {
          const tokenIdStorageSlot = BigInt(getMappingStorageSlot(tokenLookupsSlot, feeData.tokenId));
          return {
            tokenId: feeData.tokenId,
            bosonProtocolFee: await getStorageAt(fermionProtocolAddress, tokenIdStorageSlot + 7n),
            fermionFeeAmount: await getStorageAt(fermionProtocolAddress, tokenIdStorageSlot + 8n),
            verifierFee: await getStorageAt(fermionProtocolAddress, tokenIdStorageSlot + 9n),
            facilitatorFeeAmount: await getStorageAt(fermionProtocolAddress, tokenIdStorageSlot + 10n),
          };
        }),
      );

      const finalOfferValues = await Promise.all(
        offerDataList.map(async (offerData) => {
          const offerStorageSlot = getMappingStorageSlot(offerLookupsSlot, offerData.offerId);
          return {
            offerId: offerData.offerId,
            itemQuantity: await getStorageAt(fermionProtocolAddress, BigInt(offerStorageSlot) + 10n),
            firstTokenId: await getStorageAt(fermionProtocolAddress, BigInt(offerStorageSlot) + 11n),
          };
        }),
      );

      // Verify token fee values have been updated correctly
      for (let i = 0; i < feeDataList.length; i++) {
        const feeData = feeDataList[i];
        const final = finalValues[i];

        // Convert storage values to BigInt for comparison
        const expectedBosonProtocolFee = BigInt(feeData.bosonProtocolFee);
        const expectedFermionFeeAmount = BigInt(feeData.fermionFeeAmount);
        const expectedVerifierFee = BigInt(feeData.verifierFee);
        const expectedFacilitatorFeeAmount = BigInt(feeData.facilitatorFeeAmount);

        const actualBosonProtocolFee = BigInt(final.bosonProtocolFee);
        const actualFermionFeeAmount = BigInt(final.fermionFeeAmount);
        const actualVerifierFee = BigInt(final.verifierFee);
        const actualFacilitatorFeeAmount = BigInt(final.facilitatorFeeAmount);

        expect(actualBosonProtocolFee).to.equal(expectedBosonProtocolFee);
        expect(actualFermionFeeAmount).to.equal(expectedFermionFeeAmount);
        expect(actualVerifierFee).to.equal(expectedVerifierFee);
        expect(actualFacilitatorFeeAmount).to.equal(expectedFacilitatorFeeAmount);
      }

      // Verify offer values have been updated correctly
      for (let i = 0; i < offerDataList.length; i++) {
        const offerData = offerDataList[i];
        const final = finalOfferValues[i];

        // Convert storage values to BigInt for comparison
        const expectedItemQuantity = BigInt(offerData.itemQuantity);
        const expectedFirstTokenId = BigInt(offerData.firstTokenId);

        const actualItemQuantity = BigInt(final.itemQuantity);
        const actualFirstTokenId = BigInt(final.firstTokenId);

        expect(actualItemQuantity).to.equal(expectedItemQuantity);
        expect(actualFirstTokenId).to.equal(expectedFirstTokenId);
      }
    });
  });
});
