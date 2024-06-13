import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import {
  applyPercentage,
  deployFermionProtocolFixture,
  deployMockTokens,
  deriveTokenId,
  verifySellerAssistantRoleClosure,
  setNextBlockTimestamp,
} from "../utils/common";
import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, ZeroAddress, ZeroHash } from "ethers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import {
  EntityRole,
  CheckoutRequestStatus,
  PausableRegion,
  TokenState,
  VerificationStatus,
  WalletRole,
} from "../utils/enums";
import { getBosonProtocolFees } from "../utils/boson-protocol";
import { createBuyerAdvancedOrderClosure } from "../utils/seaport";
import {
  AUCTION_END_BUFFER,
  MINIMAL_BID_INCREMENT,
  DEFAULT_FRACTION_AMOUNT,
  PARTIAL_THRESHOLD_MULTIPLIER,
  LIQUIDATION_THRESHOLD_MULTIPLIER,
  PARTIAL_AUCTION_DURATION_DIVISOR,
  AUCTION_DURATION,
  UNLOCK_THRESHOLD,
  TOP_BID_LOCK_TIME,
} from "../utils/constants";

const { parseEther } = ethers;

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
  let seaportAddress: string;
  let wrapper: Contract, wrapperSelfSale: Contract, wrapperSelfCustody: Contract;
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
  let verifySellerAssistantRole: ReturnType<typeof verifySellerAssistantRoleClosure>;

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
      metadataURI: "https://example.com/offer-metadata.json",
      metadataHash: ZeroHash,
    };

    // Make three offers one for normal sale, one of self sale and one for self custody
    await offerFacet.connect(facilitator).createOffer({ ...fermionOffer, facilitatorId });

    // Mint and wrap some NFTs
    const quantity = 3n;
    await offerFacet.mintAndWrapNFTs(offerId, quantity); // offerId = 1; exchangeId = 2

    // Unwrap some NFTs - normal sale and sale with self-custody
    buyer = wallets[6];

    await mockToken.approve(fermionProtocolAddress, quantity * sellerDeposit);
    for (let i = 0n; i < quantity; i++) {
      const exchangeId = i + 1n;
      const createBuyerAdvancedOrder = createBuyerAdvancedOrderClosure(wallets, seaportAddress, mockToken, offerFacet);
      const { buyerAdvancedOrder, tokenId, encumberedAmount } = await createBuyerAdvancedOrder(
        buyer,
        offerId,
        exchangeId,
        exchange.tokenId,
      );
      await offerFacet.unwrapNFT(tokenId, buyerAdvancedOrder);

      // Submit verdicts
      await verificationFacet.connect(verifier).submitVerdict(tokenId, VerificationStatus.Verified);

      if (i == 0n) {
        const { percentage: bosonProtocolFeePercentage } = getBosonProtocolFees();
        exchange.tokenId = tokenId;
        exchange.custodianId = custodianId;
        exchange.price = encumberedAmount - applyPercentage(encumberedAmount, bosonProtocolFeePercentage);
      }
    }

    const wrapperAddress = await offerFacet.predictFermionWrapperAddress(exchange.tokenId);
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

    verifySellerAssistantRole = verifySellerAssistantRoleClosure(custodyFacet, wallets, entityFacet, fermionErrors);
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
              .withArgs(DEFAULT_FRACTION_AMOUNT, Object.values(buyoutAuctionDefaultParameters));
            await expect(tx2).to.emit(wrapper, "Fractionalised").withArgs(exchange.tokenId, DEFAULT_FRACTION_AMOUNT);
            await expect(tx2)
              .to.emit(wrapper, "AdditionalFractionsMinted")
              .withArgs(fractionsToIssue, DEFAULT_FRACTION_AMOUNT + fractionsToIssue);

            // offer vault is created
            const expectedOfferVault = {
              amount: 0n,
              period: offerVaultCreationTimestamp,
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
              .withArgs(DEFAULT_FRACTION_AMOUNT, Object.values(buyoutAuctionDefaultParameters));
            await expect(tx2).to.emit(wrapper, "Fractionalised").withArgs(exchange.tokenId, DEFAULT_FRACTION_AMOUNT);
            await expect(tx2)
              .to.emit(wrapper, "AdditionalFractionsMinted")
              .withArgs(fractionsToIssue, DEFAULT_FRACTION_AMOUNT + fractionsToIssue);

            // offer vault is created
            const expectedOfferVault = {
              amount: 0n,
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
              .withArgs(DEFAULT_FRACTION_AMOUNT, Object.values(buyoutAuctionDefaultParameters));
            await expect(tx2).to.emit(wrapper, "Fractionalised").withArgs(exchange.tokenId, DEFAULT_FRACTION_AMOUNT);
            await expect(tx2)
              .to.emit(wrapper, "AdditionalFractionsMinted")
              .withArgs(fractionsToIssue, DEFAULT_FRACTION_AMOUNT + fractionsToIssue);

            // offer vault is created
            const expectedOfferVault = {
              amount: 0n,
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
            const tx = await wrapper
              .connect(buyer)
              .mintFractions(tokenId, 1, fractionsPerToken, auctionParameters, custodianVaultParameters);
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
            await expect(tx2).to.emit(wrapper, "Fractionalised").withArgs(exchange.tokenId, fractionsPerToken);
            await expect(tx2)
              .to.emit(wrapper, "AdditionalFractionsMinted")
              .withArgs(fractionsToIssue, 2n * fractionsPerToken + fractionsToIssue);

            // offer vault remains the same, just number of items is increased
            const expectedOfferVault = {
              amount: 0n,
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
            await expect(tx2).to.emit(wrapper, "Fractionalised").withArgs(exchange.tokenId, fractionsPerToken);
            await expect(tx2)
              .to.emit(wrapper, "AdditionalFractionsMinted")
              .withArgs(fractionsToIssue, 2n * fractionsPerToken + fractionsToIssue);

            // offer vault remains the same, just number of items is increased
            const expectedOfferVault = {
              amount: 0n,
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

          it("Some periods can be covered, but not all, some funds remain in vault,  item vault balance is not multiple of custodian fee", async function () {
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
            await expect(tx2).to.emit(wrapper, "Fractionalised").withArgs(exchange.tokenId, fractionsPerToken);
            await expect(tx2)
              .to.emit(wrapper, "AdditionalFractionsMinted")
              .withArgs(fractionsToIssue, 2n * fractionsPerToken + fractionsToIssue);

            // offer vault remains the same, just number of items is increased
            const expectedOfferVault = {
              amount: 0n,
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

            const offerVaultCreationTimestamp = BigInt((await tx.getBlock()).timestamp);

            await expect(custodyVaultFacet.releaseFundsFromVault(exchange.tokenId))
              .to.be.revertedWithCustomError(fermionErrors, "InactiveVault")
              .withArgs(exchange.tokenId);

            await expect(custodyVaultFacet.releaseFundsFromVault(offerId))
              .to.be.revertedWithCustomError(fermionErrors, "PeriodNotOver")
              .withArgs(offerId, offerVaultCreationTimestamp + custodianFee.period);
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
            const tx = await wrapper
              .connect(buyer)
              .mintFractions(tokenId, 1, fractionsPerToken, auctionParameters, custodianVaultParameters);
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
    const itemCount = 1n;
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
          const tx = await wrapper
            .connect(buyer)
            .mintFractions(exchange.tokenId, 1, fractionsPerToken, auctionParameters, custodianVaultParameters);
          offerVaultCreationTimestamp = BigInt((await tx.getBlock()).timestamp);

          // offer vault is created
          const expectedOfferVault = {
            amount: 0n,
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
          expect(await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress)).to.equal(0n);
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

          it("Not enough to cover past fee", async function () {
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
              );
            offerVaultCreationTimestamp = BigInt((await tx.getBlock()).timestamp);
            await expect(tx)
              .to.emit(custodyVaultFacet, "AvailableFundsIncreased")
              .withArgs(custodianId, mockTokenAddress, custodianFee.amount * paymentPeriods);
            await expect(tx).to.emit(custodyVaultFacet, "VaultBalanceUpdated").withArgs(exchange.tokenId, 0n);

            // offer vault is created
            const expectedOfferVault = {
              amount: 0n,
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
            expect(await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress)).to.equal(
              paymentPeriods * custodianFee.amount,
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
          const tx = await wrapper
            .connect(buyer)
            .mintFractions(
              BigInt(exchange.tokenId),
              tokenCount,
              fractionsPerToken,
              auctionParameters,
              custodianVaultParameters,
            );
          offerVaultCreationTimestamp = BigInt((await tx.getBlock()).timestamp);

          // offer vault is created
          const expectedOfferVault = {
            amount: 0n,
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
          expect(await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress)).to.equal(0n);
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

          it("Not enough to cover past fee", async function () {
            await setNextBlockTimestamp(
              String(itemVaultCreationTimestamp + (paymentPeriods + 5n) * custodianFee.period + 100n),
            );

            const tx = await wrapper
              .connect(buyer)
              .mintFractions(
                BigInt(exchange.tokenId),
                tokenCount,
                fractionsPerToken,
                auctionParameters,
                custodianVaultParameters,
              );
            offerVaultCreationTimestamp = BigInt((await tx.getBlock()).timestamp);
            await expect(tx)
              .to.emit(custodyVaultFacet, "AvailableFundsIncreased")
              .withArgs(custodianId, mockTokenAddress, custodianFee.amount * paymentPeriods);
            await expect(tx).to.emit(custodyVaultFacet, "VaultBalanceUpdated").withArgs(exchange.tokenId, 0n);
            await expect(tx).to.emit(custodyVaultFacet, "VaultBalanceUpdated").withArgs(tokenId2, 0n);
            await expect(tx).to.emit(custodyVaultFacet, "VaultBalanceUpdated").withArgs(tokenId3, 0n);

            // offer vault is created
            const expectedOfferVault = {
              amount: 0n,
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
              paymentPeriods * custodianFee.amount * tokenCount,
            );
          });
        });
      });
    });

    context("addItemToCustodianOfferVault", function () {
      const offerVaultInitialAmount = (custodianFee.amount * 11n) / 10n; // pre pay for 5 periods

      beforeEach(async function () {
        const tokenId = BigInt(exchange.tokenId) + 2n;
        await custodyFacet.connect(custodian).checkIn(tokenId);
        const tx = await wrapper
          .connect(buyer)
          .mintFractions(tokenId, 1, fractionsPerToken, auctionParameters, custodianVaultParameters);
        offerVaultCreationTimestamp = BigInt((await tx.getBlock()).timestamp);

        await mockToken.approve(fermionProtocolAddress, offerVaultInitialAmount);
        await custodyVaultFacet.topUpCustodianVault(offerId, offerVaultInitialAmount);
      });

      context("Single item", function () {
        it("Item vault is empty", async function () {
          await wrapper.connect(buyer).mintFractions(exchange.tokenId, 1);

          // offer vault remains, just number of items is increased
          const expectedOfferVault = {
            amount: offerVaultInitialAmount,
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
          expect(await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress)).to.equal(0n);
        });

        context("Item vault is not empty", function () {
          const paymentPeriods = 5n;
          const topUpAmount = custodianFee.amount * paymentPeriods; // pre pay for 5 periods

          beforeEach(async function () {
            await mockToken.approve(fermionProtocolAddress, topUpAmount);
            await custodyVaultFacet.topUpCustodianVault(exchange.tokenId, topUpAmount);
          });

          it("Enough to cover past fee", async function () {
            const transferTime = itemVaultCreationTimestamp + (custodianFee.period * 3n) / 2n;
            const custodianPayoff = (custodianFee.amount * 3n) / 2n;
            const vaultTransfer = custodianFee.amount * paymentPeriods - custodianPayoff;
            await setNextBlockTimestamp(String(transferTime));

            const tx = await wrapper.connect(buyer).mintFractions(exchange.tokenId, 1);

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
            expect(await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress)).to.equal(custodianPayoff);
          });

          it("Not enough to cover past fee", async function () {
            await setNextBlockTimestamp(
              String(itemVaultCreationTimestamp + paymentPeriods * custodianFee.period + 100n),
            );

            const tx = await wrapper.connect(buyer).mintFractions(exchange.tokenId, 1);

            await expect(tx)
              .to.emit(custodyVaultFacet, "AvailableFundsIncreased")
              .withArgs(custodianId, mockTokenAddress, custodianFee.amount * paymentPeriods);
            await expect(tx).to.emit(custodyVaultFacet, "VaultBalanceUpdated").withArgs(exchange.tokenId, 0n);

            // offer vault remains, just number of items is increased
            const expectedOfferVault = {
              amount: offerVaultInitialAmount,
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
              paymentPeriods * custodianFee.amount,
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
          await wrapper.connect(buyer).mintFractions(exchange.tokenId, tokenCount);

          //  offer vault remains, just number of items is increased
          const expectedOfferVault = {
            amount: offerVaultInitialAmount,
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
          expect(await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress)).to.equal(0n);
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
            const transferTime = itemVaultCreationTimestamp + (custodianFee.period * 7n) / 2n;
            const item1Payoff =
              ((transferTime - itemVaultCreationTimestamp) * custodianFee.amount) / custodianFee.period;
            const item2Payoff =
              ((transferTime - itemVaultCreationTimestamp2) * custodianFee.amount) / custodianFee.period;
            const custodianPayoff = item1Payoff + item2Payoff;
            const vaultTransfer = custodianFee.amount * paymentPeriods * tokenCount - custodianPayoff;
            await setNextBlockTimestamp(String(transferTime));

            const tx = await wrapper.connect(buyer).mintFractions(exchange.tokenId, tokenCount);

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
            expect(await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress)).to.equal(custodianPayoff);
          });

          it("Not enough to cover past fee", async function () {
            await setNextBlockTimestamp(
              String(itemVaultCreationTimestamp + (paymentPeriods + 5n) * custodianFee.period + 100n),
            );

            const tx = await wrapper.connect(buyer).mintFractions(exchange.tokenId, tokenCount);

            await expect(tx)
              .to.emit(custodyVaultFacet, "AvailableFundsIncreased")
              .withArgs(custodianId, mockTokenAddress, custodianFee.amount * paymentPeriods);
            await expect(tx).to.emit(custodyVaultFacet, "VaultBalanceUpdated").withArgs(exchange.tokenId, 0n);
            await expect(tx).to.emit(custodyVaultFacet, "VaultBalanceUpdated").withArgs(tokenId2, 0n);

            // offer vault remains, just number of items is increased
            const expectedOfferVault = {
              amount: offerVaultInitialAmount,
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
              paymentPeriods * custodianFee.amount * tokenCount,
            );
          });
        });
      });
    });

    context("removeItemFromCustodianOfferVault", function () {
      const tokenCount = 3n;
      let bidder: HardhatEthersSigner;

      beforeEach(async function () {
        const tokenId2 = BigInt(exchange.tokenId) + 1n;
        const tokenId3 = BigInt(exchange.tokenId) + 2n;
        await custodyFacet.connect(custodian).checkIn(tokenId2);
        await custodyFacet.connect(custodian).checkIn(tokenId3);

        const tx = await wrapper
          .connect(buyer)
          .mintFractions(exchange.tokenId, tokenCount, fractionsPerToken, auctionParameters, custodianVaultParameters);
        offerVaultCreationTimestamp = BigInt((await tx.getBlock()).timestamp);

        // buyoutAuction for the first item
        bidder = wallets[7];
        const bidAmount = auctionParameters.exitPrice + parseEther("0.1");
        const usedFractions = 0;
        await mockToken.mint(bidder.address, parseEther("1000"));
        await mockToken.connect(bidder).approve(await wrapper.getAddress(), bidAmount);
        const tx2 = await wrapper.connect(bidder).bid(exchange.tokenId, bidAmount, usedFractions);
        const blockTimeStamp = (await tx2.getBlock()).timestamp;
        const auctionEnd = BigInt(blockTimeStamp) + auctionParameters.duration;
        await setNextBlockTimestamp(String(auctionEnd + 1n));
      });

      context("Not last offer item", function () {
        it("Offer vault is empty", async function () {
          const tx = await wrapper.connect(bidder).redeem(exchange.tokenId);
          const transferTime = BigInt((await tx.getBlock()).timestamp);

          // offer vault remains, just number of items is increased
          const expectedOfferVault = {
            amount: 0n,
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
            period: transferTime,
          };
          itemCount = 1n;

          expect(await custodyVaultFacet.getCustodianVault(exchange.tokenId)).to.eql([
            Object.values(expectedItemVault),
            itemCount,
          ]);
          expect(await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress)).to.equal(0n);
        });

        context("Offer vault is not empty", function () {
          const paymentPeriods = 5n;
          const vaultAmount = custodianFee.amount * paymentPeriods * tokenCount; // pre pay for 5 periods

          beforeEach(async function () {
            await mockToken.approve(fermionProtocolAddress, vaultAmount);
            await custodyVaultFacet.topUpCustodianVault(offerId, vaultAmount);
          });

          it("Enough to cover past fee", async function () {
            const transferTime = offerVaultCreationTimestamp + (custodianFee.period * 3n) / 2n;
            const custodianPayoff = (custodianFee.amount * 3n) / 2n;
            await setNextBlockTimestamp(String(transferTime));

            const tx = await wrapper.connect(bidder).redeem(exchange.tokenId);

            await expect(tx)
              .to.emit(custodyVaultFacet, "AvailableFundsIncreased")
              .withArgs(custodianId, mockTokenAddress, custodianPayoff);
            await expect(tx)
              .to.emit(custodyVaultFacet, "VaultBalanceUpdated")
              .withArgs(offerId, vaultAmount - vaultAmount / tokenCount);

            // offer vault remains, just number of items is increased and amount increases
            const expectedOfferVault = {
              amount: vaultAmount - vaultAmount / tokenCount,
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
              period: transferTime,
            };
            itemCount = 1n;

            expect(await custodyVaultFacet.getCustodianVault(exchange.tokenId)).to.eql([
              Object.values(expectedItemVault),
              itemCount,
            ]);
            expect(await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress)).to.equal(custodianPayoff);
          });

          it("Not enough to cover past fee", async function () {
            const transferTime = offerVaultCreationTimestamp + paymentPeriods * custodianFee.period + 100n;

            await setNextBlockTimestamp(String(transferTime));

            const tx = await wrapper.connect(bidder).redeem(exchange.tokenId);

            await expect(tx)
              .to.emit(custodyVaultFacet, "AvailableFundsIncreased")
              .withArgs(custodianId, mockTokenAddress, custodianFee.amount * paymentPeriods);
            await expect(tx)
              .to.emit(custodyVaultFacet, "VaultBalanceUpdated")
              .withArgs(offerId, vaultAmount - custodianFee.amount * paymentPeriods);

            // offer vault remains, just number of items is increased
            const expectedOfferVault = {
              amount: vaultAmount - custodianFee.amount * paymentPeriods,
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
              period: transferTime,
            };
            itemCount = 1n;

            expect(await custodyVaultFacet.getCustodianVault(exchange.tokenId)).to.eql([
              Object.values(expectedItemVault),
              itemCount,
            ]);
            expect(await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress)).to.equal(
              paymentPeriods * custodianFee.amount,
            );
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

          const bidAmount = auctionParameters.exitPrice + parseEther("0.1");
          const usedFractions = 0;
          await mockToken.mint(bidder.address, parseEther("1000"));
          await mockToken.connect(bidder).approve(await wrapper.getAddress(), 2n * bidAmount);
          await wrapper.connect(bidder).bid(tokenId2, bidAmount, usedFractions);
          const tx2 = await wrapper.connect(bidder).bid(tokenId3, bidAmount, usedFractions);

          const blockTimeStamp = (await tx2.getBlock()).timestamp;
          const auctionEnd = BigInt(blockTimeStamp) + auctionParameters.duration;
          await setNextBlockTimestamp(String(auctionEnd + 1n));
        });

        it("Offer vault is empty", async function () {
          await wrapper.connect(bidder).redeem(tokenId2);
          await wrapper.connect(bidder).redeem(tokenId3);
          const tx = await wrapper.connect(bidder).redeem(exchange.tokenId);
          const transferTime = BigInt((await tx.getBlock()).timestamp);

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
            period: transferTime,
          };
          itemCount = 1n;

          expect(await custodyVaultFacet.getCustodianVault(exchange.tokenId)).to.eql([
            Object.values(expectedItemVault),
            itemCount,
          ]);
          expect(await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress)).to.equal(0n);
        });

        context("Offer vault is not empty", function () {
          const paymentPeriods = 5n;
          const vaultAmount = custodianFee.amount * paymentPeriods * tokenCount; // pre pay for 5 periods

          beforeEach(async function () {
            await mockToken.approve(fermionProtocolAddress, vaultAmount);
            await custodyVaultFacet.topUpCustodianVault(offerId, vaultAmount);
          });

          it("Enough to cover past fee", async function () {
            await wrapper.connect(bidder).redeem(tokenId2);
            await wrapper.connect(bidder).redeem(tokenId3);
            const transferTime = offerVaultCreationTimestamp + (custodianFee.period * 3n) / 2n;
            const custodianPayoff = (custodianFee.amount * 3n) / 2n;
            await setNextBlockTimestamp(String(transferTime));
            const custodianAvailableFunds = await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress);
            const tx = await wrapper.connect(bidder).redeem(exchange.tokenId);

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
              period: transferTime,
            };
            itemCount = 1n;

            expect(await custodyVaultFacet.getCustodianVault(exchange.tokenId)).to.eql([
              Object.values(expectedItemVault),
              itemCount,
            ]);
            expect(await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress)).to.equal(
              custodianAvailableFunds + custodianPayoff,
            );
          });

          it("Not enough to cover past fee", async function () {
            let transferTime = offerVaultCreationTimestamp + paymentPeriods * custodianFee.period + 100n;

            await setNextBlockTimestamp(String(transferTime));
            await wrapper.connect(bidder).redeem(tokenId2);
            await wrapper.connect(bidder).redeem(tokenId3);

            const custodianAvailableFunds = await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress);
            const tx = await wrapper.connect(bidder).redeem(exchange.tokenId);
            transferTime = BigInt((await tx.getBlock()).timestamp);

            const remainderInVault = vaultAmount - (2n * vaultAmount) / 3n;
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
              period: transferTime,
            };
            itemCount = 1n;

            expect(await custodyVaultFacet.getCustodianVault(exchange.tokenId)).to.eql([
              Object.values(expectedItemVault),
              itemCount,
            ]);
            expect(await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress)).to.equal(
              custodianAvailableFunds + remainderInVault,
            );
          });
        });
      });
    });

    context.skip("releaseFundsFromVault", function () {
      const topUpAmount = custodianFee.amount * 5n; // pre pay for 5 periods

      beforeEach(async function () {
        vaultCreationTimestamp = BigInt((await tx.getBlock()).timestamp);

        await mockToken.approve(fermionProtocolAddress, topUpAmount);
        await custodyVaultFacet.topUpCustodianVault(offerId, topUpAmount);
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
              .withArgs(DEFAULT_FRACTION_AMOUNT, Object.values(buyoutAuctionDefaultParameters));
            await expect(tx2).to.emit(wrapper, "Fractionalised").withArgs(exchange.tokenId, DEFAULT_FRACTION_AMOUNT);
            await expect(tx2)
              .to.emit(wrapper, "AdditionalFractionsMinted")
              .withArgs(fractionsToIssue, DEFAULT_FRACTION_AMOUNT + fractionsToIssue);

            // offer vault is created
            const expectedOfferVault = {
              amount: 0n,
              period: offerVaultCreationTimestamp,
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
              .withArgs(DEFAULT_FRACTION_AMOUNT, Object.values(buyoutAuctionDefaultParameters));
            await expect(tx2).to.emit(wrapper, "Fractionalised").withArgs(exchange.tokenId, DEFAULT_FRACTION_AMOUNT);
            await expect(tx2)
              .to.emit(wrapper, "AdditionalFractionsMinted")
              .withArgs(fractionsToIssue, DEFAULT_FRACTION_AMOUNT + fractionsToIssue);

            // offer vault is created
            const expectedOfferVault = {
              amount: 0n,
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
              .withArgs(DEFAULT_FRACTION_AMOUNT, Object.values(buyoutAuctionDefaultParameters));
            await expect(tx2).to.emit(wrapper, "Fractionalised").withArgs(exchange.tokenId, DEFAULT_FRACTION_AMOUNT);
            await expect(tx2)
              .to.emit(wrapper, "AdditionalFractionsMinted")
              .withArgs(fractionsToIssue, DEFAULT_FRACTION_AMOUNT + fractionsToIssue);

            // offer vault is created
            const expectedOfferVault = {
              amount: 0n,
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
            const tx = await wrapper
              .connect(buyer)
              .mintFractions(
                BigInt(exchange.tokenId) + 1n,
                1,
                fractionsPerToken,
                auctionParameters,
                custodianVaultParameters,
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
            await expect(tx2).to.emit(wrapper, "Fractionalised").withArgs(exchange.tokenId, fractionsPerToken);
            await expect(tx2)
              .to.emit(wrapper, "AdditionalFractionsMinted")
              .withArgs(fractionsToIssue, 2n * fractionsPerToken + fractionsToIssue);

            // offer vault remains the same, just number of items is increased
            const expectedOfferVault = {
              amount: 0n,
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
            await expect(tx2).to.emit(wrapper, "Fractionalised").withArgs(exchange.tokenId, fractionsPerToken);
            await expect(tx2)
              .to.emit(wrapper, "AdditionalFractionsMinted")
              .withArgs(fractionsToIssue, 2n * fractionsPerToken + fractionsToIssue);

            // offer vault remains the same, just number of items is increased
            const expectedOfferVault = {
              amount: 0n,
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

          it("Some periods can be covered, but not all, some funds remain in vault,  item vault balance is not multiple of custodian fee", async function () {
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
            await expect(tx2).to.emit(wrapper, "Fractionalised").withArgs(exchange.tokenId, fractionsPerToken);
            await expect(tx2)
              .to.emit(wrapper, "AdditionalFractionsMinted")
              .withArgs(fractionsToIssue, 2n * fractionsPerToken + fractionsToIssue);

            // offer vault remains the same, just number of items is increased
            const expectedOfferVault = {
              amount: 0n,
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

            const offerVaultCreationTimestamp = BigInt((await tx.getBlock()).timestamp);

            await expect(custodyVaultFacet.releaseFundsFromVault(exchange.tokenId))
              .to.be.revertedWithCustomError(fermionErrors, "InactiveVault")
              .withArgs(exchange.tokenId);

            await expect(custodyVaultFacet.releaseFundsFromVault(offerId))
              .to.be.revertedWithCustomError(fermionErrors, "PeriodNotOver")
              .withArgs(offerId, offerVaultCreationTimestamp + custodianFee.period);
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

            const tx = await wrapper
              .connect(buyer)
              .mintFractions(
                BigInt(exchange.tokenId) + 1n,
                1,
                fractionsPerToken,
                auctionParameters,
                custodianVaultParameters,
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

  context.skip("checkOut", function () {
    it("Custodian can check item out", async function () {
      await custodyFacet.connect(custodian).checkIn(exchange.tokenId);
      await wrapper.connect(buyer).approve(fermionProtocolAddress, exchange.tokenId);
      await custodyFacet.connect(buyer).requestCheckOut(exchange.tokenId);
      await custodyFacet.clearCheckoutRequest(exchange.tokenId);

      const tx = await custodyFacet.connect(custodian).checkOut(exchange.tokenId);

      // Events
      // Fermion
      await expect(tx).to.emit(custodyFacet, "CheckedOut").withArgs(exchange.custodianId, exchange.tokenId);

      // Wrapper
      await expect(tx).to.emit(wrapper, "TokenStateChange").withArgs(exchange.tokenId, TokenState.CheckedOut);
      await expect(tx).to.emit(wrapper, "Transfer").withArgs(fermionProtocolAddress, ZeroAddress, exchange.tokenId);

      // State
      // Wrapper
      expect(await wrapper.tokenState(exchange.tokenId)).to.equal(TokenState.CheckedOut);
      await expect(wrapper.ownerOf(exchange.tokenId))
        .to.be.revertedWithCustomError(wrapper, "ERC721NonexistentToken")
        .withArgs(exchange.tokenId);
    });

    it("Self custody", async function () {
      await custodyFacet.checkIn(exchangeSelfCustody.tokenId);
      await wrapperSelfCustody.connect(buyer).approve(fermionProtocolAddress, exchangeSelfCustody.tokenId);
      await custodyFacet.connect(buyer).requestCheckOut(exchangeSelfCustody.tokenId);
      await custodyFacet.clearCheckoutRequest(exchangeSelfCustody.tokenId);

      const tx = await custodyFacet.checkOut(exchangeSelfCustody.tokenId);

      // Events
      // Fermion
      await expect(tx).to.emit(custodyFacet, "CheckedOut").withArgs(sellerId, exchangeSelfCustody.tokenId);

      // Wrapper
      await expect(tx)
        .to.emit(wrapperSelfCustody, "TokenStateChange")
        .withArgs(exchangeSelfCustody.tokenId, TokenState.CheckedOut);
      await expect(tx)
        .to.emit(wrapperSelfCustody, "Transfer")
        .withArgs(fermionProtocolAddress, ZeroAddress, exchangeSelfCustody.tokenId);

      // State
      // Wrapper
      expect(await wrapperSelfCustody.tokenState(exchangeSelfCustody.tokenId)).to.equal(TokenState.CheckedOut);
      await expect(wrapperSelfCustody.ownerOf(exchangeSelfCustody.tokenId))
        .to.be.revertedWithCustomError(wrapperSelfCustody, "ERC721NonexistentToken")
        .withArgs(exchangeSelfCustody.tokenId);
    });

    context("Revert reasons", function () {
      it("Custody region is paused", async function () {
        await pauseFacet.pause([PausableRegion.Custody]);

        await expect(custodyFacet.checkOut(exchange.tokenId))
          .to.be.revertedWithCustomError(fermionErrors, "RegionPaused")
          .withArgs(PausableRegion.Custody);
      });

      it("Caller is not the custodian's assistant", async function () {
        await custodyFacet.connect(custodian).checkIn(exchange.tokenId);
        await wrapper.connect(buyer).approve(fermionProtocolAddress, exchange.tokenId);
        await custodyFacet.connect(buyer).requestCheckOut(exchange.tokenId);
        await custodyFacet.clearCheckoutRequest(exchange.tokenId);

        const wallet = wallets[9];

        // completely random wallet
        await expect(custodyFacet.connect(wallet).checkOut(exchange.tokenId))
          .to.be.revertedWithCustomError(fermionErrors, "WalletHasNoRole")
          .withArgs(custodianId, wallet.address, EntityRole.Custodian, WalletRole.Assistant);

        // seller
        await expect(custodyFacet.checkOut(exchange.tokenId))
          .to.be.revertedWithCustomError(fermionErrors, "WalletHasNoRole")
          .withArgs(custodianId, defaultSigner.address, EntityRole.Custodian, WalletRole.Assistant);

        // an entity-wide Treasury or admin wallet (not Assistant)
        await entityFacet
          .connect(custodian)
          .addEntityWallets(custodianId, [wallet], [[]], [[[WalletRole.Treasury, WalletRole.Admin]]]);
        await expect(custodyFacet.connect(wallet).checkOut(exchange.tokenId))
          .to.be.revertedWithCustomError(fermionErrors, "WalletHasNoRole")
          .withArgs(custodianId, wallet.address, EntityRole.Custodian, WalletRole.Assistant);

        // a Custodian specific Treasury or Admin wallet
        const wallet2 = wallets[10];
        await entityFacet
          .connect(custodian)
          .addEntityWallets(
            custodianId,
            [wallet2],
            [[EntityRole.Custodian]],
            [[[WalletRole.Treasury, WalletRole.Admin]]],
          );
        await expect(custodyFacet.connect(wallet2).checkOut(exchange.tokenId))
          .to.be.revertedWithCustomError(fermionErrors, "WalletHasNoRole")
          .withArgs(custodianId, wallet2.address, EntityRole.Custodian, WalletRole.Assistant);

        // an Assistant of another role than Custodian
        await entityFacet.connect(custodian).updateEntity(custodianId, [EntityRole.Verifier, EntityRole.Custodian], "");
        await entityFacet
          .connect(custodian)
          .addEntityWallets(custodianId, [wallet2], [[EntityRole.Verifier]], [[[WalletRole.Assistant]]]);
        await expect(custodyFacet.connect(wallet2).checkOut(exchange.tokenId))
          .to.be.revertedWithCustomError(fermionErrors, "WalletHasNoRole")
          .withArgs(custodianId, wallet2.address, EntityRole.Custodian, WalletRole.Assistant);
      });

      context("Invalid state", function () {
        const tokenId = deriveTokenId("3", "4"); // token that was wrapped but not unwrapped yet

        it("Cannot check item out twice", async function () {
          await custodyFacet.connect(custodian).checkIn(exchange.tokenId);
          await wrapper.connect(buyer).approve(fermionProtocolAddress, exchange.tokenId);
          await custodyFacet.connect(buyer).requestCheckOut(exchange.tokenId);
          await custodyFacet.clearCheckoutRequest(exchange.tokenId);

          await custodyFacet.connect(custodian).checkOut(exchange.tokenId);

          await expect(custodyFacet.connect(custodian).checkOut(exchange.tokenId))
            .to.be.revertedWithCustomError(fermionErrors, "InvalidCheckoutRequestStatus")
            .withArgs(exchange.tokenId, CheckoutRequestStatus.CheckOutRequestCleared, CheckoutRequestStatus.CheckedOut);
        });

        it("Cannot check item out before it's unwrapped", async function () {
          await expect(custodyFacet.checkOut(tokenId))
            .to.be.revertedWithCustomError(fermionErrors, "InvalidCheckoutRequestStatus")
            .withArgs(tokenId, CheckoutRequestStatus.CheckOutRequestCleared, CheckoutRequestStatus.None);
        });

        it("Cannot check item out if not verified or rejected", async function () {
          await offerFacet.unwrapNFTToSelf(tokenId);

          // Unwrapped but not verified
          await expect(custodyFacet.checkOut(tokenId))
            .to.be.revertedWithCustomError(fermionErrors, "InvalidCheckoutRequestStatus")
            .withArgs(tokenId, CheckoutRequestStatus.CheckOutRequestCleared, CheckoutRequestStatus.None);

          await verificationFacet.submitVerdict(tokenId, VerificationStatus.Rejected);

          // Unwrapped and rejected
          await expect(custodyFacet.checkOut(tokenId))
            .to.be.revertedWithCustomError(fermionErrors, "InvalidCheckoutRequestStatus")
            .withArgs(tokenId, CheckoutRequestStatus.CheckOutRequestCleared, CheckoutRequestStatus.None);
        });

        it("Cannot check item out if not checked in", async function () {
          // Verified but not checked in
          await expect(custodyFacet.connect(custodian).checkOut(exchange.tokenId))
            .to.be.revertedWithCustomError(fermionErrors, "InvalidCheckoutRequestStatus")
            .withArgs(exchange.tokenId, CheckoutRequestStatus.CheckOutRequestCleared, CheckoutRequestStatus.None);
        });

        it("Cannot check item out if checkout not requested", async function () {
          await custodyFacet.connect(custodian).checkIn(exchange.tokenId);

          // Checked in but checkout not requested
          await expect(custodyFacet.connect(custodian).checkOut(exchange.tokenId))
            .to.be.revertedWithCustomError(fermionErrors, "InvalidCheckoutRequestStatus")
            .withArgs(exchange.tokenId, CheckoutRequestStatus.CheckOutRequestCleared, CheckoutRequestStatus.CheckedIn);
        });

        it("Cannot check item out if checkout request not cleared", async function () {
          await custodyFacet.connect(custodian).checkIn(exchange.tokenId);
          await wrapper.connect(buyer).approve(fermionProtocolAddress, exchange.tokenId);

          await custodyFacet.connect(buyer).requestCheckOut(exchange.tokenId);

          // Checkout request but not cleared
          await expect(custodyFacet.connect(custodian).checkOut(exchange.tokenId))
            .to.be.revertedWithCustomError(fermionErrors, "InvalidCheckoutRequestStatus")
            .withArgs(
              exchange.tokenId,
              CheckoutRequestStatus.CheckOutRequestCleared,
              CheckoutRequestStatus.CheckOutRequested,
            );
        });
      });
    });
  });
});
