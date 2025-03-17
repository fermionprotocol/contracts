import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import {
  applyPercentage,
  deployFermionProtocolFixture,
  deployMockTokens,
  deriveTokenId,
  calculateMinimalPrice,
  getBlockTimestampFromTransaction,
  setNextBlockTimestamp,
} from "../utils/common";
import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, ZeroAddress, ZeroHash, parseEther, id, MaxUint256, toBeHex, keccak256 } from "ethers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { EntityRole, PausableRegion, VerificationStatus, AccountRole, WrapType } from "../utils/enums";
import { getBosonProtocolFees } from "../utils/boson-protocol";
import { createBuyerAdvancedOrderClosure } from "../utils/seaport";
import fermionConfig from "./../../fermion.config";
import { setStorageAt } from "@nomicfoundation/hardhat-network-helpers";

const abiCoder = new ethers.AbiCoder();

describe("Funds", function () {
  let offerFacet: Contract,
    entityFacet: Contract,
    verificationFacet: Contract,
    fundsFacet: Contract,
    pauseFacet: Contract,
    configFacet: Contract,
    custodyFacet: Contract,
    royaltiesFacet: Contract;
  let mockToken1: Contract, mockToken2: Contract, mockToken3: Contract;
  let mockToken1Address: string, mockToken2Address: string, mockToken3Address: string;
  let mockPhygital1: Contract, mockPhygital2: Contract, mockPhygital3: Contract;
  let mockPhygital1Address: string, mockPhygital2Address: string, mockPhygital3Address: string;
  let fermionErrors: Contract;
  let fermionProtocolAddress: string;
  let wallets: HardhatEthersSigner[];
  let defaultSigner: HardhatEthersSigner;
  let verifier: HardhatEthersSigner;
  let buyer: HardhatEthersSigner;
  let feeCollector: HardhatEthersSigner;
  let royaltyRecipient: HardhatEthersSigner;
  let seaportAddress: string;
  const sellerId = "1";
  const verifierId = "2";
  const royaltyRecipientId = "3";
  const verifierFee = parseEther("0.1");
  const sellerDeposit = parseEther("0.05");
  const custodianFee = {
    amount: 0n,
    period: 30n * 24n * 60n * 60n, // 30 days
  };
  const { protocolFeePercentage: bosonProtocolFeePercentage } = getBosonProtocolFees();
  let minimalPrice = calculateMinimalPrice(
    verifierFee,
    0, // facilitatorFee 0
    bosonProtocolFeePercentage,
    fermionConfig.protocolParameters.protocolFeePercentage,
  );
  const customItemPrice = 1;
  let selfSaleData = abiCoder.encode(["uint256", "uint256"], [minimalPrice, customItemPrice]);

  async function setupFundsTest() {
    // Create three entities
    // Seller, Verifier, Custodian combined
    // Verifier and custodian
    const metadataURI = "https://example.com/seller-metadata.json";
    verifier = wallets[2];
    royaltyRecipient = wallets[3];
    await entityFacet.createEntity([EntityRole.Seller, EntityRole.Verifier, EntityRole.Custodian], metadataURI); // "1"
    await entityFacet.connect(verifier).createEntity([EntityRole.Verifier, EntityRole.Custodian], metadataURI); // "2"
    await entityFacet.connect(royaltyRecipient).createEntity([EntityRole.RoyaltyRecipient], metadataURI); // "3"
    await entityFacet.addRoyaltyRecipients(sellerId, [royaltyRecipientId]);

    [mockToken1, mockToken2, mockToken3, mockPhygital1, mockPhygital2, mockPhygital3] = (
      await deployMockTokens(["ERC20", "ERC20", "ERC20", "ERC721", "ERC721", "ERC721"])
    ).map((contract) => contract.connect(defaultSigner));
    await mockToken1.mint(defaultSigner.address, parseEther("1000"));
    await mockToken2.mint(defaultSigner.address, parseEther("1000"));
    await mockToken3.mint(defaultSigner.address, parseEther("1000"));
    mockToken1Address = await mockToken1.getAddress();
    mockToken2Address = await mockToken2.getAddress();
    mockToken3Address = await mockToken3.getAddress();
    mockPhygital1Address = await mockPhygital1.getAddress();
    mockPhygital2Address = await mockPhygital2.getAddress();
    mockPhygital3Address = await mockPhygital3.getAddress();

    feeCollector = wallets[8];
    const accessController = await ethers.getContractAt("AccessController", fermionProtocolAddress);
    await accessController.grantRole(id("FEE_COLLECTOR"), feeCollector.address);

    await offerFacet.addSupportedToken(mockToken1Address);

    // Create offer without phygital
    let offerId = 1;
    const quantity = "1";
    const fermionOffer = {
      sellerId,
      sellerDeposit,
      verifierId,
      verifierFee,
      custodianId: verifierId,
      custodianFee,
      facilitatorId: sellerId,
      facilitatorFeePercent: "0",
      exchangeToken: mockToken1Address,
      withPhygital: false,
      metadataURI: "https://example.com/offer-metadata.json",
      metadataHash: ZeroHash,
      royaltyInfo: { recipients: [], bps: [] },
    };

    await offerFacet.createOffer(fermionOffer);
    await offerFacet.mintAndWrapNFTs(offerId, quantity);

    // Create 2 offers with phygitals
    for (let i = 0; i < 2; i++) {
      await offerFacet.createOffer({ ...fermionOffer, verifierFee: 0, withPhygital: true });
      await offerFacet.mintAndWrapNFTs(++offerId, quantity);
    }

    minimalPrice = calculateMinimalPrice(
      verifierFee,
      0, // facilitatorFee 0
      bosonProtocolFeePercentage,
      fermionConfig.protocolParameters.protocolFeePercentage,
    );
    selfSaleData = abiCoder.encode(["uint256", "uint256"], [minimalPrice, customItemPrice]);
  }

  before(async function () {
    ({
      diamondAddress: fermionProtocolAddress,
      facets: {
        EntityFacet: entityFacet,
        OfferFacet: offerFacet,
        VerificationFacet: verificationFacet,
        FundsFacet: fundsFacet,
        PauseFacet: pauseFacet,
        ConfigFacet: configFacet,
        CustodyFacet: custodyFacet,
        RoyaltiesFacet: royaltiesFacet,
      },
      fermionErrors,
      wallets,
      defaultSigner,
      seaportAddress,
    } = await loadFixture(deployFermionProtocolFixture));

    await loadFixture(setupFundsTest);
  });

  afterEach(async function () {
    await loadFixture(setupFundsTest);
  });

  context("depositFunds", function () {
    const amount = parseEther("10");

    it("Anyone can top up entity's funds with ERC20 token", async function () {
      const wallet = wallets[9]; // completely random wallet

      const entityAvailableFunds = await fundsFacet.getAvailableFunds(sellerId, mockToken1Address);

      // Deposits funds
      await mockToken1.mint(wallet.address, amount);
      await mockToken1.connect(wallet).approve(fermionProtocolAddress, amount);
      const tx = await fundsFacet.connect(wallet).depositFunds(sellerId, mockToken1Address, amount);

      // Events
      await expect(tx).to.emit(fundsFacet, "AvailableFundsIncreased").withArgs(sellerId, mockToken1Address, amount);

      // State
      expect(await fundsFacet.getTokenList(sellerId)).to.eql([mockToken1Address]);
      expect(await fundsFacet.getAvailableFunds(sellerId, mockToken1Address)).to.equal(entityAvailableFunds + amount);
    });

    it("Anyone can top up entity's funds with native token", async function () {
      const wallet = wallets[9]; // completely random wallet

      const entityAvailableFunds = await fundsFacet.getAvailableFunds(sellerId, ZeroAddress);

      // Deposits funds
      const tx = await fundsFacet.connect(wallet).depositFunds(sellerId, ZeroAddress, amount, { value: amount });

      // Events
      await expect(tx).to.emit(fundsFacet, "AvailableFundsIncreased").withArgs(sellerId, ZeroAddress, amount);

      // State
      expect(await fundsFacet.getTokenList(sellerId)).to.eql([ZeroAddress]);
      expect(await fundsFacet.getAvailableFunds(sellerId, ZeroAddress)).to.equal(entityAvailableFunds + amount);
    });

    it("Adding the same token twice", async function () {
      const entityAvailableFundsNative = await fundsFacet.getAvailableFunds(sellerId, ZeroAddress);
      const entityAvailableFundsMockToken1 = await fundsFacet.getAvailableFunds(sellerId, mockToken1Address);

      await mockToken1.connect(defaultSigner).approve(fermionProtocolAddress, 2n * amount);

      // Deposits funds #1
      await fundsFacet.depositFunds(sellerId, mockToken1Address, amount);
      expect(await fundsFacet.getTokenList(sellerId)).to.eql([mockToken1Address]);
      expect(await fundsFacet.getAvailableFunds(sellerId, mockToken1Address)).to.equal(
        entityAvailableFundsMockToken1 + amount,
      );

      // Deposits funds #2
      await fundsFacet.depositFunds(sellerId, ZeroAddress, amount, { value: amount });
      expect(await fundsFacet.getTokenList(sellerId)).to.eql([mockToken1Address, ZeroAddress]);
      expect(await fundsFacet.getAvailableFunds(sellerId, ZeroAddress)).to.equal(entityAvailableFundsNative + amount);

      // Deposits funds #3
      await fundsFacet.depositFunds(sellerId, mockToken1Address, amount);
      expect(await fundsFacet.getTokenList(sellerId)).to.eql([mockToken1Address, ZeroAddress]); // token list should not change
      expect(await fundsFacet.getAvailableFunds(sellerId, mockToken1Address)).to.equal(
        entityAvailableFundsMockToken1 + 2n * amount,
      );
    });

    it("Fermion fractions can be deposited to protocol", async function () {
      const offerId = 1n;
      const exchangeId = 1n;
      const fnftTokenId = deriveTokenId(offerId, exchangeId);

      await mockToken1.approve(fermionProtocolAddress, sellerDeposit);
      await fundsFacet.depositFunds(sellerId, mockToken1Address, sellerDeposit);
      await mockToken1.approve(fermionProtocolAddress, 2n * verifierFee);
      await offerFacet.unwrapNFT(fnftTokenId, WrapType.SELF_SALE, selfSaleData);
      await verificationFacet.connect(verifier).submitVerdict(fnftTokenId, VerificationStatus.Verified);
      await custodyFacet.connect(verifier).checkIn(fnftTokenId);

      const fermionFnftAddress = await offerFacet.predictFermionFNFTAddress(offerId);

      const entityAvailableFunds = await fundsFacet.getAvailableFunds(sellerId, fermionFnftAddress);
      const fermionFnft = await ethers.getContractAt("FermionFNFT", fermionFnftAddress, defaultSigner);

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
        newFractionsPerAuction: amount * 5n,
      };

      const additionalDeposit = custodianFee.amount * 2n;
      await mockToken1.approve(fermionFnft, additionalDeposit);
      await fermionFnft.mintFractions(
        fnftTokenId,
        1,
        amount,
        auctionParameters,
        custodianVaultParameters,
        additionalDeposit,
        ZeroAddress,
      );

      // Deposits funds
      const fermionFractionsERC20Address = await fermionFnft.getERC20FractionsClone();
      const fermionFractionsERC20 = await ethers.getContractAt("FermionFractionsERC20", fermionFractionsERC20Address);
      await fermionFractionsERC20.connect(defaultSigner).approve(fermionProtocolAddress, amount);
      const tx = await fundsFacet.depositFunds(sellerId, fermionFractionsERC20Address, amount);

      // Events
      await expect(tx)
        .to.emit(fundsFacet, "AvailableFundsIncreased")
        .withArgs(sellerId, fermionFractionsERC20Address, amount);

      // State
      expect(await fundsFacet.getTokenList(sellerId)).to.eql([mockToken1Address, fermionFractionsERC20Address]);
      expect(await fundsFacet.getAvailableFunds(sellerId, fermionFractionsERC20Address)).to.equal(
        entityAvailableFunds + amount,
      );
    });

    context("Revert reasons", function () {
      it("Funds region is paused", async function () {
        await pauseFacet.pause([PausableRegion.Funds]);

        await expect(fundsFacet.depositFunds(sellerId, ZeroAddress, amount, { value: amount }))
          .to.be.revertedWithCustomError(fermionErrors, "RegionPaused")
          .withArgs(PausableRegion.Funds);
      });

      it("Zero amount is not allowed", async function () {
        const amount = "0";
        await expect(
          fundsFacet.depositFunds(sellerId, ZeroAddress, amount, { value: amount }),
        ).to.be.revertedWithCustomError(fermionErrors, "ZeroDepositNotAllowed");
      });

      it("Funds related errors", async function () {
        // ERC20 offer - insufficient allowance
        await mockToken1.approve(fermionProtocolAddress, amount - 1n);

        await expect(fundsFacet.depositFunds(sellerId, mockToken1Address, amount))
          .to.be.revertedWithCustomError(mockToken1, "ERC20InsufficientAllowance")
          .withArgs(fermionProtocolAddress, amount - 1n, amount);

        // ERC20 offer - contract sends insufficient funds
        await mockToken1.approve(fermionProtocolAddress, amount);
        await mockToken1.setBurnAmount(1);
        await expect(fundsFacet.depositFunds(sellerId, mockToken1Address, amount))
          .to.be.revertedWithCustomError(fermionErrors, "WrongValueReceived")
          .withArgs(amount, amount - 1n);
        await mockToken1.setBurnAmount(0);

        // ERC20 offer - insufficient balance
        const sellerBalance = await mockToken1.balanceOf(defaultSigner.address);
        await mockToken1.transfer(wallets[4].address, sellerBalance); // transfer all the tokens to another wallet

        await expect(fundsFacet.depositFunds(sellerId, mockToken1Address, amount))
          .to.be.revertedWithCustomError(mockToken1, "ERC20InsufficientBalance")
          .withArgs(defaultSigner.address, 0n, amount);

        // Native currency offer - insufficient funds
        await expect(fundsFacet.depositFunds(sellerId, ZeroAddress, amount, { value: amount - 1n }))
          .to.be.revertedWithCustomError(fermionErrors, "WrongValueReceived")
          .withArgs(amount, amount - 1n);

        // Native currency offer - too much sent
        await expect(fundsFacet.depositFunds(sellerId, ZeroAddress, amount, { value: amount + 1n }))
          .to.be.revertedWithCustomError(fermionErrors, "WrongValueReceived")
          .withArgs(amount, amount + 1n);

        // Send native currency to ERC20 offer
        await expect(
          fundsFacet.depositFunds(sellerId, mockToken1Address, amount, { value: amount }),
        ).to.be.revertedWithCustomError(fermionErrors, "NativeNotAllowed");
      });

      it("ERC721 deposit is not allowed", async function () {
        const [mockToken] = await deployMockTokens(["ERC721"]);
        const tokenId = 1n;
        await mockToken.mint(defaultSigner.address, tokenId, 1);

        await expect(fundsFacet.depositFunds(sellerId, await mockToken.getAddress(), tokenId))
          .to.be.revertedWithCustomError(fermionErrors, "ERC721CheckFailed")
          .withArgs(await mockToken.getAddress(), false);
      });

      it("Token contract reverts", async function () {
        const [mockToken] = await deployMockTokens(["ERC721"]);
        const tokenId = 1n;
        await mockToken.mint(defaultSigner.address, tokenId, 1);

        await mockToken.setRevertReason(1); // 1=revert with custom error
        await expect(
          fundsFacet.depositFunds(sellerId, await mockToken.getAddress(), tokenId),
        ).to.be.revertedWithCustomError(mockToken, "CustomError");

        await mockToken.setRevertReason(2); // 2=error string
        await expect(fundsFacet.depositFunds(sellerId, await mockToken.getAddress(), tokenId)).to.be.revertedWith(
          "Error string",
        );

        await mockToken.setRevertReason(3); // 3=arbitrary bytes
        await expect(fundsFacet.depositFunds(sellerId, await mockToken.getAddress(), tokenId)).to.be.reverted;

        await mockToken.setRevertReason(4); // 4=divide by zero
        await expect(fundsFacet.depositFunds(sellerId, await mockToken.getAddress(), tokenId)).to.be.revertedWithPanic(
          "0x12",
        );

        await mockToken.setRevertReason(5); // 4=out of bounds
        await expect(fundsFacet.depositFunds(sellerId, await mockToken.getAddress(), tokenId)).to.be.revertedWithPanic(
          "0x32",
        );
      });

      it("Token contract returns unexpected data", async function () {
        const [mockToken] = await deployMockTokens(["ERC721"]);
        const tokenId = 1n;
        await mockToken.mint(defaultSigner.address, tokenId, 1);

        await mockToken.setRevertReason(6); // 6=return too short

        await expect(fundsFacet.depositFunds(sellerId, await mockToken.getAddress(), tokenId))
          .to.be.revertedWithCustomError(fermionErrors, "UnexpectedDataReturned")
          .withArgs("0x00");

        await mockToken.setRevertReason(7); // 7=return too long

        await expect(fundsFacet.depositFunds(sellerId, await mockToken.getAddress(), tokenId))
          .to.be.revertedWithCustomError(fermionErrors, "UnexpectedDataReturned")
          .withArgs("0x000000000000000000000000000000000000000000000000000000000000000100");

        await mockToken.setRevertReason(8); // 8=true with some other data

        await expect(fundsFacet.depositFunds(sellerId, await mockToken.getAddress(), tokenId))
          .to.be.revertedWithCustomError(fermionErrors, "UnexpectedDataReturned")
          .withArgs("0x1626ba7e000000000000000abcde000000000000000000000000000000000001");
      });
    });
  });

  context("withdrawFunds", function () {
    const amountNative = parseEther("10");
    const amountMockToken = parseEther("12");

    beforeEach(async function () {
      await fundsFacet.depositFunds(sellerId, ZeroAddress, amountNative, { value: amountNative });
      await mockToken1.connect(defaultSigner).approve(fermionProtocolAddress, amountMockToken);
      await fundsFacet.depositFunds(sellerId, mockToken1Address, amountMockToken);
    });

    it("Entity-wide assistant can withdraw the funds to entity wide treasury", async function () {
      const treasury = wallets[4];
      const assistant = wallets[5];

      await entityFacet.addEntityAccounts(
        sellerId,
        [assistant, treasury],
        [[], []],
        [[[AccountRole.Assistant]], [[AccountRole.Treasury]]],
      );

      const entityAvailableFunds = await fundsFacet.getAvailableFunds(sellerId, mockToken1Address);
      const treasuryBalance = await mockToken1.balanceOf(treasury.address);

      // Withdraw funds
      const withdrawAmount = amountMockToken / 2n;
      const tx = await fundsFacet
        .connect(assistant)
        .withdrawFunds(sellerId, treasury, [mockToken1Address], [withdrawAmount]);

      // Events
      await expect(tx)
        .to.emit(fundsFacet, "FundsWithdrawn")
        .withArgs(sellerId, treasury, mockToken1Address, withdrawAmount);

      // State
      expect(await fundsFacet.getAvailableFunds(sellerId, mockToken1Address)).to.equal(
        entityAvailableFunds - withdrawAmount,
      );
      expect(await mockToken1.balanceOf(treasury.address)).to.equal(treasuryBalance + withdrawAmount);
    });

    it("Entity admin can withdraw the funds to itself", async function () {
      const entityAvailableFunds = await fundsFacet.getAvailableFunds(sellerId, ZeroAddress);
      const adminBalance = await ethers.provider.getBalance(defaultSigner.address);

      // Withdraw funds
      const withdrawAmount = amountNative / 2n;
      const tx = await fundsFacet.withdrawFunds(sellerId, defaultSigner.address, [ZeroAddress], [withdrawAmount], {
        gasPrice: 0,
      });

      // Events
      await expect(tx)
        .to.emit(fundsFacet, "FundsWithdrawn")
        .withArgs(sellerId, defaultSigner.address, ZeroAddress, withdrawAmount);

      // State
      expect(await fundsFacet.getAvailableFunds(sellerId, ZeroAddress)).to.equal(entityAvailableFunds - withdrawAmount);
      expect(await ethers.provider.getBalance(defaultSigner.address)).to.equal(adminBalance + withdrawAmount);
    });

    it("Withdraw all", async function () {
      const entityAvailableFundsNative = await fundsFacet.getAvailableFunds(sellerId, ZeroAddress);
      const entityAvailableFundsMockToken1 = await fundsFacet.getAvailableFunds(sellerId, mockToken1Address);
      const adminBalanceNative = await ethers.provider.getBalance(defaultSigner.address);
      const adminBalanceMockToken1 = await mockToken1.balanceOf(defaultSigner.address);

      // Withdraw funds
      const tx = await fundsFacet.withdrawFunds(sellerId, defaultSigner.address, [], [], { gasPrice: 0 });

      // Events
      await expect(tx)
        .to.emit(fundsFacet, "FundsWithdrawn")
        .withArgs(sellerId, defaultSigner.address, ZeroAddress, amountNative);
      await expect(tx)
        .to.emit(fundsFacet, "FundsWithdrawn")
        .withArgs(sellerId, defaultSigner.address, mockToken1Address, amountMockToken);

      // State
      expect(await fundsFacet.getAvailableFunds(sellerId, ZeroAddress)).to.equal(
        entityAvailableFundsNative - amountNative,
      );
      expect(await fundsFacet.getAvailableFunds(sellerId, ZeroAddress)).to.equal(
        entityAvailableFundsMockToken1 - amountMockToken,
      );
      expect(await ethers.provider.getBalance(defaultSigner.address)).to.equal(adminBalanceNative + amountNative);
      expect(await mockToken1.balanceOf(defaultSigner.address)).to.equal(adminBalanceMockToken1 + amountMockToken);
    });

    it("Token list is updated correctly", async function () {
      // add more tokens
      await mockToken2.connect(defaultSigner).approve(fermionProtocolAddress, amountMockToken);
      await mockToken3.connect(defaultSigner).approve(fermionProtocolAddress, amountMockToken);
      await fundsFacet.depositFunds(sellerId, mockToken2Address, amountMockToken);
      await fundsFacet.depositFunds(sellerId, mockToken3Address, amountMockToken);

      expect(await fundsFacet.getTokenList(sellerId)).to.eql([
        ZeroAddress,
        mockToken1Address,
        mockToken2Address,
        mockToken3Address,
      ]);

      // Withdraw funds
      const withdrawAmount = amountMockToken / 2n;
      await fundsFacet.withdrawFunds(sellerId, defaultSigner.address, [mockToken1Address], [withdrawAmount]);

      // Token list should not change
      expect(await fundsFacet.getTokenList(sellerId)).to.eql([
        ZeroAddress,
        mockToken1Address,
        mockToken2Address,
        mockToken3Address,
      ]);

      // Withdraw remaining mocktoken1 - token list should be updated
      await fundsFacet.withdrawFunds(sellerId, defaultSigner.address, [mockToken1Address], [withdrawAmount]);
      expect(await fundsFacet.getTokenList(sellerId)).to.eql([ZeroAddress, mockToken3Address, mockToken2Address]);

      // Withdraw all native - token list should be updated
      await fundsFacet.withdrawFunds(sellerId, defaultSigner.address, [ZeroAddress], [amountNative]);
      expect(await fundsFacet.getTokenList(sellerId)).to.eql([mockToken2Address, mockToken3Address]);
    });

    it("Buyer can withdraw if the item is not verified", async function () {
      const offerId = "1";
      const exchangeId = "1";

      // Unwrap NFT
      buyer = wallets[4];

      const createBuyerAdvancedOrder = createBuyerAdvancedOrderClosure(wallets, seaportAddress, mockToken1, offerFacet);
      const { buyerAdvancedOrder, tokenId, encumberedAmount } = await createBuyerAdvancedOrder(
        buyer,
        offerId,
        exchangeId,
      );
      await mockToken1.approve(fermionProtocolAddress, sellerDeposit);
      await offerFacet.unwrapNFT(tokenId, WrapType.OS_AUCTION, buyerAdvancedOrder);

      // Submit verdicts
      await verificationFacet.connect(verifier).submitVerdict(tokenId, VerificationStatus.Rejected);

      const bosonFeeAmount = applyPercentage(encumberedAmount, bosonProtocolFeePercentage);
      const fermionFeeAmount = applyPercentage(
        encumberedAmount,
        fermionConfig.protocolParameters.protocolFeePercentage,
      );
      const feesSum = fermionFeeAmount + bosonFeeAmount + verifierFee;
      const expectedPayout = encumberedAmount - feesSum + sellerDeposit;

      const buyerBalance = await mockToken1.balanceOf(buyer.address);
      const [buyerEntityId] = await entityFacet["getEntity(address)"](buyer.address);

      await fundsFacet
        .connect(buyer)
        .withdrawFunds(buyerEntityId, buyer.address, [mockToken1Address], [expectedPayout]);

      expect(await mockToken1.balanceOf(buyer.address)).to.equal(buyerBalance + expectedPayout);
    });

    it("Treasury can be a contract wallet", async function () {
      const contractAccountWithReceiveFactory = await ethers.getContractFactory("ContractWalletWithReceive");
      const contractAccountWithReceive = await contractAccountWithReceiveFactory.deploy();
      const contractAccountWithReceiveAddress = await contractAccountWithReceive.getAddress();

      await entityFacet.addEntityAccounts(
        sellerId,
        [contractAccountWithReceiveAddress],
        [[]],
        [[[AccountRole.Treasury]]],
      );

      // contract without receive function
      const tx = await fundsFacet.withdrawFunds(
        sellerId,
        contractAccountWithReceiveAddress,
        [ZeroAddress],
        [amountNative],
      );
      await expect(tx)
        .to.emit(fundsFacet, "FundsWithdrawn")
        .withArgs(sellerId, contractAccountWithReceiveAddress, ZeroAddress, amountNative);
      await expect(tx)
        .to.emit(contractAccountWithReceive, "FundsReceived")
        .withArgs(fermionProtocolAddress, amountNative);
    });

    it("Fermion fractions can be withdrawn", async function () {
      const amount = parseEther("10");
      const offerId = 1n;
      const exchangeId = 1n;
      const fnftTokenId = deriveTokenId(offerId, exchangeId);

      await mockToken1.approve(fermionProtocolAddress, sellerDeposit);
      await fundsFacet.depositFunds(sellerId, mockToken1Address, sellerDeposit);
      await mockToken1.approve(fermionProtocolAddress, 2n * verifierFee);
      await offerFacet.unwrapNFT(fnftTokenId, WrapType.SELF_SALE, selfSaleData);
      await verificationFacet.connect(verifier).submitVerdict(fnftTokenId, VerificationStatus.Verified);
      await custodyFacet.connect(verifier).checkIn(fnftTokenId);

      const fermionFnftAddress = await offerFacet.predictFermionFNFTAddress(offerId);
      const fermionFnft = await ethers.getContractAt("FermionFNFT", fermionFnftAddress, defaultSigner);

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
        newFractionsPerAuction: amount * 5n,
      };

      const additionalDeposit = custodianFee.amount * 2n;
      await mockToken1.approve(fermionFnft, additionalDeposit);
      await fermionFnft.mintFractions(
        fnftTokenId,
        1,
        amount,
        auctionParameters,
        custodianVaultParameters,
        additionalDeposit,
        ZeroAddress,
      );

      // Deposits funds
      const fermionFractionsERC20Address = await fermionFnft.getERC20FractionsClone();
      const fermionFractionsERC20 = await ethers.getContractAt("FermionFractionsERC20", fermionFractionsERC20Address);
      await fermionFractionsERC20.connect(defaultSigner).approve(fermionProtocolAddress, amount);
      await fundsFacet.connect(defaultSigner).depositFunds(sellerId, fermionFractionsERC20Address, amount);
      const entityAvailableFunds = await fundsFacet.getAvailableFunds(sellerId, fermionFractionsERC20Address);
      const adminBalance = await fermionFractionsERC20.balanceOf(defaultSigner.address);

      // Withdraw funds
      const withdrawAmount = amountNative / 2n;
      const tx = await fundsFacet.withdrawFunds(
        sellerId,
        defaultSigner.address,
        [fermionFractionsERC20Address],
        [withdrawAmount],
      );

      // Events
      await expect(tx)
        .to.emit(fundsFacet, "FundsWithdrawn")
        .withArgs(sellerId, defaultSigner.address, fermionFractionsERC20Address, withdrawAmount);

      // State
      expect(await fundsFacet.getAvailableFunds(sellerId, fermionFractionsERC20Address)).to.equal(
        entityAvailableFunds - withdrawAmount,
      );
      expect(await fermionFractionsERC20.balanceOf(defaultSigner.address)).to.equal(adminBalance + withdrawAmount);
    });

    context("Revert reasons", function () {
      it("Funds region is paused", async function () {
        await pauseFacet.pause([PausableRegion.Funds]);

        await expect(fundsFacet.withdrawFunds(sellerId, defaultSigner.address, [], []))
          .to.be.revertedWithCustomError(fermionErrors, "RegionPaused")
          .withArgs(PausableRegion.Funds);
      });

      it("Caller is not entity's assistant", async function () {
        const wallet = wallets[9];

        // completely random wallet
        await expect(fundsFacet.connect(wallet).withdrawFunds(sellerId, defaultSigner.address, [], []))
          .to.be.revertedWithCustomError(fermionErrors, "NotEntityWideRole")
          .withArgs(wallet.address, sellerId, AccountRole.Assistant);

        // seller's assistant (not entity wide)
        await entityFacet.addEntityAccounts(sellerId, [wallet], [[EntityRole.Seller]], [[[AccountRole.Assistant]]]);
        await expect(fundsFacet.connect(wallet).withdrawFunds(sellerId, defaultSigner.address, [], []))
          .to.be.revertedWithCustomError(fermionErrors, "NotEntityWideRole")
          .withArgs(wallet.address, sellerId, AccountRole.Assistant);

        // an entity-wide Treasury or Manager wallet (not Assistant)
        await entityFacet.addEntityAccounts(sellerId, [wallet], [[]], [[[AccountRole.Treasury, AccountRole.Manager]]]);
        await expect(fundsFacet.connect(wallet).withdrawFunds(sellerId, defaultSigner.address, [], []))
          .to.be.revertedWithCustomError(fermionErrors, "NotEntityWideRole")
          .withArgs(wallet.address, sellerId, AccountRole.Assistant);
      });

      it("Treasury is not entity's treasury", async function () {
        const treasury = wallets[9].address;

        // completely random wallet
        await expect(fundsFacet.withdrawFunds(sellerId, treasury, [], []))
          .to.be.revertedWithCustomError(fermionErrors, "NotEntityWideRole")
          .withArgs(treasury, sellerId, AccountRole.Treasury);

        // seller's treasury (not entity wide)
        await entityFacet.addEntityAccounts(sellerId, [treasury], [[EntityRole.Seller]], [[[AccountRole.Treasury]]]);
        await expect(fundsFacet.withdrawFunds(sellerId, treasury, [], []))
          .to.be.revertedWithCustomError(fermionErrors, "NotEntityWideRole")
          .withArgs(treasury, sellerId, AccountRole.Treasury);

        // an entity-wide Assistant or Manager wallet (not Assistant)
        await entityFacet.addEntityAccounts(
          sellerId,
          [treasury],
          [[]],
          [[[AccountRole.Assistant, AccountRole.Manager]]],
        );
        await expect(fundsFacet.withdrawFunds(sellerId, treasury, [], []))
          .to.be.revertedWithCustomError(fermionErrors, "NotEntityWideRole")
          .withArgs(treasury, sellerId, AccountRole.Treasury);
      });

      it("Token list and token amounts length mismatch", async function () {
        await expect(
          fundsFacet.withdrawFunds(sellerId, defaultSigner.address, [ZeroAddress], [amountNative, amountMockToken]),
        )
          .to.be.revertedWithCustomError(fermionErrors, "ArrayLengthMismatch")
          .withArgs(1, 2);

        await expect(fundsFacet.withdrawFunds(sellerId, defaultSigner.address, [ZeroAddress], []))
          .to.be.revertedWithCustomError(fermionErrors, "ArrayLengthMismatch")
          .withArgs(1, 0);
      });

      it("Nothing to withdraw - withdraw all", async function () {
        await fundsFacet.withdrawFunds(sellerId, defaultSigner.address, [], []);

        await expect(fundsFacet.withdrawFunds(sellerId, defaultSigner.address, [], [])).to.be.revertedWithCustomError(
          fermionErrors,
          "NothingToWithdraw",
        );
      });

      it("Nothing to withdraw - requested amount is 0", async function () {
        await expect(
          fundsFacet.withdrawFunds(sellerId, defaultSigner.address, [ZeroAddress], ["0"]),
        ).to.be.revertedWithCustomError(fermionErrors, "NothingToWithdraw");
      });

      it("Withdraw more than available", async function () {
        await expect(fundsFacet.withdrawFunds(sellerId, defaultSigner.address, [ZeroAddress], [amountNative + 1n]))
          .to.be.revertedWithCustomError(fermionErrors, "InsufficientAvailableFunds")
          .withArgs(amountNative, amountNative + 1n);

        await expect(
          fundsFacet.withdrawFunds(sellerId, defaultSigner.address, [mockToken1Address], [amountMockToken + 1n]),
        )
          .to.be.revertedWithCustomError(fermionErrors, "InsufficientAvailableFunds")
          .withArgs(amountMockToken, amountMockToken + 1n);
      });

      it("Treasury reverts", async function () {
        const contractAccountFactory = await ethers.getContractFactory("ContractWallet");
        const contractAccount = await contractAccountFactory.deploy();
        const contractAccountWithReceiveFactory = await ethers.getContractFactory("ContractWalletWithReceive");
        const contractAccountWithReceive = await contractAccountWithReceiveFactory.deploy();

        const contractAccountAddress = await contractAccount.getAddress();
        const contractAccountWithReceiveAddress = await contractAccountWithReceive.getAddress();

        await entityFacet.addEntityAccounts(
          sellerId,
          [contractAccountAddress, contractAccountWithReceiveAddress],
          [[], []],
          [[[AccountRole.Treasury]], [[AccountRole.Treasury]]],
        );

        // contract without receive function
        await expect(fundsFacet.withdrawFunds(sellerId, contractAccountAddress, [ZeroAddress], [amountNative]))
          .to.be.revertedWithCustomError(fermionErrors, "TokenTransferFailed")
          .withArgs(contractAccountAddress, amountNative, "0x");

        // contract with receive function, but reverting
        await contractAccountWithReceive.setAcceptingMoney(false);
        await expect(
          fundsFacet.withdrawFunds(sellerId, contractAccountWithReceiveAddress, [ZeroAddress], [amountNative]),
        )
          .to.be.revertedWithCustomError(fermionErrors, "TokenTransferFailed")
          .withArgs(contractAccountWithReceiveAddress, amountNative, id("NotAcceptingMoney()").slice(0, 10));
      });
    });
  });

  context("Offer with phygitals", function () {
    const offerId = 2n;
    const exchangeId = 2n;
    const fnftTokenId = deriveTokenId(offerId, exchangeId);
    const phygitalTokenId = 10n;
    let wallet: HardhatEthersSigner;
    let phygital: { contractAddress: string; tokenId: bigint };

    before(async function () {
      wallet = wallets[9]; // completely random wallet
      phygital = { contractAddress: mockPhygital1Address, tokenId: phygitalTokenId };
    });

    beforeEach(async function () {
      await mockPhygital1.mint(wallet.address, phygitalTokenId, 1n);
      await mockPhygital1.connect(wallet).approve(fermionProtocolAddress, phygitalTokenId);
    });

    context("depositPhygitals", function () {
      it("Anyone deposit a phygital on seller's behalf", async function () {
        // Deposits phygital
        const tx = await fundsFacet.connect(wallet).depositPhygitals([fnftTokenId], [[phygital]]);

        // Events
        await expect(tx)
          .to.emit(fundsFacet, "ERC721Deposited")
          .withArgs(mockPhygital1Address, phygitalTokenId, wallet.address);

        // State
        expect(await fundsFacet.getPhygitals(fnftTokenId)).to.eql([Object.values(phygital)]);
      });

      it("Deposit multiple phygitals to one offer", async function () {
        // Deposits phygitals
        const phygitalTokenId2 = phygitalTokenId + 1n;
        await mockPhygital1.mint(wallet.address, phygitalTokenId2, 1n);
        await mockPhygital1.connect(wallet).approve(fermionProtocolAddress, phygitalTokenId2);
        const phygital1 = { contractAddress: mockPhygital1Address, tokenId: phygitalTokenId };
        const phygital2 = { contractAddress: mockPhygital1Address, tokenId: phygitalTokenId2 };

        const tx = await fundsFacet.connect(wallet).depositPhygitals([fnftTokenId], [[phygital1, phygital2]]);

        // Events
        await expect(tx)
          .to.emit(fundsFacet, "ERC721Deposited")
          .withArgs(mockPhygital1Address, phygitalTokenId, wallet.address);
        await expect(tx)
          .to.emit(fundsFacet, "ERC721Deposited")
          .withArgs(mockPhygital1Address, phygitalTokenId2, wallet.address);
        await expect(tx)
          .to.emit(fundsFacet, "PhygitalsDeposited")
          .withArgs(fnftTokenId, [Object.values(phygital1), Object.values(phygital2)]);

        // State
        expect(await fundsFacet.getPhygitals(fnftTokenId)).to.eql([Object.values(phygital1), Object.values(phygital2)]);
      });

      it("Deposit multiple phygitals to one offer in steps", async function () {
        // Deposits phygitals
        const phygitalTokenId2 = phygitalTokenId + 1n;
        await mockPhygital1.mint(wallet.address, phygitalTokenId2, 1n);
        await mockPhygital1.connect(wallet).approve(fermionProtocolAddress, phygitalTokenId2);
        const phygital1 = { contractAddress: mockPhygital1Address, tokenId: phygitalTokenId };
        const phygital2 = { contractAddress: mockPhygital1Address, tokenId: phygitalTokenId2 };

        await fundsFacet.connect(wallet).depositPhygitals([fnftTokenId], [[phygital1]]);

        // State
        expect(await fundsFacet.getPhygitals(fnftTokenId)).to.eql([Object.values(phygital1)]);

        const tx = await fundsFacet.connect(wallet).depositPhygitals([fnftTokenId], [[phygital2]]);

        // Events
        await expect(tx)
          .to.emit(fundsFacet, "ERC721Deposited")
          .withArgs(mockPhygital1Address, phygitalTokenId2, wallet.address);
        await expect(tx)
          .to.emit(fundsFacet, "PhygitalsDeposited")
          .withArgs(fnftTokenId, [Object.values(phygital2)]);

        // State
        expect(await fundsFacet.getPhygitals(fnftTokenId)).to.eql([Object.values(phygital1), Object.values(phygital2)]);
      });

      it("Deposit multiple phygitals to one multiple offers", async function () {
        // Deposits phygitals
        const phygitalTokenId2 = 34n;
        const phygitalTokenId3 = 123n;
        await mockPhygital2.mint(wallet.address, phygitalTokenId2, 1n);
        await mockPhygital2.connect(wallet).approve(fermionProtocolAddress, phygitalTokenId2);
        await mockPhygital3.mint(wallet.address, phygitalTokenId3, 1n);
        await mockPhygital3.connect(wallet).approve(fermionProtocolAddress, phygitalTokenId3);
        const phygital1 = { contractAddress: mockPhygital1Address, tokenId: phygitalTokenId };
        const phygital2 = { contractAddress: mockPhygital2Address, tokenId: phygitalTokenId2 };
        const phygital3 = { contractAddress: mockPhygital3Address, tokenId: phygitalTokenId3 };

        const fnftTokenId2 = deriveTokenId(3n, 3n);
        const tx = await fundsFacet
          .connect(wallet)
          .depositPhygitals([fnftTokenId, fnftTokenId2], [[phygital1, phygital2], [phygital3]]);

        // Events
        await expect(tx)
          .to.emit(fundsFacet, "ERC721Deposited")
          .withArgs(mockPhygital1Address, phygitalTokenId, wallet.address);
        await expect(tx)
          .to.emit(fundsFacet, "ERC721Deposited")
          .withArgs(mockPhygital2Address, phygitalTokenId2, wallet.address);
        await expect(tx)
          .to.emit(fundsFacet, "ERC721Deposited")
          .withArgs(mockPhygital3Address, phygitalTokenId3, wallet.address);
        await expect(tx)
          .to.emit(fundsFacet, "PhygitalsDeposited")
          .withArgs(fnftTokenId, [Object.values(phygital1), Object.values(phygital2)]);
        await expect(tx)
          .to.emit(fundsFacet, "PhygitalsDeposited")
          .withArgs(fnftTokenId2, [Object.values(phygital3)]);

        // State
        expect(await fundsFacet.getPhygitals(fnftTokenId)).to.eql([Object.values(phygital1), Object.values(phygital2)]);
        expect(await fundsFacet.getPhygitals(fnftTokenId2)).to.eql([Object.values(phygital3)]);
      });

      it("Withdrawn token can be deposited again", async function () {
        // Deposits phygital
        await fundsFacet.connect(wallet).depositPhygitals([fnftTokenId], [[phygital]]);
        await fundsFacet["withdrawPhygitals(uint256[],(address,uint256)[][])"]([fnftTokenId], [[phygital]]);
        expect(await fundsFacet.getPhygitals(fnftTokenId)).to.eql([]);

        await mockPhygital1.approve(fermionProtocolAddress, phygitalTokenId);
        const tx = await fundsFacet.depositPhygitals([fnftTokenId], [[phygital]]);

        // Events
        await expect(tx)
          .to.emit(fundsFacet, "ERC721Deposited")
          .withArgs(mockPhygital1Address, phygitalTokenId, defaultSigner.address);

        // State
        expect(await fundsFacet.getPhygitals(fnftTokenId)).to.eql([Object.values(phygital)]);
      });

      it("Fermion FNFT can be deposited as phygital", async function () {
        const offerId = 1n;
        const exchangeId = 1n;
        const phygitalFnftTokenId = deriveTokenId(offerId, exchangeId);

        await mockToken1.approve(fermionProtocolAddress, sellerDeposit);
        await fundsFacet.depositFunds(sellerId, mockToken1Address, sellerDeposit);
        await mockToken1.approve(fermionProtocolAddress, 2n * verifierFee);
        await offerFacet.unwrapNFT(phygitalFnftTokenId, WrapType.SELF_SALE, selfSaleData);
        await verificationFacet.connect(verifier).submitVerdict(phygitalFnftTokenId, VerificationStatus.Verified);
        await custodyFacet.connect(verifier).checkIn(phygitalFnftTokenId);

        const fermionPhygitalFnftAddress = await offerFacet.predictFermionFNFTAddress(offerId);
        const fermionFnft = await ethers.getContractAt("FermionFNFT", fermionPhygitalFnftAddress, defaultSigner);

        // Deposits phygital
        await fermionFnft.approve(fermionProtocolAddress, phygitalFnftTokenId);
        const phygital = { contractAddress: fermionPhygitalFnftAddress, tokenId: phygitalFnftTokenId };
        const tx = await fundsFacet.depositPhygitals([fnftTokenId], [[phygital]]);

        // Events
        await expect(tx)
          .to.emit(fundsFacet, "ERC721Deposited")
          .withArgs(fermionPhygitalFnftAddress, phygitalFnftTokenId, defaultSigner.address);

        // State
        expect(await fundsFacet.getPhygitals(fnftTokenId)).to.eql([Object.values(phygital)]);
      });

      context("Revert reasons", function () {
        it("Funds region is paused", async function () {
          await pauseFacet.pause([PausableRegion.Funds]);

          await expect(fundsFacet.connect(wallet).depositPhygitals([fnftTokenId], [[phygital]]))
            .to.be.revertedWithCustomError(fermionErrors, "RegionPaused")
            .withArgs(PausableRegion.Funds);
        });

        it("Length of _tokenIds and _phygitals does not match", async function () {
          await expect(fundsFacet.connect(wallet).depositPhygitals([fnftTokenId, fnftTokenId], [[phygital]]))
            .to.be.revertedWithCustomError(fermionErrors, "ArrayLengthMismatch")
            .withArgs(2, 1);

          await expect(fundsFacet.connect(wallet).depositPhygitals([fnftTokenId], [[phygital], [phygital, phygital]]))
            .to.be.revertedWithCustomError(fermionErrors, "ArrayLengthMismatch")
            .withArgs(1, 2);
        });

        it("Offer is not with phygitals", async function () {
          const fnftTokenId = deriveTokenId(1n, 1n);

          await expect(fundsFacet.connect(wallet).depositPhygitals([fnftTokenId], [[phygital]]))
            .to.be.revertedWithCustomError(fermionErrors, "NoPhygitalOffer")
            .withArgs(fnftTokenId);
        });

        it("Phygitals are already verified", async function () {
          await fundsFacet.connect(wallet).depositPhygitals([fnftTokenId], [[phygital]]);
          await mockToken1.approve(fermionProtocolAddress, sellerDeposit + minimalPrice);
          await fundsFacet.depositFunds(sellerId, mockToken1Address, sellerDeposit);
          await offerFacet.unwrapNFT(fnftTokenId, WrapType.SELF_SALE, selfSaleData);
          const encoded = abiCoder.encode(["tuple(address,uint256)[]"], [[Object.values(phygital)]]);
          const digest = ethers.keccak256(encoded);
          await verificationFacet.verifyPhygitals(fnftTokenId, digest);

          // Try to deposit another phygital
          const phygitalTokenId2 = phygitalTokenId + 1n;
          await mockPhygital1.mint(wallet.address, phygitalTokenId2, 1n);
          await mockPhygital1.connect(wallet).approve(fermionProtocolAddress, phygitalTokenId2);
          const phygital2 = { contractAddress: mockPhygital1Address, tokenId: phygitalTokenId2 };

          await expect(fundsFacet.connect(wallet).depositPhygitals([fnftTokenId], [[phygital2]]))
            .to.be.revertedWithCustomError(fermionErrors, "PhygitalsAlreadyVerified")
            .withArgs(fnftTokenId);
        });

        it("Funds related errors", async function () {
          // ERC721 insufficient allowance
          await mockPhygital1.connect(wallet).approve(ZeroAddress, phygitalTokenId);

          await expect(fundsFacet.connect(wallet).depositPhygitals([fnftTokenId], [[phygital]]))
            .to.be.revertedWithCustomError(mockPhygital1, "ERC721InsufficientApproval")
            .withArgs(fermionProtocolAddress, phygitalTokenId);

          // ERC721 - caller not an owner
          await expect(fundsFacet.depositPhygitals([fnftTokenId], [[phygital]]))
            .to.be.revertedWithCustomError(mockPhygital1, "ERC721InsufficientApproval")
            .withArgs(fermionProtocolAddress, phygitalTokenId);

          // ERC721 - non-existent token
          await expect(fundsFacet.depositPhygitals([fnftTokenId], [[{ ...phygital, tokenId: 999n }]]))
            .to.be.revertedWithCustomError(mockPhygital1, "ERC721NonexistentToken")
            .withArgs(999n);

          // ERC721 contract does not send the token
          await mockPhygital1.setHoldTransfer(true);
          await expect(fundsFacet.depositPhygitals([fnftTokenId], [[phygital]]))
            .to.be.revertedWithCustomError(fermionErrors, "ERC721TokenNotTransferred")
            .withArgs(phygital.contractAddress, phygital.tokenId);
        });

        it("Not an ERC721 contract", async function () {
          await expect(
            fundsFacet.depositPhygitals([fnftTokenId], [[{ ...phygital, contractAddress: mockToken1Address }]]),
          )
            .to.be.revertedWithCustomError(fermionErrors, "ERC721CheckFailed")
            .withArgs(mockToken1Address, true);
        });

        it("Token contract reverts", async function () {
          await mockPhygital1.setRevertReason(1); // 1=revert with custom error
          await expect(
            fundsFacet.connect(wallet).depositPhygitals([fnftTokenId], [[phygital]]),
          ).to.be.revertedWithCustomError(mockPhygital1, "CustomError");

          await mockPhygital1.setRevertReason(2); // 2=error string
          await expect(fundsFacet.connect(wallet).depositPhygitals([fnftTokenId], [[phygital]])).to.be.revertedWith(
            "Error string",
          );

          await mockPhygital1.setRevertReason(3); // 3=arbitrary bytes
          await expect(fundsFacet.connect(wallet).depositPhygitals([fnftTokenId], [[phygital]])).to.be.reverted;

          await mockPhygital1.setRevertReason(4); // 4=divide by zero
          await expect(
            fundsFacet.connect(wallet).depositPhygitals([fnftTokenId], [[phygital]]),
          ).to.be.revertedWithPanic("0x12");

          await mockPhygital1.setRevertReason(5); // 4=out of bounds
          await expect(
            fundsFacet.connect(wallet).depositPhygitals([fnftTokenId], [[phygital]]),
          ).to.be.revertedWithPanic("0x32");
        });

        it("Token contract returns unexpected data", async function () {
          await mockPhygital1.setRevertReason(6); // 6=return too short

          await expect(fundsFacet.connect(wallet).depositPhygitals([fnftTokenId], [[phygital]]))
            .to.be.revertedWithCustomError(fermionErrors, "UnexpectedDataReturned")
            .withArgs("0x00");

          await mockPhygital1.setRevertReason(7); // 7=return too long

          await expect(fundsFacet.connect(wallet).depositPhygitals([fnftTokenId], [[phygital]]))
            .to.be.revertedWithCustomError(fermionErrors, "UnexpectedDataReturned")
            .withArgs("0x000000000000000000000000000000000000000000000000000000000000000100");

          await mockPhygital1.setRevertReason(8); // 8=true with some other data

          await expect(fundsFacet.connect(wallet).depositPhygitals([fnftTokenId], [[phygital]]))
            .to.be.revertedWithCustomError(fermionErrors, "UnexpectedDataReturned")
            .withArgs("0x1626ba7e000000000000000abcde000000000000000000000000000000000001");
        });
      });
    });

    context("withdrawPhygitals - seller", function () {
      before(async function () {
        fundsFacet.withdrawPhygitals = fundsFacet["withdrawPhygitals(uint256[],(address,uint256)[][])"];
      });

      beforeEach(async function () {
        await fundsFacet.connect(wallet).depositPhygitals([fnftTokenId], [[phygital]]);
      });

      it("Seller can withdraw the phygitals before they are verified", async function () {
        // Withdraw phygital
        const tx = await fundsFacet.withdrawPhygitals([fnftTokenId], [[phygital]]);

        // Events
        await expect(tx)
          .to.emit(fundsFacet, "ERC721Withdrawn")
          .withArgs(mockPhygital1Address, phygitalTokenId, defaultSigner.address);
        await expect(tx)
          .to.emit(fundsFacet, "PhygitalsWithdrawn")
          .withArgs(fnftTokenId, [Object.values(phygital)]);

        // State
        expect(await fundsFacet.getPhygitals(fnftTokenId)).to.eql([]);
      });

      it("Seller can withdraw the if the RWA does not get verified", async function () {
        await mockToken1.approve(fermionProtocolAddress, sellerDeposit + minimalPrice);
        await fundsFacet.depositFunds(sellerId, mockToken1Address, sellerDeposit);
        await offerFacet.unwrapNFT(fnftTokenId, WrapType.SELF_SALE, selfSaleData);
        const digest = ethers.keccak256(abiCoder.encode(["tuple(address,uint256)[]"], [[Object.values(phygital)]]));
        await verificationFacet.verifyPhygitals(fnftTokenId, digest);

        await verificationFacet.connect(verifier).submitVerdict(fnftTokenId, VerificationStatus.Rejected);

        // Withdraw phygital
        const tx = await fundsFacet.withdrawPhygitals([fnftTokenId], [[phygital]]);

        // Events
        await expect(tx)
          .to.emit(fundsFacet, "ERC721Withdrawn")
          .withArgs(mockPhygital1Address, phygitalTokenId, defaultSigner.address);
        await expect(tx)
          .to.emit(fundsFacet, "PhygitalsWithdrawn")
          .withArgs(fnftTokenId, [Object.values(phygital)]);

        // State
        expect(await fundsFacet.getPhygitals(fnftTokenId)).to.eql([]);
      });

      it("Withdraw multiple phygitals from one offer", async function () {
        // Deposits phygitals
        const phygitalTokenId2 = phygitalTokenId + 1n;
        const phygitalTokenId3 = phygitalTokenId + 2n;
        const phygitalTokenId4 = phygitalTokenId + 3n;
        await mockPhygital1.mint(wallet.address, phygitalTokenId2, 3n);
        await mockPhygital1.connect(wallet).approve(fermionProtocolAddress, phygitalTokenId2);
        await mockPhygital1.connect(wallet).approve(fermionProtocolAddress, phygitalTokenId3);
        await mockPhygital1.connect(wallet).approve(fermionProtocolAddress, phygitalTokenId4);
        const phygital1 = { contractAddress: mockPhygital1Address, tokenId: phygitalTokenId };
        const phygital2 = { contractAddress: mockPhygital1Address, tokenId: phygitalTokenId2 };
        const phygital3 = { contractAddress: mockPhygital1Address, tokenId: phygitalTokenId3 };
        const phygital4 = { contractAddress: mockPhygital1Address, tokenId: phygitalTokenId4 };
        // phygital1 is already deposited
        await fundsFacet.connect(wallet).depositPhygitals([fnftTokenId], [[phygital2, phygital3, phygital4]]);

        // Withdraw phygitals
        const tx = await fundsFacet.withdrawPhygitals([fnftTokenId], [[phygital2]]);

        // Events
        await expect(tx)
          .to.emit(fundsFacet, "ERC721Withdrawn")
          .withArgs(mockPhygital1Address, phygitalTokenId2, defaultSigner.address);
        await expect(tx)
          .to.emit(fundsFacet, "PhygitalsWithdrawn")
          .withArgs(fnftTokenId, [Object.values(phygital2)]);

        expect(await fundsFacet.getPhygitals(fnftTokenId)).to.eql([
          Object.values(phygital1),
          Object.values(phygital4),
          Object.values(phygital3),
        ]);

        // Withdraw remaining phygitals
        const tx2 = await fundsFacet.withdrawPhygitals([fnftTokenId], [[phygital3, phygital4, phygital1]]);

        await expect(tx2)
          .to.emit(fundsFacet, "ERC721Withdrawn")
          .withArgs(mockPhygital1Address, phygitalTokenId, defaultSigner.address);
        await expect(tx2)
          .to.emit(fundsFacet, "ERC721Withdrawn")
          .withArgs(mockPhygital1Address, phygitalTokenId3, defaultSigner.address);
        await expect(tx2)
          .to.emit(fundsFacet, "ERC721Withdrawn")
          .withArgs(mockPhygital1Address, phygitalTokenId4, defaultSigner.address);
        await expect(tx2)
          .to.emit(fundsFacet, "PhygitalsWithdrawn")
          .withArgs(fnftTokenId, [Object.values(phygital3), Object.values(phygital4), Object.values(phygital1)]);

        // State
        expect(await fundsFacet.getPhygitals(fnftTokenId)).to.eql([]);
      });

      it("Withdraw multiple phygitals from one multiple offers", async function () {
        // Deposits phygitals
        const phygitalTokenId2 = 34n;
        const phygitalTokenId3 = 123n;
        await mockPhygital2.mint(wallet.address, phygitalTokenId2, 1n);
        await mockPhygital2.connect(wallet).approve(fermionProtocolAddress, phygitalTokenId2);
        await mockPhygital3.mint(wallet.address, phygitalTokenId3, 1n);
        await mockPhygital3.connect(wallet).approve(fermionProtocolAddress, phygitalTokenId3);
        const phygital1 = { contractAddress: mockPhygital1Address, tokenId: phygitalTokenId };
        const phygital2 = { contractAddress: mockPhygital2Address, tokenId: phygitalTokenId2 };
        const phygital3 = { contractAddress: mockPhygital3Address, tokenId: phygitalTokenId3 };

        const fnftTokenId2 = deriveTokenId(3n, 3n);
        // phygital1 is already deposited
        await fundsFacet.connect(wallet).depositPhygitals([fnftTokenId, fnftTokenId2], [[phygital2], [phygital3]]);

        const tx = await fundsFacet.withdrawPhygitals([fnftTokenId2, fnftTokenId], [[phygital3], [phygital1]]);

        // Events
        await expect(tx)
          .to.emit(fundsFacet, "ERC721Withdrawn")
          .withArgs(mockPhygital1Address, phygitalTokenId, defaultSigner.address);
        await expect(tx)
          .to.emit(fundsFacet, "ERC721Withdrawn")
          .withArgs(mockPhygital3Address, phygitalTokenId3, defaultSigner.address);
        await expect(tx)
          .to.emit(fundsFacet, "PhygitalsWithdrawn")
          .withArgs(fnftTokenId, [Object.values(phygital1)]);
        await expect(tx)
          .to.emit(fundsFacet, "PhygitalsWithdrawn")
          .withArgs(fnftTokenId2, [Object.values(phygital3)]);

        // State
        expect(await fundsFacet.getPhygitals(fnftTokenId)).to.eql([Object.values(phygital2)]);
        expect(await fundsFacet.getPhygitals(fnftTokenId2)).to.eql([]);
      });

      it("Fermion FNFT can be withdrawn as phygital", async function () {
        await fundsFacet.withdrawPhygitals([fnftTokenId], [[phygital]]); // get rid of the deposited phygital

        const offerId = 1n;
        const exchangeId = 1n;
        const phygitalFnftTokenId = deriveTokenId(offerId, exchangeId);

        await mockToken1.approve(fermionProtocolAddress, sellerDeposit);
        await fundsFacet.depositFunds(sellerId, mockToken1Address, sellerDeposit);
        await mockToken1.approve(fermionProtocolAddress, 2n * verifierFee);
        await offerFacet.unwrapNFT(phygitalFnftTokenId, WrapType.SELF_SALE, selfSaleData);
        await verificationFacet.connect(verifier).submitVerdict(phygitalFnftTokenId, VerificationStatus.Verified);
        await custodyFacet.connect(verifier).checkIn(phygitalFnftTokenId);

        const fermionPhygitalFnftAddress = await offerFacet.predictFermionFNFTAddress(offerId);
        const fermionFnft = await ethers.getContractAt("FermionFNFT", fermionPhygitalFnftAddress, defaultSigner);

        // Deposits phygital
        await fermionFnft.approve(fermionProtocolAddress, phygitalFnftTokenId);
        const fnftPhygital = { contractAddress: fermionPhygitalFnftAddress, tokenId: phygitalFnftTokenId };
        await fundsFacet.depositPhygitals([fnftTokenId], [[fnftPhygital]]);

        // Withdraw phygital
        const tx = await fundsFacet.withdrawPhygitals([fnftTokenId], [[fnftPhygital]]);

        // Events
        await expect(tx)
          .to.emit(fundsFacet, "ERC721Withdrawn")
          .withArgs(fermionPhygitalFnftAddress, phygitalFnftTokenId, defaultSigner.address);

        // State
        expect(await fundsFacet.getPhygitals(fnftTokenId)).to.eql([]);
      });

      context("Revert reasons", function () {
        it("Funds region is paused", async function () {
          await pauseFacet.pause([PausableRegion.Funds]);

          await expect(fundsFacet.withdrawPhygitals([fnftTokenId], [[phygital]]))
            .to.be.revertedWithCustomError(fermionErrors, "RegionPaused")
            .withArgs(PausableRegion.Funds);
        });

        it("Length of _tokenIds and _phygitals does not match", async function () {
          await expect(fundsFacet.withdrawPhygitals([fnftTokenId, fnftTokenId], [[phygital]]))
            .to.be.revertedWithCustomError(fermionErrors, "ArrayLengthMismatch")
            .withArgs(2, 1);

          await expect(fundsFacet.withdrawPhygitals([fnftTokenId], [[phygital], [phygital, phygital]]))
            .to.be.revertedWithCustomError(fermionErrors, "ArrayLengthMismatch")
            .withArgs(1, 2);
        });

        it("Offer is not with phygitals", async function () {
          const fnftTokenId = deriveTokenId(1n, 1n);

          await expect(fundsFacet.withdrawPhygitals([fnftTokenId], [[phygital]]))
            .to.be.revertedWithCustomError(fermionErrors, "NoPhygitalOffer")
            .withArgs(fnftTokenId);
        });

        it("Phygitals are already verified", async function () {
          await mockToken1.approve(fermionProtocolAddress, sellerDeposit + minimalPrice);
          await fundsFacet.depositFunds(sellerId, mockToken1Address, sellerDeposit);
          await offerFacet.unwrapNFT(fnftTokenId, WrapType.SELF_SALE, selfSaleData);
          const digest = ethers.keccak256(abiCoder.encode(["tuple(address,uint256)[]"], [[Object.values(phygital)]]));
          await verificationFacet.verifyPhygitals(fnftTokenId, digest);

          // Try to deposit another phygital
          const phygitalTokenId2 = phygitalTokenId + 1n;
          await mockPhygital1.mint(wallet.address, phygitalTokenId2, 1n);
          await mockPhygital1.connect(wallet).approve(fermionProtocolAddress, phygitalTokenId2);
          const phygital2 = { contractAddress: mockPhygital1Address, tokenId: phygitalTokenId2 };

          await expect(fundsFacet.withdrawPhygitals([fnftTokenId], [[phygital2]]))
            .to.be.revertedWithCustomError(fermionErrors, "PhygitalsAlreadyVerified")
            .withArgs(fnftTokenId);
        });

        it("Phygital does not belong to the offer", async function () {
          const phygitalTokenId2 = phygitalTokenId + 1n;
          await mockPhygital1.mint(wallet.address, phygitalTokenId2, 1n);
          await mockPhygital1.connect(wallet).approve(fermionProtocolAddress, phygitalTokenId2);
          const phygital2 = { contractAddress: mockPhygital1Address, tokenId: phygitalTokenId2 };
          const fnftTokenId2 = deriveTokenId(3n, 3n);
          await fundsFacet.connect(wallet).depositPhygitals([fnftTokenId2], [[phygital2]]);

          await expect(fundsFacet.withdrawPhygitals([fnftTokenId], [[phygital2]]))
            .to.be.revertedWithCustomError(fermionErrors, "PhygitalsNotFound")
            .withArgs(fnftTokenId, Object.values(phygital2));
        });

        it("Trying to transfer ERC20 token owned by the protocol", async function () {
          await mockToken1.approve(fermionProtocolAddress, sellerDeposit);
          await fundsFacet.depositFunds(sellerId, mockToken1Address, sellerDeposit);

          const phygital2 = { contractAddress: mockToken1Address, tokenId: sellerDeposit }; // "tokenId" of ERC721 corresponds to "amount" of ERC20

          await expect(fundsFacet.withdrawPhygitals([fnftTokenId], [[phygital2]]))
            .to.be.revertedWithCustomError(fermionErrors, "PhygitalsNotFound")
            .withArgs(fnftTokenId, Object.values(phygital2));
        });
      });
    });

    context("withdrawPhygitals - buyer", function () {
      let buyer: HardhatEthersSigner;
      let custodian: HardhatEthersSigner;

      before(async function () {
        buyer = wallets[4];
        custodian = verifier;

        fundsFacet.withdrawPhygitals = fundsFacet.connect(buyer)["withdrawPhygitals(uint256[],address)"];
      });

      beforeEach(async function () {
        await fundsFacet.connect(wallet).depositPhygitals([fnftTokenId], [[phygital]]);

        const createBuyerAdvancedOrder = createBuyerAdvancedOrderClosure(
          wallets,
          seaportAddress,
          mockToken1,
          offerFacet,
        );
        const { buyerAdvancedOrder, tokenId } = await createBuyerAdvancedOrder(buyer, offerId.toString(), exchangeId);
        await mockToken1.approve(fermionProtocolAddress, sellerDeposit);
        await offerFacet.unwrapNFT(tokenId, WrapType.OS_AUCTION, buyerAdvancedOrder);

        const fermionFnftAddress = await offerFacet.predictFermionFNFTAddress(offerId);
        const fermionFnft = await ethers.getContractAt("FermionFNFT", fermionFnftAddress);
        await fermionFnft.connect(buyer).setApprovalForAll(fermionProtocolAddress, true);
      });

      it("Buyer can withdraw the phygitals after the checkout request is cleared", async function () {
        const digest = ethers.keccak256(abiCoder.encode(["tuple(address,uint256)[]"], [[Object.values(phygital)]]));
        await verificationFacet.connect(buyer).verifyPhygitals(fnftTokenId, digest);
        await verificationFacet.connect(verifier).submitVerdict(fnftTokenId, VerificationStatus.Verified);
        await custodyFacet.connect(custodian).checkIn(fnftTokenId);
        await custodyFacet.connect(buyer).requestCheckOut(fnftTokenId);
        await custodyFacet.clearCheckoutRequest(fnftTokenId);

        // Withdraw phygital
        const tx = await fundsFacet.withdrawPhygitals([fnftTokenId], buyer.address);

        // Events
        await expect(tx)
          .to.emit(fundsFacet, "ERC721Withdrawn")
          .withArgs(mockPhygital1Address, phygitalTokenId, buyer.address);
        await expect(tx)
          .to.emit(fundsFacet, "PhygitalsWithdrawn")
          .withArgs(fnftTokenId, [Object.values(phygital)]);

        // State. In happy path, the phygital is not removed from the offer
        expect(await fundsFacet.getPhygitals(fnftTokenId)).to.eql([Object.values(phygital)]);
      });

      it("Withdraw multiple phygitals from one offer", async function () {
        // Deposits phygitals
        const phygitalTokenId2 = phygitalTokenId + 1n;
        const phygitalTokenId3 = phygitalTokenId + 2n;
        await mockPhygital1.mint(wallet.address, phygitalTokenId2, 2n);
        await mockPhygital1.connect(wallet).approve(fermionProtocolAddress, phygitalTokenId2);
        await mockPhygital1.connect(wallet).approve(fermionProtocolAddress, phygitalTokenId3);
        const phygital1 = { contractAddress: mockPhygital1Address, tokenId: phygitalTokenId };
        const phygital2 = { contractAddress: mockPhygital1Address, tokenId: phygitalTokenId2 };
        const phygital3 = { contractAddress: mockPhygital1Address, tokenId: phygitalTokenId3 };

        // phygital1 is already deposited
        await fundsFacet.connect(wallet).depositPhygitals([fnftTokenId], [[phygital2, phygital3]]);

        // Verify the phygitals
        const digest = ethers.keccak256(
          abiCoder.encode(
            ["tuple(address,uint256)[]"],
            [[Object.values(phygital1), Object.values(phygital2), Object.values(phygital3)]],
          ),
        );
        await verificationFacet.connect(buyer).verifyPhygitals(fnftTokenId, digest);
        await verificationFacet.connect(verifier).submitVerdict(fnftTokenId, VerificationStatus.Verified);
        await custodyFacet.connect(custodian).checkIn(fnftTokenId);
        await custodyFacet.connect(buyer).requestCheckOut(fnftTokenId);
        await custodyFacet.clearCheckoutRequest(fnftTokenId);

        // Withdraw phygitals
        const tx = await fundsFacet.withdrawPhygitals([fnftTokenId], buyer.address);

        // Events
        await expect(tx)
          .to.emit(fundsFacet, "ERC721Withdrawn")
          .withArgs(mockPhygital1Address, phygitalTokenId, buyer.address);
        await expect(tx)
          .to.emit(fundsFacet, "ERC721Withdrawn")
          .withArgs(mockPhygital1Address, phygitalTokenId2, buyer.address);
        await expect(tx)
          .to.emit(fundsFacet, "ERC721Withdrawn")
          .withArgs(mockPhygital1Address, phygitalTokenId3, buyer.address);
        await expect(tx)
          .to.emit(fundsFacet, "PhygitalsWithdrawn")
          .withArgs(fnftTokenId, [Object.values(phygital1), Object.values(phygital2), Object.values(phygital3)]);

        expect(await fundsFacet.getPhygitals(fnftTokenId)).to.eql([
          Object.values(phygital1),
          Object.values(phygital2),
          Object.values(phygital3),
        ]);
      });

      it("Withdraw multiple phygitals from one multiple offers", async function () {
        // Deposits phygitals
        const phygitalTokenId2 = 34n;
        const phygitalTokenId3 = 123n;
        await mockPhygital2.mint(wallet.address, phygitalTokenId2, 1n);
        await mockPhygital2.connect(wallet).approve(fermionProtocolAddress, phygitalTokenId2);
        await mockPhygital3.mint(wallet.address, phygitalTokenId3, 1n);
        await mockPhygital3.connect(wallet).approve(fermionProtocolAddress, phygitalTokenId3);
        const phygital1 = { contractAddress: mockPhygital1Address, tokenId: phygitalTokenId };
        const phygital2 = { contractAddress: mockPhygital2Address, tokenId: phygitalTokenId2 };
        const phygital3 = { contractAddress: mockPhygital3Address, tokenId: phygitalTokenId3 };

        const fnftTokenId2 = deriveTokenId(3n, 3n);
        // phygital1 is already deposited
        await fundsFacet.connect(wallet).depositPhygitals([fnftTokenId, fnftTokenId2], [[phygital2], [phygital3]]);

        // Verify the phygitals
        const digest = ethers.keccak256(
          abiCoder.encode(["tuple(address,uint256)[]"], [[Object.values(phygital1), Object.values(phygital2)]]),
        );
        await verificationFacet.connect(buyer).verifyPhygitals(fnftTokenId, digest);
        await verificationFacet.connect(verifier).submitVerdict(fnftTokenId, VerificationStatus.Verified);
        await custodyFacet.connect(custodian).checkIn(fnftTokenId);
        await custodyFacet.connect(buyer).requestCheckOut(fnftTokenId);
        await custodyFacet.clearCheckoutRequest(fnftTokenId);

        const createBuyerAdvancedOrder = createBuyerAdvancedOrderClosure(
          wallets,
          seaportAddress,
          mockToken1,
          offerFacet,
        );
        const { buyerAdvancedOrder, tokenId } = await createBuyerAdvancedOrder(
          buyer,
          (offerId + 1n).toString(),
          exchangeId + 1n,
        );
        await mockToken1.approve(fermionProtocolAddress, sellerDeposit);
        await offerFacet.unwrapNFT(tokenId, WrapType.OS_AUCTION, buyerAdvancedOrder);
        const digest2 = ethers.keccak256(abiCoder.encode(["tuple(address,uint256)[]"], [[Object.values(phygital3)]]));
        await verificationFacet.connect(buyer).verifyPhygitals(fnftTokenId2, digest2);
        await verificationFacet.connect(verifier).submitVerdict(fnftTokenId2, VerificationStatus.Verified);
        await custodyFacet.connect(custodian).checkIn(fnftTokenId2);
        const fermionFnftAddress = await offerFacet.predictFermionFNFTAddress(offerId + 1n);
        const fermionFnft = await ethers.getContractAt("FermionFNFT", fermionFnftAddress);
        await fermionFnft.connect(buyer).setApprovalForAll(fermionProtocolAddress, true);
        await custodyFacet.connect(buyer).requestCheckOut(fnftTokenId2);
        await custodyFacet.clearCheckoutRequest(fnftTokenId2);

        const tx = await fundsFacet.withdrawPhygitals([fnftTokenId2, fnftTokenId], buyer.address);

        // Events
        await expect(tx)
          .to.emit(fundsFacet, "ERC721Withdrawn")
          .withArgs(mockPhygital1Address, phygitalTokenId, buyer.address);
        await expect(tx)
          .to.emit(fundsFacet, "ERC721Withdrawn")
          .withArgs(mockPhygital2Address, phygitalTokenId2, buyer.address);
        await expect(tx)
          .to.emit(fundsFacet, "ERC721Withdrawn")
          .withArgs(mockPhygital3Address, phygitalTokenId3, buyer.address);
        await expect(tx)
          .to.emit(fundsFacet, "PhygitalsWithdrawn")
          .withArgs(fnftTokenId, [Object.values(phygital1), Object.values(phygital2)]);
        await expect(tx)
          .to.emit(fundsFacet, "PhygitalsWithdrawn")
          .withArgs(fnftTokenId2, [Object.values(phygital3)]);

        // State
        expect(await fundsFacet.getPhygitals(fnftTokenId)).to.eql([Object.values(phygital1), Object.values(phygital2)]);
        expect(await fundsFacet.getPhygitals(fnftTokenId2)).to.eql([Object.values(phygital3)]);
      });

      it("Treasury can be a contract wallet", async function () {
        const digest = ethers.keccak256(abiCoder.encode(["tuple(address,uint256)[]"], [[Object.values(phygital)]]));
        await verificationFacet.connect(buyer).verifyPhygitals(fnftTokenId, digest);
        await verificationFacet.connect(verifier).submitVerdict(fnftTokenId, VerificationStatus.Verified);
        await custodyFacet.connect(custodian).checkIn(fnftTokenId);
        await custodyFacet.connect(buyer).requestCheckOut(fnftTokenId);
        await custodyFacet.clearCheckoutRequest(fnftTokenId);

        const contractAccountWithReceiveFactory = await ethers.getContractFactory("ContractWalletWithReceive");
        const contractAccountWithReceive = await contractAccountWithReceiveFactory.deploy();
        const contractAccountWithReceiveAddress = await contractAccountWithReceive.getAddress();
        const [buyerEntityId] = await entityFacet["getEntity(address)"](buyer.address);
        await entityFacet
          .connect(buyer)
          .addEntityAccounts(buyerEntityId, [contractAccountWithReceiveAddress], [[]], [[[AccountRole.Treasury]]]);

        // Withdraw phygital
        const tx = await fundsFacet.withdrawPhygitals([fnftTokenId], contractAccountWithReceiveAddress);

        // Events
        await expect(tx)
          .to.emit(fundsFacet, "ERC721Withdrawn")
          .withArgs(mockPhygital1Address, phygitalTokenId, contractAccountWithReceiveAddress);
        await expect(tx)
          .to.emit(contractAccountWithReceive, "PhygitalReceived")
          .withArgs(phygital.contractAddress, phygital.tokenId);

        // State. In happy path, the phygital is not removed from the offer
        expect(await fundsFacet.getPhygitals(fnftTokenId)).to.eql([Object.values(phygital)]);
      });

      context("Revert reasons", function () {
        it("The checkout request is not cleared yet", async function () {
          const digest = ethers.keccak256(abiCoder.encode(["tuple(address,uint256)[]"], [[Object.values(phygital)]]));
          await verificationFacet.connect(buyer).verifyPhygitals(fnftTokenId, digest);
          await expect(fundsFacet.withdrawPhygitals([fnftTokenId], buyer.address))
            .to.be.revertedWithCustomError(fermionErrors, "NoSuchEntity")
            .withArgs(MaxUint256);

          await verificationFacet.connect(verifier).submitVerdict(fnftTokenId, VerificationStatus.Verified);
          await expect(fundsFacet.withdrawPhygitals([fnftTokenId], buyer.address))
            .to.be.revertedWithCustomError(fermionErrors, "NoSuchEntity")
            .withArgs(MaxUint256);

          await custodyFacet.connect(custodian).checkIn(fnftTokenId);
          await expect(fundsFacet.withdrawPhygitals([fnftTokenId], buyer.address))
            .to.be.revertedWithCustomError(fermionErrors, "NoSuchEntity")
            .withArgs(MaxUint256);

          await custodyFacet.connect(buyer).requestCheckOut(fnftTokenId);
          await expect(fundsFacet.withdrawPhygitals([fnftTokenId], buyer.address))
            .to.be.revertedWithCustomError(fermionErrors, "NoSuchEntity")
            .withArgs(MaxUint256);
        });

        context("Checkout request cleared", function () {
          beforeEach(async function () {
            const digest = ethers.keccak256(abiCoder.encode(["tuple(address,uint256)[]"], [[Object.values(phygital)]]));
            await verificationFacet.connect(buyer).verifyPhygitals(fnftTokenId, digest);
            await verificationFacet.connect(verifier).submitVerdict(fnftTokenId, VerificationStatus.Verified);
            await custodyFacet.connect(custodian).checkIn(fnftTokenId);
            await custodyFacet.connect(buyer).requestCheckOut(fnftTokenId);
            await custodyFacet.clearCheckoutRequest(fnftTokenId);
          });

          it("Funds region is paused", async function () {
            await pauseFacet.pause([PausableRegion.Funds]);

            await expect(fundsFacet.withdrawPhygitals([fnftTokenId], buyer.address))
              .to.be.revertedWithCustomError(fermionErrors, "RegionPaused")
              .withArgs(PausableRegion.Funds);
          });

          it("Caller is not the buyer's assistant", async function () {
            const randomWallet = wallets[5];
            const [buyerEntityId] = await entityFacet["getEntity(address)"](buyer.address);

            await expect(
              fundsFacet.connect(randomWallet)["withdrawPhygitals(uint256[],address)"]([fnftTokenId], buyer.address),
            )
              .to.be.revertedWithCustomError(fermionErrors, "NotEntityWideRole")
              .withArgs(randomWallet.address, buyerEntityId, AccountRole.Assistant);
          });

          it("Treasury does not belong to buyer", async function () {
            const randomWallet = wallets[5];
            const [buyerEntityId] = await entityFacet["getEntity(address)"](buyer.address);

            await expect(
              fundsFacet.connect(buyer)["withdrawPhygitals(uint256[],address)"]([fnftTokenId], randomWallet.address),
            )
              .to.be.revertedWithCustomError(fermionErrors, "NotEntityWideRole")
              .withArgs(randomWallet.address, buyerEntityId, AccountRole.Treasury);
          });

          it("Treasury reverts", async function () {
            const contractAccountFactory = await ethers.getContractFactory("ContractWallet");
            const contractAccount = await contractAccountFactory.deploy();
            const contractAccountAddress = await contractAccount.getAddress();
            const contractAccountWithReceiveFactory = await ethers.getContractFactory("ContractWalletWithReceive");
            const contractAccountWithReceive = await contractAccountWithReceiveFactory.deploy();
            const contractAccountWithReceiveAddress = await contractAccountWithReceive.getAddress();
            const [buyerEntityId] = await entityFacet["getEntity(address)"](buyer.address);
            await entityFacet
              .connect(buyer)
              .addEntityAccounts(
                buyerEntityId,
                [contractAccountWithReceiveAddress, contractAccountAddress],
                [[], []],
                [[[AccountRole.Treasury]], [[AccountRole.Treasury]]],
              );

            // contract without receive function
            await expect(fundsFacet.withdrawPhygitals([fnftTokenId], contractAccountAddress))
              .to.be.revertedWithCustomError(mockPhygital1, "ERC721InvalidReceiver")
              .withArgs(contractAccountAddress);

            // contract with receive function, but reverting
            await contractAccountWithReceive.setAcceptingMoney(false);
            await expect(
              fundsFacet.withdrawPhygitals([fnftTokenId], contractAccountWithReceiveAddress),
            ).to.be.revertedWithCustomError(contractAccountWithReceive, "NotAcceptingMoney");
          });

          it("The phygitals are already withdrawn", async function () {
            // Withdraw phygital
            await fundsFacet.withdrawPhygitals([fnftTokenId], buyer.address);

            // Try to withdraw again
            await expect(fundsFacet.withdrawPhygitals([fnftTokenId], buyer.address))
              .to.be.revertedWithCustomError(fermionErrors, "NoSuchEntity")
              .withArgs(MaxUint256);

            // The same phygital gets deposited again to another offer
            const fnftTokenId2 = deriveTokenId(3n, 3n);
            await mockPhygital1.connect(buyer).approve(fermionProtocolAddress, phygitalTokenId);
            await fundsFacet.connect(buyer).depositPhygitals([fnftTokenId2], [[phygital]]);

            await expect(fundsFacet.withdrawPhygitals([fnftTokenId], buyer.address))
              .to.be.revertedWithCustomError(fermionErrors, "NoSuchEntity")
              .withArgs(MaxUint256);

            await expect(
              fundsFacet
                .connect(defaultSigner)
                ["withdrawPhygitals(uint256[],(address,uint256)[][])"]([fnftTokenId], [[phygital]]),
            )
              .to.be.revertedWithCustomError(fermionErrors, "PhygitalsAlreadyVerified")
              .withArgs(fnftTokenId);
          });

          it("Transfer of phygitals is not successful", async function () {
            // ERC721 contract does not send the token
            await mockPhygital1.setRevertReason(1); // revert on transfer

            // Try to withdraw
            await expect(fundsFacet.withdrawPhygitals([fnftTokenId], buyer.address)).to.be.revertedWithCustomError(
              mockPhygital1,
              "CustomError",
            );
          });

          it("Phygitals belong to different accounts", async function () {
            // Buy another offer with another account. Set previous buyer as assistant and treasury
            const buyer2 = wallets[9];
            const createBuyerAdvancedOrder = createBuyerAdvancedOrderClosure(
              wallets,
              seaportAddress,
              mockToken1,
              offerFacet,
            );
            const { buyerAdvancedOrder, tokenId: fnftTokenId2 } = await createBuyerAdvancedOrder(
              buyer2,
              (offerId + 1n).toString(),
              exchangeId + 1n,
            );
            await mockToken1.approve(fermionProtocolAddress, sellerDeposit);
            await offerFacet.unwrapNFT(fnftTokenId2, WrapType.OS_AUCTION, buyerAdvancedOrder);

            const phygitalTokenId2 = phygitalTokenId + 1n;
            await mockPhygital1.mint(wallet.address, phygitalTokenId2, 1n);
            await mockPhygital1.connect(wallet).approve(fermionProtocolAddress, phygitalTokenId2);
            const phygital2 = { contractAddress: mockPhygital1Address, tokenId: phygitalTokenId2 };
            await fundsFacet.connect(wallet).depositPhygitals([fnftTokenId2], [[phygital2]]);

            const digest2 = ethers.keccak256(
              abiCoder.encode(["tuple(address,uint256)[]"], [[Object.values(phygital2)]]),
            );
            await verificationFacet.connect(buyer2).verifyPhygitals(fnftTokenId2, digest2);
            await verificationFacet.connect(verifier).submitVerdict(fnftTokenId2, VerificationStatus.Verified);
            await custodyFacet.connect(custodian).checkIn(fnftTokenId2);
            const fermionFnftAddress = await offerFacet.predictFermionFNFTAddress(offerId + 1n);
            const fermionFnft = await ethers.getContractAt("FermionFNFT", fermionFnftAddress);
            await fermionFnft.connect(buyer2).setApprovalForAll(fermionProtocolAddress, true);
            await custodyFacet.connect(buyer2).requestCheckOut(fnftTokenId2);
            await custodyFacet.clearCheckoutRequest(fnftTokenId2);

            const [buyer2EntityId] = await entityFacet["getEntity(address)"](buyer2.address);
            await entityFacet
              .connect(buyer2)
              .addEntityAccounts(
                buyer2EntityId,
                [buyer.address],
                [[]],
                [[[AccountRole.Assistant, AccountRole.Treasury]]],
              );

            // Try to withdraw
            await expect(fundsFacet.withdrawPhygitals([fnftTokenId, fnftTokenId2], buyer.address))
              .to.be.revertedWithCustomError(fermionErrors, "AccessDenied")
              .withArgs(buyer.address);
          });
        });
      });
    });
  });

  context("withdrawProtocolFees", function () {
    const amountNative = parseEther("10");
    const amountMockToken = parseEther("12");
    const protocolId = 0n;
    const protocolTreasury = fermionConfig.protocolParameters.treasury;

    beforeEach(async function () {
      await fundsFacet.depositFunds(protocolId, ZeroAddress, amountNative, { value: amountNative });
      await mockToken1.connect(defaultSigner).approve(fermionProtocolAddress, amountMockToken);
      await fundsFacet.depositFunds(protocolId, mockToken1Address, amountMockToken);
    });

    it("Fee collector can withdraw the funds to protocol treasury", async function () {
      const entityAvailableFunds = await fundsFacet.getAvailableFunds(protocolId, mockToken1Address);
      const treasuryBalance = await mockToken1.balanceOf(protocolTreasury);

      // Withdraw funds
      const withdrawAmount = amountMockToken / 2n;
      const tx = await fundsFacet.connect(feeCollector).withdrawProtocolFees([mockToken1Address], [withdrawAmount]);

      // Events
      await expect(tx)
        .to.emit(fundsFacet, "FundsWithdrawn")
        .withArgs(protocolId, protocolTreasury, mockToken1Address, withdrawAmount);

      // State
      expect(await fundsFacet.getAvailableFunds(protocolId, mockToken1Address)).to.equal(
        entityAvailableFunds - withdrawAmount,
      );
      expect(await mockToken1.balanceOf(protocolTreasury)).to.equal(treasuryBalance + withdrawAmount);
    });

    it("Withdraw all", async function () {
      const entityAvailableFundsNative = await fundsFacet.getAvailableFunds(protocolId, ZeroAddress);
      const entityAvailableFundsMockToken1 = await fundsFacet.getAvailableFunds(protocolId, mockToken1Address);
      const treasuryBalanceNative = await ethers.provider.getBalance(protocolTreasury);
      const treasuryBalanceMockToken1 = await mockToken1.balanceOf(protocolTreasury);

      // Withdraw funds
      const tx = await fundsFacet.connect(feeCollector).withdrawProtocolFees([], [], { gasPrice: 0 });

      // Events
      await expect(tx)
        .to.emit(fundsFacet, "FundsWithdrawn")
        .withArgs(protocolId, protocolTreasury, ZeroAddress, amountNative);
      await expect(tx)
        .to.emit(fundsFacet, "FundsWithdrawn")
        .withArgs(protocolId, protocolTreasury, mockToken1Address, amountMockToken);

      // State
      expect(await fundsFacet.getAvailableFunds(protocolId, ZeroAddress)).to.equal(
        entityAvailableFundsNative - amountNative,
      );
      expect(await fundsFacet.getAvailableFunds(protocolId, ZeroAddress)).to.equal(
        entityAvailableFundsMockToken1 - amountMockToken,
      );
      expect(await ethers.provider.getBalance(protocolTreasury)).to.equal(treasuryBalanceNative + amountNative);
      expect(await mockToken1.balanceOf(protocolTreasury)).to.equal(treasuryBalanceMockToken1 + amountMockToken);
    });

    it("Token list is updated correctly", async function () {
      // add more tokens
      await mockToken2.connect(defaultSigner).approve(fermionProtocolAddress, amountMockToken);
      await mockToken3.connect(defaultSigner).approve(fermionProtocolAddress, amountMockToken);
      await fundsFacet.depositFunds(protocolId, mockToken2Address, amountMockToken);
      await fundsFacet.depositFunds(protocolId, mockToken3Address, amountMockToken);

      expect(await fundsFacet.getTokenList(protocolId)).to.eql([
        ZeroAddress,
        mockToken1Address,
        mockToken2Address,
        mockToken3Address,
      ]);

      // Withdraw funds
      const withdrawAmount = amountMockToken / 2n;
      await fundsFacet.connect(feeCollector).withdrawProtocolFees([mockToken1Address], [withdrawAmount]);

      // Token list should not change
      expect(await fundsFacet.getTokenList(protocolId)).to.eql([
        ZeroAddress,
        mockToken1Address,
        mockToken2Address,
        mockToken3Address,
      ]);

      // Withdraw remaining mocktoken1 - token list should be updated
      await fundsFacet.connect(feeCollector).withdrawProtocolFees([mockToken1Address], [withdrawAmount]);
      expect(await fundsFacet.getTokenList(protocolId)).to.eql([ZeroAddress, mockToken3Address, mockToken2Address]);

      // Withdraw all native - token list should be updated
      await fundsFacet.connect(feeCollector).withdrawProtocolFees([ZeroAddress], [amountNative]);
      expect(await fundsFacet.getTokenList(protocolId)).to.eql([mockToken2Address, mockToken3Address]);
    });

    it("Treasury can be a contract wallet", async function () {
      const contractAccountWithReceiveFactory = await ethers.getContractFactory("ContractWalletWithReceive");
      const contractAccountWithReceive = await contractAccountWithReceiveFactory.deploy();
      const contractAccountWithReceiveAddress = await contractAccountWithReceive.getAddress();

      await configFacet.setTreasuryAddress(contractAccountWithReceiveAddress);

      // contract without receive function
      const tx = await fundsFacet.connect(feeCollector).withdrawProtocolFees([ZeroAddress], [amountNative]);
      await expect(tx)
        .to.emit(fundsFacet, "FundsWithdrawn")
        .withArgs(protocolId, contractAccountWithReceiveAddress, ZeroAddress, amountNative);
      await expect(tx)
        .to.emit(contractAccountWithReceive, "FundsReceived")
        .withArgs(fermionProtocolAddress, amountNative);
    });

    context("Revert reasons", function () {
      it("Funds region is paused", async function () {
        await pauseFacet.pause([PausableRegion.Funds]);

        await expect(fundsFacet.connect(feeCollector).withdrawProtocolFees([], []))
          .to.be.revertedWithCustomError(fermionErrors, "RegionPaused")
          .withArgs(PausableRegion.Funds);
      });

      it("Caller does not have fee collector role", async function () {
        const accessControl = await ethers.getContractAt("IAccessControl", ethers.ZeroAddress);
        const wallet = wallets[9];

        // completely random wallet
        await expect(fundsFacet.connect(wallet).withdrawProtocolFees([], []))
          .to.be.revertedWithCustomError(accessControl, "AccessControlUnauthorizedAccount")
          .withArgs(wallet.address, id("FEE_COLLECTOR"));
      });

      it("Fee collector cannot use withdraw funds to collect the fees", async function () {
        await expect(fundsFacet.connect(feeCollector).withdrawFunds(protocolId, protocolTreasury, [], []))
          .to.be.revertedWithCustomError(fermionErrors, "NoSuchEntity")
          .withArgs(protocolId);
      });

      it("Token list and token amounts length mismatch", async function () {
        await expect(
          fundsFacet.connect(feeCollector).withdrawProtocolFees([ZeroAddress], [amountNative, amountMockToken]),
        )
          .to.be.revertedWithCustomError(fermionErrors, "ArrayLengthMismatch")
          .withArgs(1, 2);

        await expect(fundsFacet.connect(feeCollector).withdrawProtocolFees([ZeroAddress], []))
          .to.be.revertedWithCustomError(fermionErrors, "ArrayLengthMismatch")
          .withArgs(1, 0);
      });

      it("Nothing to withdraw - withdraw all", async function () {
        await fundsFacet.connect(feeCollector).withdrawProtocolFees([], []);

        await expect(fundsFacet.connect(feeCollector).withdrawProtocolFees([], [])).to.be.revertedWithCustomError(
          fermionErrors,
          "NothingToWithdraw",
        );
      });

      it("Nothing to withdraw - requested amount is 0", async function () {
        await expect(
          fundsFacet.connect(feeCollector).withdrawProtocolFees([ZeroAddress], ["0"]),
        ).to.be.revertedWithCustomError(fermionErrors, "NothingToWithdraw");
      });

      it("Withdraw more than available", async function () {
        await expect(fundsFacet.connect(feeCollector).withdrawProtocolFees([ZeroAddress], [amountNative + 1n]))
          .to.be.revertedWithCustomError(fermionErrors, "InsufficientAvailableFunds")
          .withArgs(amountNative, amountNative + 1n);

        await expect(fundsFacet.connect(feeCollector).withdrawProtocolFees([mockToken1Address], [amountMockToken + 1n]))
          .to.be.revertedWithCustomError(fermionErrors, "InsufficientAvailableFunds")
          .withArgs(amountMockToken, amountMockToken + 1n);
      });

      it("Treasury reverts", async function () {
        const contractAccountFactory = await ethers.getContractFactory("ContractWallet");
        const contractAccount = await contractAccountFactory.deploy();
        const contractAccountWithReceiveFactory = await ethers.getContractFactory("ContractWalletWithReceive");
        const contractAccountWithReceive = await contractAccountWithReceiveFactory.deploy();

        const contractAccountAddress = await contractAccount.getAddress();
        const contractAccountWithReceiveAddress = await contractAccountWithReceive.getAddress();

        await configFacet.setTreasuryAddress(contractAccountAddress);
        // contract without receive function
        await expect(fundsFacet.connect(feeCollector).withdrawProtocolFees([ZeroAddress], [amountNative]))
          .to.be.revertedWithCustomError(fermionErrors, "TokenTransferFailed")
          .withArgs(contractAccountAddress, amountNative, "0x");

        // contract with receive function, but reverting
        await configFacet.setTreasuryAddress(contractAccountWithReceiveAddress);
        await contractAccountWithReceive.setAcceptingMoney(false);
        await expect(fundsFacet.connect(feeCollector).withdrawProtocolFees([ZeroAddress], [amountNative]))
          .to.be.revertedWithCustomError(fermionErrors, "TokenTransferFailed")
          .withArgs(contractAccountWithReceiveAddress, amountNative, id("NotAcceptingMoney()").slice(0, 10));
      });
    });
  });

  context("collectRoyalties", function () {
    const offerId = 1n;
    const exchangeId = 1n;
    const tokenId = deriveTokenId(offerId, exchangeId);
    const bidAmount = parseEther("1");
    const royalties = 2_00n;
    const sellerRoyalties = 4_00n;
    const sellerRoyalties2 = 5_00n;
    let wrapper: Contract;

    beforeEach(async function () {
      const wrapperAddress = await offerFacet.predictFermionFNFTAddress(offerId);
      wrapper = await ethers.getContractAt("FermionFNFT", wrapperAddress);

      // update royalties
      const royaltyInfo = {
        recipients: [royaltyRecipient.address, defaultSigner.address, ZeroAddress],
        bps: [royalties, sellerRoyalties, sellerRoyalties2],
      };
      await royaltiesFacet.updateOfferRoyaltyRecipients([offerId], royaltyInfo);

      // selfsale
      await mockToken1.approve(fermionProtocolAddress, sellerDeposit);
      await fundsFacet.depositFunds(sellerId, mockToken1Address, sellerDeposit);
      await mockToken1.approve(fermionProtocolAddress, 2n * verifierFee);
      await offerFacet.unwrapNFT(tokenId, WrapType.SELF_SALE, selfSaleData);
      await verificationFacet.connect(verifier).submitVerdict(tokenId, VerificationStatus.Verified);
      await custodyFacet.connect(verifier).checkIn(tokenId);

      // mint fractions
      const additionalDeposit = custodianFee.amount * 2n;
      await mockToken1.approve(wrapperAddress, additionalDeposit);
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
        newFractionsPerAuction: fractionsPerToken * 5n,
      };
      await wrapper
        .connect(defaultSigner)
        .mintFractions(
          tokenId,
          1,
          fractionsPerToken,
          auctionParameters,
          custodianVaultParameters,
          additionalDeposit,
          ZeroAddress,
        );

      // bid
      const bidder = wallets[5];

      await mockToken1.mint(bidder.address, parseEther("10"));
      await mockToken1.connect(bidder).approve(wrapperAddress, bidAmount);
      const tx = await wrapper.connect(bidder).bid(tokenId, bidAmount, 0n);

      const auctionEnd = (await getBlockTimestampFromTransaction(tx)) + Number(auctionParameters.duration);
      await setNextBlockTimestamp(auctionEnd + 1);
    });

    it("During the auction finalization, the protocol collects the royalties", async function () {
      const sellerAvailableFunds = await fundsFacet.getAvailableFunds(sellerId, mockToken1Address);
      const royaltyRecipientAvailableFunds = await fundsFacet.getAvailableFunds(royaltyRecipientId, mockToken1Address);
      const tx = await wrapper.connect(defaultSigner).finalizeAndClaim(tokenId, 1n);

      // Events
      await expect(tx)
        .to.emit(fundsFacet, "AvailableFundsIncreased")
        .withArgs(sellerId, mockToken1Address, applyPercentage(bidAmount, sellerRoyalties)); // recipient = seller admin address
      await expect(tx)
        .to.emit(fundsFacet, "AvailableFundsIncreased")
        .withArgs(sellerId, mockToken1Address, applyPercentage(bidAmount, sellerRoyalties2)); // recipient = zero address
      await expect(tx)
        .to.emit(fundsFacet, "AvailableFundsIncreased")
        .withArgs(royaltyRecipientId, mockToken1Address, applyPercentage(bidAmount, royalties)); // recipient = zero address

      // State
      expect(await fundsFacet.getAvailableFunds(sellerId, mockToken1Address)).to.equal(
        sellerAvailableFunds +
          applyPercentage(bidAmount, sellerRoyalties) +
          applyPercentage(bidAmount, sellerRoyalties2),
      );
      expect(await fundsFacet.getAvailableFunds(royaltyRecipientId, mockToken1Address)).to.equal(
        royaltyRecipientAvailableFunds + applyPercentage(bidAmount, royalties),
      );
    });

    it.only("Offers without royalties (pre v1.1.0)", async function () {
      // "delete" offer.royaltyInfo
      const protocolEntitiesSlotNumber = BigInt("0x88d4ceef162f03fe6cb4afc6ec9059995e2e55e4c807661ebd7d646b852a9700"); // // keccak256(abi.encode(uint256(keccak256("fermion.protocol.entities")) - 1)) & ~bytes32(uint256(0xff));
      const offerSlot = BigInt(keccak256(toBeHex(offerId, 32) + (protocolEntitiesSlotNumber + 2n).toString(16)));
      const offerRoyaltyInfoSlot = offerSlot + 12n;
      await setStorageAt(fermionProtocolAddress, offerRoyaltyInfoSlot, ZeroHash); // set length to 0

      const sellerAvailableFunds = await fundsFacet.getAvailableFunds(sellerId, mockToken1Address);
      const tx = await wrapper.connect(defaultSigner).finalizeAndClaim(tokenId, 1n);

      // Events
      await expect(tx).to.not.emit(fundsFacet, "AvailableFundsIncreased");

      // State
      expect(await fundsFacet.getAvailableFunds(sellerId, mockToken1Address)).to.equal(sellerAvailableFunds);
    });

    context("Revert reasons", function () {
      it("Funds region is paused", async function () {
        await pauseFacet.pause([PausableRegion.Funds]);

        await expect(wrapper.connect(defaultSigner).finalizeAndClaim(tokenId, 1n))
          .to.be.revertedWithCustomError(fermionErrors, "RegionPaused")
          .withArgs(PausableRegion.Funds);
      });

      it("Caller is not the fermion wrapper", async function () {
        // completely random wallet
        await expect(fundsFacet.collectRoyalties(tokenId, bidAmount))
          .to.be.revertedWithCustomError(fundsFacet, "AccessDenied")
          .withArgs(defaultSigner.address);
      });
    });
  });

  context("getTokenList", async function () {
    it("Returns list of tokens", async function () {
      const amount = parseEther("1");
      await mockToken1.connect(defaultSigner).approve(fermionProtocolAddress, amount);
      await mockToken2.connect(defaultSigner).approve(fermionProtocolAddress, amount);
      await mockToken3.connect(defaultSigner).approve(fermionProtocolAddress, amount);

      await fundsFacet.depositFunds(sellerId, mockToken1Address, amount);
      await fundsFacet.depositFunds(sellerId, ZeroAddress, amount, { value: amount });
      await fundsFacet.depositFunds(sellerId, mockToken2Address, amount);
      await fundsFacet.depositFunds(sellerId, mockToken3Address, amount);

      // Read on chain state
      const returnedTokenList = await fundsFacet.getTokenList(sellerId);
      const expectedAvailableFunds = [
        await mockToken1.getAddress(),
        ZeroAddress,
        await mockToken2.getAddress(),
        await mockToken3.getAddress(),
      ];
      expect(returnedTokenList).to.eql(expectedAvailableFunds);
    });
  });

  context("getTokenListPaginated", async function () {
    let mockTokens: Contract[];
    beforeEach(async function () {
      const amount = parseEther("1");
      mockTokens = [mockToken1, mockToken2, mockToken3, ...(await deployMockTokens(["ERC20", "ERC20"]))];

      // top up assistants account
      for (const mockToken of mockTokens) {
        await mockToken.mint(defaultSigner.address, amount);
        await mockToken.connect(defaultSigner).approve(fermionProtocolAddress, amount);
        await fundsFacet.depositFunds(sellerId, await mockToken.getAddress(), amount);
      }

      // Deposit token - seller
      await fundsFacet.depositFunds(sellerId, ZeroAddress, amount, { value: amount });
    });

    it("Returns list of tokens", async function () {
      const limit = 3;
      const offset = 1;

      // Read on chain state
      const returnedTokenList = await fundsFacet.getTokenListPaginated(sellerId, limit, offset);
      const expectedAvailableFunds = await Promise.all(
        mockTokens.slice(offset, offset + limit).map((token) => token.getAddress()),
      );
      expect(returnedTokenList).to.eql(expectedAvailableFunds);
    });

    it("Offset is more than number of tokens", async function () {
      const limit = 2;
      const offset = 8;
      // Read on chain state
      const returnedTokenList = await fundsFacet.getTokenListPaginated(sellerId, limit, offset);
      const expectedAvailableFunds: string[] = [];
      expect(returnedTokenList).to.eql(expectedAvailableFunds);
    });

    it("Limit + offset is more than number of tokens", async function () {
      const limit = 7;
      const offset = 2;
      // Read on chain state
      const returnedTokenList = await fundsFacet.getTokenListPaginated(sellerId, limit, offset);
      const expectedAvailableFunds = [
        ...(await Promise.all(mockTokens.slice(offset).map((token) => token.getAddress()))),
        ZeroAddress,
      ];
      expect(returnedTokenList).to.eql(expectedAvailableFunds);
    });
  });
});
