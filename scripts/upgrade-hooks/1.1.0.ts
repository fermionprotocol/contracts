import { ApolloClient, InMemoryCache, gql } from "@apollo/client/core";
import hre from "hardhat";
import { AbiCoder } from "ethers";

const { ethers } = hre; // Access ethers from hre
const GRAPHQL_URL = "https://api.studio.thegraph.com/query/19713/fermion-testing-amoy/version/latest";
const TOKEN_STATUSES = [3, 4, 5, 6, 7];
const VERSION = "1.1.0";

const abiCoder = new AbiCoder(); // Create a new AbiCoder instance
const client = new ApolloClient({
  uri: GRAPHQL_URL,
  cache: new InMemoryCache(),
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

const OFFER_QUERY = gql`
  query FetchOffers($statuses: [Int!]) {
    offers(where: { fNFTs_: { status_in: $statuses } }) {
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

const FNFT_RANGE_QUERY = gql`
  query FetchFNFTRanges {
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
  const response = await client.query({
    query: FNFT_RANGE_QUERY,
  });

  if (!response?.data?.fnftranges) {
    throw new Error("No FNFT range data found in GraphQL response");
  }
  return response.data.fnftranges;
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
  const response = await client.query({
    query: OFFER_QUERY,
    variables: { statuses: TOKEN_STATUSES },
  });

  if (!response?.data?.offers) {
    throw new Error("No data found in GraphQL response");
  }
  return response.data.offers;
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
    const facilitatorFeePercentBps = BigInt(offer.facilitatorFeePercent); // Already in BPS

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
 * Perform pre-upgrade tasks, including deploying the BackfillingFacet contract,
 * preparing initialization data, and making the diamond cut.
 */
// TODO: test the preUpgrade hook in the migration PR.
export async function preUpgrade(protocolAddress: string) {
  // TODO: pause the protocol (this can be done in migration PR)
  console.log("Fetching and preparing backfill data...");
  const feeDataList = await prepareFeeBackfillData();
  const offerDataList = await prepareOfferBackfillData();

  console.log("Deploying BackfillingFacet...");
  const BackfillingFacetFactory = await ethers.getContractFactory("BackfillingFacet");
  const backfillingFacet = await BackfillingFacetFactory.deploy();
  await backfillingFacet.deployed();
  console.log(`BackfillingFacet deployed at: ${backfillingFacet.address}`);

  console.log("Preparing initialization calldata...");
  const backFillFeesCalldata = backfillingFacet.interface.encodeFunctionData("backFillTokenFees", [feeDataList]);
  const backFillOfferCalldata = backfillingFacet.interface.encodeFunctionData("backFillOfferData", [offerDataList]);

  const version = ethers.toUtf8Bytes(VERSION);
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
