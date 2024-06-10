import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { getInterfaceID, deployMockTokens } from "../utils/common";
import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, ZeroHash } from "ethers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { TokenState } from "../utils/enums";

const { ZeroAddress } = ethers;

describe("FermionFNFT", function () {
  let fermionWrapper: Contract, fermionWrapperProxy: Contract;
  let wallets: HardhatEthersSigner[];
  let fermionProtocolSigner: HardhatEthersSigner;
  let wrapperContractOwner: HardhatEthersSigner;
  let mockBosonPriceDiscovery: HardhatEthersSigner;
  let mockBoson: Contract;

  async function setupFermionWrapperTest() {
    const [mockConduit, mockBosonPriceDiscovery] = (await ethers.getSigners()).slice(9, 11);
    const FermionFNFT = await ethers.getContractFactory("FermionFNFT");
    const fermionWrapper = await FermionFNFT.deploy(mockBosonPriceDiscovery.address, {
      seaport: ZeroAddress,
      openSeaConduit: mockConduit.address,
      openSeaConduitKey: ZeroHash,
    }); // For these tests, zero constructor arguments are okay

    const Proxy = await ethers.getContractFactory("MockProxy");
    const proxy = await Proxy.deploy(await fermionWrapper.getAddress());

    const fermionWrapperProxy = await ethers.getContractAt("FermionFNFT", await proxy.getAddress());

    const [mockBoson] = await deployMockTokens(["ERC721"]);
    return { fermionWrapper, fermionWrapperProxy, mockBoson, mockBosonPriceDiscovery };
  }

  before(async function () {
    ({ fermionWrapper, fermionWrapperProxy, mockBoson, mockBosonPriceDiscovery } =
      await loadFixture(setupFermionWrapperTest));
    wallets = await ethers.getSigners();
    fermionProtocolSigner = wallets[1]; // wallet that simulates the fermion protocol
    wrapperContractOwner = wallets[2];

    fermionWrapperProxy = fermionWrapperProxy.connect(fermionProtocolSigner);
  });

  afterEach(async function () {
    await loadFixture(setupFermionWrapperTest);
  });

  context("supportsInterface", function () {
    it("Supports ERC165 and ERC721 interfaces", async function () {
      const { interface: ERC165Interface } = await ethers.getContractAt("IERC165", ZeroAddress);
      const { interface: ERC721Interface } = await ethers.getContractAt("IERC721", ZeroAddress);
      const { interface: FermionWrapperInterface } = await ethers.getContractAt("IFermionWrapper", ZeroAddress);

      const ERC165InterfaceID = getInterfaceID(ERC165Interface);
      const ERC721InterfaceID = getInterfaceID(ERC721Interface, [ERC165InterfaceID]);
      const FermionWrapperInterfaceID = getInterfaceID(FermionWrapperInterface, [ERC165InterfaceID, ERC721InterfaceID]);

      expect(await fermionWrapper.supportsInterface(ERC165InterfaceID)).to.be.true;
      expect(await fermionWrapper.supportsInterface(ERC721InterfaceID)).to.be.true;
      expect(await fermionWrapper.supportsInterface(FermionWrapperInterfaceID)).to.be.true;

      await fermionWrapper.liquidSupply();
    });
  });

  context("initialize", function () {
    it("Initialization via proxy sets the new owner", async function () {
      await expect(fermionWrapperProxy.initialize(ZeroAddress, wrapperContractOwner.address))
        .to.emit(fermionWrapperProxy, "OwnershipTransferred")
        .withArgs(ZeroAddress, wrapperContractOwner.address);

      expect(await fermionWrapperProxy.owner()).to.equal(wrapperContractOwner.address);
    });

    context("Revert reasons", function () {
      it("Direct initialization fails", async function () {
        await expect(
          fermionWrapper.initialize(ZeroAddress, wrapperContractOwner.address),
        ).to.be.revertedWithCustomError(fermionWrapper, "InvalidInitialization");
      });

      it("Second initialization via proxy fails", async function () {
        await fermionWrapperProxy.initialize(ZeroAddress, wrapperContractOwner.address);

        await expect(
          fermionWrapperProxy.initialize(ZeroAddress, wrapperContractOwner.address),
        ).to.be.revertedWithCustomError(fermionWrapper, "InvalidInitialization");
      });
    });
  });

  context("transferOwnership", function () {
    beforeEach(async function () {
      await fermionWrapperProxy.initialize(ZeroAddress, wrapperContractOwner.address);
    });

    it("Initialization caller can transfer the ownership", async function () {
      const newOwner = wallets[3];

      await expect(fermionWrapperProxy.transferOwnership(newOwner))
        .to.emit(fermionWrapperProxy, "OwnershipTransferred")
        .withArgs(wrapperContractOwner.address, newOwner.address);

      expect(await fermionWrapperProxy.owner()).to.equal(newOwner.address);
    });

    context("Revert reasons", function () {
      it("Unauthorized call", async function () {
        const newOwner = wallets[3];
        await expect(fermionWrapperProxy.connect(newOwner).transferOwnership(newOwner.address))
          .to.be.revertedWithCustomError(fermionWrapperProxy, "OwnableUnauthorizedAccount")
          .withArgs(newOwner.address);
      });

      it("The owner cannot transfer it directly", async function () {
        expect(await fermionWrapperProxy.owner()).to.equal(wrapperContractOwner.address);

        const newOwner = wallets[3];
        await expect(fermionWrapperProxy.connect(wrapperContractOwner).transferOwnership(newOwner.address))
          .to.be.revertedWithCustomError(fermionWrapperProxy, "OwnableUnauthorizedAccount")
          .withArgs(wrapperContractOwner.address);
      });
    });
  });

  context("wrapForAuction", function () {
    let seller: HardhatEthersSigner;
    const startTokenId = 2n ** 128n + 1n;
    const quantity = 10n;
    beforeEach(async function () {
      await mockBoson.mint(fermionProtocolSigner, startTokenId, quantity);

      await fermionWrapperProxy.initialize(await mockBoson.getAddress(), wrapperContractOwner.address);

      seller = wallets[3];
    });

    it("Protocol can wrap", async function () {
      await mockBoson.connect(fermionProtocolSigner).setApprovalForAll(await fermionWrapperProxy.getAddress(), true);
      const tx = await fermionWrapperProxy.wrapForAuction(startTokenId, quantity, seller.address);

      for (let i = 0n; i < quantity; i++) {
        const tokenId = startTokenId + i;
        await expect(tx).to.emit(fermionWrapperProxy, "Transfer").withArgs(ZeroAddress, seller.address, tokenId);
        expect(await fermionWrapperProxy.ownerOf(tokenId)).to.equal(seller.address);
      }
    });

    context("Revert reasons", function () {
      it("Unauthorized call", async function () {
        const randomWallet = wallets[4];
        await expect(fermionWrapperProxy.connect(randomWallet).wrapForAuction(startTokenId, quantity, seller.address))
          .to.be.revertedWithCustomError(mockBoson, "ERC721InsufficientApproval")
          .withArgs(await fermionWrapperProxy.getAddress(), startTokenId);
      });

      it("Wrapped vouchers cannot be transferred", async function () {
        const newOwner = wallets[4];
        await mockBoson.connect(fermionProtocolSigner).setApprovalForAll(await fermionWrapperProxy.getAddress(), true);
        await fermionWrapperProxy.wrapForAuction(startTokenId, quantity, seller.address);

        for (let i = 0n; i < quantity; i++) {
          const tokenId = startTokenId + i;
          await expect(fermionWrapperProxy.connect(seller).transferFrom(seller.address, newOwner.address, tokenId))
            .to.be.revertedWithCustomError(fermionWrapperProxy, "InvalidStateOrCaller")
            .withArgs(tokenId, seller.address, TokenState.Wrapped);
        }
      });
    });
  });

  context("unwrap/unwrapToSelf", function () {
    // This tests internal FermionFNFT.unwrap function, which is used by both unwrap and unwrapToSelf
    // Tests are done using only unwrapToSelf, since the setup is simpler

    let seller: HardhatEthersSigner;
    const startTokenId = 1;
    const quantity = 10;

    beforeEach(async function () {
      seller = wallets[3];

      await mockBoson.mint(fermionProtocolSigner, startTokenId, quantity);
      await fermionWrapperProxy.initialize(await mockBoson.getAddress(), wrapperContractOwner.address);
      await mockBoson.connect(fermionProtocolSigner).setApprovalForAll(await fermionWrapperProxy.getAddress(), true);
      await fermionWrapperProxy.wrapForAuction(startTokenId, quantity, seller.address);
    });

    it("Boson price discovery can unwrap", async function () {
      const tx = await fermionWrapperProxy.connect(mockBosonPriceDiscovery).unwrapToSelf(startTokenId, ZeroAddress, 0);

      await expect(tx)
        .to.emit(mockBoson, "Transfer")
        .withArgs(await fermionWrapperProxy.getAddress(), fermionProtocolSigner.address, startTokenId);

      expect(await mockBoson.ownerOf(startTokenId)).to.equal(fermionProtocolSigner.address);
      expect(await fermionWrapperProxy.tokenState(startTokenId)).to.equal(TokenState.Unverified);
    });

    context("Revert reasons", function () {
      it("Unauthorized call", async function () {
        // Fermion protocol
        await expect(fermionWrapperProxy.unwrapToSelf(startTokenId, ZeroAddress, 0))
          .to.be.revertedWithCustomError(fermionWrapperProxy, "InvalidStateOrCaller")
          .withArgs(startTokenId, fermionProtocolSigner.address, TokenState.Wrapped);

        // Seller
        await expect(fermionWrapperProxy.connect(seller).unwrapToSelf(startTokenId, ZeroAddress, 0))
          .to.be.revertedWithCustomError(fermionWrapperProxy, "InvalidStateOrCaller")
          .withArgs(startTokenId, seller.address, TokenState.Wrapped);

        // Random wallet
        const randomWallet = wallets[4];
        await expect(fermionWrapperProxy.connect(randomWallet).unwrapToSelf(startTokenId, ZeroAddress, 0))
          .to.be.revertedWithCustomError(fermionWrapperProxy, "InvalidStateOrCaller")
          .withArgs(startTokenId, randomWallet.address, TokenState.Wrapped);
      });

      it("Only wrapped tokens can be unwrapped", async function () {
        await fermionWrapperProxy.connect(mockBosonPriceDiscovery).unwrapToSelf(startTokenId, ZeroAddress, 0);

        await expect(fermionWrapperProxy.connect(mockBosonPriceDiscovery).unwrapToSelf(startTokenId, ZeroAddress, 0))
          .to.be.revertedWithCustomError(fermionWrapperProxy, "InvalidStateOrCaller")
          .withArgs(startTokenId, mockBosonPriceDiscovery.address, TokenState.Unverified);
      });
    });
  });
});
