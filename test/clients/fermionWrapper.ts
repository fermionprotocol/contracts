import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { getInterfaceID } from "../utils/common";
import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract } from "ethers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

const { ZeroAddress } = ethers;

describe("FermionWrapper", function () {
  let fermionWrapper: Contract, fermionWrapperProxy: Contract;
  let wallets: HardhatEthersSigner[];
  let fermionProtocolSigner: HardhatEthersSigner;
  let wrapperContractOwner: HardhatEthersSigner;

  async function setupFermionWrapperTest() {
    const FermionWrapper = await ethers.getContractFactory("FermionWrapper");
    const fermionWrapper = await FermionWrapper.deploy(ZeroAddress);

    const Proxy = await ethers.getContractFactory("MockProxy");
    const proxy = await Proxy.deploy(await fermionWrapper.getAddress());

    const fermionWrapperProxy = await ethers.getContractAt("FermionWrapper", await proxy.getAddress());

    return { fermionWrapper, fermionWrapperProxy };
  }

  before(async function () {
    ({ fermionWrapper, fermionWrapperProxy } = await loadFixture(setupFermionWrapperTest));
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
        ).to.be.revertedWithCustomError(fermionWrapper, "AlreadyInitialized");
      });

      it("Second initialization via proxy fails", async function () {
        await fermionWrapperProxy.initialize(ZeroAddress, wrapperContractOwner.address);

        await expect(
          fermionWrapperProxy.initialize(ZeroAddress, wrapperContractOwner.address),
        ).to.be.revertedWithCustomError(fermionWrapper, "AlreadyInitialized");
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
});
