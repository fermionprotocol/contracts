import { createClient, fetchExchange } from "@urql/core";
import { AbiCoder, encodeBytes32String } from "ethers";
import hre from "hardhat";
import fetch from "node-fetch";

const { ethers } = hre;
const GRAPHQL_URL =
  "https://api.0xgraph.xyz/api/public/bc2d0937-fe5a-4a0c-97f5-b90b8428f989/subgraphs/fermion-staging-amoy/latest/gn";
const VERSION = "1.1.0";

const abiCoder = new AbiCoder();

// Create a urql client with just fetchExchange since we don't need caching
const client = createClient({
  url: GRAPHQL_URL,
  exchanges: [fetchExchange],
  fetch: fetch as any,
});

interface Token {
  id: string;
  status: number;
  priceLog: { amount: string | null };
}

interface Offer {
  verifierFee: string;
  facilitatorFeePercent: string;
  fNFTs: Token[];
}

export interface FeeData {
  tokenId: string;
  bosonProtocolFee: bigint;
  fermionFeeAmount: bigint;
  verifierFee: bigint;
  facilitatorFeeAmount: bigint;
}

const OFFER_QUERY = `
  query {
    offers(where: { fNFTs_: { status_in: [3, 4, 5, 6, 7] } }) {
      verifierFee
      facilitatorFeePercent
      fNFTs {
        id
        status
        priceLog {
          amount
        }
      }
    }
  }
`;

const FNFT_RANGE_QUERY = `
  query {
    fnftranges {
      bosonOfferId
      startingId
      quantity
    }
  }
`;

interface FNFTRange {
  bosonOfferId: string;
  startingId: string;
  quantity: string;
}

export interface OfferData {
  offerId: string;
  itemQuantity: string;
  firstTokenId: string;
}

/**
 * Fetch GraphQL data for FNFT ranges.
 */
async function fetchFNFTRangeData(): Promise<FNFTRange[]> {
  const result = await client.query(FNFT_RANGE_QUERY, {}).toPromise();

  if (result.error) {
    throw new Error(`GraphQL error: ${result.error.message}`);
  }

  if (!result.data?.fnftranges) {
    throw new Error("No FNFT range data found in GraphQL response");
  }

  return result.data.fnftranges;
}

/**
 * Prepare backfill data for offers.
 */
export async function prepareOfferBackfillData(): Promise<OfferData[]> {
  const fnftRanges = await fetchFNFTRangeData();
  const offerDataList: OfferData[] = [];

  for (const range of fnftRanges) {
    offerDataList.push({
      offerId: range.bosonOfferId,
      itemQuantity: range.quantity,
      firstTokenId: range.startingId,
    });
  }

  console.log("Prepared Offer Backfill Data:", JSON.stringify(offerDataList, null, 2));

  return offerDataList;
}

/**
 * Fetch GraphQL data for offers and tokens in specific states.
 */
async function fetchGraphQLData(): Promise<Offer[]> {
  const result = await client.query(OFFER_QUERY, {}).toPromise();

  if (result.error) {
    throw new Error(`GraphQL error: ${result.error.message}`);
  }

  if (!result.data?.offers) {
    throw new Error("No data found in GraphQL response");
  }

  return result.data.offers;
}

/**
 * Calculate fees for backfilling based on offer details.
 */
function calculateFees(verifierFee: bigint, facilitatorFeePercentBps: bigint, tokenId: string, price: bigint): FeeData {
  const HUNDRED_PERCENT_BPS = 100_00n;
  const BOSON_PROTOCOL_FEE_BPS = 50n; // 0.5%
  const bosonProtocolFee = (price * BOSON_PROTOCOL_FEE_BPS) / HUNDRED_PERCENT_BPS;
  const fermionFeeAmount = 0n;
  const remainder = price - bosonProtocolFee - fermionFeeAmount - verifierFee;
  const facilitatorFeeAmount = remainder > 0n ? (remainder * facilitatorFeePercentBps) / HUNDRED_PERCENT_BPS : 0n;

  return {
    tokenId,
    bosonProtocolFee,
    fermionFeeAmount,
    verifierFee,
    facilitatorFeeAmount,
  };
}

/**
 * Prepare backfill data from fetched offers.
 */
export async function prepareFeeBackfillData(): Promise<FeeData[]> {
  const offers = await fetchGraphQLData();
  const feeDataList: FeeData[] = [];

  for (const offer of offers) {
    const verifierFee = BigInt(offer.verifierFee);
    const facilitatorFeePercentBps = BigInt(offer.facilitatorFeePercent);

    for (const token of offer.fNFTs) {
      const price = token.priceLog?.amount ? BigInt(token.priceLog.amount) : 0n;
      const tokenId = token.id.split("-")[1];
      const feeData = calculateFees(verifierFee, facilitatorFeePercentBps, tokenId, price);
      feeDataList.push(feeData);
    }
  }

  console.log(
    "Prepared Backfill Data:",
    JSON.stringify(feeDataList, (_key, value) => (typeof value === "bigint" ? value.toString() : value), 2),
  );

  return feeDataList;
}

/**
 * Perform pre-upgrade tasks, including deploying the BackfillingV1_1_0 contract,
 * preparing initialization data, and making the diamond cut.
 */
export async function preUpgrade(protocolAddress: string) {
  console.log("Fetching and preparing backfill data...");
  const feeDataList = await prepareFeeBackfillData();
  const offerDataList = await prepareOfferBackfillData();

  console.log("Deploying BackfillingV1_1_0...");
  const BackfillingV1_1_0 = await ethers.getContractFactory("BackfillingV1_1_0");
  const backfillingFacet = await BackfillingV1_1_0.deploy();
  await backfillingFacet.deployed();
  console.log(`BackfillingV1_1_0 deployed at: ${backfillingFacet.address}`);

  console.log("Preparing initialization calldata...");
  const backFillFeesCalldata = backfillingFacet.interface.encodeFunctionData("backFillTokenFees", [feeDataList]);
  const backFillOfferCalldata = backfillingFacet.interface.encodeFunctionData("backFillOfferData", [offerDataList]);

  const version = encodeBytes32String(VERSION);
  const addresses = [backfillingFacet.address];
  const calldata = [backFillFeesCalldata, backFillOfferCalldata];
  const interfacesToAdd: string[] = [];
  const interfacesToRemove: string[] = [];

  const backfillingCalldata = abiCoder.encode(
    ["bytes32", "address[]", "bytes[]", "bytes4[]", "bytes4[]"],
    [version, addresses, calldata, interfacesToAdd, interfacesToRemove],
  );

  console.log("Calling DiamondCutFacet.diamondCut...");
  const diamondCutFacet = await ethers.getContractAt("DiamondCutFacet", protocolAddress);
  const tx = await diamondCutFacet.diamondCut([], backfillingFacet.address, backfillingCalldata);

  console.log("Transaction sent. Waiting for confirmation...");
  await tx.wait();

  console.log("Diamond cut and backfilling initialization completed successfully.");
}
