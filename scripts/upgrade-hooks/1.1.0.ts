import { createClient, fetchExchange } from "@urql/core";
import { encodeBytes32String } from "ethers";
import hre from "hardhat";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { readContracts, checkRole } from "../libraries/utils";
import { PausableRegion } from "../../test/utils/enums";
const { ethers } = hre;
const VERSION = "1.1.0";

// Function to get the correct GRAPHQL_URL based on chainId and env
function getGraphQLUrl(chainId: number, env: string): string {
  const subgraphConfig = JSON.parse(fs.readFileSync(path.join(__dirname, "subgraph_config.json"), "utf8"));

  if (!subgraphConfig[env] || !subgraphConfig[env][chainId.toString()]) {
    throw new Error(`No subgraph configuration found for chainId ${chainId} and env ${env}`);
  }

  const url = subgraphConfig[env][chainId.toString()].subgraphUrl;
  if (url === "TBD") {
    throw new Error(`Subgraph URL is TBD for chainId ${chainId} and env ${env}`);
  }

  return url;
}

// Function to get the InitializationFacet address based on chainId and env
export async function getInitializationFacetAddress(chainId: number, env: string): Promise<string> {
  const addressData = await readContracts(env);
  const initializationFacet = addressData.contracts.find((contract: any) => contract.name === "InitializationFacet");

  if (!initializationFacet) {
    throw new Error(`InitializationFacet not found in addresses file for chainId ${chainId} and env ${env}`);
  }

  return initializationFacet.address;
}

interface Token {
  tokenId: string;
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
    offers(first: 1000, where: { fNFTs_: { status_in: [3, 4, 5, 6, 7] } }) {
      verifierFee
      facilitatorFeePercent
      fNFTs {
        tokenId
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
    fnftranges (first: 1000) {
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
async function fetchFNFTRangeData(client: any): Promise<FNFTRange[]> {
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
 * Prepare backfill firstTokenId and itemQuantity data for offers.
 */
export async function prepareOfferBackfillData(client: any): Promise<OfferData[]> {
  const fnftRanges = await fetchFNFTRangeData(client);
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
 * Fetch GraphQL data for nft tokens in offers that are in a specific state.
 */
async function fetchOfferData(client: any): Promise<Offer[]> {
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
  const facilitatorFeeAmount = (remainder * facilitatorFeePercentBps) / HUNDRED_PERCENT_BPS;

  return {
    tokenId,
    bosonProtocolFee,
    fermionFeeAmount,
    verifierFee,
    facilitatorFeeAmount,
  };
}

/**
 * Prepare backfill fee data from fetched offers.
 */
export async function prepareTokenFeeBackfillData(client: any): Promise<FeeData[]> {
  const offers = await fetchOfferData(client);
  const feeDataList: FeeData[] = [];

  for (const offer of offers) {
    const verifierFee = BigInt(offer.verifierFee);
    const facilitatorFeePercentBps = BigInt(offer.facilitatorFeePercent);

    for (const token of offer.fNFTs) {
      const price = token.priceLog?.amount ? BigInt(token.priceLog.amount) : 0n; // full item price
      const tokenId = token.tokenId;
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
 * Execute a diamond cut with backfilling initialization data
 */
export async function executeBackfillingDiamondCut(
  protocolAddress: string,
  backfillingFacet: any,
  offerBackfillCalldata: string,
  tokenBackfillCalldata: string,
  initializationFacetImplAddress: string,
  version: string,
) {
  const backfillingFacetAddress = await backfillingFacet.getAddress();
  const addresses = [backfillingFacetAddress, backfillingFacetAddress];
  const calldata = [offerBackfillCalldata, tokenBackfillCalldata];
  const interfacesToAdd: string[] = [];
  const interfacesToRemove: string[] = [];

  // Get the initialization facet to encode the calldata properly
  const initializationFacet = await ethers.getContractAt("InitializationFacet", protocolAddress);
  const initCalldata = initializationFacet.interface.encodeFunctionData("initialize", [
    version,
    addresses,
    calldata,
    interfacesToAdd,
    interfacesToRemove,
  ]);

  console.log("Calling DiamondCutFacet.diamondCut...");
  const diamondCutFacet = await ethers.getContractAt("DiamondCutFacet", protocolAddress);
  const tx = await diamondCutFacet.diamondCut([], initializationFacetImplAddress, initCalldata);
  await tx.wait();
  console.log("Diamond cut completed successfully");
}

/**
 * Perform pre-upgrade tasks, including deploying the BackfillingV1_1_0 contract,
 * preparing initialization data, and making the diamond cut.
 */
export async function preUpgrade(protocolAddress: string, chainId: number, env: string, isDryRun: boolean = false) {
  const signer = (await ethers.getSigners())[0].address;
  await checkRole([{ name: "FermionDiamond", address: protocolAddress }], "PAUSER", signer);

  const pauseFacet = await ethers.getContractAt("PauseFacet", protocolAddress);
  const regionsToPause = [
    PausableRegion.Offer,
    PausableRegion.Verification,
    PausableRegion.Custody,
    PausableRegion.CustodyVault,
  ];

  console.log(
    "Pausing specific protocol regions before backfill:",
    regionsToPause.map((region) => PausableRegion[region]),
  );
  await pauseFacet.pause(regionsToPause);

  // Set the correct GRAPHQL_URL based on chainId and env
  const graphQLUrl = getGraphQLUrl(chainId, env);
  const client = createClient({
    url: graphQLUrl,
    exchanges: [fetchExchange],
    fetch: fetch as any,
  });

  console.log("Fetching and preparing backfill data...");
  const feeDataList = await prepareTokenFeeBackfillData(client);
  const offerDataList = await prepareOfferBackfillData(client);

  console.log("Deploying BackfillingV1_1_0...");
  const BackfillingV1_1_0 = await ethers.getContractFactory("BackfillingV1_1_0");
  const backfillingFacet = await BackfillingV1_1_0.deploy();
  await backfillingFacet.waitForDeployment();
  console.log(`BackfillingV1_1_0 deployed at: ${await backfillingFacet.getAddress()}`);

  console.log("Preparing initialization calldata...");
  const backFillFeesCalldata = backfillingFacet.interface.encodeFunctionData("backFillTokenFees", [feeDataList]);
  const backFillOfferCalldata = backfillingFacet.interface.encodeFunctionData("backFillOfferData", [offerDataList]);

  const version = encodeBytes32String(VERSION);
  // Use the correct environment name based on whether we're in dry-run mode
  const envForContracts = isDryRun ? `${env}-dry-run` : env;
  const initializationFacetImplAddress = await getInitializationFacetAddress(chainId, envForContracts);

  await executeBackfillingDiamondCut(
    protocolAddress,
    backfillingFacet,
    backFillOfferCalldata,
    backFillFeesCalldata,
    initializationFacetImplAddress,
    version,
  );
}

/**
 * Perform post-upgrade tasks, including verification of the upgrade.
 */
export async function postUpgrade(protocolAddress: string) {
  console.log("Verifying upgrade...");
  const initializationFacet = await ethers.getContractAt("InitializationFacet", protocolAddress);
  const version = await initializationFacet.getVersion();
  console.log(`Verified version: ${version.replace(/\0/g, "")}`);

  const pauseFacet = await ethers.getContractAt("PauseFacet", protocolAddress);
  console.log("Unpausing all protocol regions after upgrade...");
  await pauseFacet.unpause([]);
}
