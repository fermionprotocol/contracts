import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployFermionProtocolFixture, deployMockTokens, deriveTokenId } from "../utils/common";
import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, ZeroAddress, ZeroHash } from "ethers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { EntityRole, VerificationStatus, WalletRole } from "../utils/enums";
import { Seaport } from "@opensea/seaport-js";
import { ItemType } from "@opensea/seaport-js/lib/constants";
import { getBosonProtocolFees } from "../utils/boson-protocol";

const { parseEther, id } = ethers;

describe("Funds", function () {
  let offerFacet: Contract, entityFacet: Contract, verificationFacet: Contract, fundsFacet: Contract;
  let mockToken1: Contract, mockToken2: Contract, mockToken3: Contract;
  let mockToken1Address: string, mockToken2Address: string, mockToken3Address: string;
  let fermionErrors: Contract;
  let fermionProtocolAddress: string;
  let wallets: HardhatEthersSigner[];
  let defaultSigner: HardhatEthersSigner;
  let verifier: HardhatEthersSigner;
  let buyer: HardhatEthersSigner;
  let seaportAddress: string;
  const sellerId = "1";
  const verifierId = "2";
  const verifierFee = parseEther("0.1");
  const sellerDeposit = parseEther("0.05");

  async function setupCustodyTest() {
    // Create three entities
    // Seller, Verifier, Custodian combined
    // Verifier and custodian
    const metadataURI = "https://example.com/seller-metadata.json";
    verifier = wallets[2];
    await entityFacet.createEntity([EntityRole.Seller, EntityRole.Verifier, EntityRole.Custodian], metadataURI); // "1"
    await entityFacet.connect(verifier).createEntity([EntityRole.Verifier, EntityRole.Custodian], metadataURI); // "2"

    [mockToken1, mockToken2, mockToken3] = await deployMockTokens(["ERC20", "ERC20", "ERC20"]);
    mockToken1 = mockToken1.connect(defaultSigner);
    mockToken2 = mockToken2.connect(defaultSigner);
    mockToken3 = mockToken3.connect(defaultSigner);
    await mockToken1.mint(defaultSigner.address, parseEther("1000"));
    await mockToken2.mint(defaultSigner.address, parseEther("1000"));
    await mockToken3.mint(defaultSigner.address, parseEther("1000"));
    mockToken1Address = await mockToken1.getAddress();
    mockToken2Address = await mockToken2.getAddress();
    mockToken3Address = await mockToken3.getAddress();
  }

  async function createBuyerAdvancedOrder(buyer: HardhatEthersSigner, offerId: string, exchangeId: string) {
    const fullPrice = parseEther("1");
    const openSeaFee = (fullPrice * 2n) / 100n;
    const openSea = wallets[5]; // a mock OS address
    const seaport = new Seaport(buyer, { overrides: { seaportVersion: "1.6", contractAddress: seaportAddress } });

    await mockToken1.mint(buyer.address, fullPrice);

    const exchangeToken = await mockToken1.getAddress();
    const tokenId = deriveTokenId(offerId, exchangeId).toString();
    const wrapperAddress = await offerFacet.predictFermionWrapperAddress(tokenId);
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
            recipient: openSea.address,
          },
        ],
      },
      buyer.address,
    );

    const buyerOrder = await executeAllActions();
    const buyerAdvancedOrder = {
      ...buyerOrder,
      numerator: 1n,
      denominator: 1n,
      extraData: "0x",
    };

    const encumberedAmount = fullPrice - openSeaFee;

    return { buyerAdvancedOrder, tokenId, encumberedAmount };
  }

  // Used to test methods that can be called by the Seller's Assistant only

  before(async function () {
    ({
      diamondAddress: fermionProtocolAddress,
      facets: {
        EntityFacet: entityFacet,
        OfferFacet: offerFacet,
        VerificationFacet: verificationFacet,
        FundsFacet: fundsFacet,
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

    context("Revert reasons", function () {
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

      await entityFacet.addEntityWallets(
        sellerId,
        [assistant, treasury],
        [[], []],
        [[[WalletRole.Assistant]], [[WalletRole.Treasury]]],
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
      const tx = await fundsFacet.withdrawFunds(sellerId, defaultSigner.address, [ZeroAddress], [withdrawAmount]);

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
      const tx = await fundsFacet.withdrawFunds(sellerId, defaultSigner.address, [], []);

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
      await offerFacet.addSupportedToken(mockToken1Address);

      // Create offer
      const offerId = "1";
      const exchangeId = "1";
      const quantity = "1";
      const fermionOffer = {
        sellerId,
        sellerDeposit,
        verifierId,
        verifierFee,
        custodianId: verifierId,
        exchangeToken: mockToken1Address,
        metadataURI: "https://example.com/offer-metadata.json",
        metadataHash: ZeroHash,
      };

      await mockToken1.approve(fermionProtocolAddress, sellerDeposit);
      await offerFacet.createOffer(fermionOffer);
      await offerFacet.mintAndWrapNFTs(offerId, quantity);

      // Unwrap NFT
      buyer = wallets[4];

      const { buyerAdvancedOrder, tokenId, encumberedAmount } = await createBuyerAdvancedOrder(
        buyer,
        offerId,
        exchangeId,
      ); // ToDo: use commone closuer
      await offerFacet.unwrapNFT(tokenId, buyerAdvancedOrder);

      // Submit verdicts
      await verificationFacet.connect(verifier).submitVerdict(tokenId, VerificationStatus.Rejected);

      const { percentage: bosonProtocolFeePercentage } = getBosonProtocolFees();
      const expectedPayout =
        encumberedAmount -
        (encumberedAmount * BigInt(bosonProtocolFeePercentage)) / 10000n -
        verifierFee +
        sellerDeposit;

      const buyerBalance = await mockToken1.balanceOf(buyer.address);
      const [buyerEntityId] = await entityFacet["getEntity(address)"](buyer.address);

      await fundsFacet
        .connect(buyer)
        .withdrawFunds(buyerEntityId, buyer.address, [mockToken1Address], [expectedPayout]);

      expect(await mockToken1.balanceOf(buyer.address)).to.equal(buyerBalance + expectedPayout);
    });

    it("Treasury can be a contract wallet", async function () {
      const contractWalletWithReceiveFactory = await ethers.getContractFactory("ContractWalletWithReceive");
      const contractWalletWithReceive = await contractWalletWithReceiveFactory.deploy();
      const contractWalletWithReceiveAddress = await contractWalletWithReceive.getAddress();

      await entityFacet.addEntityWallets(sellerId, [contractWalletWithReceiveAddress], [[]], [[[WalletRole.Treasury]]]);

      // contract without receive function
      const tx = await fundsFacet.withdrawFunds(
        sellerId,
        contractWalletWithReceiveAddress,
        [ZeroAddress],
        [amountNative],
      );
      await expect(tx)
        .to.emit(fundsFacet, "FundsWithdrawn")
        .withArgs(sellerId, contractWalletWithReceiveAddress, ZeroAddress, amountNative);
      await expect(tx)
        .to.emit(contractWalletWithReceive, "FundsReceived")
        .withArgs(fermionProtocolAddress, amountNative);
    });

    context("Revert reasons", function () {
      it("Caller is not entity's assistant", async function () {
        const wallet = wallets[9];

        // completely random wallet
        await expect(fundsFacet.connect(wallet).withdrawFunds(sellerId, defaultSigner.address, [], []))
          .to.be.revertedWithCustomError(fermionErrors, "NotEntityAssistant")
          .withArgs(sellerId, wallet.address);

        // seller's assistant (not entity wide)
        await entityFacet.addEntityWallets(sellerId, [wallet], [[EntityRole.Seller]], [[[WalletRole.Assistant]]]);
        await expect(fundsFacet.connect(wallet).withdrawFunds(sellerId, defaultSigner.address, [], []))
          .to.be.revertedWithCustomError(fermionErrors, "NotEntityAssistant")
          .withArgs(sellerId, wallet.address);

        // an entity-wide Treasury or admin wallet (not Assistant)
        await entityFacet.addEntityWallets(sellerId, [wallet], [[]], [[[WalletRole.Treasury, WalletRole.Admin]]]);
        await expect(fundsFacet.connect(wallet).withdrawFunds(sellerId, defaultSigner.address, [], []))
          .to.be.revertedWithCustomError(fermionErrors, "NotEntityAssistant")
          .withArgs(sellerId, wallet.address);
      });

      it("Treasury is not entity's treasury", async function () {
        const treasury = wallets[9].address;

        // completely random wallet
        await expect(fundsFacet.withdrawFunds(sellerId, treasury, [], []))
          .to.be.revertedWithCustomError(fermionErrors, "NotEntityTreasury")
          .withArgs(sellerId, treasury);

        // seller's treasury (not entity wide)
        await entityFacet.addEntityWallets(sellerId, [treasury], [[EntityRole.Seller]], [[[WalletRole.Treasury]]]);
        await expect(fundsFacet.withdrawFunds(sellerId, treasury, [], []))
          .to.be.revertedWithCustomError(fermionErrors, "NotEntityTreasury")
          .withArgs(sellerId, treasury);

        // an entity-wide Assistant or admin wallet (not Assistant)
        await entityFacet.addEntityWallets(sellerId, [treasury], [[]], [[[WalletRole.Assistant, WalletRole.Admin]]]);
        await expect(fundsFacet.withdrawFunds(sellerId, treasury, [], []))
          .to.be.revertedWithCustomError(fermionErrors, "NotEntityTreasury")
          .withArgs(sellerId, treasury);
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
        const contractWalletFactory = await ethers.getContractFactory("ContractWallet");
        const contractWallet = await contractWalletFactory.deploy();
        const contractWalletWithReceiveFactory = await ethers.getContractFactory("ContractWalletWithReceive");
        const contractWalletWithReceive = await contractWalletWithReceiveFactory.deploy();

        const contractWalletAddress = await contractWallet.getAddress();
        const contractWalletWithReceiveAddress = await contractWalletWithReceive.getAddress();

        await entityFacet.addEntityWallets(
          sellerId,
          [contractWalletAddress, contractWalletWithReceiveAddress],
          [[], []],
          [[[WalletRole.Treasury]], [[WalletRole.Treasury]]],
        );

        // contract without receive function
        await expect(fundsFacet.withdrawFunds(sellerId, contractWalletAddress, [ZeroAddress], [amountNative]))
          .to.be.revertedWithCustomError(fermionErrors, "TokenTransferFailed")
          .withArgs(contractWalletAddress, amountNative, "0x");

        // contract with receive function, but reverting
        await contractWalletWithReceive.setAcceptingMoney(false);
        await expect(
          fundsFacet.withdrawFunds(sellerId, contractWalletWithReceiveAddress, [ZeroAddress], [amountNative]),
        )
          .to.be.revertedWithCustomError(fermionErrors, "TokenTransferFailed")
          .withArgs(contractWalletWithReceiveAddress, amountNative, id("NotAcceptingMoney()").slice(0, 10));
      });
    });
  });
});
