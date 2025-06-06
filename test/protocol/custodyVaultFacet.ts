import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployFermionProtocolFixture, deployMockTokens, setNextBlockTimestamp } from "../utils/common";
import { assert, expect } from "chai";
import { ethers } from "hardhat";
import { Contract, ZeroHash, id } from "ethers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { EntityRole, PausableRegion, VerificationStatus, WrapType } from "../utils/enums";
import { createBuyerAdvancedOrderClosure } from "../utils/seaport";
import {
  AUCTION_END_BUFFER,
  MINIMAL_BID_INCREMENT,
  DEFAULT_FRACTION_AMOUNT,
  PARTIAL_THRESHOLD_MULTIPLIER,
  PARTIAL_AUCTION_DURATION_DIVISOR,
  AUCTION_DURATION,
  UNLOCK_THRESHOLD,
  TOP_BID_LOCK_TIME,
} from "../utils/constants";

const { parseEther, ZeroAddress } = ethers;

describe("CustodyVault", function () {
  let offerFacet: Contract,
    entityFacet: Contract,
    verificationFacet: Contract,
    custodyFacet: Contract,
    fundsFacet: Contract,
    pauseFacet: Contract,
    custodyVaultFacet: Contract;
  let mockToken: Contract, mockTokenAddress: string;
  let fermionErrors: Contract;
  let fermionProtocolAddress: string;
  let wallets: HardhatEthersSigner[];
  let defaultSigner: HardhatEthersSigner;
  let custodian: HardhatEthersSigner;
  let facilitator: HardhatEthersSigner, facilitator2: HardhatEthersSigner;
  let buyer: HardhatEthersSigner;
  let bidder: HardhatEthersSigner;
  let seaportAddress: string;
  let wrapper: Contract;
  const offerId = "1";
  const sellerId = "1";
  const verifierId = "2";
  const custodianId = "3";
  const facilitatorId = "4";
  const facilitator2Id = "5";
  const verifierFee = parseEther("0.1");
  const sellerDeposit = parseEther("0.05");
  const custodianFee = {
    amount: parseEther("0.05"),
    period: 30n * 24n * 60n * 60n, // 30 days
  };
  const exchange = { tokenId: "", custodianId: "", price: 0n };
  const additionalDeposit = 0n;
  const defaultEpoch = 0n;

  async function setupCustodyTest() {
    // Create three entities
    // Seller, Verifier, Custodian combined
    // Verifier only
    // Custodian only
    const metadataURI = "https://example.com/seller-metadata.json";
    const verifier = wallets[2];
    custodian = wallets[3];
    facilitator = wallets[4];
    facilitator2 = wallets[5];
    await entityFacet.createEntity([EntityRole.Seller, EntityRole.Verifier, EntityRole.Custodian], metadataURI); // "1"
    await entityFacet.connect(verifier).createEntity([EntityRole.Verifier], metadataURI); // "2"
    await entityFacet.connect(custodian).createEntity([EntityRole.Custodian], metadataURI); // "3"
    await entityFacet.connect(facilitator).createEntity([EntityRole.Seller], metadataURI); // "4"
    await entityFacet.connect(facilitator2).createEntity([EntityRole.Seller], metadataURI); // "4"
    await entityFacet.addFacilitators(sellerId, [facilitatorId, facilitator2Id]);

    [mockToken] = await deployMockTokens(["ERC20"]);
    mockToken = mockToken.connect(defaultSigner);
    await mockToken.mint(defaultSigner.address, parseEther("1000"));
    mockTokenAddress = await mockToken.getAddress();

    await offerFacet.addSupportedToken(await mockToken.getAddress());

    // Create offer
    const fermionOffer = {
      sellerId,
      sellerDeposit,
      verifierId,
      verifierFee,
      custodianId: "3",
      custodianFee,
      facilitatorId: sellerId,
      facilitatorFeePercent: "0",
      exchangeToken: await mockToken.getAddress(),
      withPhygital: false,
      metadata: {
        URI: "https://example.com/offer-metadata.json",
        hash: ZeroHash,
      },
      royaltyInfo: { recipients: [], bps: [] },
    };

    // Make three offers one for normal sale, one of self sale and one for self custody
    await offerFacet.connect(facilitator).createOffer({ ...fermionOffer, facilitatorId });

    // Mint and wrap some NFTs
    const quantity = 3n;
    await offerFacet.mintAndWrapNFTs(offerId, quantity, { name: "test FNFT", symbol: "tFNFT" }); // offerId = 1; exchangeId = 2

    // Unwrap some NFTs - normal sale and sale with self-custody
    buyer = wallets[6];
    await mockToken.mint(buyer.address, parseEther("1000"));
    await mockToken.approve(fermionProtocolAddress, quantity * sellerDeposit);
    const verificationMetadata = {
      URI: "https://example.com/verification-metadata.json",
      hash: id("metadata"),
    };
    for (let i = 0n; i < quantity; i++) {
      const exchangeId = i + 1n;
      const createBuyerAdvancedOrder = createBuyerAdvancedOrderClosure(wallets, seaportAddress, mockToken, offerFacet);
      const { buyerAdvancedOrder, tokenId, encumberedAmount } = await createBuyerAdvancedOrder(
        buyer,
        offerId,
        exchangeId,
      );
      await offerFacet.unwrapNFT(tokenId, WrapType.OS_AUCTION, buyerAdvancedOrder);

      // Submit verdicts
      await verificationFacet
        .connect(verifier)
        .submitVerdict(tokenId, VerificationStatus.Verified, verificationMetadata);

      if (i == 0n) {
        exchange.tokenId = tokenId;
        exchange.custodianId = custodianId;
        exchange.price = encumberedAmount;
      }
    }

    bidder = wallets[7];
    await mockToken.mint(bidder.address, parseEther("1000"));

    const wrapperAddress = await offerFacet.predictFermionFNFTAddress(offerId);
    wrapper = await ethers.getContractAt("FermionFNFT", wrapperAddress);
  }

  before(async function () {
    ({
      diamondAddress: fermionProtocolAddress,
      facets: {
        EntityFacet: entityFacet,
        OfferFacet: offerFacet,
        VerificationFacet: verificationFacet,
        CustodyFacet: custodyFacet,
        FundsFacet: fundsFacet,
        PauseFacet: pauseFacet,
        CustodyVaultFacet: custodyVaultFacet,
      },
      fermionErrors,
      wallets,
      defaultSigner,
      seaportAddress,
    } = await loadFixture(deployFermionProtocolFixture));

    await loadFixture(setupCustodyTest);
  });

  afterEach(async function () {
    await loadFixture(setupCustodyTest);
  });

  context("checkIn", function () {
    it("Check-in creates vault", async function () {
      const tx = await custodyFacet.connect(custodian).checkIn(exchange.tokenId);

      const blockTimeStamp = (await tx.getBlock()).timestamp;
      const expectedCustodianVault = {
        amount: 0n,
        period: BigInt(blockTimeStamp),
      };
      const itemCount = 1n;

      expect(await custodyVaultFacet.getCustodianVault(exchange.tokenId)).to.eql([
        Object.values(expectedCustodianVault),
        itemCount,
      ]);
    });
  });

  context("topUpCustodianVault", function () {
    const topUpAmount = parseEther("0.01");
    let vaultCreationTimestamp: bigint;
    const itemCount = 1n;

    beforeEach(async function () {
      const tx = await custodyFacet.connect(custodian).checkIn(exchange.tokenId);
      vaultCreationTimestamp = BigInt((await tx.getBlock()).timestamp);
    });

    it("Anyone can top-up the vault", async function () {
      const protocolBalance = await mockToken.balanceOf(fermionProtocolAddress);

      await mockToken.approve(fermionProtocolAddress, topUpAmount);
      const tx = await custodyVaultFacet.topUpCustodianVault(exchange.tokenId, topUpAmount);

      await expect(tx).to.emit(custodyVaultFacet, "VaultBalanceUpdated").withArgs(exchange.tokenId, topUpAmount);

      const expectedCustodianVault = {
        amount: topUpAmount,
        period: vaultCreationTimestamp,
      };

      expect(await custodyVaultFacet.getCustodianVault(exchange.tokenId)).to.eql([
        Object.values(expectedCustodianVault),
        itemCount,
      ]);
      expect(await mockToken.balanceOf(fermionProtocolAddress)).to.equal(protocolBalance + topUpAmount);
    });

    it("Second top-up adds value", async function () {
      const protocolBalance = await mockToken.balanceOf(fermionProtocolAddress);

      await mockToken.approve(fermionProtocolAddress, topUpAmount);
      await custodyVaultFacet.topUpCustodianVault(exchange.tokenId, topUpAmount);

      const topUpAmount2 = parseEther("0.01");
      await mockToken.approve(fermionProtocolAddress, topUpAmount2);
      const tx = await custodyVaultFacet.topUpCustodianVault(exchange.tokenId, topUpAmount2);
      await expect(tx)
        .to.emit(custodyVaultFacet, "VaultBalanceUpdated")
        .withArgs(exchange.tokenId, topUpAmount + topUpAmount2);

      const expectedCustodianVault = {
        amount: topUpAmount + topUpAmount2,
        period: vaultCreationTimestamp,
      };

      expect(await custodyVaultFacet.getCustodianVault(exchange.tokenId)).to.eql([
        Object.values(expectedCustodianVault),
        itemCount,
      ]);
      expect(await mockToken.balanceOf(fermionProtocolAddress)).to.equal(protocolBalance + topUpAmount + topUpAmount2);
    });

    context("Revert reasons", function () {
      it("Custody region is paused", async function () {
        await pauseFacet.pause([PausableRegion.CustodyVault]);

        await expect(custodyVaultFacet.topUpCustodianVault(exchange.tokenId, topUpAmount))
          .to.be.revertedWithCustomError(fermionErrors, "RegionPaused")
          .withArgs(PausableRegion.CustodyVault);
      });

      it("Amount to deposit is zero", async function () {
        const topUpAmount = 0n;

        await expect(
          custodyVaultFacet.topUpCustodianVault(exchange.tokenId, topUpAmount),
        ).to.be.revertedWithCustomError(fermionErrors, "ZeroDepositNotAllowed");
      });

      it("Vault does not exist/is inactive", async function () {
        // existing token id but not checked in
        await expect(custodyVaultFacet.topUpCustodianVault(exchange.tokenId + 1n, topUpAmount))
          .to.be.revertedWithCustomError(fermionErrors, "InactiveVault")
          .withArgs(exchange.tokenId + 1n);

        // invalid token id
        await expect(custodyVaultFacet.topUpCustodianVault(0n, topUpAmount))
          .to.be.revertedWithCustomError(fermionErrors, "InactiveVault")
          .withArgs(0n);

        await expect(custodyVaultFacet.topUpCustodianVault(1000n, topUpAmount))
          .to.be.revertedWithCustomError(fermionErrors, "InactiveVault")
          .withArgs(1000n);
      });

      it("Funds related errors", async function () {
        // ERC20 offer - insufficient allowance
        await mockToken.approve(fermionProtocolAddress, topUpAmount - 1n);

        await expect(custodyVaultFacet.topUpCustodianVault(exchange.tokenId, topUpAmount))
          .to.be.revertedWithCustomError(mockToken, "ERC20InsufficientAllowance")
          .withArgs(fermionProtocolAddress, topUpAmount - 1n, topUpAmount);

        // ERC20 offer - contract sends insufficient funds
        await mockToken.approve(fermionProtocolAddress, topUpAmount);
        await mockToken.setBurnAmount(1);
        await expect(custodyVaultFacet.topUpCustodianVault(exchange.tokenId, topUpAmount))
          .to.be.revertedWithCustomError(fermionErrors, "WrongValueReceived")
          .withArgs(topUpAmount, topUpAmount - 1n);
        await mockToken.setBurnAmount(0);

        // ERC20 offer - insufficient balance
        const signerBalance = await mockToken.balanceOf(defaultSigner.address);
        await mockToken.transfer(wallets[4].address, signerBalance); // transfer all the tokens to another wallet

        await expect(custodyVaultFacet.topUpCustodianVault(exchange.tokenId, topUpAmount))
          .to.be.revertedWithCustomError(mockToken, "ERC20InsufficientBalance")
          .withArgs(defaultSigner.address, 0n, topUpAmount);

        // Send native currency to ERC20 offer
        await expect(
          custodyVaultFacet.topUpCustodianVault(exchange.tokenId, topUpAmount, { value: topUpAmount }),
        ).to.be.revertedWithCustomError(fermionErrors, "NativeNotAllowed");
      });
    });
  });

  context("Single F-NFT owner (non-fractionalized)", function () {
    const itemCount = 1n;
    context("releaseFundsFromVault", function () {
      const topUpAmount = custodianFee.amount * 5n; // pre pay for 5 periods
      let vaultCreationTimestamp: bigint;

      beforeEach(async function () {
        const tx = await custodyFacet.connect(custodian).checkIn(exchange.tokenId);
        vaultCreationTimestamp = BigInt((await tx.getBlock()).timestamp);

        await mockToken.approve(fermionProtocolAddress, topUpAmount);
        await custodyVaultFacet.topUpCustodianVault(exchange.tokenId, topUpAmount);
      });

      it("After the period is over, the funds can be released to custodian", async function () {
        await setNextBlockTimestamp(String(vaultCreationTimestamp + custodianFee.period + 100n));

        const protocolBalance = await mockToken.balanceOf(fermionProtocolAddress);
        const custodianAvailableFunds = await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress);

        const tx = await custodyVaultFacet.releaseFundsFromVault(exchange.tokenId);

        await expect(tx)
          .to.emit(custodyVaultFacet, "VaultBalanceUpdated")
          .withArgs(exchange.tokenId, topUpAmount - custodianFee.amount);
        await expect(tx)
          .to.emit(custodyVaultFacet, "AvailableFundsIncreased")
          .withArgs(custodianId, mockTokenAddress, custodianFee.amount);

        const expectedCustodianVault = {
          amount: topUpAmount - custodianFee.amount,
          period: vaultCreationTimestamp + custodianFee.period,
        };

        expect(await custodyVaultFacet.getCustodianVault(exchange.tokenId)).to.eql([
          Object.values(expectedCustodianVault),
          itemCount,
        ]);
        expect(await mockToken.balanceOf(fermionProtocolAddress)).to.equal(protocolBalance); // releasing should not change protocol balance
        expect(await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress)).to.equal(
          custodianAvailableFunds + custodianFee.amount,
        );

        // Wait another period to release the funds again
        await setNextBlockTimestamp(String(vaultCreationTimestamp + 2n * custodianFee.period + 150n));

        const tx2 = await custodyVaultFacet.releaseFundsFromVault(exchange.tokenId);

        await expect(tx2)
          .to.emit(custodyVaultFacet, "VaultBalanceUpdated")
          .withArgs(exchange.tokenId, topUpAmount - 2n * custodianFee.amount);
        await expect(tx2)
          .to.emit(custodyVaultFacet, "AvailableFundsIncreased")
          .withArgs(custodianId, mockTokenAddress, custodianFee.amount);

        const expectedCustodianVault2 = {
          amount: topUpAmount - 2n * custodianFee.amount,
          period: vaultCreationTimestamp + 2n * custodianFee.period,
        };

        expect(await custodyVaultFacet.getCustodianVault(exchange.tokenId)).to.eql([
          Object.values(expectedCustodianVault2),
          itemCount,
        ]);
        expect(await mockToken.balanceOf(fermionProtocolAddress)).to.equal(protocolBalance); // releasing should not change protocol balance
        expect(await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress)).to.equal(
          custodianAvailableFunds + 2n * custodianFee.amount,
        );
      });

      it("Payout for multiple periods in bulk", async function () {
        const payoutPeriods = 3n;
        await setNextBlockTimestamp(String(vaultCreationTimestamp + payoutPeriods * custodianFee.period + 200n));

        const protocolBalance = await mockToken.balanceOf(fermionProtocolAddress);
        const custodianAvailableFunds = await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress);

        const tx = await custodyVaultFacet.releaseFundsFromVault(exchange.tokenId);

        await expect(tx)
          .to.emit(custodyVaultFacet, "VaultBalanceUpdated")
          .withArgs(exchange.tokenId, topUpAmount - payoutPeriods * custodianFee.amount);
        await expect(tx)
          .to.emit(custodyVaultFacet, "AvailableFundsIncreased")
          .withArgs(custodianId, mockTokenAddress, payoutPeriods * custodianFee.amount);

        const expectedCustodianVault = {
          amount: topUpAmount - payoutPeriods * custodianFee.amount,
          period: vaultCreationTimestamp + payoutPeriods * custodianFee.period,
        };

        expect(await custodyVaultFacet.getCustodianVault(exchange.tokenId)).to.eql([
          Object.values(expectedCustodianVault),
          itemCount,
        ]);
        expect(await mockToken.balanceOf(fermionProtocolAddress)).to.equal(protocolBalance); // releasing should not change protocol balance
        expect(await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress)).to.equal(
          custodianAvailableFunds + payoutPeriods * custodianFee.amount,
        );
      });

      context("Insufficient balance start partial auction", function () {
        context("First/single item from collection", function () {
          it("Nothing to release", async function () {
            const payoutPeriods = 5n; // empty the vault
            await setNextBlockTimestamp(String(vaultCreationTimestamp + payoutPeriods * custodianFee.period + 200n));

            const tx = await custodyVaultFacet.releaseFundsFromVault(exchange.tokenId);
            await expect(tx).to.not.emit(custodyVaultFacet, "AuctionStarted");
            const expectedCustodianVault = {
              amount: 0n,
              period: vaultCreationTimestamp + payoutPeriods * custodianFee.period,
            };
            let itemCount = 1n;

            expect(await custodyVaultFacet.getCustodianVault(exchange.tokenId)).to.eql([
              Object.values(expectedCustodianVault),
              itemCount,
            ]);

            await setNextBlockTimestamp(
              String(vaultCreationTimestamp + (payoutPeriods + 1n) * custodianFee.period + 200n),
            );

            const partialAuctionThreshold = PARTIAL_THRESHOLD_MULTIPLIER * custodianFee.amount;
            const fractionsToIssue = (partialAuctionThreshold * DEFAULT_FRACTION_AMOUNT) / exchange.price;
            const buyoutAuctionDefaultParameters = {
              exitPrice: exchange.price,
              duration: AUCTION_DURATION,
              unlockThreshold: UNLOCK_THRESHOLD,
              topBidLockTime: TOP_BID_LOCK_TIME,
            };

            const custodianAvailableFunds = await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress);

            const tx2 = await custodyVaultFacet.releaseFundsFromVault(exchange.tokenId);
            const offerVaultCreationTimestamp = BigInt((await tx2.getBlock()).timestamp);
            const auctionEnd = offerVaultCreationTimestamp + custodianFee.period / PARTIAL_AUCTION_DURATION_DIVISOR;
            await expect(tx2).to.not.emit(fundsFacet, "AvailableFundsIncreased");
            await expect(tx2)
              .to.emit(custodyVaultFacet, "AuctionStarted")
              .withArgs(offerId, fractionsToIssue, auctionEnd);
            await expect(tx2)
              .to.emit(wrapper, "FractionsSetup")
              .withArgs(DEFAULT_FRACTION_AMOUNT, Object.values(buyoutAuctionDefaultParameters), defaultEpoch);
            await expect(tx2)
              .to.emit(wrapper, "Fractionalised")
              .withArgs(exchange.tokenId, DEFAULT_FRACTION_AMOUNT, defaultEpoch);
            await expect(tx2)
              .to.emit(wrapper, "AdditionalFractionsMinted")
              .withArgs(fractionsToIssue, DEFAULT_FRACTION_AMOUNT + fractionsToIssue, defaultEpoch);

            // offer vault is created
            const expectedOfferVault = {
              amount: 0n,
              period: expectedCustodianVault.period,
            };

            expect(await custodyVaultFacet.getCustodianVault(offerId)).to.eql([
              Object.values(expectedOfferVault),
              itemCount,
            ]);

            // item vault is closed
            const expectedItemVault = {
              amount: 0n,
              period: 0n,
            };
            itemCount = 0n;

            expect(await custodyVaultFacet.getCustodianVault(exchange.tokenId)).to.eql([
              Object.values(expectedItemVault),
              itemCount,
            ]);
            expect(await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress)).to.equal(custodianAvailableFunds);
          });

          it("Some periods can be covered, but not all, item vault balance is multiple of custodian fee", async function () {
            const payoutPeriods = 5n; // empty the vault
            await setNextBlockTimestamp(
              String(vaultCreationTimestamp + (payoutPeriods + 1n) * custodianFee.period + 200n),
            );

            const partialAuctionThreshold = PARTIAL_THRESHOLD_MULTIPLIER * custodianFee.amount;
            const fractionsToIssue = (partialAuctionThreshold * DEFAULT_FRACTION_AMOUNT) / exchange.price;
            const buyoutAuctionDefaultParameters = {
              exitPrice: exchange.price,
              duration: AUCTION_DURATION,
              unlockThreshold: UNLOCK_THRESHOLD,
              topBidLockTime: TOP_BID_LOCK_TIME,
            };

            const custodianAvailableFunds = await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress);

            const tx2 = await custodyVaultFacet.releaseFundsFromVault(exchange.tokenId);
            const offerVaultCreationTimestamp = BigInt((await tx2.getBlock()).timestamp);
            const auctionEnd = offerVaultCreationTimestamp + custodianFee.period / PARTIAL_AUCTION_DURATION_DIVISOR;
            await expect(tx2)
              .to.emit(fundsFacet, "AvailableFundsIncreased")
              .withArgs(custodianId, mockTokenAddress, payoutPeriods * custodianFee.amount);
            await expect(tx2)
              .to.emit(custodyVaultFacet, "AuctionStarted")
              .withArgs(offerId, fractionsToIssue, auctionEnd);
            await expect(tx2)
              .to.emit(wrapper, "FractionsSetup")
              .withArgs(DEFAULT_FRACTION_AMOUNT, Object.values(buyoutAuctionDefaultParameters), defaultEpoch);
            await expect(tx2)
              .to.emit(wrapper, "Fractionalised")
              .withArgs(exchange.tokenId, DEFAULT_FRACTION_AMOUNT, defaultEpoch);
            await expect(tx2)
              .to.emit(wrapper, "AdditionalFractionsMinted")
              .withArgs(fractionsToIssue, DEFAULT_FRACTION_AMOUNT + fractionsToIssue, defaultEpoch);

            // offer vault is created
            const expectedOfferVault = {
              amount: 0n,
              period: vaultCreationTimestamp + payoutPeriods * custodianFee.period, // matches the last payout from item vault
            };
            let itemCount = 1n;

            expect(await custodyVaultFacet.getCustodianVault(offerId)).to.eql([
              Object.values(expectedOfferVault),
              itemCount,
            ]);

            // item vault is closed
            const expectedItemVault = {
              amount: 0n,
              period: 0n,
            };
            itemCount = 0n;

            expect(await custodyVaultFacet.getCustodianVault(exchange.tokenId)).to.eql([
              Object.values(expectedItemVault),
              itemCount,
            ]);
            expect(await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress)).to.equal(
              custodianAvailableFunds + payoutPeriods * custodianFee.amount,
            );
          });

          it("Some periods can be covered, but not all, some funds remain in vault,  item vault balance is not multiple of custodian fee", async function () {
            const topUpAmount = custodianFee.amount / 2n; // half of the period
            await mockToken.approve(fermionProtocolAddress, topUpAmount);
            await custodyVaultFacet.topUpCustodianVault(exchange.tokenId, topUpAmount);

            const payoutPeriods = 5n; // empty the vault
            await setNextBlockTimestamp(
              String(vaultCreationTimestamp + (payoutPeriods + 1n) * custodianFee.period + 200n),
            );

            const partialAuctionThreshold = PARTIAL_THRESHOLD_MULTIPLIER * custodianFee.amount;
            const fractionsToIssue = (partialAuctionThreshold * DEFAULT_FRACTION_AMOUNT) / exchange.price;
            const buyoutAuctionDefaultParameters = {
              exitPrice: exchange.price,
              duration: AUCTION_DURATION,
              unlockThreshold: UNLOCK_THRESHOLD,
              topBidLockTime: TOP_BID_LOCK_TIME,
            };

            const custodianAvailableFunds = await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress);

            const tx2 = await custodyVaultFacet.releaseFundsFromVault(exchange.tokenId);
            const offerVaultCreationTimestamp = BigInt((await tx2.getBlock()).timestamp);
            const auctionEnd = offerVaultCreationTimestamp + custodianFee.period / PARTIAL_AUCTION_DURATION_DIVISOR;
            await expect(tx2)
              .to.emit(fundsFacet, "AvailableFundsIncreased")
              .withArgs(custodianId, mockTokenAddress, payoutPeriods * custodianFee.amount);
            await expect(tx2)
              .to.emit(fundsFacet, "AvailableFundsIncreased")
              .withArgs(custodianId, mockTokenAddress, topUpAmount); // the reminder is also released
            await expect(tx2)
              .to.emit(custodyVaultFacet, "AuctionStarted")
              .withArgs(offerId, fractionsToIssue, auctionEnd);
            await expect(tx2)
              .to.emit(wrapper, "FractionsSetup")
              .withArgs(DEFAULT_FRACTION_AMOUNT, Object.values(buyoutAuctionDefaultParameters), defaultEpoch);
            await expect(tx2)
              .to.emit(wrapper, "Fractionalised")
              .withArgs(exchange.tokenId, DEFAULT_FRACTION_AMOUNT, defaultEpoch);
            await expect(tx2)
              .to.emit(wrapper, "AdditionalFractionsMinted")
              .withArgs(fractionsToIssue, DEFAULT_FRACTION_AMOUNT + fractionsToIssue, defaultEpoch);

            // offer vault is created
            const expectedOfferVault = {
              amount: 0n,
              period: vaultCreationTimestamp + payoutPeriods * custodianFee.period, // matches the last payout from item vault
            };
            let itemCount = 1n;

            expect(await custodyVaultFacet.getCustodianVault(offerId)).to.eql([
              Object.values(expectedOfferVault),
              itemCount,
            ]);

            // item vault is closed
            const expectedItemVault = {
              amount: 0n,
              period: 0n,
            };
            itemCount = 0n;

            expect(await custodyVaultFacet.getCustodianVault(exchange.tokenId)).to.eql([
              Object.values(expectedItemVault),
              itemCount,
            ]);
            expect(await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress)).to.equal(
              custodianAvailableFunds + payoutPeriods * custodianFee.amount + topUpAmount,
            );
          });
        });

        context("Existing fractionalised F-NFT in collection", function () {
          const fractionsPerToken = 5000n * 10n ** 18n;
          const auctionParameters = {
            exitPrice: parseEther("0.1"),
            duration: 60n * 60n * 24n * 7n, // 1 week
            unlockThreshold: 7500n, // 75%
            topBidLockTime: 60n * 60n * 24n * 2n, // two days
          };
          let offerVaultCreationTimestamp: bigint;
          const custodianVaultParameters = {
            partialAuctionThreshold: custodianFee.amount * 15n,
            partialAuctionDuration: custodianFee.period / 2n,
            liquidationThreshold: custodianFee.amount * 2n,
            newFractionsPerAuction: 0n,
          };

          before(async function () {
            const expectedPrice = (exchange.price * 11n) / 10n;
            custodianVaultParameters.newFractionsPerAuction =
              (custodianFee.amount * 15n * fractionsPerToken) / expectedPrice;
          });

          beforeEach(async function () {
            const tokenId = BigInt(exchange.tokenId) + 1n;
            await custodyFacet.connect(custodian).checkIn(tokenId);
            const additionalDeposit = custodianFee.amount * 2n;
            await mockToken.connect(buyer).approve(await wrapper.getAddress(), additionalDeposit);
            const tx = await wrapper
              .connect(buyer)
              .mintFractions(
                tokenId,
                1,
                fractionsPerToken,
                auctionParameters,
                custodianVaultParameters,
                additionalDeposit,
                ZeroAddress,
              );
            offerVaultCreationTimestamp = BigInt((await tx.getBlock()).timestamp);
          });

          it("Nothing to release", async function () {
            const payoutPeriods = 5n; // empty the vault
            await setNextBlockTimestamp(String(vaultCreationTimestamp + payoutPeriods * custodianFee.period + 200n));

            const tx = await custodyVaultFacet.releaseFundsFromVault(exchange.tokenId);
            await expect(tx).to.not.emit(custodyVaultFacet, "AuctionStarted");
            const expectedCustodianVault = {
              amount: 0n,
              period: vaultCreationTimestamp + payoutPeriods * custodianFee.period,
            };
            let itemCount = 1n;

            expect(await custodyVaultFacet.getCustodianVault(exchange.tokenId)).to.eql([
              Object.values(expectedCustodianVault),
              itemCount,
            ]);

            await setNextBlockTimestamp(
              String(vaultCreationTimestamp + (payoutPeriods + 1n) * custodianFee.period + 200n),
            );

            const fractionsToIssue = 2n * custodianVaultParameters.newFractionsPerAuction; // for the previously fractionalised token and the new one
            const custodianAvailableFunds = await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress);

            const tx2 = await custodyVaultFacet.releaseFundsFromVault(exchange.tokenId);
            const timestamp = BigInt((await tx2.getBlock()).timestamp);
            const auctionEnd = timestamp + custodianVaultParameters.partialAuctionDuration;
            await expect(tx2).to.not.emit(fundsFacet, "AvailableFundsIncreased");
            await expect(tx2)
              .to.emit(custodyVaultFacet, "AuctionStarted")
              .withArgs(offerId, fractionsToIssue, auctionEnd);
            await expect(tx2).to.not.emit(wrapper, "FractionsSetup");
            await expect(tx2)
              .to.emit(wrapper, "Fractionalised")
              .withArgs(exchange.tokenId, fractionsPerToken, defaultEpoch);
            await expect(tx2)
              .to.emit(wrapper, "AdditionalFractionsMinted")
              .withArgs(fractionsToIssue, 2n * fractionsPerToken + fractionsToIssue, defaultEpoch);

            // offer vault remains the same, just number of items is increased
            const expectedOfferVault = {
              amount: custodianFee.amount, // from the fractionalisation of other token
              period: offerVaultCreationTimestamp,
            };
            itemCount = 2n;

            expect(await custodyVaultFacet.getCustodianVault(offerId)).to.eql([
              Object.values(expectedOfferVault),
              itemCount,
            ]);

            // item vault is closed
            const expectedItemVault = {
              amount: 0n,
              period: 0n,
            };
            itemCount = 0n;

            expect(await custodyVaultFacet.getCustodianVault(exchange.tokenId)).to.eql([
              Object.values(expectedItemVault),
              itemCount,
            ]);
            expect(await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress)).to.equal(custodianAvailableFunds);
          });

          it("Some periods can be covered, but not all, item vault balance is multiple of custodian fee", async function () {
            const payoutPeriods = 5n; // empty the vault
            await setNextBlockTimestamp(
              String(vaultCreationTimestamp + (payoutPeriods + 1n) * custodianFee.period + 200n),
            );

            const fractionsToIssue = 2n * custodianVaultParameters.newFractionsPerAuction; // for the previously fractionalised token and the new one
            const custodianAvailableFunds = await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress);

            const tx2 = await custodyVaultFacet.releaseFundsFromVault(exchange.tokenId);
            const timestamp = BigInt((await tx2.getBlock()).timestamp);
            const auctionEnd = timestamp + custodianVaultParameters.partialAuctionDuration;
            await expect(tx2)
              .to.emit(fundsFacet, "AvailableFundsIncreased")
              .withArgs(custodianId, mockTokenAddress, payoutPeriods * custodianFee.amount);
            await expect(tx2)
              .to.emit(custodyVaultFacet, "AuctionStarted")
              .withArgs(offerId, fractionsToIssue, auctionEnd);
            await expect(tx2).to.not.emit(wrapper, "FractionsSetup");
            await expect(tx2)
              .to.emit(wrapper, "Fractionalised")
              .withArgs(exchange.tokenId, fractionsPerToken, defaultEpoch);
            await expect(tx2)
              .to.emit(wrapper, "AdditionalFractionsMinted")
              .withArgs(fractionsToIssue, 2n * fractionsPerToken + fractionsToIssue, defaultEpoch);

            // offer vault remains the same, just number of items is increased
            const expectedOfferVault = {
              amount: custodianFee.amount, // from the fractionalisation of other token
              period: offerVaultCreationTimestamp,
            };
            let itemCount = 2n;

            expect(await custodyVaultFacet.getCustodianVault(offerId)).to.eql([
              Object.values(expectedOfferVault),
              itemCount,
            ]);

            // item vault is closed
            const expectedItemVault = {
              amount: 0n,
              period: 0n,
            };
            itemCount = 0n;

            expect(await custodyVaultFacet.getCustodianVault(exchange.tokenId)).to.eql([
              Object.values(expectedItemVault),
              itemCount,
            ]);
            expect(await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress)).to.equal(
              custodianAvailableFunds + payoutPeriods * custodianFee.amount,
            );
          });

          it("Some periods can be covered, but not all, some funds remain in vault, item vault balance is not multiple of custodian fee", async function () {
            const topUpAmount = custodianFee.amount / 2n; // half of the period
            await mockToken.approve(fermionProtocolAddress, topUpAmount);
            await custodyVaultFacet.topUpCustodianVault(exchange.tokenId, topUpAmount);

            const payoutPeriods = 5n; // empty the vault
            await setNextBlockTimestamp(
              String(vaultCreationTimestamp + (payoutPeriods + 1n) * custodianFee.period + 200n),
            );

            const fractionsToIssue = 2n * custodianVaultParameters.newFractionsPerAuction; // for the previously fractionalised token and the new one
            const custodianAvailableFunds = await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress);

            const tx2 = await custodyVaultFacet.releaseFundsFromVault(exchange.tokenId);
            const timestamp = BigInt((await tx2.getBlock()).timestamp);
            const auctionEnd = timestamp + custodianVaultParameters.partialAuctionDuration;
            await expect(tx2)
              .to.emit(fundsFacet, "AvailableFundsIncreased")
              .withArgs(custodianId, mockTokenAddress, payoutPeriods * custodianFee.amount);
            await expect(tx2)
              .to.emit(fundsFacet, "AvailableFundsIncreased")
              .withArgs(custodianId, mockTokenAddress, topUpAmount); // the reminder is also released
            await expect(tx2)
              .to.emit(custodyVaultFacet, "AuctionStarted")
              .withArgs(offerId, fractionsToIssue, auctionEnd);
            await expect(tx2).to.not.emit(wrapper, "FractionsSetup");
            await expect(tx2)
              .to.emit(wrapper, "Fractionalised")
              .withArgs(exchange.tokenId, fractionsPerToken, defaultEpoch);
            await expect(tx2)
              .to.emit(wrapper, "AdditionalFractionsMinted")
              .withArgs(fractionsToIssue, 2n * fractionsPerToken + fractionsToIssue, defaultEpoch);

            // offer vault remains the same, just number of items is increased
            const expectedOfferVault = {
              amount: custodianFee.amount, // from the fractionalisation of other token
              period: offerVaultCreationTimestamp,
            };
            let itemCount = 2n;

            expect(await custodyVaultFacet.getCustodianVault(offerId)).to.eql([
              Object.values(expectedOfferVault),
              itemCount,
            ]);

            // item vault is closed
            const expectedItemVault = {
              amount: 0n,
              period: 0n,
            };
            itemCount = 0n;

            expect(await custodyVaultFacet.getCustodianVault(exchange.tokenId)).to.eql([
              Object.values(expectedItemVault),
              itemCount,
            ]);
            expect(await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress)).to.equal(
              custodianAvailableFunds + payoutPeriods * custodianFee.amount + topUpAmount,
            );
          });
        });
      });

      context("Revert reasons", function () {
        it("Custody region is paused", async function () {
          await pauseFacet.pause([PausableRegion.CustodyVault]);

          await expect(custodyVaultFacet.releaseFundsFromVault(exchange.tokenId))
            .to.be.revertedWithCustomError(fermionErrors, "RegionPaused")
            .withArgs(PausableRegion.CustodyVault);
        });

        it("Vault does not exist/is inactive", async function () {
          // existing token id but not checked in
          await expect(custodyVaultFacet.releaseFundsFromVault(exchange.tokenId + 1n))
            .to.be.revertedWithCustomError(fermionErrors, "InactiveVault")
            .withArgs(exchange.tokenId + 1n);

          // invalid token id
          await expect(custodyVaultFacet.releaseFundsFromVault(0n))
            .to.be.revertedWithCustomError(fermionErrors, "InactiveVault")
            .withArgs(0n);

          await expect(custodyVaultFacet.releaseFundsFromVault(1000n))
            .to.be.revertedWithCustomError(fermionErrors, "InactiveVault")
            .withArgs(1000n);
        });

        it("Period not over yet", async function () {
          await setNextBlockTimestamp(String(vaultCreationTimestamp + custodianFee.period - 1n));

          await expect(custodyVaultFacet.releaseFundsFromVault(exchange.tokenId))
            .to.be.revertedWithCustomError(fermionErrors, "PeriodNotOver")
            .withArgs(exchange.tokenId, vaultCreationTimestamp + custodianFee.period);

          await setNextBlockTimestamp(String(vaultCreationTimestamp + custodianFee.period + 1n));
          await custodyVaultFacet.releaseFundsFromVault(exchange.tokenId);

          await setNextBlockTimestamp(String(vaultCreationTimestamp + 2n * custodianFee.period - 1n));

          await expect(custodyVaultFacet.releaseFundsFromVault(exchange.tokenId))
            .to.be.revertedWithCustomError(fermionErrors, "PeriodNotOver")
            .withArgs(exchange.tokenId, vaultCreationTimestamp + 2n * custodianFee.period);

          await setNextBlockTimestamp(String(vaultCreationTimestamp + 4n * custodianFee.period + 1n));
          await custodyVaultFacet.releaseFundsFromVault(exchange.tokenId);

          await setNextBlockTimestamp(String(vaultCreationTimestamp + 5n * custodianFee.period - 1n));
          await expect(custodyVaultFacet.releaseFundsFromVault(exchange.tokenId))
            .to.be.revertedWithCustomError(fermionErrors, "PeriodNotOver")
            .withArgs(exchange.tokenId, vaultCreationTimestamp + 5n * custodianFee.period);
        });

        context("Auction is ongoing", function () {
          it("First/single item from collection", async function () {
            const payoutPeriods = 5n; // empty the vault
            await setNextBlockTimestamp(
              String(vaultCreationTimestamp + (payoutPeriods + 1n) * custodianFee.period + 200n),
            );

            const tx = await custodyVaultFacet.releaseFundsFromVault(exchange.tokenId);
            await expect(tx).to.emit(custodyVaultFacet, "AuctionStarted");

            const auctionStart = BigInt((await tx.getBlock()).timestamp);
            const auctionEnd = auctionStart + custodianFee.period / PARTIAL_AUCTION_DURATION_DIVISOR;

            await expect(custodyVaultFacet.releaseFundsFromVault(exchange.tokenId))
              .to.be.revertedWithCustomError(fermionErrors, "InactiveVault")
              .withArgs(exchange.tokenId);

            await expect(custodyVaultFacet.releaseFundsFromVault(offerId))
              .to.be.revertedWithCustomError(fermionErrors, "AuctionOngoing")
              .withArgs(offerId, auctionEnd);
          });

          it("Existing fractionalised F-NFT in collection", async function () {
            const fractionsPerToken = 5000n * 10n ** 18n;
            const auctionParameters = {
              exitPrice: parseEther("0.1"),
              duration: 60n * 60n * 24n * 7n, // 1 week
              unlockThreshold: 7500n, // 75%
              topBidLockTime: 60n * 60n * 24n * 2n, // two days
            };
            const custodianVaultParameters = {
              partialAuctionThreshold: custodianFee.amount * 15n,
              partialAuctionDuration: custodianFee.period / 2n,
              liquidationThreshold: custodianFee.amount * 2n,
              newFractionsPerAuction: (custodianFee.amount * 15n * fractionsPerToken) / exchange.price,
            };

            const tokenId = BigInt(exchange.tokenId) + 1n;
            await custodyFacet.connect(custodian).checkIn(tokenId);
            const additionalDeposit = custodianFee.amount * 2n;
            await mockToken.connect(buyer).approve(await wrapper.getAddress(), additionalDeposit);
            const tx = await wrapper
              .connect(buyer)
              .mintFractions(
                tokenId,
                1,
                fractionsPerToken,
                auctionParameters,
                custodianVaultParameters,
                additionalDeposit,
                ZeroAddress,
              );
            const offerVaultCreationTimestamp = BigInt((await tx.getBlock()).timestamp);

            const payoutPeriods = 5n; // empty the vault
            await setNextBlockTimestamp(
              String(offerVaultCreationTimestamp + (payoutPeriods + 1n) * custodianFee.period + 200n),
            );

            const tx2 = await custodyVaultFacet.releaseFundsFromVault(exchange.tokenId);
            await expect(tx2).to.emit(custodyVaultFacet, "AuctionStarted");

            const auctionStart = BigInt((await tx2.getBlock()).timestamp);
            const auctionEnd = auctionStart + custodianVaultParameters.partialAuctionDuration;

            await expect(custodyVaultFacet.releaseFundsFromVault(exchange.tokenId))
              .to.be.revertedWithCustomError(fermionErrors, "InactiveVault")
              .withArgs(exchange.tokenId);

            await expect(custodyVaultFacet.releaseFundsFromVault(offerId))
              .to.be.revertedWithCustomError(fermionErrors, "AuctionOngoing")
              .withArgs(offerId, auctionEnd);
          });
        });
      });
    });
  });

  context("Multiple F-NFT owners (fractionalised)", function () {
    const fractionsPerToken = 5000n * 10n ** 18n;
    const auctionParameters = {
      exitPrice: parseEther("0.1"),
      duration: 60n * 60n * 24n * 7n, // 1 week
      unlockThreshold: 7500n, // 75%
      topBidLockTime: 60n * 60n * 24n * 2n, // two days
    };
    let offerVaultCreationTimestamp: bigint;
    let itemVaultCreationTimestamp: bigint;

    const custodianVaultParameters = {
      partialAuctionThreshold: custodianFee.amount * 15n,
      partialAuctionDuration: custodianFee.period / 2n,
      liquidationThreshold: custodianFee.amount * 2n,
      newFractionsPerAuction: 0n,
    };

    before(async function () {
      const expectedPrice = (exchange.price * 11n) / 10n;
      custodianVaultParameters.newFractionsPerAuction = (custodianFee.amount * 15n * fractionsPerToken) / expectedPrice;
    });

    beforeEach(async function () {
      const tx = await custodyFacet.connect(custodian).checkIn(exchange.tokenId);
      itemVaultCreationTimestamp = BigInt((await tx.getBlock()).timestamp);
    });

    context("setupCustodianOfferVault", function () {
      context("Single item", function () {
        it("Item vault is empty", async function () {
          const additionalDeposit = custodianFee.amount * 2n;
          await mockToken.connect(buyer).approve(await wrapper.getAddress(), additionalDeposit);
          const buyerBalance = await mockToken.balanceOf(buyer.address);

          const tx = await wrapper
            .connect(buyer)
            .mintFractions(
              exchange.tokenId,
              1,
              fractionsPerToken,
              auctionParameters,
              custodianVaultParameters,
              additionalDeposit,
              ZeroAddress,
            );
          offerVaultCreationTimestamp = BigInt((await tx.getBlock()).timestamp);

          const custodianPayoff =
            ((offerVaultCreationTimestamp - itemVaultCreationTimestamp) * custodianFee.amount) / custodianFee.period;
          await expect(tx)
            .to.emit(custodyVaultFacet, "AvailableFundsIncreased")
            .withArgs(custodianId, mockTokenAddress, custodianPayoff);
          await expect(tx).to.emit(custodyVaultFacet, "VaultBalanceUpdated").withArgs(offerId, custodianFee.amount);

          // offer vault is created
          const expectedOfferVault = {
            amount: custodianFee.amount,
            period: offerVaultCreationTimestamp,
          };
          let itemCount = 1n;

          expect(await custodyVaultFacet.getCustodianVault(offerId)).to.eql([
            Object.values(expectedOfferVault),
            itemCount,
          ]);

          // item vault is closed
          const expectedItemVault = {
            amount: 0n,
            period: 0n,
          };
          itemCount = 0n;

          expect(await custodyVaultFacet.getCustodianVault(exchange.tokenId)).to.eql([
            Object.values(expectedItemVault),
            itemCount,
          ]);
          expect(await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress)).to.equal(custodianPayoff);
          expect(await mockToken.balanceOf(buyer.address)).to.equal(
            buyerBalance - custodianFee.amount - custodianPayoff,
          );
        });

        context("Item vault is not empty", function () {
          const paymentPeriods = 5n;
          const topUpAmount = custodianFee.amount * paymentPeriods; // pre pay for 5 periods

          beforeEach(async function () {
            await mockToken.approve(fermionProtocolAddress, topUpAmount);
            await custodyVaultFacet.topUpCustodianVault(exchange.tokenId, topUpAmount);
          });

          it("Enough to cover past fee", async function () {
            const setupTime = itemVaultCreationTimestamp + (custodianFee.period * 3n) / 2n;
            const custodianPayoff = (custodianFee.amount * 3n) / 2n;
            const vaultTransfer = custodianFee.amount * paymentPeriods - custodianPayoff;
            await setNextBlockTimestamp(String(setupTime));

            const tx = await wrapper
              .connect(buyer)
              .mintFractions(
                BigInt(exchange.tokenId),
                1,
                fractionsPerToken,
                auctionParameters,
                custodianVaultParameters,
                additionalDeposit,
                ZeroAddress,
              );
            offerVaultCreationTimestamp = BigInt((await tx.getBlock()).timestamp);
            await expect(tx)
              .to.emit(custodyVaultFacet, "AvailableFundsIncreased")
              .withArgs(custodianId, mockTokenAddress, custodianPayoff);
            await expect(tx).to.emit(custodyVaultFacet, "VaultBalanceUpdated").withArgs(exchange.tokenId, 0n);
            await expect(tx).to.emit(custodyVaultFacet, "VaultBalanceUpdated").withArgs(offerId, vaultTransfer);

            // offer vault is created
            const expectedOfferVault = {
              amount: vaultTransfer,
              period: offerVaultCreationTimestamp,
            };
            let itemCount = 1n;

            expect(await custodyVaultFacet.getCustodianVault(offerId)).to.eql([
              Object.values(expectedOfferVault),
              itemCount,
            ]);

            // item vault is closed
            const expectedItemVault = {
              amount: 0n,
              period: 0n,
            };
            itemCount = 0n;

            expect(await custodyVaultFacet.getCustodianVault(exchange.tokenId)).to.eql([
              Object.values(expectedItemVault),
              itemCount,
            ]);
            expect(await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress)).to.equal(custodianPayoff);
          });

          it("Not enough in item vault to cover past fee", async function () {
            const additionalDeposit = custodianFee.amount * 2n;
            await mockToken.connect(buyer).approve(await wrapper.getAddress(), additionalDeposit);
            const buyerBalance = await mockToken.balanceOf(buyer.address);

            await setNextBlockTimestamp(
              String(itemVaultCreationTimestamp + paymentPeriods * custodianFee.period + 100n),
            );

            const tx = await wrapper
              .connect(buyer)
              .mintFractions(
                BigInt(exchange.tokenId),
                1,
                fractionsPerToken,
                auctionParameters,
                custodianVaultParameters,
                additionalDeposit,
                ZeroAddress,
              );
            offerVaultCreationTimestamp = BigInt((await tx.getBlock()).timestamp);

            const custodianPayoff =
              ((offerVaultCreationTimestamp - itemVaultCreationTimestamp) * custodianFee.amount) / custodianFee.period;
            await expect(tx)
              .to.emit(custodyVaultFacet, "AvailableFundsIncreased")
              .withArgs(custodianId, mockTokenAddress, custodianPayoff);
            await expect(tx).to.emit(custodyVaultFacet, "VaultBalanceUpdated").withArgs(exchange.tokenId, 0n);
            await expect(tx).to.emit(custodyVaultFacet, "VaultBalanceUpdated").withArgs(offerId, custodianFee.amount);

            // offer vault is created
            const expectedOfferVault = {
              amount: custodianFee.amount,
              period: offerVaultCreationTimestamp,
            };
            let itemCount = 1n;

            expect(await custodyVaultFacet.getCustodianVault(offerId)).to.eql([
              Object.values(expectedOfferVault),
              itemCount,
            ]);

            // item vault is closed
            const expectedItemVault = {
              amount: 0n,
              period: 0n,
            };
            itemCount = 0n;

            expect(await custodyVaultFacet.getCustodianVault(exchange.tokenId)).to.eql([
              Object.values(expectedItemVault),
              itemCount,
            ]);
            expect(await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress)).to.equal(custodianPayoff);
            const missingAmount = custodianPayoff - topUpAmount;
            expect(await mockToken.balanceOf(buyer.address)).to.equal(
              buyerBalance - custodianFee.amount - missingAmount,
            );
          });
        });
      });

      context("Multiple items", function () {
        const tokenCount = 3n;
        let itemVaultCreationTimestamp2: bigint;
        let itemVaultCreationTimestamp3: bigint;
        let tokenId2: bigint;
        let tokenId3: bigint;

        beforeEach(async function () {
          tokenId2 = BigInt(exchange.tokenId) + 1n;
          tokenId3 = BigInt(exchange.tokenId) + 2n;

          const checkInTime2 = itemVaultCreationTimestamp + (custodianFee.period * 11n) / 10n;
          await setNextBlockTimestamp(String(checkInTime2));
          const tx = await custodyFacet.connect(custodian).checkIn(tokenId2);
          itemVaultCreationTimestamp2 = BigInt((await tx.getBlock()).timestamp);

          const checkInTime3 = itemVaultCreationTimestamp + (custodianFee.period * 16n) / 10n;
          await setNextBlockTimestamp(String(checkInTime3));
          const tx2 = await custodyFacet.connect(custodian).checkIn(tokenId3);
          itemVaultCreationTimestamp3 = BigInt((await tx2.getBlock()).timestamp);
        });

        it("Item vault is empty", async function () {
          const additionalDeposit = custodianFee.amount * 2n * tokenCount;
          await mockToken.connect(buyer).approve(await wrapper.getAddress(), additionalDeposit);
          const buyerBalance = await mockToken.balanceOf(buyer.address);

          const tx = await wrapper
            .connect(buyer)
            .mintFractions(
              BigInt(exchange.tokenId),
              tokenCount,
              fractionsPerToken,
              auctionParameters,
              custodianVaultParameters,
              additionalDeposit,
              ZeroAddress,
            );
          offerVaultCreationTimestamp = BigInt((await tx.getBlock()).timestamp);

          const custodianPayoff =
            ((offerVaultCreationTimestamp - itemVaultCreationTimestamp) * custodianFee.amount) / custodianFee.period;
          const custodianPayoff2 =
            ((offerVaultCreationTimestamp - itemVaultCreationTimestamp2) * custodianFee.amount) / custodianFee.period;
          const custodianPayoff3 =
            ((offerVaultCreationTimestamp - itemVaultCreationTimestamp3) * custodianFee.amount) / custodianFee.period;
          await expect(tx)
            .to.emit(custodyVaultFacet, "AvailableFundsIncreased")
            .withArgs(custodianId, mockTokenAddress, custodianPayoff);
          await expect(tx)
            .to.emit(custodyVaultFacet, "AvailableFundsIncreased")
            .withArgs(custodianId, mockTokenAddress, custodianPayoff2);
          await expect(tx)
            .to.emit(custodyVaultFacet, "AvailableFundsIncreased")
            .withArgs(custodianId, mockTokenAddress, custodianPayoff3);
          await expect(tx)
            .to.emit(custodyVaultFacet, "VaultBalanceUpdated")
            .withArgs(offerId, custodianFee.amount * tokenCount);

          // offer vault is created
          const expectedOfferVault = {
            amount: custodianFee.amount * tokenCount,
            period: offerVaultCreationTimestamp,
          };
          let itemCount = tokenCount;

          expect(await custodyVaultFacet.getCustodianVault(offerId)).to.eql([
            Object.values(expectedOfferVault),
            itemCount,
          ]);

          // item vault is closed
          const expectedItemVault = {
            amount: 0n,
            period: 0n,
          };
          itemCount = 0n;

          expect(await custodyVaultFacet.getCustodianVault(exchange.tokenId)).to.eql([
            Object.values(expectedItemVault),
            itemCount,
          ]);
          expect(await custodyVaultFacet.getCustodianVault(tokenId2)).to.eql([
            Object.values(expectedItemVault),
            itemCount,
          ]);
          expect(await custodyVaultFacet.getCustodianVault(tokenId3)).to.eql([
            Object.values(expectedItemVault),
            itemCount,
          ]);
          expect(await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress)).to.equal(
            custodianPayoff + custodianPayoff2 + custodianPayoff3,
          );
          expect(await mockToken.balanceOf(buyer.address)).to.equal(
            buyerBalance - custodianFee.amount * tokenCount - (custodianPayoff + custodianPayoff2 + custodianPayoff3),
          );
        });

        context("Item vault is not empty", function () {
          const paymentPeriods = 5n;
          const topUpAmount = custodianFee.amount * paymentPeriods; // pre pay for 5 periods

          beforeEach(async function () {
            await mockToken.approve(fermionProtocolAddress, tokenCount * topUpAmount);
            await custodyVaultFacet.topUpCustodianVault(exchange.tokenId, topUpAmount);
            await custodyVaultFacet.topUpCustodianVault(tokenId2, topUpAmount);
            await custodyVaultFacet.topUpCustodianVault(tokenId3, topUpAmount);
          });

          it("Enough to cover past fee", async function () {
            const setupTime = itemVaultCreationTimestamp + (custodianFee.period * 7n) / 2n;
            const item1Payoff = ((setupTime - itemVaultCreationTimestamp) * custodianFee.amount) / custodianFee.period;
            const item2Payoff = ((setupTime - itemVaultCreationTimestamp2) * custodianFee.amount) / custodianFee.period;
            const item3Payoff = ((setupTime - itemVaultCreationTimestamp3) * custodianFee.amount) / custodianFee.period;
            const custodianPayoff = item1Payoff + item2Payoff + item3Payoff;
            const vaultTransfer = custodianFee.amount * paymentPeriods * tokenCount - custodianPayoff;
            await setNextBlockTimestamp(String(setupTime));

            const tx = await wrapper
              .connect(buyer)
              .mintFractions(
                BigInt(exchange.tokenId),
                tokenCount,
                fractionsPerToken,
                auctionParameters,
                custodianVaultParameters,
                additionalDeposit,
                ZeroAddress,
              );
            offerVaultCreationTimestamp = BigInt((await tx.getBlock()).timestamp);
            await expect(tx)
              .to.emit(custodyVaultFacet, "AvailableFundsIncreased")
              .withArgs(custodianId, mockTokenAddress, item1Payoff);
            await expect(tx)
              .to.emit(custodyVaultFacet, "AvailableFundsIncreased")
              .withArgs(custodianId, mockTokenAddress, item2Payoff);
            await expect(tx)
              .to.emit(custodyVaultFacet, "AvailableFundsIncreased")
              .withArgs(custodianId, mockTokenAddress, item3Payoff);
            await expect(tx).to.emit(custodyVaultFacet, "VaultBalanceUpdated").withArgs(exchange.tokenId, 0n);
            await expect(tx).to.emit(custodyVaultFacet, "VaultBalanceUpdated").withArgs(tokenId2, 0n);
            await expect(tx).to.emit(custodyVaultFacet, "VaultBalanceUpdated").withArgs(tokenId3, 0n);
            await expect(tx).to.emit(custodyVaultFacet, "VaultBalanceUpdated").withArgs(offerId, vaultTransfer);

            // offer vault is created
            const expectedOfferVault = {
              amount: vaultTransfer,
              period: offerVaultCreationTimestamp,
            };
            let itemCount = tokenCount;

            expect(await custodyVaultFacet.getCustodianVault(offerId)).to.eql([
              Object.values(expectedOfferVault),
              itemCount,
            ]);

            // item vault is closed
            const expectedItemVault = {
              amount: 0n,
              period: 0n,
            };
            itemCount = 0n;

            expect(await custodyVaultFacet.getCustodianVault(exchange.tokenId)).to.eql([
              Object.values(expectedItemVault),
              itemCount,
            ]);
            expect(await custodyVaultFacet.getCustodianVault(tokenId2)).to.eql([
              Object.values(expectedItemVault),
              itemCount,
            ]);
            expect(await custodyVaultFacet.getCustodianVault(tokenId3)).to.eql([
              Object.values(expectedItemVault),
              itemCount,
            ]);
            expect(await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress)).to.equal(custodianPayoff);
          });

          it("Not enough to cover past fee from item vault", async function () {
            const additionalDeposit = custodianFee.amount * (paymentPeriods + 2n) * tokenCount;
            await mockToken.connect(buyer).approve(await wrapper.getAddress(), additionalDeposit);
            const buyerBalance = await mockToken.balanceOf(buyer.address);

            await setNextBlockTimestamp(
              String(itemVaultCreationTimestamp + (paymentPeriods + 2n) * custodianFee.period + 100n),
            );

            const tx = await wrapper
              .connect(buyer)
              .mintFractions(
                BigInt(exchange.tokenId),
                tokenCount,
                fractionsPerToken,
                auctionParameters,
                custodianVaultParameters,
                additionalDeposit,
                ZeroAddress,
              );
            offerVaultCreationTimestamp = BigInt((await tx.getBlock()).timestamp);
            const custodianPayoff =
              ((offerVaultCreationTimestamp - itemVaultCreationTimestamp) * custodianFee.amount) / custodianFee.period;
            const custodianPayoff2 =
              ((offerVaultCreationTimestamp - itemVaultCreationTimestamp2) * custodianFee.amount) / custodianFee.period;
            const custodianPayoff3 =
              ((offerVaultCreationTimestamp - itemVaultCreationTimestamp3) * custodianFee.amount) / custodianFee.period;
            await expect(tx)
              .to.emit(custodyVaultFacet, "AvailableFundsIncreased")
              .withArgs(custodianId, mockTokenAddress, custodianPayoff);
            await expect(tx)
              .to.emit(custodyVaultFacet, "AvailableFundsIncreased")
              .withArgs(custodianId, mockTokenAddress, custodianPayoff2);
            await expect(tx)
              .to.emit(custodyVaultFacet, "AvailableFundsIncreased")
              .withArgs(custodianId, mockTokenAddress, custodianPayoff3);
            await expect(tx)
              .to.emit(custodyVaultFacet, "VaultBalanceUpdated")
              .withArgs(offerId, custodianFee.amount * tokenCount);
            await expect(tx).to.emit(custodyVaultFacet, "VaultBalanceUpdated").withArgs(exchange.tokenId, 0n);
            await expect(tx).to.emit(custodyVaultFacet, "VaultBalanceUpdated").withArgs(tokenId2, 0n);
            await expect(tx).to.emit(custodyVaultFacet, "VaultBalanceUpdated").withArgs(tokenId3, 0n);

            // offer vault is created
            const expectedOfferVault = {
              amount: custodianFee.amount * tokenCount,
              period: offerVaultCreationTimestamp,
            };
            let itemCount = tokenCount;

            expect(await custodyVaultFacet.getCustodianVault(offerId)).to.eql([
              Object.values(expectedOfferVault),
              itemCount,
            ]);

            // item vault is closed
            const expectedItemVault = {
              amount: 0n,
              period: 0n,
            };
            itemCount = 0n;

            expect(await custodyVaultFacet.getCustodianVault(exchange.tokenId)).to.eql([
              Object.values(expectedItemVault),
              itemCount,
            ]);
            expect(await custodyVaultFacet.getCustodianVault(tokenId2)).to.eql([
              Object.values(expectedItemVault),
              itemCount,
            ]);
            expect(await custodyVaultFacet.getCustodianVault(tokenId3)).to.eql([
              Object.values(expectedItemVault),
              itemCount,
            ]);
            expect(await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress)).to.equal(
              custodianPayoff + custodianPayoff2 + custodianPayoff3,
            );
            const missingAmount = custodianPayoff + custodianPayoff2 + custodianPayoff3 - topUpAmount * tokenCount;
            expect(await mockToken.balanceOf(buyer.address)).to.equal(
              buyerBalance - custodianFee.amount * tokenCount - missingAmount,
            );
          });
        });
      });

      context("Revert reasons", function () {
        it("Custody region is paused", async function () {
          await pauseFacet.pause([PausableRegion.CustodyVault]);

          await expect(
            wrapper
              .connect(buyer)
              .mintFractions(
                exchange.tokenId,
                1,
                fractionsPerToken,
                auctionParameters,
                custodianVaultParameters,
                additionalDeposit,
                ZeroAddress,
              ),
          )
            .to.be.revertedWithCustomError(fermionErrors, "RegionPaused")
            .withArgs(PausableRegion.CustodyVault);
        });

        it("Insufficient balance to fractionalise", async function () {
          await expect(
            wrapper
              .connect(buyer)
              .mintFractions(
                exchange.tokenId,
                1,
                fractionsPerToken,
                auctionParameters,
                custodianVaultParameters,
                0n,
                ZeroAddress,
              ),
          ).to.be.revertedWithCustomError(fermionErrors, "InsufficientBalanceToFractionalise");
        });

        it("Partial auction threshold is below custodian fee", async function () {
          const additionalDeposit = custodianFee.amount * 2n;
          await mockToken.connect(buyer).approve(await wrapper.getAddress(), additionalDeposit);

          await expect(
            wrapper.connect(buyer).mintFractions(
              exchange.tokenId,
              1,
              fractionsPerToken,
              auctionParameters,
              {
                ...custodianVaultParameters,
                partialAuctionThreshold: custodianFee.amount - 1n,
                liquidationThreshold: custodianFee.amount - 2n,
              },
              additionalDeposit,
              ZeroAddress,
            ),
          ).to.be.revertedWithCustomError(fermionErrors, "InvalidPartialAuctionThreshold");
        });

        it("Caller is not the wrapper", async function () {
          await expect(
            custodyVaultFacet
              .connect(defaultSigner)
              .setupCustodianOfferVault(exchange.tokenId, 1, custodianVaultParameters, additionalDeposit),
          )
            .to.be.revertedWithCustomError(fermionErrors, "AccessDenied")
            .withArgs(defaultSigner.address);
        });
      });
    });

    context("addItemToCustodianOfferVault", function () {
      const offerVaultInitialAmount = (custodianFee.amount * 11n) / 10n;

      beforeEach(async function () {
        const tokenId = BigInt(exchange.tokenId) + 2n;
        await custodyFacet.connect(custodian).checkIn(tokenId);

        const additionalDeposit = custodianFee.amount * 2n;
        await mockToken.connect(buyer).approve(await wrapper.getAddress(), additionalDeposit);
        const tx = await wrapper
          .connect(buyer)
          .mintFractions(
            tokenId,
            1,
            fractionsPerToken,
            auctionParameters,
            custodianVaultParameters,
            additionalDeposit,
            ZeroAddress,
          );
        offerVaultCreationTimestamp = BigInt((await tx.getBlock()).timestamp);

        await mockToken.approve(fermionProtocolAddress, offerVaultInitialAmount - custodianFee.amount); // custodianFee.amount already in the vault from fracionalisation
        await custodyVaultFacet.topUpCustodianVault(offerId, offerVaultInitialAmount - custodianFee.amount);
      });

      context("Single item", function () {
        it("Item vault is empty", async function () {
          const additionalDeposit = custodianFee.amount * 2n;
          await mockToken.connect(buyer).approve(await wrapper.getAddress(), additionalDeposit);
          const buyerBalance = await mockToken.balanceOf(buyer.address);
          const custodianAvailableFunds = await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress);

          const tx = await wrapper.connect(buyer).mintFractions(exchange.tokenId, 1, additionalDeposit);
          const transferTime = BigInt((await tx.getBlock()).timestamp);
          const custodianPayoff =
            ((transferTime - itemVaultCreationTimestamp) * custodianFee.amount) / custodianFee.period;

          await expect(tx)
            .to.emit(custodyVaultFacet, "AvailableFundsIncreased")
            .withArgs(custodianId, mockTokenAddress, custodianPayoff);
          await expect(tx)
            .to.emit(custodyVaultFacet, "VaultBalanceUpdated")
            .withArgs(offerId, offerVaultInitialAmount + custodianFee.amount);

          // offer vault remains, just number of items is increased
          const expectedOfferVault = {
            amount: offerVaultInitialAmount + custodianFee.amount,
            period: offerVaultCreationTimestamp,
          };
          let itemCount = 2n;

          expect(await custodyVaultFacet.getCustodianVault(offerId)).to.eql([
            Object.values(expectedOfferVault),
            itemCount,
          ]);

          // item vault is closed
          const expectedItemVault = {
            amount: 0n,
            period: 0n,
          };
          itemCount = 0n;

          expect(await custodyVaultFacet.getCustodianVault(exchange.tokenId)).to.eql([
            Object.values(expectedItemVault),
            itemCount,
          ]);
          expect(await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress)).to.equal(
            custodianAvailableFunds + custodianPayoff,
          );
          expect(await mockToken.balanceOf(buyer.address)).to.equal(
            buyerBalance - custodianFee.amount - custodianPayoff,
          );
        });

        context("Item vault is not empty", function () {
          const paymentPeriods = 5n;
          const topUpAmount = custodianFee.amount * paymentPeriods; // pre pay for 5 periods

          beforeEach(async function () {
            await mockToken.approve(fermionProtocolAddress, topUpAmount);
            await custodyVaultFacet.topUpCustodianVault(exchange.tokenId, topUpAmount);
          });

          it("Enough to cover past fee", async function () {
            const custodianAvailableFunds = await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress);

            const transferTime = itemVaultCreationTimestamp + (custodianFee.period * 3n) / 2n;
            const custodianPayoff = (custodianFee.amount * 3n) / 2n;
            const vaultTransfer = custodianFee.amount * paymentPeriods - custodianPayoff;
            await setNextBlockTimestamp(String(transferTime));

            const tx = await wrapper.connect(buyer).mintFractions(exchange.tokenId, 1, additionalDeposit);

            await expect(tx)
              .to.emit(custodyVaultFacet, "AvailableFundsIncreased")
              .withArgs(custodianId, mockTokenAddress, custodianPayoff);
            await expect(tx).to.emit(custodyVaultFacet, "VaultBalanceUpdated").withArgs(exchange.tokenId, 0n);
            await expect(tx)
              .to.emit(custodyVaultFacet, "VaultBalanceUpdated")
              .withArgs(offerId, offerVaultInitialAmount + vaultTransfer);

            // offer vault remains, just number of items is increased and amount increases
            const expectedOfferVault = {
              amount: offerVaultInitialAmount + vaultTransfer,
              period: offerVaultCreationTimestamp,
            };
            let itemCount = 2n;

            expect(await custodyVaultFacet.getCustodianVault(offerId)).to.eql([
              Object.values(expectedOfferVault),
              itemCount,
            ]);

            // item vault is closed
            const expectedItemVault = {
              amount: 0n,
              period: 0n,
            };
            itemCount = 0n;

            expect(await custodyVaultFacet.getCustodianVault(exchange.tokenId)).to.eql([
              Object.values(expectedItemVault),
              itemCount,
            ]);
            expect(await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress)).to.equal(
              custodianAvailableFunds + custodianPayoff,
            );
          });

          it("Not enough to cover past fee entirely from item vault", async function () {
            const custodianAvailableFunds = await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress);
            const buyerBalance = await mockToken.balanceOf(buyer.address);

            await setNextBlockTimestamp(
              String(itemVaultCreationTimestamp + paymentPeriods * custodianFee.period + 100n),
            );

            const additionalDeposit = custodianFee.amount * 2n;
            await mockToken.connect(buyer).approve(await wrapper.getAddress(), additionalDeposit);
            const tx = await wrapper.connect(buyer).mintFractions(exchange.tokenId, 1, additionalDeposit);
            const transferTime = BigInt((await tx.getBlock()).timestamp);

            const custodianPayoff =
              ((transferTime - itemVaultCreationTimestamp) * custodianFee.amount) / custodianFee.period;

            await expect(tx)
              .to.emit(custodyVaultFacet, "AvailableFundsIncreased")
              .withArgs(custodianId, mockTokenAddress, custodianPayoff);
            await expect(tx).to.emit(custodyVaultFacet, "VaultBalanceUpdated").withArgs(exchange.tokenId, 0n);
            await expect(tx)
              .to.emit(custodyVaultFacet, "VaultBalanceUpdated")
              .withArgs(offerId, offerVaultInitialAmount + custodianFee.amount);

            // offer vault remains, just number of items is increased
            const expectedOfferVault = {
              amount: offerVaultInitialAmount + custodianFee.amount,
              period: offerVaultCreationTimestamp,
            };
            let itemCount = 2n;

            expect(await custodyVaultFacet.getCustodianVault(offerId)).to.eql([
              Object.values(expectedOfferVault),
              itemCount,
            ]);

            // item vault is closed
            const expectedItemVault = {
              amount: 0n,
              period: 0n,
            };
            itemCount = 0n;

            expect(await custodyVaultFacet.getCustodianVault(exchange.tokenId)).to.eql([
              Object.values(expectedItemVault),
              itemCount,
            ]);
            expect(await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress)).to.equal(
              custodianAvailableFunds + custodianPayoff,
            );
            const missingAmount = custodianPayoff - topUpAmount;
            expect(await mockToken.balanceOf(buyer.address)).to.equal(
              buyerBalance - custodianFee.amount - missingAmount,
            );
          });
        });
      });

      context("Multiple items", function () {
        const tokenCount = 2n;
        let itemVaultCreationTimestamp2: bigint;
        let tokenId2: bigint;

        beforeEach(async function () {
          tokenId2 = BigInt(exchange.tokenId) + 1n;

          const checkInTime2 = itemVaultCreationTimestamp + (custodianFee.period * 11n) / 10n;
          await setNextBlockTimestamp(String(checkInTime2));
          const tx = await custodyFacet.connect(custodian).checkIn(tokenId2);
          itemVaultCreationTimestamp2 = BigInt((await tx.getBlock()).timestamp);
        });

        it("Item vault is empty", async function () {
          const custodianAvailableFunds = await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress);
          const additionalDeposit = custodianFee.amount * 2n * tokenCount;
          const buyerBalance = await mockToken.balanceOf(buyer.address);
          await mockToken.connect(buyer).approve(await wrapper.getAddress(), additionalDeposit);
          const tx = await wrapper.connect(buyer).mintFractions(exchange.tokenId, tokenCount, additionalDeposit);

          const transferTime = BigInt((await tx.getBlock()).timestamp);
          const custodianPayoff =
            ((transferTime - itemVaultCreationTimestamp) * custodianFee.amount) / custodianFee.period;
          const custodianPayoff2 =
            ((transferTime - itemVaultCreationTimestamp2) * custodianFee.amount) / custodianFee.period;

          await expect(tx)
            .to.emit(custodyVaultFacet, "AvailableFundsIncreased")
            .withArgs(custodianId, mockTokenAddress, custodianPayoff);
          await expect(tx)
            .to.emit(custodyVaultFacet, "AvailableFundsIncreased")
            .withArgs(custodianId, mockTokenAddress, custodianPayoff2);
          await expect(tx)
            .to.emit(custodyVaultFacet, "VaultBalanceUpdated")
            .withArgs(offerId, offerVaultInitialAmount + custodianFee.amount * tokenCount);

          //  offer vault remains, just number of items is increased
          const expectedOfferVault = {
            amount: offerVaultInitialAmount + custodianFee.amount * tokenCount,
            period: offerVaultCreationTimestamp,
          };
          let itemCount = tokenCount + 1n;

          expect(await custodyVaultFacet.getCustodianVault(offerId)).to.eql([
            Object.values(expectedOfferVault),
            itemCount,
          ]);

          // item vault is closed
          const expectedItemVault = {
            amount: 0n,
            period: 0n,
          };
          itemCount = 0n;

          expect(await custodyVaultFacet.getCustodianVault(exchange.tokenId)).to.eql([
            Object.values(expectedItemVault),
            itemCount,
          ]);
          expect(await custodyVaultFacet.getCustodianVault(tokenId2)).to.eql([
            Object.values(expectedItemVault),
            itemCount,
          ]);
          expect(await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress)).to.equal(
            custodianAvailableFunds + custodianPayoff + custodianPayoff2,
          );
          const missingAmount = custodianPayoff + custodianPayoff2;
          expect(await mockToken.balanceOf(buyer.address)).to.equal(
            buyerBalance - custodianFee.amount * tokenCount - missingAmount,
          );
        });

        context("Item vault is not empty", function () {
          const paymentPeriods = 5n;
          const topUpAmount = custodianFee.amount * paymentPeriods; // pre pay for 5 periods

          beforeEach(async function () {
            await mockToken.approve(fermionProtocolAddress, tokenCount * topUpAmount);
            await custodyVaultFacet.topUpCustodianVault(exchange.tokenId, topUpAmount);
            await custodyVaultFacet.topUpCustodianVault(tokenId2, topUpAmount);
          });

          it("Enough to cover past fee", async function () {
            const custodianAvailableFunds = await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress);
            const transferTime = itemVaultCreationTimestamp + (custodianFee.period * 7n) / 2n;
            const item1Payoff =
              ((transferTime - itemVaultCreationTimestamp) * custodianFee.amount) / custodianFee.period;
            const item2Payoff =
              ((transferTime - itemVaultCreationTimestamp2) * custodianFee.amount) / custodianFee.period;
            const custodianPayoff = item1Payoff + item2Payoff;
            const vaultTransfer = custodianFee.amount * paymentPeriods * tokenCount - custodianPayoff;
            await setNextBlockTimestamp(String(transferTime));

            const tx = await wrapper.connect(buyer).mintFractions(exchange.tokenId, tokenCount, additionalDeposit);

            await expect(tx)
              .to.emit(custodyVaultFacet, "AvailableFundsIncreased")
              .withArgs(custodianId, mockTokenAddress, item1Payoff);
            await expect(tx)
              .to.emit(custodyVaultFacet, "AvailableFundsIncreased")
              .withArgs(custodianId, mockTokenAddress, item2Payoff);
            await expect(tx).to.emit(custodyVaultFacet, "VaultBalanceUpdated").withArgs(exchange.tokenId, 0n);
            await expect(tx).to.emit(custodyVaultFacet, "VaultBalanceUpdated").withArgs(tokenId2, 0n);
            await expect(tx)
              .to.emit(custodyVaultFacet, "VaultBalanceUpdated")
              .withArgs(offerId, offerVaultInitialAmount + vaultTransfer);

            // offer vault remains, just number of items is increased and amount increases
            const expectedOfferVault = {
              amount: offerVaultInitialAmount + vaultTransfer,
              period: offerVaultCreationTimestamp,
            };
            let itemCount = tokenCount + 1n;

            expect(await custodyVaultFacet.getCustodianVault(offerId)).to.eql([
              Object.values(expectedOfferVault),
              itemCount,
            ]);

            // item vault is closed
            const expectedItemVault = {
              amount: 0n,
              period: 0n,
            };
            itemCount = 0n;

            expect(await custodyVaultFacet.getCustodianVault(exchange.tokenId)).to.eql([
              Object.values(expectedItemVault),
              itemCount,
            ]);
            expect(await custodyVaultFacet.getCustodianVault(tokenId2)).to.eql([
              Object.values(expectedItemVault),
              itemCount,
            ]);
            expect(await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress)).to.equal(
              custodianAvailableFunds + custodianPayoff,
            );
          });

          it("Not enough to cover past fee from item vault", async function () {
            const custodianAvailableFunds = await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress);
            const buyerBalance = await mockToken.balanceOf(buyer.address);
            await setNextBlockTimestamp(
              String(itemVaultCreationTimestamp + (paymentPeriods + 2n) * custodianFee.period + 100n),
            );

            const additionalDeposit = custodianFee.amount * (paymentPeriods + 2n) * tokenCount;
            await mockToken.connect(buyer).approve(await wrapper.getAddress(), additionalDeposit);
            const tx = await wrapper.connect(buyer).mintFractions(exchange.tokenId, tokenCount, additionalDeposit);

            const transferTime = BigInt((await tx.getBlock()).timestamp);
            const custodianPayoff =
              ((transferTime - itemVaultCreationTimestamp) * custodianFee.amount) / custodianFee.period;
            const custodianPayoff2 =
              ((transferTime - itemVaultCreationTimestamp2) * custodianFee.amount) / custodianFee.period;

            await expect(tx)
              .to.emit(custodyVaultFacet, "AvailableFundsIncreased")
              .withArgs(custodianId, mockTokenAddress, custodianPayoff);
            await expect(tx)
              .to.emit(custodyVaultFacet, "AvailableFundsIncreased")
              .withArgs(custodianId, mockTokenAddress, custodianPayoff2);
            await expect(tx)
              .to.emit(custodyVaultFacet, "VaultBalanceUpdated")
              .withArgs(offerId, offerVaultInitialAmount + custodianFee.amount * tokenCount);
            await expect(tx).to.emit(custodyVaultFacet, "VaultBalanceUpdated").withArgs(exchange.tokenId, 0n);
            await expect(tx).to.emit(custodyVaultFacet, "VaultBalanceUpdated").withArgs(tokenId2, 0n);

            // offer vault remains, just number of items is increased
            const expectedOfferVault = {
              amount: offerVaultInitialAmount + custodianFee.amount * tokenCount,
              period: offerVaultCreationTimestamp,
            };
            let itemCount = tokenCount + 1n;

            expect(await custodyVaultFacet.getCustodianVault(offerId)).to.eql([
              Object.values(expectedOfferVault),
              itemCount,
            ]);

            // item vault is closed
            const expectedItemVault = {
              amount: 0n,
              period: 0n,
            };
            itemCount = 0n;

            expect(await custodyVaultFacet.getCustodianVault(exchange.tokenId)).to.eql([
              Object.values(expectedItemVault),
              itemCount,
            ]);
            expect(await custodyVaultFacet.getCustodianVault(tokenId2)).to.eql([
              Object.values(expectedItemVault),
              itemCount,
            ]);
            expect(await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress)).to.equal(
              custodianAvailableFunds + custodianPayoff + custodianPayoff2,
            );
            const missingAmount = custodianPayoff + custodianPayoff2 - topUpAmount * tokenCount;
            expect(await mockToken.balanceOf(buyer.address)).to.equal(
              buyerBalance - custodianFee.amount * tokenCount - missingAmount,
            );
          });
        });
      });

      context("Revert reasons", function () {
        it("Custody region is paused", async function () {
          await pauseFacet.pause([PausableRegion.CustodyVault]);

          await expect(wrapper.connect(buyer).mintFractions(exchange.tokenId, 1, additionalDeposit))
            .to.be.revertedWithCustomError(fermionErrors, "RegionPaused")
            .withArgs(PausableRegion.CustodyVault);
        });

        it("Insufficient balance to fractionalise", async function () {
          await expect(wrapper.connect(buyer).mintFractions(exchange.tokenId, 1, 0n)).to.be.revertedWithCustomError(
            fermionErrors,
            "InsufficientBalanceToFractionalise",
          );
        });

        it("Caller is not the wrapper", async function () {
          await expect(
            custodyVaultFacet
              .connect(defaultSigner)
              .addItemToCustodianOfferVault(exchange.tokenId, 1, additionalDeposit),
          )
            .to.be.revertedWithCustomError(fermionErrors, "AccessDenied")
            .withArgs(defaultSigner.address);
        });
      });
    });

    context("methods that require an active vault", function () {
      const tokenCount = 3n;
      const initialVaultAmount = custodianFee.amount * tokenCount; // from fractionalisation

      beforeEach(async function () {
        const tokenId2 = BigInt(exchange.tokenId) + 1n;
        const tokenId3 = BigInt(exchange.tokenId) + 2n;
        await custodyFacet.connect(custodian).checkIn(tokenId2);
        await custodyFacet.connect(custodian).checkIn(tokenId3);

        const additionalDeposit = custodianFee.amount * 2n * tokenCount;
        await mockToken.connect(buyer).approve(await wrapper.getAddress(), additionalDeposit);

        const tx = await wrapper
          .connect(buyer)
          .mintFractions(
            exchange.tokenId,
            tokenCount,
            fractionsPerToken,
            auctionParameters,
            custodianVaultParameters,
            additionalDeposit,
            ZeroAddress,
          );
        offerVaultCreationTimestamp = BigInt((await tx.getBlock()).timestamp);
      });

      context("topUpCustodianVault", function () {
        const topUpAmount = parseEther("0.01");

        it("Anyone can top-up the vault", async function () {
          const protocolBalance = await mockToken.balanceOf(fermionProtocolAddress);

          await mockToken.approve(fermionProtocolAddress, topUpAmount);
          const tx = await custodyVaultFacet.topUpCustodianVault(offerId, topUpAmount);

          await expect(tx)
            .to.emit(custodyVaultFacet, "VaultBalanceUpdated")
            .withArgs(offerId, initialVaultAmount + topUpAmount);

          const expectedCustodianVault = {
            amount: initialVaultAmount + topUpAmount,
            period: offerVaultCreationTimestamp,
          };

          expect(await custodyVaultFacet.getCustodianVault(offerId)).to.eql([
            Object.values(expectedCustodianVault),
            tokenCount,
          ]);
          expect(await mockToken.balanceOf(fermionProtocolAddress)).to.equal(protocolBalance + topUpAmount);
        });

        it("Second top-up adds value", async function () {
          const protocolBalance = await mockToken.balanceOf(fermionProtocolAddress);

          await mockToken.approve(fermionProtocolAddress, topUpAmount);
          await custodyVaultFacet.topUpCustodianVault(offerId, topUpAmount);

          const topUpAmount2 = parseEther("0.01");
          await mockToken.approve(fermionProtocolAddress, topUpAmount2);
          const tx = await custodyVaultFacet.topUpCustodianVault(offerId, topUpAmount2);
          await expect(tx)
            .to.emit(custodyVaultFacet, "VaultBalanceUpdated")
            .withArgs(offerId, initialVaultAmount + topUpAmount + topUpAmount2);

          const expectedCustodianVault = {
            amount: initialVaultAmount + topUpAmount + topUpAmount2,
            period: offerVaultCreationTimestamp,
          };

          expect(await custodyVaultFacet.getCustodianVault(offerId)).to.eql([
            Object.values(expectedCustodianVault),
            tokenCount,
          ]);
          expect(await mockToken.balanceOf(fermionProtocolAddress)).to.equal(
            protocolBalance + topUpAmount + topUpAmount2,
          );
        });

        context("Revert reasons", function () {
          it("Custody region is paused", async function () {
            await pauseFacet.pause([PausableRegion.CustodyVault]);

            await expect(custodyVaultFacet.topUpCustodianVault(offerId, topUpAmount))
              .to.be.revertedWithCustomError(fermionErrors, "RegionPaused")
              .withArgs(PausableRegion.CustodyVault);
          });

          it("Amount to deposit is zero", async function () {
            const topUpAmount = 0n;

            await expect(custodyVaultFacet.topUpCustodianVault(offerId, topUpAmount)).to.be.revertedWithCustomError(
              fermionErrors,
              "ZeroDepositNotAllowed",
            );
          });

          it("Vault does not exist/is inactive", async function () {
            // existing token id but not checked in
            await expect(custodyVaultFacet.topUpCustodianVault(offerId + 1n, topUpAmount))
              .to.be.revertedWithCustomError(fermionErrors, "InactiveVault")
              .withArgs(offerId + 1n);

            // invalid token id
            await expect(custodyVaultFacet.topUpCustodianVault(0n, topUpAmount))
              .to.be.revertedWithCustomError(fermionErrors, "InactiveVault")
              .withArgs(0n);

            await expect(custodyVaultFacet.topUpCustodianVault(1000n, topUpAmount))
              .to.be.revertedWithCustomError(fermionErrors, "InactiveVault")
              .withArgs(1000n);
          });

          it("Funds related errors", async function () {
            // ERC20 offer - insufficient allowance
            await mockToken.approve(fermionProtocolAddress, topUpAmount - 1n);

            await expect(custodyVaultFacet.topUpCustodianVault(offerId, topUpAmount))
              .to.be.revertedWithCustomError(mockToken, "ERC20InsufficientAllowance")
              .withArgs(fermionProtocolAddress, topUpAmount - 1n, topUpAmount);

            // ERC20 offer - contract sends insufficient funds
            await mockToken.approve(fermionProtocolAddress, topUpAmount);
            await mockToken.setBurnAmount(1);
            await expect(custodyVaultFacet.topUpCustodianVault(offerId, topUpAmount))
              .to.be.revertedWithCustomError(fermionErrors, "WrongValueReceived")
              .withArgs(topUpAmount, topUpAmount - 1n);
            await mockToken.setBurnAmount(0);

            // ERC20 offer - insufficient balance
            const signerBalance = await mockToken.balanceOf(defaultSigner.address);
            await mockToken.transfer(wallets[4].address, signerBalance); // transfer all the tokens to another wallet

            await expect(custodyVaultFacet.topUpCustodianVault(offerId, topUpAmount))
              .to.be.revertedWithCustomError(mockToken, "ERC20InsufficientBalance")
              .withArgs(defaultSigner.address, 0n, topUpAmount);

            // Send native currency to ERC20 offer
            await expect(
              custodyVaultFacet.topUpCustodianVault(offerId, topUpAmount, { value: topUpAmount }),
            ).to.be.revertedWithCustomError(fermionErrors, "NativeNotAllowed");
          });
        });
      });

      context("removeItemFromCustodianOfferVault", function () {
        const tokenCount = 3n;
        const bidAmount = auctionParameters.exitPrice + parseEther("0.1");
        const usedFractions = 0;

        beforeEach(async function () {
          // buyoutAuction for the first item

          await mockToken.connect(bidder).approve(await wrapper.getAddress(), bidAmount);
        });

        context("Not last offer item", function () {
          context("Offer vault is not empty", function () {
            const paymentPeriods = 5n;
            const prepaymentAmount = custodianFee.amount * paymentPeriods * tokenCount; // pre pay for 5 periods
            const vaultAmount = prepaymentAmount + custodianFee.amount * tokenCount; // 1 period custodian fee already from fractionalisation

            beforeEach(async function () {
              await mockToken.approve(fermionProtocolAddress, prepaymentAmount);
              await custodyVaultFacet.topUpCustodianVault(offerId, prepaymentAmount);
            });

            it("Enough to cover past fee", async function () {
              const custodianAvailableFunds = await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress);
              const transferTime = offerVaultCreationTimestamp + (custodianFee.period * 3n) / 2n;
              const itemVaultCreationTimestamp = transferTime + auctionParameters.duration;
              const custodianPayoff =
                ((itemVaultCreationTimestamp - offerVaultCreationTimestamp) * custodianFee.amount) /
                custodianFee.period;

              const removedFromVault = vaultAmount / tokenCount;
              const releasedToWrapper = removedFromVault - custodianPayoff;
              const wrapperBalance = await mockToken.balanceOf(await wrapper.getAddress());

              await setNextBlockTimestamp(String(transferTime));

              const tx = await wrapper.connect(bidder).bid(exchange.tokenId, bidAmount, usedFractions);

              await expect(tx)
                .to.emit(custodyVaultFacet, "AvailableFundsIncreased")
                .withArgs(custodianId, mockTokenAddress, custodianPayoff);
              await expect(tx)
                .to.emit(custodyVaultFacet, "VaultBalanceUpdated")
                .withArgs(offerId, vaultAmount - removedFromVault);

              // offer vault remains, just number of items is increased and amount increases
              const expectedOfferVault = {
                amount: vaultAmount - removedFromVault,
                period: offerVaultCreationTimestamp,
              };
              let itemCount = 2n;

              expect(await custodyVaultFacet.getCustodianVault(offerId)).to.eql([
                Object.values(expectedOfferVault),
                itemCount,
              ]);

              // item vault is opened
              const expectedItemVault = {
                amount: 0n,
                period: itemVaultCreationTimestamp,
              };
              itemCount = 1n;

              expect(await custodyVaultFacet.getCustodianVault(exchange.tokenId)).to.eql([
                Object.values(expectedItemVault),
                itemCount,
              ]);
              expect(await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress)).to.equal(
                custodianAvailableFunds + custodianPayoff,
              );
              expect(await mockToken.balanceOf(await wrapper.getAddress())).to.equal(
                wrapperBalance + bidAmount + releasedToWrapper,
              );
            });

            it("Not enough to cover past fee", async function () {
              const custodianAvailableFunds = await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress);
              const effectivePaymentPeriods = paymentPeriods + 1n; // 1 period already paid from fractionalisation
              const transferTime = offerVaultCreationTimestamp + effectivePaymentPeriods * custodianFee.period + 100n;
              const wrapperBalance = await mockToken.balanceOf(await wrapper.getAddress());
              const itemVaultCreationTimestamp = transferTime + auctionParameters.duration;

              await setNextBlockTimestamp(String(transferTime));

              const tx = await wrapper.connect(bidder).bid(exchange.tokenId, bidAmount, usedFractions);

              await expect(tx)
                .to.emit(custodyVaultFacet, "AvailableFundsIncreased")
                .withArgs(custodianId, mockTokenAddress, custodianFee.amount * effectivePaymentPeriods);
              await expect(tx)
                .to.emit(custodyVaultFacet, "VaultBalanceUpdated")
                .withArgs(offerId, vaultAmount - custodianFee.amount * effectivePaymentPeriods);

              // offer vault remains, just number of items is increased
              const expectedOfferVault = {
                amount: vaultAmount - custodianFee.amount * effectivePaymentPeriods,
                period: offerVaultCreationTimestamp,
              };
              let itemCount = 2n;

              expect(await custodyVaultFacet.getCustodianVault(offerId)).to.eql([
                Object.values(expectedOfferVault),
                itemCount,
              ]);

              // item vault is open
              const expectedItemVault = {
                amount: 0n,
                period: itemVaultCreationTimestamp,
              };
              itemCount = 1n;

              expect(await custodyVaultFacet.getCustodianVault(exchange.tokenId)).to.eql([
                Object.values(expectedItemVault),
                itemCount,
              ]);
              expect(await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress)).to.equal(
                custodianAvailableFunds + effectivePaymentPeriods * custodianFee.amount,
              );
              expect(await mockToken.balanceOf(await wrapper.getAddress())).to.equal(wrapperBalance + bidAmount); // only bid added, nothing from the vault
            });
          });
        });

        context("Last item in vault", function () {
          const tokenCount = 2n;
          let tokenId2: bigint;
          let tokenId3: bigint;

          beforeEach(async function () {
            tokenId2 = BigInt(exchange.tokenId) + 1n;
            tokenId3 = BigInt(exchange.tokenId) + 2n;

            await mockToken.mint(bidder.address, parseEther("1000"));
            await mockToken.connect(bidder).approve(await wrapper.getAddress(), 3n * bidAmount);
          });

          context("Offer vault is not empty", function () {
            const paymentPeriods = 5n;
            const prepaymentAmount = custodianFee.amount * paymentPeriods * tokenCount; // pre pay for 5 periods
            const vaultAmount = prepaymentAmount + custodianFee.amount * (tokenCount + 1n); // 1 period custodian fee already from fractionalisation

            beforeEach(async function () {
              await mockToken.approve(fermionProtocolAddress, prepaymentAmount);
              await custodyVaultFacet.topUpCustodianVault(offerId, prepaymentAmount);
            });

            it("Enough to cover past fee", async function () {
              await wrapper.connect(bidder).bid(tokenId2, bidAmount, usedFractions);
              await wrapper.connect(bidder).bid(tokenId3, bidAmount, usedFractions);
              const transferTime = offerVaultCreationTimestamp + (custodianFee.period * 3n) / 2n;
              const itemVaultCreationTimestamp = transferTime + auctionParameters.duration;
              // const custodianPayoff = (custodianFee.amount * 3n) / 2n;
              const custodianPayoff =
                ((itemVaultCreationTimestamp - offerVaultCreationTimestamp) * custodianFee.amount) /
                custodianFee.period;
              const wrapperBalance = await mockToken.balanceOf(await wrapper.getAddress());
              const newVaultAmount = vaultAmount - (vaultAmount * 2n) / 3n;
              const releasedToWrapper = newVaultAmount - custodianPayoff;

              await setNextBlockTimestamp(String(transferTime));
              const custodianAvailableFunds = await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress);
              const tx = await wrapper.connect(bidder).bid(exchange.tokenId, bidAmount, usedFractions);

              await expect(tx)
                .to.emit(custodyVaultFacet, "AvailableFundsIncreased")
                .withArgs(custodianId, mockTokenAddress, custodianPayoff);
              await expect(tx).to.emit(custodyVaultFacet, "VaultBalanceUpdated").withArgs(offerId, 0n);

              // offer vault get closed
              const expectedOfferVault = {
                amount: 0n,
                period: 0n,
              };
              let itemCount = 0n;

              expect(await custodyVaultFacet.getCustodianVault(offerId)).to.eql([
                Object.values(expectedOfferVault),
                itemCount,
              ]);

              // item vault is open
              const expectedItemVault = {
                amount: 0n,
                period: itemVaultCreationTimestamp,
              };
              itemCount = 1n;

              expect(await custodyVaultFacet.getCustodianVault(exchange.tokenId)).to.eql([
                Object.values(expectedItemVault),
                itemCount,
              ]);
              expect(await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress)).to.equal(
                custodianAvailableFunds + custodianPayoff,
              );
              expect(await mockToken.balanceOf(await wrapper.getAddress())).to.equal(
                wrapperBalance + bidAmount + releasedToWrapper,
              );
            });

            it("Not enough to cover past fee", async function () {
              let transferTime = offerVaultCreationTimestamp + paymentPeriods * custodianFee.period + 100n;
              await setNextBlockTimestamp(String(transferTime));

              await wrapper.connect(bidder).bid(tokenId2, bidAmount, usedFractions);
              const vaultAmount2 = vaultAmount - vaultAmount / 3n;
              // await wrapper.connect(bidder).redeem(tokenId3);
              await wrapper.connect(bidder).bid(tokenId3, bidAmount, usedFractions);
              const vaultAmount3 = vaultAmount2 - vaultAmount2 / 2n;

              const remainderInVault = vaultAmount3;
              const custodianAvailableFunds = await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress);
              const wrapperBalance = await mockToken.balanceOf(await wrapper.getAddress());

              const tx = await wrapper.connect(bidder).bid(exchange.tokenId, bidAmount, usedFractions);
              transferTime = BigInt((await tx.getBlock()).timestamp);
              const itemVaultCreationTimestamp = transferTime + auctionParameters.duration;

              await expect(tx)
                .to.emit(custodyVaultFacet, "AvailableFundsIncreased")
                .withArgs(custodianId, mockTokenAddress, remainderInVault);
              await expect(tx).to.emit(custodyVaultFacet, "VaultBalanceUpdated").withArgs(offerId, 0n);

              // offer vault remains, just number of items is increased
              const expectedOfferVault = {
                amount: 0n,
                period: 0n,
              };
              let itemCount = 0n;

              expect(await custodyVaultFacet.getCustodianVault(offerId)).to.eql([
                Object.values(expectedOfferVault),
                itemCount,
              ]);

              // item vault is open
              const expectedItemVault = {
                amount: 0n,
                period: itemVaultCreationTimestamp,
              };
              itemCount = 1n;

              expect(await custodyVaultFacet.getCustodianVault(exchange.tokenId)).to.eql([
                Object.values(expectedItemVault),
                itemCount,
              ]);
              expect(await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress)).to.equal(
                custodianAvailableFunds + remainderInVault,
              );
              expect(await mockToken.balanceOf(await wrapper.getAddress())).to.equal(wrapperBalance + bidAmount); // only bid added, nothing from vault
            });
          });
        });

        context("Revert reasons", function () {
          it("Custody region is paused", async function () {
            await pauseFacet.pause([PausableRegion.CustodyVault]);

            await expect(wrapper.connect(bidder).bid(exchange.tokenId, bidAmount, usedFractions))
              .to.be.revertedWithCustomError(fermionErrors, "RegionPaused")
              .withArgs(PausableRegion.CustodyVault);
          });

          it("Caller is not the wrapper", async function () {
            await expect(
              custodyVaultFacet.connect(defaultSigner).removeItemFromCustodianOfferVault(exchange.tokenId, 0n),
            )
              .to.be.revertedWithCustomError(fermionErrors, "AccessDenied")
              .withArgs(defaultSigner.address);
          });
        });
      });

      context("repayDebt", function () {
        const tokenCount = 3n;
        const bidAmount = auctionParameters.exitPrice + parseEther("0.1");
        const usedFractions = 0;
        const paymentPeriods = 5n;
        const prepaymentAmount = custodianFee.amount * paymentPeriods * tokenCount; // pre pay for 5 periods

        beforeEach(async function () {
          await mockToken.connect(bidder).approve(await wrapper.getAddress(), bidAmount);
          await mockToken.approve(fermionProtocolAddress, prepaymentAmount);
        });

        context("Not last offer item", async function () {
          const vaultAmount = prepaymentAmount + custodianFee.amount * tokenCount; // 1 period custodian fee already from fractionalisation
          const effectivePaymentPeriods = paymentPeriods + 1n; // 1 period already paid from fractionalisation
          let deficit: bigint;

          beforeEach(async function () {
            const transferTime = offerVaultCreationTimestamp + effectivePaymentPeriods * custodianFee.period + 100n;
            const itemVaultCreationTimestamp = transferTime + auctionParameters.duration;
            const custodianPayoff =
              ((itemVaultCreationTimestamp - offerVaultCreationTimestamp) * custodianFee.amount) / custodianFee.period;
            deficit = vaultAmount / 3n - custodianPayoff;

            await custodyVaultFacet.topUpCustodianVault(offerId, prepaymentAmount);
            await setNextBlockTimestamp(String(transferTime));
          });

          it("bid covers the debt", async function () {
            const tx = await wrapper.connect(bidder).bid(exchange.tokenId, bidAmount, usedFractions);
            const bidTime = BigInt((await tx.getBlock()).timestamp);
            const auctionEnd = bidTime + auctionParameters.duration + 1n;
            await setNextBlockTimestamp(String(auctionEnd));

            const custodianAvailableFunds = await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress);
            const repaid = -deficit; // deficit is negative. Absolute value of deficit is less than bidAmount, so it is repaid in full
            const tx2 = await wrapper.connect(bidder).redeem(exchange.tokenId);
            await expect(tx2)
              .to.emit(custodyVaultFacet, "AvailableFundsIncreased")
              .withArgs(custodianId, mockTokenAddress, repaid);

            expect(await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress)).to.equal(
              custodianAvailableFunds + repaid,
            );
          });

          it("bid does not cover the debt", async function () {
            const bidAmount = (-deficit * 3n) / 4n;
            await wrapper.connect(bidder).bid(exchange.tokenId, bidAmount, usedFractions);
            const fermionFractionsERC20Address = await wrapper.getERC20FractionsClone();
            const fermionFractionsERC20 = await ethers.getContractAt(
              "FermionFractionsERC20",
              fermionFractionsERC20Address,
            );
            const sellerFractions = await fermionFractionsERC20.balanceOf(buyer.address);
            const tx = await wrapper.connect(buyer).voteToStartAuction(exchange.tokenId, sellerFractions); // bid is below exit price, original buyer votes to start auction
            const voteTime = BigInt((await tx.getBlock()).timestamp);
            const auctionEnd = voteTime + auctionParameters.duration + 1n;
            await setNextBlockTimestamp(String(auctionEnd));

            const custodianAvailableFunds = await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress);
            const repaid = bidAmount; //Absolute value of deficit is more than bidAmount, so it is not repaid in full
            const tx2 = await wrapper.connect(bidder).redeem(exchange.tokenId);
            await expect(tx2)
              .to.emit(custodyVaultFacet, "AvailableFundsIncreased")
              .withArgs(custodianId, mockTokenAddress, repaid);

            expect(await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress)).to.equal(
              custodianAvailableFunds + repaid,
            );
          });
        });

        context("Last item in vault", function () {
          const tokenCount = 2n;
          const prepaymentAmount = custodianFee.amount * paymentPeriods * tokenCount; // pre pay for 5 periods
          let deficit: bigint;
          let transferTime: bigint;
          beforeEach(async function () {
            await custodyVaultFacet.topUpCustodianVault(offerId, prepaymentAmount);

            const tokenId2 = BigInt(exchange.tokenId) + 1n;
            const tokenId3 = BigInt(exchange.tokenId) + 2n;

            await mockToken.mint(bidder.address, parseEther("1000"));
            await mockToken.connect(bidder).approve(await wrapper.getAddress(), 3n * bidAmount);
            const vaultAmount = prepaymentAmount + custodianFee.amount * (tokenCount + 1n); // 1 period custodian fee already from fractionalisation
            transferTime = offerVaultCreationTimestamp + paymentPeriods * custodianFee.period + 100n;
            await setNextBlockTimestamp(String(transferTime));
            await wrapper.connect(bidder).bid(tokenId2, bidAmount, usedFractions);
            const vaultAmount2 = vaultAmount - vaultAmount / 3n;
            await wrapper.connect(bidder).bid(tokenId3, bidAmount, usedFractions);
            const vaultAmount3 = vaultAmount2 - vaultAmount2 / 2n;

            transferTime += 100n;
            await setNextBlockTimestamp(String(transferTime));
            const itemVaultCreationTimestamp = transferTime + auctionParameters.duration;
            const custodianPayoff =
              ((itemVaultCreationTimestamp - offerVaultCreationTimestamp) * custodianFee.amount) / custodianFee.period;

            deficit = vaultAmount3 - custodianPayoff;
          });

          it("bid covers the debt", async function () {
            await wrapper.connect(bidder).bid(exchange.tokenId, bidAmount, usedFractions);
            const auctionEnd = transferTime + auctionParameters.duration + 1n;
            await setNextBlockTimestamp(String(auctionEnd));

            const custodianAvailableFunds = await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress);
            const repaid = -deficit; // deficit is negative. Absolute value of deficit is less than bidAmount, so it is repaid in full
            const tx2 = await wrapper.connect(bidder).redeem(exchange.tokenId);
            await expect(tx2)
              .to.emit(custodyVaultFacet, "AvailableFundsIncreased")
              .withArgs(custodianId, mockTokenAddress, repaid); // deficit is

            expect(await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress)).to.equal(
              custodianAvailableFunds + repaid,
            );
          });

          it("bid does not cover the debt", async function () {
            const bidAmount = (-deficit * 3n) / 4n;
            await wrapper.connect(bidder).bid(exchange.tokenId, bidAmount, usedFractions);
            const tx = await wrapper.connect(buyer).voteToStartAuction(exchange.tokenId, fractionsPerToken); // bid is below exit price, vote to start auction
            const voteTime = BigInt((await tx.getBlock()).timestamp);
            const auctionEnd = voteTime + auctionParameters.duration + 1n;
            await setNextBlockTimestamp(String(auctionEnd));

            const custodianAvailableFunds = await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress);
            const repaid = bidAmount; //Absolute value of deficit is more than bidAmount, so it is not repaid in full
            const tx2 = await wrapper.connect(bidder).redeem(exchange.tokenId);
            await expect(tx2)
              .to.emit(custodyVaultFacet, "AvailableFundsIncreased")
              .withArgs(custodianId, mockTokenAddress, repaid); // deficit is

            expect(await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress)).to.equal(
              custodianAvailableFunds + repaid,
            );
          });
        });

        context("Revert reasons", function () {
          it("Custody region is paused", async function () {
            await pauseFacet.pause([PausableRegion.CustodyVault]);

            await expect(custodyVaultFacet.repayDebt(exchange.tokenId, 0n))
              .to.be.revertedWithCustomError(fermionErrors, "RegionPaused")
              .withArgs(PausableRegion.CustodyVault);
          });

          it("Caller is not the wrapper", async function () {
            await expect(custodyVaultFacet.connect(defaultSigner).repayDebt(exchange.tokenId, 0n))
              .to.be.revertedWithCustomError(fermionErrors, "AccessDenied")
              .withArgs(defaultSigner.address);
          });
        });
      });

      context("releaseFundsFromVault", function () {
        const topUpAmount = (custodianVaultParameters.partialAuctionThreshold - custodianFee.amount) * tokenCount; // 1 period is covered by the initial fractionalisation deposit
        const vaultAmount = topUpAmount + custodianFee.amount * tokenCount; // fee for 1 period in already from fractionalisation

        beforeEach(async function () {
          await mockToken.approve(fermionProtocolAddress, topUpAmount);
          await custodyVaultFacet.topUpCustodianVault(offerId, topUpAmount);
        });

        context("Custody vault balance falls stays above partial auction threshold", function () {
          const additionalTopUpAmount = custodianFee.amount * 5n * tokenCount; // add funds so it stays above partial auction threshold

          beforeEach(async function () {
            await mockToken.approve(fermionProtocolAddress, additionalTopUpAmount);
            await custodyVaultFacet.topUpCustodianVault(offerId, additionalTopUpAmount);
          });

          it("After the period is over, the funds can be released to custodian", async function () {
            await setNextBlockTimestamp(String(offerVaultCreationTimestamp + custodianFee.period + 100n));

            const protocolBalance = await mockToken.balanceOf(fermionProtocolAddress);
            const custodianAvailableFunds = await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress);

            const tx = await custodyVaultFacet.releaseFundsFromVault(offerId);

            await expect(tx)
              .to.emit(custodyVaultFacet, "VaultBalanceUpdated")
              .withArgs(offerId, vaultAmount + additionalTopUpAmount - custodianFee.amount * tokenCount);
            await expect(tx)
              .to.emit(custodyVaultFacet, "AvailableFundsIncreased")
              .withArgs(custodianId, mockTokenAddress, custodianFee.amount * tokenCount);
            await expect(tx).to.not.emit(custodyVaultFacet, "AuctionStarted");

            const expectedCustodianVault = {
              amount: vaultAmount + additionalTopUpAmount - custodianFee.amount * tokenCount,
              period: offerVaultCreationTimestamp + custodianFee.period,
            };

            expect(await custodyVaultFacet.getCustodianVault(offerId)).to.eql([
              Object.values(expectedCustodianVault),
              tokenCount,
            ]);
            expect(await mockToken.balanceOf(fermionProtocolAddress)).to.equal(protocolBalance); // releasing should not change protocol balance
            expect(await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress)).to.equal(
              custodianAvailableFunds + tokenCount * custodianFee.amount,
            );

            // Wait another period to release the funds again
            await setNextBlockTimestamp(String(offerVaultCreationTimestamp + 2n * custodianFee.period + 150n));

            const tx2 = await custodyVaultFacet.releaseFundsFromVault(offerId);

            await expect(tx2)
              .to.emit(custodyVaultFacet, "VaultBalanceUpdated")
              .withArgs(offerId, vaultAmount + additionalTopUpAmount - 2n * custodianFee.amount * tokenCount);
            await expect(tx2)
              .to.emit(custodyVaultFacet, "AvailableFundsIncreased")
              .withArgs(custodianId, mockTokenAddress, custodianFee.amount * tokenCount);

            const expectedCustodianVault2 = {
              amount: vaultAmount + additionalTopUpAmount - 2n * custodianFee.amount * tokenCount,
              period: offerVaultCreationTimestamp + 2n * custodianFee.period,
            };

            expect(await custodyVaultFacet.getCustodianVault(offerId)).to.eql([
              Object.values(expectedCustodianVault2),
              tokenCount,
            ]);
            expect(await mockToken.balanceOf(fermionProtocolAddress)).to.equal(protocolBalance); // releasing should not change protocol balance
            expect(await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress)).to.equal(
              custodianAvailableFunds + 2n * custodianFee.amount * tokenCount,
            );
          });

          it("Payout for multiple periods in bulk", async function () {
            const payoutPeriods = 3n;
            await setNextBlockTimestamp(
              String(offerVaultCreationTimestamp + payoutPeriods * custodianFee.period + 200n),
            );

            const protocolBalance = await mockToken.balanceOf(fermionProtocolAddress);
            const custodianAvailableFunds = await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress);

            const tx = await custodyVaultFacet.releaseFundsFromVault(offerId);

            await expect(tx)
              .to.emit(custodyVaultFacet, "VaultBalanceUpdated")
              .withArgs(
                offerId,
                vaultAmount + additionalTopUpAmount - payoutPeriods * custodianFee.amount * tokenCount,
              );
            await expect(tx)
              .to.emit(custodyVaultFacet, "AvailableFundsIncreased")
              .withArgs(custodianId, mockTokenAddress, payoutPeriods * custodianFee.amount * tokenCount);
            await expect(tx).to.not.emit(custodyVaultFacet, "AuctionStarted");

            const expectedCustodianVault = {
              amount: vaultAmount + additionalTopUpAmount - payoutPeriods * custodianFee.amount * tokenCount,
              period: offerVaultCreationTimestamp + payoutPeriods * custodianFee.period,
            };

            expect(await custodyVaultFacet.getCustodianVault(offerId)).to.eql([
              Object.values(expectedCustodianVault),
              tokenCount,
            ]);
            expect(await mockToken.balanceOf(fermionProtocolAddress)).to.equal(protocolBalance); // releasing should not change protocol balance
            expect(await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress)).to.equal(
              custodianAvailableFunds + payoutPeriods * custodianFee.amount * tokenCount,
            );
          });
        });

        context("Custody vault balance falls below partial auction threshold", function () {
          it("Fall below the threshold, enough to pay the fee", async function () {
            const payoutPeriods = 2n;
            const custodianPayout = payoutPeriods * custodianFee.amount * tokenCount;
            await setNextBlockTimestamp(
              String(offerVaultCreationTimestamp + payoutPeriods * custodianFee.period + 200n),
            );

            const fractionsToIssue = tokenCount * custodianVaultParameters.newFractionsPerAuction; // for the previously fractionalised token and the new one
            const custodianAvailableFunds = await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress);

            const tx2 = await custodyVaultFacet.releaseFundsFromVault(offerId);
            const timestamp = BigInt((await tx2.getBlock()).timestamp);
            const auctionEnd = timestamp + custodianVaultParameters.partialAuctionDuration;
            await expect(tx2)
              .to.emit(fundsFacet, "AvailableFundsIncreased")
              .withArgs(custodianId, mockTokenAddress, custodianPayout);
            await expect(tx2)
              .to.emit(custodyVaultFacet, "VaultBalanceUpdated")
              .withArgs(offerId, vaultAmount - custodianPayout);
            await expect(tx2)
              .to.emit(custodyVaultFacet, "AuctionStarted")
              .withArgs(offerId, fractionsToIssue, auctionEnd);
            await expect(tx2)
              .to.emit(wrapper, "AdditionalFractionsMinted")
              .withArgs(fractionsToIssue, tokenCount * fractionsPerToken + fractionsToIssue, defaultEpoch);

            // offer vault remains the same
            const expectedOfferVault = {
              amount: vaultAmount - custodianPayout,
              period: offerVaultCreationTimestamp + payoutPeriods * custodianFee.period,
            };

            expect(await custodyVaultFacet.getCustodianVault(offerId)).to.eql([
              Object.values(expectedOfferVault),
              tokenCount,
            ]);

            expect(await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress)).to.equal(
              custodianAvailableFunds + custodianPayout,
            );
          });

          it("Some periods can be covered, but not all, item vault balance is multiple of custodian fee", async function () {
            const payoutPeriods = 15n;
            await setNextBlockTimestamp(
              String(offerVaultCreationTimestamp + (payoutPeriods + 1n) * custodianFee.period + 200n),
            );

            const fractionsToIssue = tokenCount * custodianVaultParameters.newFractionsPerAuction; // for the previously fractionalised token and the new one
            const custodianAvailableFunds = await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress);

            const tx2 = await custodyVaultFacet.releaseFundsFromVault(offerId);
            const timestamp = BigInt((await tx2.getBlock()).timestamp);
            const auctionEnd = timestamp + custodianVaultParameters.partialAuctionDuration;
            await expect(tx2)
              .to.emit(fundsFacet, "AvailableFundsIncreased")
              .withArgs(custodianId, mockTokenAddress, payoutPeriods * custodianFee.amount * tokenCount);
            await expect(tx2)
              .to.emit(custodyVaultFacet, "AuctionStarted")
              .withArgs(offerId, fractionsToIssue, auctionEnd);
            await expect(tx2)
              .to.emit(wrapper, "AdditionalFractionsMinted")
              .withArgs(fractionsToIssue, tokenCount * fractionsPerToken + fractionsToIssue, defaultEpoch);

            const expectedOfferVault = {
              amount: 0n,
              period: offerVaultCreationTimestamp + payoutPeriods * custodianFee.period,
            };

            expect(await custodyVaultFacet.getCustodianVault(offerId)).to.eql([
              Object.values(expectedOfferVault),
              tokenCount,
            ]);

            expect(await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress)).to.equal(
              custodianAvailableFunds + payoutPeriods * custodianFee.amount * tokenCount,
            );
          });

          it("Some periods can be covered, but not all, some funds remain in vault,  item vault balance is not multiple of custodian fee", async function () {
            const additionalTopUpAmount = custodianFee.amount / 2n; // half of the period
            await mockToken.approve(fermionProtocolAddress, additionalTopUpAmount);
            await custodyVaultFacet.topUpCustodianVault(offerId, additionalTopUpAmount);

            const payoutPeriods = 15n;
            await setNextBlockTimestamp(
              String(offerVaultCreationTimestamp + (payoutPeriods + 1n) * custodianFee.period + 200n),
            );

            const fractionsToIssue = tokenCount * custodianVaultParameters.newFractionsPerAuction; // for the previously fractionalised token and the new one
            const custodianAvailableFunds = await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress);

            const tx2 = await custodyVaultFacet.releaseFundsFromVault(offerId);
            const timestamp = BigInt((await tx2.getBlock()).timestamp);
            const auctionEnd = timestamp + custodianVaultParameters.partialAuctionDuration;
            await expect(tx2)
              .to.emit(fundsFacet, "AvailableFundsIncreased")
              .withArgs(custodianId, mockTokenAddress, payoutPeriods * custodianFee.amount * tokenCount);
            await expect(tx2)
              .to.emit(custodyVaultFacet, "VaultBalanceUpdated")
              .withArgs(offerId, additionalTopUpAmount);
            await expect(tx2)
              .to.emit(custodyVaultFacet, "AuctionStarted")
              .withArgs(offerId, fractionsToIssue, auctionEnd);
            await expect(tx2)
              .to.emit(wrapper, "AdditionalFractionsMinted")
              .withArgs(fractionsToIssue, tokenCount * fractionsPerToken + fractionsToIssue, defaultEpoch);

            // offer vault remains the same, just number of items is increased
            const expectedOfferVault = {
              amount: additionalTopUpAmount,
              period: offerVaultCreationTimestamp + payoutPeriods * custodianFee.period,
            };

            expect(await custodyVaultFacet.getCustodianVault(offerId)).to.eql([
              Object.values(expectedOfferVault),
              tokenCount,
            ]);

            expect(await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress)).to.equal(
              custodianAvailableFunds + payoutPeriods * custodianFee.amount * tokenCount,
            );
          });
        });

        context("Revert reasons", function () {
          it("Custody region is paused", async function () {
            await pauseFacet.pause([PausableRegion.CustodyVault]);

            await expect(custodyVaultFacet.releaseFundsFromVault(offerId))
              .to.be.revertedWithCustomError(fermionErrors, "RegionPaused")
              .withArgs(PausableRegion.CustodyVault);
          });

          it("Vault does not exist/is inactive", async function () {
            // invalid offer id
            await expect(custodyVaultFacet.releaseFundsFromVault(0n))
              .to.be.revertedWithCustomError(fermionErrors, "InactiveVault")
              .withArgs(0n);

            await expect(custodyVaultFacet.releaseFundsFromVault(1000n))
              .to.be.revertedWithCustomError(fermionErrors, "InactiveVault")
              .withArgs(1000n);
          });

          it("Period not over yet", async function () {
            await setNextBlockTimestamp(String(offerVaultCreationTimestamp + custodianFee.period - 1n));

            await expect(custodyVaultFacet.releaseFundsFromVault(offerId))
              .to.be.revertedWithCustomError(fermionErrors, "PeriodNotOver")
              .withArgs(offerId, offerVaultCreationTimestamp + custodianFee.period);

            await setNextBlockTimestamp(String(offerVaultCreationTimestamp + custodianFee.period + 1n));
            await custodyVaultFacet.releaseFundsFromVault(offerId);

            await setNextBlockTimestamp(String(offerVaultCreationTimestamp + 2n * custodianFee.period - 1n));

            await expect(custodyVaultFacet.releaseFundsFromVault(offerId))
              .to.be.revertedWithCustomError(fermionErrors, "PeriodNotOver")
              .withArgs(offerId, offerVaultCreationTimestamp + 2n * custodianFee.period);

            await setNextBlockTimestamp(String(offerVaultCreationTimestamp + 4n * custodianFee.period + 1n));
            await custodyVaultFacet.releaseFundsFromVault(offerId);

            await setNextBlockTimestamp(String(offerVaultCreationTimestamp + 5n * custodianFee.period - 1n));
            await expect(custodyVaultFacet.releaseFundsFromVault(offerId))
              .to.be.revertedWithCustomError(fermionErrors, "PeriodNotOver")
              .withArgs(offerId, offerVaultCreationTimestamp + 5n * custodianFee.period);
          });

          context("Auction is ongoing", function () {
            it("Existing fractionalised F-NFT in collection", async function () {
              const payoutPeriods = 2n;
              await setNextBlockTimestamp(
                String(offerVaultCreationTimestamp + payoutPeriods * custodianFee.period + 200n),
              );

              const tx2 = await custodyVaultFacet.releaseFundsFromVault(offerId);
              await expect(tx2).to.emit(custodyVaultFacet, "AuctionStarted");

              await expect(custodyVaultFacet.releaseFundsFromVault(offerId))
                .to.be.revertedWithCustomError(fermionErrors, "PeriodNotOver")
                .withArgs(offerId, offerVaultCreationTimestamp + (payoutPeriods + 1n) * custodianFee.period);
            });

            it("Existing fractionalised F-NFT in collection", async function () {
              const payoutPeriods = 2n;
              await setNextBlockTimestamp(
                String(offerVaultCreationTimestamp + (payoutPeriods + 1n) * custodianFee.period - 200n),
              );

              const tx2 = await custodyVaultFacet.releaseFundsFromVault(offerId);
              await expect(tx2).to.emit(custodyVaultFacet, "AuctionStarted");

              const auctionStart = BigInt((await tx2.getBlock()).timestamp);
              const auctionEnd = auctionStart + custodianVaultParameters.partialAuctionDuration;

              await setNextBlockTimestamp(
                String(offerVaultCreationTimestamp + (payoutPeriods + 1n) * custodianFee.period + 200n),
              );

              await expect(custodyVaultFacet.releaseFundsFromVault(offerId))
                .to.be.revertedWithCustomError(fermionErrors, "AuctionOngoing")
                .withArgs(offerId, auctionEnd);
            });
          });
        });
      });

      context("bid", function () {
        const bidderId = 6n;

        let auctionEnd: bigint;
        const bidAmount = (custodianVaultParameters.partialAuctionThreshold * tokenCount * 11n) / 10n;

        beforeEach(async function () {
          await setNextBlockTimestamp(String(offerVaultCreationTimestamp + custodianFee.period + 200n));
          const tx = await custodyVaultFacet.releaseFundsFromVault(offerId);
          await expect(tx).to.emit(custodyVaultFacet, "AuctionStarted");
          const timestamp = BigInt((await tx.getBlock()).timestamp);
          auctionEnd = timestamp + custodianVaultParameters.partialAuctionDuration;
        });

        it("Place a bid", async function () {
          const custodianVault = await custodyVaultFacet.getCustodianVault(offerId);
          const protocolBalance = await mockToken.balanceOf(fermionProtocolAddress);

          await mockToken.connect(bidder).approve(fermionProtocolAddress, bidAmount);

          const tx = await custodyVaultFacet.connect(bidder).bid(offerId, bidAmount);

          await expect(tx)
            .to.emit(custodyVaultFacet, "BidPlaced")
            .withArgs(offerId, bidder.address, bidderId, bidAmount);
          await expect(tx).to.not.emit(fundsFacet, "AvailableFundsIncreased");

          expect(await mockToken.balanceOf(fermionProtocolAddress)).to.equal(protocolBalance + bidAmount);
          expect(await custodyVaultFacet.getCustodianVault(offerId)).to.eql(custodianVault); // placing a bid does not change the vault

          const expectedAuctionDetails = {
            endTime: auctionEnd,
            availableFractions: custodianVaultParameters.newFractionsPerAuction * tokenCount,
            maxBid: bidAmount,
            bidderId: bidderId,
          };
          expect(await custodyVaultFacet.getPartialAuctionDetails(offerId)).to.eql(
            Object.values(expectedAuctionDetails),
          );
        });

        it("When outbid, previous bidder gets the money in available funds", async function () {
          await mockToken.connect(bidder).approve(fermionProtocolAddress, bidAmount);
          await custodyVaultFacet.connect(bidder).bid(offerId, bidAmount);

          const newBidder = wallets[8];
          const newBidAmount = (bidAmount * 12n) / 10n;
          await mockToken.mint(newBidder.address, newBidAmount);

          const custodianVault = await custodyVaultFacet.getCustodianVault(offerId);
          const protocolBalance = await mockToken.balanceOf(fermionProtocolAddress);
          await mockToken.connect(newBidder).approve(fermionProtocolAddress, newBidAmount);

          const tx = await custodyVaultFacet.connect(newBidder).bid(offerId, newBidAmount);

          await expect(tx)
            .to.emit(custodyVaultFacet, "BidPlaced")
            .withArgs(offerId, newBidder.address, bidderId + 1n, newBidAmount);
          await expect(tx)
            .to.emit(fundsFacet, "AvailableFundsIncreased")
            .withArgs(bidderId, mockTokenAddress, bidAmount);

          expect(await mockToken.balanceOf(fermionProtocolAddress)).to.equal(protocolBalance + newBidAmount);
          expect(await fundsFacet.getAvailableFunds(bidderId, mockTokenAddress)).to.equal(bidAmount);
          expect(await custodyVaultFacet.getCustodianVault(offerId)).to.eql(custodianVault); // placing a bid does not change the vault
          const expectedAuctionDetails = {
            endTime: auctionEnd,
            availableFractions: custodianVaultParameters.newFractionsPerAuction * tokenCount,
            maxBid: newBidAmount,
            bidderId: bidderId + 1n,
          };
          expect(await custodyVaultFacet.getPartialAuctionDetails(offerId)).to.eql(
            Object.values(expectedAuctionDetails),
          );
        });

        it("placing a bid within buffer time extends it by buffer period", async function () {
          const { endTime } = await custodyVaultFacet.getPartialAuctionDetails(offerId);

          await mockToken.connect(bidder).approve(fermionProtocolAddress, bidAmount);
          await custodyVaultFacet.connect(bidder).bid(offerId, bidAmount);
          const { endTime: endTime2 } = await custodyVaultFacet.getPartialAuctionDetails(offerId);
          expect(endTime2).to.equal(endTime);

          const newBidder = wallets[8];
          const newBidAmount = (bidAmount * 12n) / 10n;
          await mockToken.mint(newBidder.address, newBidAmount);
          await mockToken.connect(newBidder).approve(fermionProtocolAddress, newBidAmount);

          await setNextBlockTimestamp(String(auctionEnd - AUCTION_END_BUFFER + 123n));

          const tx = await custodyVaultFacet.connect(newBidder).bid(offerId, newBidAmount);
          const timestamp = BigInt((await tx.getBlock()).timestamp);
          const { endTime: endTime3 } = await custodyVaultFacet.getPartialAuctionDetails(offerId);
          expect(endTime3).to.equal(timestamp + AUCTION_END_BUFFER);
        });

        context("Revert reasons", function () {
          it("Custody region is paused", async function () {
            await pauseFacet.pause([PausableRegion.CustodyVault]);

            await expect(custodyVaultFacet.connect(bidder).bid(offerId, bidAmount))
              .to.be.revertedWithCustomError(fermionErrors, "RegionPaused")
              .withArgs(PausableRegion.CustodyVault);
          });

          it("No auction for the vault", async function () {
            // invalid offer id
            await expect(custodyVaultFacet.connect(bidder).bid(0n, bidAmount))
              .to.be.revertedWithCustomError(fermionErrors, "AuctionNotStarted")
              .withArgs(0n);

            await expect(custodyVaultFacet.connect(bidder).bid(1000n, bidAmount))
              .to.be.revertedWithCustomError(fermionErrors, "AuctionNotStarted")
              .withArgs(1000n);
          });

          it("Auction ended", async function () {
            await setNextBlockTimestamp(String(auctionEnd + 1n));

            await expect(custodyVaultFacet.connect(bidder).bid(offerId, bidAmount))
              .to.be.revertedWithCustomError(fermionErrors, "AuctionEnded")
              .withArgs(offerId, auctionEnd);
          });

          it("Second bid is too low", async function () {
            await mockToken.connect(bidder).approve(fermionProtocolAddress, bidAmount);
            await custodyVaultFacet.connect(bidder).bid(offerId, bidAmount);

            const newBidder = wallets[8];
            const minimalBid = (bidAmount * (10000n + MINIMAL_BID_INCREMENT)) / 10000n;
            const newBidAmount = minimalBid - 1n;

            await expect(custodyVaultFacet.connect(newBidder).bid(offerId, newBidAmount))
              .to.be.revertedWithCustomError(fermionErrors, "InvalidBid")
              .withArgs(offerId, minimalBid, newBidAmount);
          });

          it("Funds related errors", async function () {
            // ERC20 offer - insufficient allowance
            await mockToken.connect(bidder).approve(fermionProtocolAddress, bidAmount - 1n);

            await expect(custodyVaultFacet.connect(bidder).bid(offerId, bidAmount))
              .to.be.revertedWithCustomError(mockToken, "ERC20InsufficientAllowance")
              .withArgs(fermionProtocolAddress, bidAmount - 1n, bidAmount);

            // ERC20 offer - contract sends insufficient funds
            await mockToken.connect(bidder).approve(fermionProtocolAddress, bidAmount);
            await mockToken.setBurnAmount(1);
            await expect(custodyVaultFacet.connect(bidder).bid(offerId, bidAmount))
              .to.be.revertedWithCustomError(fermionErrors, "WrongValueReceived")
              .withArgs(bidAmount, bidAmount - 1n);
            await mockToken.setBurnAmount(0);

            // ERC20 offer - insufficient balance
            const bidderBalance = await mockToken.balanceOf(bidder.address);
            await mockToken.connect(bidder).transfer(wallets[4].address, bidderBalance); // transfer all the tokens to another wallet

            await expect(custodyVaultFacet.connect(bidder).bid(offerId, bidAmount))
              .to.be.revertedWithCustomError(mockToken, "ERC20InsufficientBalance")
              .withArgs(bidder.address, 0n, bidAmount);

            // Send native currency to ERC20 offer
            await expect(
              custodyVaultFacet.connect(bidder).bid(offerId, bidAmount, { value: bidAmount }),
            ).to.be.revertedWithCustomError(fermionErrors, "NativeNotAllowed");
          });
        });
      });

      context("endAuction", function () {
        let auctionEnd: bigint;
        const bidAmount = custodianVaultParameters.liquidationThreshold * tokenCount + 1n; // above liquidation, but below threshold

        beforeEach(async function () {
          await setNextBlockTimestamp(String(offerVaultCreationTimestamp + custodianFee.period + 200n));
          const tx = await custodyVaultFacet.releaseFundsFromVault(offerId);
          await expect(tx).to.emit(custodyVaultFacet, "AuctionStarted");
          const timestamp = BigInt((await tx.getBlock()).timestamp);
          auctionEnd = timestamp + custodianVaultParameters.partialAuctionDuration;

          await mockToken.connect(bidder).approve(fermionProtocolAddress, bidAmount);
        });

        context("Above the liquidation threshold", function () {
          beforeEach(async function () {
            await custodyVaultFacet.connect(bidder).bid(offerId, bidAmount);
          });

          it("End the auction", async function () {
            const [custodianVault] = await custodyVaultFacet.getCustodianVault(offerId);
            const protocolBalance = await mockToken.balanceOf(fermionProtocolAddress);

            await setNextBlockTimestamp(String(auctionEnd + 1n));
            const tx = await custodyVaultFacet.endAuction(offerId);

            await expect(tx)
              .to.emit(custodyVaultFacet, "AuctionFinished")
              .withArgs(
                offerId,
                bidder.address,
                custodianVaultParameters.newFractionsPerAuction * tokenCount,
                bidAmount,
              );
            await expect(tx)
              .to.emit(custodyVaultFacet, "VaultBalanceUpdated")
              .withArgs(offerId, custodianVault.amount + bidAmount);
            await expect(tx).to.not.emit(wrapper, "AuctionStarted"); // buyout auction should not start

            expect(await mockToken.balanceOf(fermionProtocolAddress)).to.equal(protocolBalance);
            const expectedCustodianVault = {
              amount: custodianVault.amount + bidAmount,
              period: custodianVault.period,
            };
            expect(await custodyVaultFacet.getCustodianVault(offerId)).to.eql([
              Object.values(expectedCustodianVault),
              tokenCount,
            ]); // placing a bid does not change the vault

            const expectedAuctionDetails = {
              endTime: 0n,
              availableFractions: 0n,
              maxBid: 0n,
              bidderId: 0n,
            };
            expect(await custodyVaultFacet.getPartialAuctionDetails(offerId)).to.eql(
              Object.values(expectedAuctionDetails),
            );
          });

          it("After it's finished, a new auction can be started next period", async function () {
            await setNextBlockTimestamp(String(auctionEnd + 1n));
            await custodyVaultFacet.endAuction(offerId);

            await setNextBlockTimestamp(String(offerVaultCreationTimestamp + 2n * custodianFee.period + 200n));
            const tx = await custodyVaultFacet.releaseFundsFromVault(offerId);
            await expect(tx).to.emit(custodyVaultFacet, "AuctionStarted"); // new partial auction started

            const timestamp = BigInt((await tx.getBlock()).timestamp);
            auctionEnd = timestamp + custodianVaultParameters.partialAuctionDuration;

            const expectedAuctionDetails = {
              endTime: auctionEnd,
              availableFractions: custodianVaultParameters.newFractionsPerAuction * tokenCount,
              maxBid: 0n,
              bidderId: 0n,
            };
            expect(await custodyVaultFacet.getPartialAuctionDetails(offerId)).to.eql(
              Object.values(expectedAuctionDetails),
            );
          });

          it("remove items from vault while auction is ongoing", async function () {
            const usedFractions = 0n;
            const buyoutAuctionBid = auctionParameters.exitPrice + parseEther("0.1");
            const partialAuctionBid = bidAmount;
            await mockToken.mint(bidder.address, buyoutAuctionBid * 3n);
            await mockToken.connect(bidder).approve(await wrapper.getAddress(), buyoutAuctionBid * 3n);
            await wrapper.connect(bidder).bid(exchange.tokenId, buyoutAuctionBid, usedFractions);
            await wrapper.connect(bidder).bid(BigInt(exchange.tokenId) + 1n, buyoutAuctionBid, usedFractions);
            await wrapper.connect(bidder).bid(BigInt(exchange.tokenId) + 2n, buyoutAuctionBid, usedFractions);

            await setNextBlockTimestamp(String(auctionEnd + 1n));
            const tx = await custodyVaultFacet.endAuction(offerId);

            await expect(tx)
              .to.emit(custodyVaultFacet, "AuctionFinished")
              .withArgs(
                offerId,
                bidder.address,
                custodianVaultParameters.newFractionsPerAuction * tokenCount,
                partialAuctionBid,
              );
            await expect(tx).to.not.emit(custodyVaultFacet, "VaultBalanceUpdated");
            await expect(tx)
              .to.emit(custodyVaultFacet, "AvailableFundsIncreased")
              .withArgs(custodianId, mockTokenAddress, partialAuctionBid);
            await expect(tx).to.not.emit(wrapper, "AuctionStarted"); // buyout auction should not start
          });
        });

        it("The amount below the liquidation threshold starts the buyout auction", async function () {
          const bidAmount = 1n;
          await custodyVaultFacet.connect(bidder).bid(offerId, bidAmount);

          const [custodianVault] = await custodyVaultFacet.getCustodianVault(offerId);
          const protocolBalance = await mockToken.balanceOf(fermionProtocolAddress);

          await setNextBlockTimestamp(String(auctionEnd + 1n));
          const tx = await custodyVaultFacet.endAuction(offerId);
          const timestamp = BigInt((await tx.getBlock()).timestamp);
          const buyoutAuctionEnd = timestamp + auctionParameters.duration;

          // partial auction
          await expect(tx)
            .to.emit(custodyVaultFacet, "AuctionFinished")
            .withArgs(offerId, bidder.address, custodianVaultParameters.newFractionsPerAuction * tokenCount, bidAmount);
          await expect(tx)
            .to.emit(custodyVaultFacet, "VaultBalanceUpdated")
            .withArgs(offerId, custodianVault.amount + bidAmount); // event representing the end of the partial auction
          await expect(tx).to.emit(custodyVaultFacet, "VaultBalanceUpdated").withArgs(offerId, 0n); // event representing the closing of the offer vault
          // buyout auction
          for (let i = 0n; i < tokenCount; i++) {
            await expect(tx)
              .to.emit(wrapper, "AuctionStarted")
              .withArgs(BigInt(exchange.tokenId) + i, buyoutAuctionEnd, 0);
          }

          expect(await mockToken.balanceOf(fermionProtocolAddress)).to.equal(protocolBalance);
          const expectedCustodianVault = {
            amount: 0n, // should be closed
            period: 0n,
          };
          expect(await custodyVaultFacet.getCustodianVault(offerId)).to.eql([
            Object.values(expectedCustodianVault),
            0n,
          ]);

          const expectedAuctionDetails = {
            endTime: 0n,
            availableFractions: 0n,
            maxBid: 0n,
            bidderId: 0n,
          };
          expect(await custodyVaultFacet.getPartialAuctionDetails(offerId)).to.eql(
            Object.values(expectedAuctionDetails),
          );
        });

        it("Buyout auction starts only for fractionalized item", async function () {
          // recombine one fnft
          const buyoutBidAmount = auctionParameters.exitPrice + 1n;
          await mockToken.mint(bidder.address, buyoutBidAmount);
          await mockToken.connect(bidder).approve(await wrapper.getAddress(), buyoutBidAmount);
          const tx0 = await wrapper.connect(bidder).bid(exchange.tokenId, buyoutBidAmount, 0n);
          const timestamp0 = BigInt((await tx0.getBlock()).timestamp);
          const buyoutAuctionEnd0 = timestamp0 + auctionParameters.duration;
          await setNextBlockTimestamp(String(buyoutAuctionEnd0 + 1n));
          await wrapper.connect(bidder).redeem(exchange.tokenId);

          // fractional auction
          const bidAmount = 1n;
          await custodyVaultFacet.connect(bidder).bid(offerId, bidAmount);

          await setNextBlockTimestamp(String(auctionEnd + 1n));
          const tx = await custodyVaultFacet.endAuction(offerId);
          const timestamp = BigInt((await tx.getBlock()).timestamp);
          const buyoutAuctionEnd = timestamp + auctionParameters.duration;

          // buyout auctions
          // No auction for the first token
          try {
            await expect(tx).to.emit(wrapper, "AuctionStarted").withArgs(exchange.tokenId, buyoutAuctionEnd, 0);
            assert(false, "Should not find the event");
          } catch (error) {
            expect(
              error.message.includes("The specified arguments") &&
                error.message.includes("were not included in any of"),
            ).to.equal(true);
          }

          for (let i = 1n; i < tokenCount; i++) {
            await expect(tx)
              .to.emit(wrapper, "AuctionStarted")
              .withArgs(BigInt(exchange.tokenId) + i, buyoutAuctionEnd, 0);
          }
        });

        context("Revert reasons", function () {
          it("Custody region is paused", async function () {
            await pauseFacet.pause([PausableRegion.CustodyVault]);

            await expect(custodyVaultFacet.endAuction(offerId))
              .to.be.revertedWithCustomError(fermionErrors, "RegionPaused")
              .withArgs(PausableRegion.CustodyVault);
          });

          it("No auction for the vault", async function () {
            // invalid offer id
            await expect(custodyVaultFacet.endAuction(0n))
              .to.be.revertedWithCustomError(fermionErrors, "AuctionNotStarted")
              .withArgs(0n);

            await expect(custodyVaultFacet.endAuction(1000n))
              .to.be.revertedWithCustomError(fermionErrors, "AuctionNotStarted")
              .withArgs(1000n);
          });

          it("Auction not ended", async function () {
            await setNextBlockTimestamp(String(auctionEnd - 1n));

            await expect(custodyVaultFacet.endAuction(offerId))
              .to.be.revertedWithCustomError(fermionErrors, "AuctionOngoing")
              .withArgs(offerId, auctionEnd);
          });
        });
      });
    });
  });

  context("checkOut", function () {
    it("After checkout any vault is closed", async function () {
      await custodyFacet.connect(custodian).checkIn(exchange.tokenId);
      const vaultBalance = parseEther("1.23");
      await mockToken.approve(fermionProtocolAddress, vaultBalance);
      await custodyVaultFacet.topUpCustodianVault(exchange.tokenId, vaultBalance);
      await wrapper.connect(buyer).approve(fermionProtocolAddress, exchange.tokenId);
      await custodyFacet.connect(buyer).requestCheckOut(exchange.tokenId);
      await custodyFacet.clearCheckoutRequest(exchange.tokenId, 0);

      const tx = await custodyFacet.connect(custodian).checkOut(exchange.tokenId);

      // Events
      await expect(tx).to.emit(custodyFacet, "VaultBalanceUpdated").withArgs(exchange.tokenId, 0n);
      await expect(tx)
        .to.emit(fundsFacet, "AvailableFundsIncreased")
        .withArgs(custodianId, mockTokenAddress, vaultBalance);

      // State
      const expectedItemVault = {
        amount: 0n,
        period: 0n,
      };
      const itemCount = 0n;

      expect(await custodyVaultFacet.getCustodianVault(exchange.tokenId)).to.eql([
        Object.values(expectedItemVault),
        itemCount,
      ]);

      expect(await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress)).to.equal(vaultBalance);
    });
  });
});
