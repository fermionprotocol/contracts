import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { getInterfaceID, deployMockTokens } from "../utils/common";
import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, ZeroHash } from "ethers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { TokenState } from "../utils/enums";

const { parseEther, ZeroAddress } = ethers;

describe("FermionFNFT", function () {
  let fermionFNFT: Contract, fermionFNFTProxy: Contract;
  let wallets: HardhatEthersSigner[];
  let seller: HardhatEthersSigner;
  let fermionMock: Contract;
  const startTokenId = 2n ** 128n + 1n;
  const quantity = 10n;
  const additionalDeposit = 0n;

  async function setupFermionFNFTTest() {
    wallets = await ethers.getSigners();
    const wrapperContractOwner = wallets[2];
    seller = wallets[3];
    const [mockConduit, mockBosonPriceDiscovery] = (await ethers.getSigners()).slice(9, 11);
    const FermionFNFT = await ethers.getContractFactory("FermionFNFT");
    const fermionFNFT = await FermionFNFT.deploy(mockBosonPriceDiscovery.address, {
      seaport: ZeroAddress,
      openSeaConduit: mockConduit.address,
      openSeaConduitKey: ZeroHash,
    }); // For these tests, zero constructor arguments are okay

    const Proxy = await ethers.getContractFactory("MockProxy");
    const proxy = await Proxy.deploy(await fermionFNFT.getAddress());

    const fermionFNFTProxy = await ethers.getContractAt("FermionFNFT", await proxy.getAddress());

    const [mockBoson, mockExchangeToken] = await deployMockTokens(["ERC721", "ERC20"]);

    const fermionMockFactory = await ethers.getContractFactory("MockFermion");
    fermionMock = await fermionMockFactory.deploy(
      await fermionFNFTProxy.getAddress(),
      await mockExchangeToken.getAddress(),
    );

    await mockBoson.mint(await fermionMock.getAddress(), startTokenId, quantity);
    await fermionFNFTProxy
      .attach(fermionMock)
      .initialize(await mockBoson.getAddress(), wrapperContractOwner.address, await mockExchangeToken.getAddress());
    await fermionMock.setDestinationOverride(await mockBoson.getAddress());
    await mockBoson.attach(fermionMock).setApprovalForAll(await fermionFNFTProxy.getAddress(), true);
    await fermionFNFTProxy.attach(fermionMock).wrapForAuction(startTokenId, quantity, seller.address);

    for (let i = 0n; i < quantity; i++) {
      const tokenId = startTokenId + i;
      await fermionFNFTProxy.connect(mockBosonPriceDiscovery).unwrapToSelf(startTokenId + i, ZeroAddress, 0);
      if (i < quantity - 1n) {
        await fermionFNFTProxy.attach(fermionMock).pushToNextTokenState(tokenId, TokenState.Verified);
        await fermionFNFTProxy.attach(fermionMock).pushToNextTokenState(tokenId, TokenState.CheckedIn);
      }
    }

    return { fermionFNFT, fermionFNFTProxy, mockBoson, mockBosonPriceDiscovery };
  }

  before(async function () {
    ({ fermionFNFT, fermionFNFTProxy } = await loadFixture(setupFermionFNFTTest));
  });

  afterEach(async function () {
    await loadFixture(setupFermionFNFTTest);
  });

  context("supportsInterface", function () {
    it("Supports ERC165 and ERC721 interfaces", async function () {
      const { interface: ERC165Interface } = await ethers.getContractAt("IERC165", ZeroAddress);
      const { interface: ERC721Interface } = await ethers.getContractAt("IERC721", ZeroAddress);
      const { interface: FermionWrapperInterface } = await ethers.getContractAt("IFermionWrapper", ZeroAddress);
      const { interface: FermionFractionsInterface } = await ethers.getContractAt("IFermionFractions", ZeroAddress);
      const { interface: FermionFNFTInterface } = await ethers.getContractAt("IFermionFNFT", ZeroAddress);

      const ERC165InterfaceID = getInterfaceID(ERC165Interface);
      const ERC721InterfaceID = getInterfaceID(ERC721Interface, [ERC165InterfaceID]);
      const FermionWrapperInterfaceID = getInterfaceID(FermionWrapperInterface, [ERC165InterfaceID, ERC721InterfaceID]);
      const FermionFractionsInterfaceID = getInterfaceID(FermionFractionsInterface);
      const FermionFNFTInterfaceID = getInterfaceID(FermionFNFTInterface, [
        ERC165InterfaceID,
        ERC721InterfaceID,
        FermionWrapperInterfaceID,
        FermionFractionsInterfaceID,
      ]);

      expect(await fermionFNFT.supportsInterface(ERC165InterfaceID)).to.be.true;
      expect(await fermionFNFT.supportsInterface(ERC721InterfaceID)).to.be.true;
      expect(await fermionFNFT.supportsInterface(FermionWrapperInterfaceID)).to.be.true;
      expect(await fermionFNFT.supportsInterface(FermionFractionsInterfaceID)).to.be.true;
      expect(await fermionFNFT.supportsInterface(FermionFNFTInterfaceID)).to.be.true;
    });
  });

  context("ERC20 methods", function () {
    it("decimals", async function () {
      expect(await fermionFNFT.decimals()).to.equal(18);
    });

    it("Approve fractions transfer", async function () {
      const fractionsAmount = 5000n * 10n ** 18n;
      const auctionParameters = {
        exitPrice: parseEther("0.1"),
        duration: 0n,
        unlockThreshold: 0n,
        topBidLockTime: 0n,
      };
      const custodianFee = {
        amount: parseEther("0.05"),
        period: 30n * 24n * 60n * 60n, // 30 days
      };
      const custodianVaultParameters = {
        partialAuctionThreshold: custodianFee.amount * 15n,
        partialAuctionDuration: custodianFee.period / 2n,
        liquidationThreshold: custodianFee.amount * 2n,
        newFractionsPerAuction: fractionsAmount,
      };

      await fermionFNFTProxy
        .connect(seller)
        .mintFractions(
          startTokenId,
          1,
          fractionsAmount,
          auctionParameters,
          custodianVaultParameters,
          additionalDeposit,
        );

      const approvedWallet = wallets[4];

      // Approve fractions transfer
      await expect(fermionFNFTProxy.connect(seller).approve(approvedWallet.address, fractionsAmount))
        .to.emit(fermionFNFTProxy, "Approval")
        .withArgs(seller.address, approvedWallet.address, fractionsAmount);

      // Get allowance
      expect(await fermionFNFTProxy.allowance(seller.address, approvedWallet.address)).to.equal(fractionsAmount);

      // Transfer fractions
      await fermionFNFTProxy
        .connect(approvedWallet)
        .transferFrom(seller.address, approvedWallet.address, fractionsAmount);

      // Check balance
      expect(await fermionFNFTProxy.balanceOf(approvedWallet.address)).to.equal(fractionsAmount);
      expect(await fermionFNFTProxy.balanceOf(seller.address)).to.equal(0);
    });

    it("Reverts", async function () {
      const fractionsAmount = 5000n * 10n ** 18n;
      const auctionParameters = {
        exitPrice: parseEther("0.1"),
        duration: 0n,
        unlockThreshold: 0n,
        topBidLockTime: 0n,
      };
      const custodianFee = {
        amount: parseEther("0.05"),
        period: 30n * 24n * 60n * 60n, // 30 days
      };
      const custodianVaultParameters = {
        partialAuctionThreshold: custodianFee.amount * 15n,
        partialAuctionDuration: custodianFee.period / 2n,
        liquidationThreshold: custodianFee.amount * 2n,
        newFractionsPerAuction: fractionsAmount,
      };

      await fermionFNFTProxy
        .connect(seller)
        .mintFractions(
          startTokenId,
          1,
          fractionsAmount,
          auctionParameters,
          custodianVaultParameters,
          additionalDeposit,
        );

      // Approve to 0 address
      await expect(fermionFNFTProxy.connect(seller).approve(ZeroAddress, fractionsAmount))
        .to.be.revertedWithCustomError(fermionFNFTProxy, "ERC20InvalidSpender")
        .withArgs(ZeroAddress);

      // Send to 0 address
      await expect(fermionFNFTProxy.connect(seller).transfer(ZeroAddress, fractionsAmount))
        .to.be.revertedWithCustomError(fermionFNFTProxy, "ERC20InvalidReceiver")
        .withArgs(ZeroAddress);
    });
  });
});
