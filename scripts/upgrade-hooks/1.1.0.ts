import { ethers } from "ethers";
import { ApolloClient, InMemoryCache, gql } from "@apollo/client/core";

const GRAPHQL_URL = "https://api.studio.thegraph.com/query/19713/fermion-testing-amoy/version/latest";
const TOKEN_STATUSES = [3, 4, 5, 6, 7];

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

/**
 * Fetch GraphQL data for offers and tokens in specific states.
 */
async function fetchGraphQLData(): Promise<Offer[]> {
  try {
    const response = await client.query({
      query: OFFER_QUERY,
      variables: { statuses: TOKEN_STATUSES },
    });

    if (!response?.data?.offers) {
      throw new Error("No data found in GraphQL response");
    }
    return response.data.offers;
  } catch (error) {
    console.error("Error fetching GraphQL data:", error);
    throw error;
  }
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
export async function prepareBackfillData(): Promise<FeeData[]> {
  const offers = await fetchGraphQLData();
  const feeDataList: FeeData[] = [];

  offers.forEach((offer) => {
    const verifierFee = BigInt(offer.verifierFee);
    const facilitatorFeePercentBps = BigInt(offer.facilitatorFeePercent); // Already in BPS

    offer.fNFTs.forEach((token) => {
      // Handle null priceLog gracefully, default to 0 if price is missing
      const price = token.priceLog?.amount ? BigInt(token.priceLog.amount) : 0n;

      const feeData = calculateFees(verifierFee, facilitatorFeePercentBps, token.id, price);
      feeDataList.push(feeData);
    });
  });

  console.log(
    "Prepared Backfill Data:",
    JSON.stringify(feeDataList, (key, value) => (typeof value === "bigint" ? value.toString() : value), 2),
  );
  return feeDataList;
}

/**
 * Perform pre-upgrade tasks, such as backfilling data.
 */
export async function preUpgrade(protocolAddress: string) {
  console.log("Fetching and preparing backfill data...");
  const feeDataList = await prepareBackfillData();

  const provider = new ethers.JsonRpcProvider();
  const signer = await provider.getSigner();

  const backfillingFacet = new ethers.Contract(
    protocolAddress,
    ["function backFillV1_1_0(FeeData[] calldata feeDataList) external"],
    signer,
  );

  const chunkSize = 100;
  for (let i = 0; i < feeDataList.length; i += chunkSize) {
    const chunk = feeDataList.slice(i, i + chunkSize);

    const tx = await backfillingFacet.backFillV1_1_0(chunk);
    await tx.wait();

    console.log(`Processed chunk ${Math.ceil(i / chunkSize) + 1}/${Math.ceil(feeDataList.length / chunkSize)}`);
  }

  console.log("Backfilling completed successfully.");
}
