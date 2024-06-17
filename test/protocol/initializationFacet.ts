import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployFermionProtocolFixture } from "../utils/common";
import { getBosonHandler } from "../utils/boson-protocol";
import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract } from "ethers";
import { makeDiamondCut } from "../../scripts/deploy";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

const { encodeBytes32String, ZeroAddress, ZeroHash } = ethers;

describe("Initialization", function () {
  let initializationFacet: Contract;
  let fermionErrors: Contract;
  let fermionProtocolAddress: string;
  let initializationFacetImplementationAddress: string;
  let wallets: HardhatEthersSigner[];

  before(async function () {
    ({
      diamondAddress: fermionProtocolAddress,
      facets: { InitializationFacet: initializationFacet },
      implementationAddresses: { InitializationFacet: initializationFacetImplementationAddress },
      fermionErrors,
      wallets,
    } = await loadFixture(deployFermionProtocolFixture));
  });

  afterEach(async function () {
    await loadFixture(deployFermionProtocolFixture);
  });

  describe("Initialization facet", function () {
    let accessControllerAddress: string;
    let defaultAdmin: HardhatEthersSigner;
    before(async function () {
      const accessControllerFactory = await ethers.getContractFactory("AccessController");
      const accessController = await accessControllerFactory.deploy();
      accessControllerAddress = await accessController.getAddress();
      defaultAdmin = wallets[0];
    });

    context("Initial deployment", function () {
      it("Check Boson Roles", async function () {
        const accountHandler = await getBosonHandler("IBosonAccountHandler");

        const [exists, seller] = await accountHandler.getSellerByAddress(fermionProtocolAddress);

        expect(exists).to.be.true;
        expect(seller.assistant).to.equal(fermionProtocolAddress);
        expect(seller.admin).to.equal(fermionProtocolAddress);
        expect(seller.treasury).to.equal(fermionProtocolAddress);
        expect(seller.metadataUri).to.equal("");

        const buyerId = seller.id + 1n;
        const [existsBuyer, buyer] = await accountHandler.getBuyer(buyerId);

        expect(existsBuyer).to.be.true;
        expect(buyer.wallet).to.equal(fermionProtocolAddress);

        const [existDR, disputeResolver, , sellerAllowList] =
          await accountHandler.getDisputeResolverByAddress(fermionProtocolAddress);
        expect(existDR).to.be.true;
        expect(disputeResolver.assistant).to.equal(fermionProtocolAddress);
        expect(disputeResolver.admin).to.equal(fermionProtocolAddress);
        expect(disputeResolver.treasury).to.equal(fermionProtocolAddress);
        expect(disputeResolver.metadataUri).to.equal("");
        expect(sellerAllowList).to.eql([seller.id]);
      });

      context("Revert reasons", function () {
        it("Initializing again fails", async function () {
          const accountHandler = await getBosonHandler("IBosonAccountHandler");
          const initializeBosonSeller = initializationFacet.interface.encodeFunctionData("initializeDiamond", [
            accessControllerAddress,
            defaultAdmin.address,
            await accountHandler.getAddress(),
            fermionProtocolAddress, // dummy value
          ]);

          await expect(
            makeDiamondCut(fermionProtocolAddress, [], initializationFacetImplementationAddress, initializeBosonSeller),
          ).to.be.revertedWithCustomError(accountHandler, "SellerAddressMustBeUnique");
        });

        it("Boson protocol address is 0", async function () {
          const initializeBosonSeller = initializationFacet.interface.encodeFunctionData("initializeDiamond", [
            accessControllerAddress,
            defaultAdmin.address,
            ZeroAddress,
            fermionProtocolAddress, // dummy value
          ]);

          await expect(
            makeDiamondCut(fermionProtocolAddress, [], initializationFacetImplementationAddress, initializeBosonSeller),
          ).to.be.revertedWithCustomError(fermionErrors, "InvalidAddress");
        });

        it("Wrapper implementation address is 0", async function () {
          const initializeBosonSeller = initializationFacet.interface.encodeFunctionData("initializeDiamond", [
            accessControllerAddress,
            defaultAdmin.address,
            fermionProtocolAddress, // dummy value
            ZeroAddress,
          ]);

          await expect(
            makeDiamondCut(fermionProtocolAddress, [], initializationFacetImplementationAddress, initializeBosonSeller),
          ).to.be.revertedWithCustomError(fermionErrors, "InvalidAddress");
        });

        it("Direct initialization", async function () {
          const initializationFacetImplementation = initializationFacet.attach(
            initializationFacetImplementationAddress,
          );

          await expect(
            initializationFacetImplementation.initializeDiamond(ZeroAddress, ZeroAddress, ZeroAddress, ZeroAddress),
          ).to.be.revertedWithCustomError(fermionErrors, "DirectInitializationNotAllowed");
        });

        it("initializeDiamond is not registered", async function () {
          const initializeBosonSeller = initializationFacet.interface.encodeFunctionData("initializeDiamond", [
            accessControllerAddress,
            defaultAdmin.address,
            ZeroAddress,
            ZeroAddress,
          ]);
          const selector = initializationFacet.interface.getFunction("initializeDiamond").selector;
          const diamond = await ethers.getContractAt("Diamond", fermionProtocolAddress);

          await expect(makeDiamondCut(fermionProtocolAddress, [], fermionProtocolAddress, initializeBosonSeller))
            .to.be.revertedWithCustomError(diamond, "FunctionNotFound")
            .withArgs(selector);
        });
      });
    });

    context("Upgrades", function () {
      it("Emits ProtocolInitialized event", async function () {
        const newVersion = encodeBytes32String("v0.0.1");

        const initializationCall = initializationFacet.interface.encodeFunctionData("initialize", [
          newVersion,
          [],
          [],
          [],
          [],
        ]);

        await expect(
          makeDiamondCut(fermionProtocolAddress, [], initializationFacetImplementationAddress, initializationCall),
        )
          .to.emit(initializationFacet, "ProtocolInitialized")
          .withArgs(newVersion);
      });

      it("Sets a new version", async function () {
        const newVersion = "v0.0.1";

        const initializationCall = initializationFacet.interface.encodeFunctionData("initialize", [
          encodeBytes32String(newVersion),
          [],
          [],
          [],
          [],
        ]);

        await makeDiamondCut(fermionProtocolAddress, [], initializationFacetImplementationAddress, initializationCall);

        const protocolVersion = (await initializationFacet.getVersion()).replace(/\0/g, "");

        expect(protocolVersion).to.equal(newVersion);
      });

      it("Registers interface", async function () {
        const newVersion = encodeBytes32String("v0.0.1");
        let interfacesToAdd = ["0x11111111", "0x22222222", "0x33333333", "0x44444444"];

        const initializationCall = initializationFacet.interface.encodeFunctionData("initialize", [
          newVersion,
          [],
          [],
          interfacesToAdd,
          [],
        ]);

        await makeDiamondCut(fermionProtocolAddress, [], initializationFacetImplementationAddress, initializationCall);

        const IERC165 = await ethers.getContractAt("IERC165", fermionProtocolAddress);
        for (const interfaceId of interfacesToAdd) {
          expect(await IERC165.supportsInterface(interfaceId)).to.be.true;
        }

        let interfacesToRemove = ["0x22222222", "0x44444444"];
        const initializationCall2 = initializationFacet.interface.encodeFunctionData("initialize", [
          newVersion,
          [],
          [],
          [],
          interfacesToRemove,
        ]);

        await makeDiamondCut(fermionProtocolAddress, [], initializationFacetImplementationAddress, initializationCall2);
        for (const interfaceId of interfacesToRemove) {
          expect(await IERC165.supportsInterface(interfaceId)).to.be.false;
        }

        interfacesToAdd = ["0x55555555", "0x66666666"];
        interfacesToRemove = ["0x11111111", "0x33333333"];

        const initializationCall3 = initializationFacet.interface.encodeFunctionData("initialize", [
          newVersion,
          [],
          [],
          interfacesToAdd,
          interfacesToRemove,
        ]);

        await makeDiamondCut(fermionProtocolAddress, [], initializationFacetImplementationAddress, initializationCall3);

        for (const interfaceId of ["0x11111111", "0x22222222", "0x33333333", "0x44444444"]) {
          expect(await IERC165.supportsInterface(interfaceId)).to.be.false;
        }
        for (const interfaceId of ["0x55555555", "0x66666666"]) {
          expect(await IERC165.supportsInterface(interfaceId)).to.be.true;
        }
      });

      it("Facet is called", async function () {
        const newVersion = encodeBytes32String("v0.0.1");

        const testInitializationFactoey = await ethers.getContractFactory("TestInitialization");
        const testInitializationFacet = await testInitializationFactoey.deploy();

        const initializationCall = initializationFacet.interface.encodeFunctionData("initialize", [
          newVersion,
          [await testInitializationFacet.getAddress()],
          [testInitializationFacet.interface.encodeFunctionData("init", [0])], // 0: init normally
          [],
          [],
        ]);

        await expect(
          makeDiamondCut(fermionProtocolAddress, [], initializationFacetImplementationAddress, initializationCall),
        )
          .to.emit(testInitializationFacet.attach(fermionProtocolAddress), "FacetInitialized")
          .withArgs(fermionProtocolAddress);
      });

      context("Revert reasons", function () {
        it("initialize is not registered", async function () {
          const initializationCall = initializationFacet.interface.encodeFunctionData("initialize", [
            ZeroHash,
            [],
            [],
            [],
            [],
          ]);

          const selector = initializationFacet.interface.getFunction("initialize").selector;
          const diamond = await ethers.getContractAt("Diamond", fermionProtocolAddress);

          await expect(makeDiamondCut(fermionProtocolAddress, [], fermionProtocolAddress, initializationCall))
            .to.be.revertedWithCustomError(diamond, "FunctionNotFound")
            .withArgs(selector);
        });

        it("Initializing again fails", async function () {
          const initializationCall = initializationFacet.interface.encodeFunctionData("initialize", [
            ZeroHash,
            [],
            [],
            [],
            [],
          ]);

          await expect(
            makeDiamondCut(fermionProtocolAddress, [], initializationFacetImplementationAddress, initializationCall),
          ).to.be.revertedWithCustomError(fermionErrors, "VersionMustBeSet");
        });

        it("Mismatch between addresses and calldatas", async function () {
          const addresses = [fermionProtocolAddress, ZeroAddress];
          const calldatas = [ZeroHash];

          const initializationCall = initializationFacet.interface.encodeFunctionData("initialize", [
            encodeBytes32String("v0.0.1"),
            addresses,
            calldatas,
            [],
            [],
          ]);

          await expect(
            makeDiamondCut(fermionProtocolAddress, [], initializationFacetImplementationAddress, initializationCall),
          )
            .to.be.revertedWithCustomError(fermionErrors, "AddressesAndCalldataLengthMismatch")
            .withArgs(addresses.length, calldatas.length);

          addresses.pop();
          calldatas.push(ZeroHash);
          const initializationCall2 = initializationFacet.interface.encodeFunctionData("initialize", [
            encodeBytes32String("v0.0.1"),
            addresses,
            calldatas,
            [],
            [],
          ]);

          await expect(
            makeDiamondCut(fermionProtocolAddress, [], initializationFacetImplementationAddress, initializationCall2),
          )
            .to.be.revertedWithCustomError(fermionErrors, "AddressesAndCalldataLengthMismatch")
            .withArgs(addresses.length, calldatas.length);
        });

        it("Direct initialization", async function () {
          const initializationFacetImplementation = initializationFacet.attach(
            initializationFacetImplementationAddress,
          );

          await expect(
            initializationFacetImplementation.initialize(ZeroHash, [], [], [], []),
          ).to.be.revertedWithCustomError(fermionErrors, "DirectInitializationNotAllowed");
        });

        context("initialization fails", function () {
          const newVersion = encodeBytes32String("v0.0.1");

          it("Facet without code", async function () {
            const noCodeAddress = wallets[2].address; // address without code
            const initializationCall = initializationFacet.interface.encodeFunctionData("initialize", [
              newVersion,
              [noCodeAddress],
              [ZeroHash],
              [],
              [],
            ]);

            const diamond = await ethers.getContractAt("Diamond", fermionProtocolAddress);

            await expect(
              makeDiamondCut(fermionProtocolAddress, [], initializationFacetImplementationAddress, initializationCall),
            )
              .to.be.revertedWithCustomError(diamond, "NoBytecodeAtAddress")
              .withArgs(noCodeAddress, "LibDiamondCut: _init address has no code");
          });

          it("Facet reverts with a reason", async function () {
            const testInitializationFactoey = await ethers.getContractFactory("TestInitialization");
            const testInitializationFacet = await testInitializationFactoey.deploy();

            const initializationCall = initializationFacet.interface.encodeFunctionData("initialize", [
              newVersion,
              [await testInitializationFacet.getAddress()],
              [testInitializationFacet.interface.encodeFunctionData("init", [1])], // 1: revert with reason
              [],
              [],
            ]);

            await expect(
              makeDiamondCut(fermionProtocolAddress, [], initializationFacetImplementationAddress, initializationCall),
            ).to.be.revertedWithCustomError(testInitializationFacet, "revertingFacet");
          });

          it("Facet reverts without a reason", async function () {
            const testInitializationFactoey = await ethers.getContractFactory("TestInitialization");
            const testInitializationFacet = await testInitializationFactoey.deploy();

            const facetAddress = await testInitializationFacet.getAddress();
            const facetInitCalldata = testInitializationFacet.interface.encodeFunctionData("init", [2]); // 2: revert without a reason

            const initializationCall = initializationFacet.interface.encodeFunctionData("initialize", [
              newVersion,
              [facetAddress],
              [facetInitCalldata],
              [],
              [],
            ]);

            const diamond = await ethers.getContractAt("Diamond", fermionProtocolAddress);

            await expect(
              makeDiamondCut(fermionProtocolAddress, [], initializationFacetImplementationAddress, initializationCall),
            )
              .to.be.revertedWithCustomError(diamond, "InitializationFunctionReverted")
              .withArgs(facetAddress, facetInitCalldata);
          });
        });
      });
    });
  });
});
