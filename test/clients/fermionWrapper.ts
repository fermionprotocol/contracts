import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployMockTokens } from "../utils/common";
import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, ZeroHash } from "ethers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { TokenState } from "../utils/enums";

const { ZeroAddress } = ethers;

describe("FermionFNFT - wrapper tests", function () {
  let fermionWrapper: Contract, fermionWrapperProxy: Contract;
  let wallets: HardhatEthersSigner[];
  let fermionProtocolSigner: HardhatEthersSigner;
  let wrapperContractOwner: HardhatEthersSigner;
  let mockBosonPriceDiscovery: HardhatEthersSigner;
  let mockBoson: Contract;
  const metadataURI = "https://example.com";

  async function setupFermionWrapperTest() {
    wallets = await ethers.getSigners();
    fermionProtocolSigner = wallets[1]; // wallet that simulates the fermion protocol
    wrapperContractOwner = wallets[2];

    const [mockConduit, mockBosonPriceDiscovery] = wallets.slice(9, 11);

    const seaportWrapperConstructorArgs = [
      mockBosonPriceDiscovery.address,
      {
        seaport: wallets[10].address, // dummy address
        openSeaConduit: mockConduit.address,
        openSeaConduitKey: ZeroHash,
      },
    ];
    const FermionSeaportWrapper = await ethers.getContractFactory("SeaportWrapper");
    const fermionSeaportWrapper = await FermionSeaportWrapper.deploy(...seaportWrapperConstructorArgs);

    const FermionFNFT = await ethers.getContractFactory("FermionFNFT");
    const fermionWrapper = await FermionFNFT.deploy(
      mockBosonPriceDiscovery.address,
      await fermionSeaportWrapper.getAddress(),
      wallets[10].address,
    ); // dummy address

    const Proxy = await ethers.getContractFactory("MockProxy");
    const proxy = await Proxy.deploy(await fermionWrapper.getAddress());

    const fermionWrapperProxy = await ethers.getContractAt("FermionFNFT", await proxy.getAddress());

    const [mockBoson] = await deployMockTokens(["ERC721"]);
    return { fermionWrapper, fermionWrapperProxy, mockBoson, mockBosonPriceDiscovery };
  }

  before(async function () {
    ({ fermionWrapper, fermionWrapperProxy, mockBoson, mockBosonPriceDiscovery } =
      await loadFixture(setupFermionWrapperTest));

    fermionWrapperProxy = fermionWrapperProxy.connect(fermionProtocolSigner);
  });

  afterEach(async function () {
    await loadFixture(setupFermionWrapperTest);
  });

  context("initialize", function () {
    const offerId = 1n;

    it("Initialization via proxy sets the new owner and metadataURI", async function () {
      await expect(
        fermionWrapperProxy.initialize(ZeroAddress, wrapperContractOwner.address, ZeroAddress, offerId, metadataURI),
      )
        .to.emit(fermionWrapperProxy, "OwnershipTransferred")
        .withArgs(ZeroAddress, wrapperContractOwner.address);

      expect(await fermionWrapperProxy.owner()).to.equal(wrapperContractOwner.address);
      expect(await fermionWrapperProxy.contractURI()).to.equal(metadataURI);
    });

    context("Revert reasons", function () {
      it("Direct initialization fails", async function () {
        await expect(
          fermionWrapper.initialize(ZeroAddress, wrapperContractOwner.address, ZeroAddress, offerId, metadataURI),
        ).to.be.revertedWithCustomError(fermionWrapper, "InvalidInitialization");
      });

      it("Second initialization via proxy fails", async function () {
        await fermionWrapperProxy.initialize(
          ZeroAddress,
          wrapperContractOwner.address,
          ZeroAddress,
          offerId,
          metadataURI,
        );

        await expect(
          fermionWrapperProxy.initialize(ZeroAddress, wrapperContractOwner.address, ZeroAddress, offerId, metadataURI),
        ).to.be.revertedWithCustomError(fermionWrapper, "InvalidInitialization");
      });
    });
  });

  context("transferOwnership", function () {
    const offerId = 1n;
    beforeEach(async function () {
      await fermionWrapperProxy.initialize(
        ZeroAddress,
        wrapperContractOwner.address,
        ZeroAddress,
        offerId,
        metadataURI,
      );
    });

    it("Initialization caller can transfer the ownership", async function () {
      const newOwner = wallets[3];

      await expect(
        fermionProtocolSigner.sendTransaction({
          to: await fermionWrapperProxy.getAddress(),
          data:
            fermionWrapperProxy.interface.encodeFunctionData("transferOwnership", [newOwner.address]) +
            fermionProtocolSigner.address.slice(2), // append the address to mimic the fermion protocol behavior
        }),
      )
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

        await expect(
          newOwner.sendTransaction({
            to: await fermionWrapperProxy.getAddress(),
            data:
              fermionWrapperProxy.interface.encodeFunctionData("transferOwnership", [newOwner.address]) +
              fermionProtocolSigner.address.slice(2), // append the address to mimic the fermion protocol behavior
          }),
        )
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
    const offerId = 1n;
    beforeEach(async function () {
      await mockBoson.mint(fermionProtocolSigner, startTokenId, quantity);

      await fermionWrapperProxy.initialize(
        await mockBoson.getAddress(),
        wrapperContractOwner.address,
        ZeroAddress,
        offerId,
        metadataURI,
      );

      seller = wallets[3];
    });

    it("Protocol can wrap", async function () {
      await mockBoson.connect(fermionProtocolSigner).setApprovalForAll(await fermionWrapperProxy.getAddress(), true);
      const tx = await fermionProtocolSigner.sendTransaction({
        to: await fermionWrapperProxy.getAddress(),
        data:
          fermionWrapperProxy.interface.encodeFunctionData("wrapForAuction", [startTokenId, quantity, seller.address]) +
          fermionProtocolSigner.address.slice(2), // append the address to mimic the fermion protocol behavior
      });

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
        await fermionProtocolSigner.sendTransaction({
          to: await fermionWrapperProxy.getAddress(),
          data:
            fermionWrapperProxy.interface.encodeFunctionData("wrapForAuction", [
              startTokenId,
              quantity,
              seller.address,
            ]) + fermionProtocolSigner.address.slice(2), // append the address to mimic the fermion protocol behavior
        });

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
    const startTokenId = 2n ** 128n + 1n;
    const quantity = 10n;
    const offerId = 1n;

    beforeEach(async function () {
      seller = wallets[3];

      await mockBoson.mint(fermionProtocolSigner, startTokenId, quantity);
      await fermionWrapperProxy.initialize(
        await mockBoson.getAddress(),
        wrapperContractOwner.address,
        ZeroAddress,
        offerId,
        metadataURI,
      );
      await mockBoson.connect(fermionProtocolSigner).setApprovalForAll(await fermionWrapperProxy.getAddress(), true);

      await fermionProtocolSigner.sendTransaction({
        to: await fermionWrapperProxy.getAddress(),
        data:
          fermionWrapperProxy.interface.encodeFunctionData("wrapForAuction", [startTokenId, quantity, seller.address]) +
          fermionProtocolSigner.address.slice(2), // append the address to mimic the fermion protocol behavior
      });
    });

    it("Boson price discovery can unwrap", async function () {
      await fermionProtocolSigner.sendTransaction({
        to: await fermionWrapperProxy.getAddress(),
        data:
          fermionWrapperProxy.interface.encodeFunctionData("pushToNextTokenState", [
            startTokenId,
            TokenState.Unwrapping,
          ]) + fermionProtocolSigner.address.slice(2), // append the address to mimic the fermion protocol behavior
      });

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
        await fermionProtocolSigner.sendTransaction({
          to: await fermionWrapperProxy.getAddress(),
          data:
            fermionWrapperProxy.interface.encodeFunctionData("pushToNextTokenState", [
              startTokenId,
              TokenState.Unwrapping,
            ]) + fermionProtocolSigner.address.slice(2), // append the address to mimic the fermion protocol behavior
        });

        await fermionWrapperProxy.connect(mockBosonPriceDiscovery).unwrapToSelf(startTokenId, ZeroAddress, 0);

        await expect(fermionWrapperProxy.connect(mockBosonPriceDiscovery).unwrapToSelf(startTokenId, ZeroAddress, 0))
          .to.be.revertedWithCustomError(fermionWrapperProxy, "InvalidStateOrCaller")
          .withArgs(startTokenId, mockBosonPriceDiscovery.address, TokenState.Unverified);
      });

      it("Unwrapped but unverified FNFTs cannot be transferred", async function () {
        const newOwner = wallets[4];
        await fermionProtocolSigner.sendTransaction({
          to: await fermionWrapperProxy.getAddress(),
          data:
            fermionWrapperProxy.interface.encodeFunctionData("pushToNextTokenState", [
              startTokenId,
              TokenState.Unwrapping,
            ]) + fermionProtocolSigner.address.slice(2), // append the address to mimic the fermion protocol behavior
        });

        await fermionWrapperProxy.connect(mockBosonPriceDiscovery).unwrapToSelf(startTokenId, ZeroAddress, 0);

        await expect(fermionWrapperProxy.connect(seller).transferFrom(seller.address, newOwner.address, startTokenId))
          .to.be.revertedWithCustomError(fermionWrapperProxy, "InvalidStateOrCaller")
          .withArgs(startTokenId, seller.address, TokenState.Unverified);
      });
    });
  });

  context("tokenURI", function () {
    const startTokenId = 2n ** 128n + 1n;
    const quantity = 10n;
    const offerId = 1n;

    beforeEach(async function () {
      await mockBoson.mint(fermionProtocolSigner, startTokenId, quantity);

      await fermionWrapperProxy.initialize(
        await mockBoson.getAddress(),
        wrapperContractOwner.address,
        ZeroAddress,
        offerId,
        metadataURI,
      );
    });

    it("All tokens have the same URI", async function () {
      const seller = wallets[3];
      await mockBoson.connect(fermionProtocolSigner).setApprovalForAll(await fermionWrapperProxy.getAddress(), true);
      await fermionProtocolSigner.sendTransaction({
        to: await fermionWrapperProxy.getAddress(),
        data:
          fermionWrapperProxy.interface.encodeFunctionData("wrapForAuction", [startTokenId, quantity, seller.address]) +
          fermionProtocolSigner.address.slice(2), // append the address to mimic the fermion protocol behavior
      });

      for (let i = 0n; i < quantity; i++) {
        const tokenId = startTokenId + i;
        expect(await fermionWrapperProxy.tokenURI(tokenId)).to.equal(metadataURI);
      }
    });

    context("Revert reasons", function () {
      it("Minted, but not wrapped", async function () {
        for (let i = 0n; i < quantity; i++) {
          const tokenId = startTokenId + i;
          await expect(fermionWrapperProxy.tokenURI(tokenId))
            .to.be.revertedWithCustomError(fermionWrapper, "ERC721NonexistentToken")
            .withArgs(tokenId);
        }
      });

      it("Non existent", async function () {
        let tokenId = 0n;
        await expect(fermionWrapperProxy.tokenURI(tokenId))
          .to.be.revertedWithCustomError(fermionWrapper, "ERC721NonexistentToken")
          .withArgs(tokenId);

        tokenId = startTokenId + quantity;
        await expect(fermionWrapperProxy.tokenURI(tokenId)).to.be.revertedWithCustomError(
          fermionWrapper,
          "ERC721NonexistentToken",
        );
      });
    });
  });
});
