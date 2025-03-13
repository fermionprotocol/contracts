import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { applyPercentage, deployFermionProtocolFixture, deployMockTokens, deriveTokenId } from "../utils/common";
import { setupDryRun } from "../../scripts/dry-run";
import { getBosonHandler } from "../utils/boson-protocol";
import { expect } from "chai";
import hre, { ethers } from "hardhat";
import { Contract, ZeroHash } from "ethers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { EntityRole } from "../utils/enums";
import { Seaport } from "@opensea/seaport-js";
import { ItemType } from "@opensea/seaport-js/lib/constants";
import { AdvancedOrder } from "@opensea/seaport-js/lib/types";
import { getBosonProtocolFees } from "../utils/boson-protocol";
import fermionConfig from "./../../fermion.config";

const { ZeroAddress, parseEther } = ethers;
const { percentage: bosonProtocolFeePercentage } = getBosonProtocolFees();

describe("[@skip-on-coverage] Seaport integration test", function () {
  this.timeout(100000000);
  const sellerId = "1";
  const verifierId = "1";
  const custodianId = "1";
  const facilitatorId = "1";
  const custodianFee = {
    amount: parseEther("0.05"),
    period: 30n * 24n * 60n * 60n, // 30 days
  };
  let offerFacet: Contract, entityFacet: Contract;
  let mockToken: Contract;
  let defaultSigner: HardhatEthersSigner;
  let buyer: HardhatEthersSigner;
  let seaportAddress: string;
  let bosonProtocolAddress: string;

  async function setupOfferTest() {
    const metadataURI = "https://example.com/seller-metadata.json";
    await entityFacet.createEntity([EntityRole.Seller, EntityRole.Verifier, EntityRole.Custodian], metadataURI); // "1"

    // Connect to Hardhat Provider
    buyer = ethers.Wallet.createRandom().connect(ethers.provider);
    // Set balance
    await ethers.provider.send("hardhat_setBalance", [
      buyer.address,
      "0x56BC75E2D63100000", // 100 ETH
    ]);

    [mockToken] = await deployMockTokens(["ERC20"]);
    mockToken = mockToken.connect(defaultSigner);
    await mockToken.mint(defaultSigner.address, parseEther("1000"));

    await offerFacet.addSupportedToken(await mockToken.getAddress());
    await offerFacet.addSupportedToken(ZeroAddress);
  }

  before(async function () {
    if (hre.network.name === "hardhat") this.skip();

    const env = "prod";

    await setupDryRun(env, "", true);
    [defaultSigner] = await ethers.getSigners();

    const fixtureArgs = { env, defaultSigner };

    ({
      facets: { EntityFacet: entityFacet, OfferFacet: offerFacet },
      seaportAddress,
      bosonProtocolAddress,
    } = await loadFixture(deployFermionProtocolFixture.bind(fixtureArgs)));

    await loadFixture(setupOfferTest);
  });

  afterEach(async function () {
    await loadFixture(setupOfferTest);
  });

  context("unwrapping", function () {
    let bosonOfferId: bigint;
    let exchangeId: bigint;
    let tokenId: string;
    let bosonSellerId: bigint; // Fermion's seller id inside Boson

    const quantity = 1n;
    const verifierFee = parseEther("0.01");
    // const bosonSellerId = "1"; // Fermion's seller id inside Boson

    const fullPrice = parseEther("10");
    const openSeaFee = (fullPrice * 2_50n) / 100_00n;
    const priceSubOSFee = fullPrice - openSeaFee;
    const priceSubOSAndBosonFee = priceSubOSFee - applyPercentage(priceSubOSFee, bosonProtocolFeePercentage);
    let openSeaAddress: string, buyerAddress: string;
    let bosonProtocolBalance: bigint;
    let buyerAdvancedOrder: AdvancedOrder;
    let seaport: Seaport;

    let exchangeToken: string;
    let wrapperAddress: string;
    let bosonExchangeHandler: Contract;
    let defaultCollectionAddress: string;

    before(async function () {
      const bosonAccountHandler = await getBosonHandler("IBosonAccountHandler", bosonProtocolAddress);
      bosonSellerId = (await bosonAccountHandler.getNextAccountId()) - 3n; // reduce for seller, buyer, dr
      [defaultCollectionAddress] = await bosonAccountHandler.getSellersCollections(bosonSellerId);

      const bosonOfferHandler = await getBosonHandler("IBosonOfferHandler", bosonProtocolAddress);
      bosonOfferId = await bosonOfferHandler.getNextOfferId();

      bosonExchangeHandler = await getBosonHandler("IBosonExchangeHandler", bosonProtocolAddress);
      exchangeId = await bosonExchangeHandler.getNextExchangeId();

      exchangeToken = await mockToken.getAddress();
      tokenId = deriveTokenId(bosonOfferId, exchangeId).toString();

      wrapperAddress = await offerFacet.predictFermionFNFTAddress(bosonOfferId);
    });

    context("Zero seller deposit", function () {
      const sellerDeposit = 0n;

      beforeEach(async function () {
        const fermionOffer = {
          sellerId,
          sellerDeposit,
          verifierId,
          verifierFee,
          custodianId,
          custodianFee,
          facilitatorId,
          facilitatorFeePercent: "0",
          exchangeToken,
          metadataURI: "https://example.com/offer-metadata.json",
          metadataHash: ZeroHash,
        };

        await offerFacet.createOffer(fermionOffer);
        await offerFacet.mintAndWrapNFTs(bosonOfferId, quantity);

        // const openSea = wallets[5]; // a mock OS address
        const networkName = hre.config.networks["hardhat"].forking.originalChain.name;
        openSeaAddress = fermionConfig.externalContracts[networkName].seaportConfig.openSeaConduit;
        buyerAddress = buyer.address;
        seaport = new Seaport(buyer, { overrides: { seaportVersion: "1.6", contractAddress: seaportAddress } });

        await mockToken.mint(buyerAddress, fullPrice);

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
                recipient: openSeaAddress,
              },
            ],
            startTime: 0,
          },
          buyerAddress,
        );

        const buyerOrder = await executeAllActions();

        buyerAdvancedOrder = {
          ...buyerOrder,
          numerator: 1n,
          denominator: 1n,
          extraData: "0x",
        };

        bosonProtocolBalance = await mockToken.balanceOf(bosonProtocolAddress);
        // openSeaBalance = await mockToken.balanceOf(openSeaAddress);
      });

      context("unwrap (with OS auction)", function () {
        it("Unwrapping", async function () {
          const tx = await offerFacet.unwrapNFT(tokenId, buyerAdvancedOrder);

          // events:
          // fermion
          const blockTimestamp = BigInt((await tx.getBlock()).timestamp);
          const itemVerificationTimeout = blockTimestamp + fermionConfig.protocolParameters.defaultVerificationTimeout;
          const itemMaxVerificationTimeout = blockTimestamp + fermionConfig.protocolParameters.maxVerificationTimeout;
          await expect(tx)
            .to.emit(offerFacet, "VerificationInitiated")
            .withArgs(bosonOfferId, verifierId, tokenId, itemVerificationTimeout, itemMaxVerificationTimeout);
          await expect(tx).to.emit(offerFacet, "ItemPriceObserved").withArgs(tokenId, priceSubOSAndBosonFee);

          // Boson:
          await expect(tx)
            .to.emit(bosonExchangeHandler, "FundsEncumbered")
            .withArgs(bosonSellerId, exchangeToken, sellerDeposit, defaultCollectionAddress);

          // State:
          const newBosonProtocolBalance = await mockToken.balanceOf(bosonProtocolAddress);
          expect(newBosonProtocolBalance).to.equal(bosonProtocolBalance + fullPrice - openSeaFee);
        });
      });
    });
  });
});
