import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import {
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
  const exchange = { tokenId: "", custodianId: "" };
  const exchangeSelfSale = { tokenId: "", custodianId: "" };
  const exchangeSelfCustody = { tokenId: "", custodianId: "" };
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
    const offerId = "1"; // buyer != seller, custodian != seller
    const offerIdSelfSale = "2"; // buyer = seller, custodian != seller
    const offerIdSelfCustody = "3"; // buyer != seller, custodian = seller
    await offerFacet.connect(facilitator).createOffer({ ...fermionOffer, facilitatorId });
    await offerFacet.createOffer({ ...fermionOffer, sellerDeposit: "0" });
    await offerFacet.createOffer({ ...fermionOffer, verifierId: "1", custodianId: "1", verifierFee: "0" });

    // Mint and wrap some NFTs
    const quantity = "1";
    await offerFacet.mintAndWrapNFTs(offerIdSelfSale, quantity); // offerId = 2; exchangeId = 1
    await offerFacet.mintAndWrapNFTs(offerId, quantity); // offerId = 1; exchangeId = 2
    await offerFacet.mintAndWrapNFTs(offerIdSelfCustody, "2"); // offerId = 3; exchangeId = 3
    const exchangeIdSelf = "1";
    const exchangeId = "2";
    const exchangeIdSelfCustody = "3";

    // Unwrap some NFTs - normal sale and sale with self-custody
    buyer = wallets[6];

    await mockToken.approve(fermionProtocolAddress, 2n * sellerDeposit);
    const createBuyerAdvancedOrder = createBuyerAdvancedOrderClosure(wallets, seaportAddress, mockToken, offerFacet);
    const { buyerAdvancedOrder, tokenId } = await createBuyerAdvancedOrder(buyer, offerId, exchangeId);
    await offerFacet.unwrapNFT(tokenId, buyerAdvancedOrder);

    const { buyerAdvancedOrder: buyerAdvancedOrderSelfCustody, tokenId: tokenIdSelfCustody } =
      await createBuyerAdvancedOrder(buyer, offerIdSelfCustody, exchangeIdSelfCustody);
    await offerFacet.unwrapNFT(tokenIdSelfCustody, buyerAdvancedOrderSelfCustody);

    // unwrap to self
    const tokenIdSelf = deriveTokenId(offerIdSelfSale, exchangeIdSelf).toString();
    const { percentage: bosonProtocolFeePercentage } = getBosonProtocolFees();
    const minimalPrice = (10000n * verifierFee) / (10000n - BigInt(bosonProtocolFeePercentage));
    await mockToken.approve(fermionProtocolAddress, minimalPrice);
    await offerFacet.unwrapNFTToSelf(tokenIdSelf);

    exchange.tokenId = tokenId;
    exchange.custodianId = custodianId;

    // Self sale
    exchangeSelfSale.tokenId = tokenIdSelf;
    exchangeSelfSale.custodianId = custodianId;

    // Self verification
    exchangeSelfCustody.tokenId = tokenIdSelfCustody;
    exchangeSelfCustody.custodianId = sellerId;

    // Submit verdicts
    await verificationFacet.connect(verifier).submitVerdict(tokenId, VerificationStatus.Verified);
    await verificationFacet.connect(verifier).submitVerdict(tokenIdSelf, VerificationStatus.Verified);
    await verificationFacet.submitVerdict(tokenIdSelfCustody, VerificationStatus.Verified);

    const wrapperAddress = await offerFacet.predictFermionWrapperAddress(exchange.tokenId);
    wrapper = await ethers.getContractAt("FermionFNFT", wrapperAddress);

    const wrapperAddressSelfSale = await offerFacet.predictFermionWrapperAddress(exchangeSelfSale.tokenId);
    wrapperSelfSale = await ethers.getContractAt("FermionFNFT", wrapperAddressSelfSale);

    const wrapperAddressSelfCustody = await offerFacet.predictFermionWrapperAddress(exchangeSelfCustody.tokenId);
    wrapperSelfCustody = await ethers.getContractAt("FermionFNFT", wrapperAddressSelfCustody);
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

      expect(await custodyVaultFacet.getCustodianVault(exchange.tokenId)).to.eql(Object.values(expectedCustodianVault));
    });
  });

  context("topUpCustodianVault", function () {
    const topUpAmount = parseEther("0.01");
    let vaultCreationTimestamp: bigint;

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

      expect(await custodyVaultFacet.getCustodianVault(exchange.tokenId)).to.eql(Object.values(expectedCustodianVault));
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

      expect(await custodyVaultFacet.getCustodianVault(exchange.tokenId)).to.eql(Object.values(expectedCustodianVault));
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
        await expect(custodyVaultFacet.topUpCustodianVault(exchangeSelfSale.tokenId, topUpAmount))
          .to.be.revertedWithCustomError(fermionErrors, "InactiveVault")
          .withArgs(exchangeSelfSale.tokenId);

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

  context.only("Single F-NFT owner (non-fractionalized)", function () {
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

        expect(await custodyVaultFacet.getCustodianVault(exchange.tokenId)).to.eql(
          Object.values(expectedCustodianVault),
        );
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

        expect(await custodyVaultFacet.getCustodianVault(exchange.tokenId)).to.eql(
          Object.values(expectedCustodianVault2),
        );
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

        expect(await custodyVaultFacet.getCustodianVault(exchange.tokenId)).to.eql(
          Object.values(expectedCustodianVault),
        );
        expect(await mockToken.balanceOf(fermionProtocolAddress)).to.equal(protocolBalance); // releasing should not change protocol balance
        expect(await fundsFacet.getAvailableFunds(custodianId, mockTokenAddress)).to.equal(
          custodianAvailableFunds + payoutPeriods * custodianFee.amount,
        );
      });

      context("Insufficient balance start partial auction", function () {});

      context("Revert reasons", function () {
        it("Custody region is paused", async function () {
          await pauseFacet.pause([PausableRegion.CustodyVault]);

          await expect(custodyVaultFacet.releaseFundsFromVault(exchange.tokenId))
            .to.be.revertedWithCustomError(fermionErrors, "RegionPaused")
            .withArgs(PausableRegion.CustodyVault);
        });

        it("Vault does not exist/is inactive", async function () {
          // existing token id but not checked in
          await expect(custodyVaultFacet.releaseFundsFromVault(exchangeSelfSale.tokenId))
            .to.be.revertedWithCustomError(fermionErrors, "InactiveVault")
            .withArgs(exchangeSelfSale.tokenId);

          // invalid token id
          await expect(custodyVaultFacet.releaseFundsFromVault(0n))
            .to.be.revertedWithCustomError(fermionErrors, "InactiveVault")
            .withArgs(0n);

          await expect(custodyVaultFacet.releaseFundsFromVault(1000n))
            .to.be.revertedWithCustomError(fermionErrors, "InactiveVault")
            .withArgs(1000n);
        });

        it("Period not over yer", async function () {
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
