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
  let fermionProtocolSigner: HardhatEthersSigner;
  let seller: HardhatEthersSigner;
  const startTokenId = 2n ** 128n + 1n;
  const quantity = 10n;

  async function setupFermionFNFTTest() {
    wallets = await ethers.getSigners();
    fermionProtocolSigner = wallets[1]; // wallet that simulates the fermion protocol
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

    const fermionFNFTProxy = await ethers.getContractAt("FermionFNFT", await proxy.getAddress(), fermionProtocolSigner);

    const [mockBoson, mockExchangeToken] = await deployMockTokens(["ERC721", "ERC20"]);

    await mockBoson.mint(fermionProtocolSigner, startTokenId, quantity);
    await fermionFNFTProxy.initialize(
      await mockBoson.getAddress(),
      wrapperContractOwner.address,
      await mockExchangeToken.getAddress(),
    );
    await mockBoson.connect(fermionProtocolSigner).setApprovalForAll(await fermionFNFTProxy.getAddress(), true);
    await fermionFNFTProxy.wrapForAuction(startTokenId, quantity, seller.address);

    for (let i = 0n; i < quantity; i++) {
      const tokenId = startTokenId + i;
      await fermionFNFTProxy.connect(mockBosonPriceDiscovery).unwrapToSelf(startTokenId + i, ZeroAddress, 0);
      if (i < quantity - 1n) await fermionFNFTProxy.pushToNextTokenState(tokenId, TokenState.Verified);
    }

    return { fermionFNFT, fermionFNFTProxy, mockBoson, mockBosonPriceDiscovery };
  }

  before(async function () {
    ({ fermionFNFT, fermionFNFTProxy } = await loadFixture(setupFermionFNFTTest));

    fermionFNFTProxy = fermionFNFTProxy.connect(fermionProtocolSigner);
  });

  afterEach(async function () {
    await loadFixture(setupFermionFNFTTest);
  });

  context("supportsInterface", function () {
    it("Supports ERC165 and ERC721 interfaces", async function () {
      const { interface: ERC165Interface } = await ethers.getContractAt("IERC165", ZeroAddress);
      const { interface: ERC721Interface } = await ethers.getContractAt("IERC721", ZeroAddress);
      const { interface: FermionWrapperInterface } = await ethers.getContractAt("IFermionWrapper", ZeroAddress);
      const { interface: FermionFNFTInterface } = await ethers.getContractAt("IFermionFNFT", ZeroAddress);

      const ERC165InterfaceID = getInterfaceID(ERC165Interface);
      const ERC721InterfaceID = getInterfaceID(ERC721Interface, [ERC165InterfaceID]);
      const FermionWrapperInterfaceID = getInterfaceID(FermionWrapperInterface, [ERC165InterfaceID, ERC721InterfaceID]);
      const FermionFNFTInterfaceID = getInterfaceID(FermionFNFTInterface, [
        ERC165InterfaceID,
        ERC721InterfaceID,
        FermionWrapperInterfaceID,
      ]);

      expect(await fermionFNFT.supportsInterface(ERC165InterfaceID)).to.be.true;
      expect(await fermionFNFT.supportsInterface(ERC721InterfaceID)).to.be.true;
      expect(await fermionFNFT.supportsInterface(FermionWrapperInterfaceID)).to.be.true;
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

      await fermionFNFTProxy.connect(seller).mintFractions(startTokenId, 1, fractionsAmount, auctionParameters);

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

      await fermionFNFTProxy.connect(seller).mintFractions(startTokenId, 1, fractionsAmount, auctionParameters);

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
