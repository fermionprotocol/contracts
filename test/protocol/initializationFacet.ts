import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployFermionProtocolFixture, getBosonHandler } from "../utils/common";
import { expect } from "chai";
import { ethers } from "hardhat";
import { makeDiamondCut } from "../../scripts/deploy";

const { ZeroAddress } = ethers;

describe("Entity", function () {
  let initializationFacet;
  let fermionErrors;
  let fermionProtocolAddress: string;
  let initializationFacetImplementationAddress: string;

  before(async function () {
    ({
      diamondAddress: fermionProtocolAddress,
      facets: { InitializationFacet: initializationFacet },
      implementationAddresses: { InitializationFacet: initializationFacetImplementationAddress },
      fermionErrors,
    } = await loadFixture(deployFermionProtocolFixture));
  });

  afterEach(async function () {
    await loadFixture(deployFermionProtocolFixture);
  });

  describe("Initialization facet", function () {
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
      });

      context("Revert reasons", function () {
        it("Initializing again fails", async function () {
          const accountHandler = await getBosonHandler("IBosonAccountHandler");
          const initializeBosonSeller = initializationFacet.interface.encodeFunctionData(
            "initializeBosonSellerAndBuyer",
            [await accountHandler.getAddress()],
          );

          await expect(
            makeDiamondCut(fermionProtocolAddress, [], await initializationFacet.getAddress(), initializeBosonSeller),
          ).to.be.revertedWithCustomError(accountHandler, "SellerAddressMustBeUnique");
        });

        it("Initializing again fails", async function () {
          const initializeBosonSeller = initializationFacet.interface.encodeFunctionData(
            "initializeBosonSellerAndBuyer",
            [ZeroAddress],
          );

          await expect(
            makeDiamondCut(fermionProtocolAddress, [], initializationFacetImplementationAddress, initializeBosonSeller),
          ).to.be.revertedWithCustomError(fermionErrors, "InvalidAddress");
        });

        it("Direct initialization", async function () {
          const initializationFacetImplementation = initializationFacet.attach(
            initializationFacetImplementationAddress,
          );

          await expect(
            initializationFacetImplementation.initializeBosonSellerAndBuyer(ZeroAddress),
          ).to.be.revertedWithCustomError(fermionErrors, "DirectInitializationNotAllowed");
        });

        it("initializeBosonSellerAndBuyer is not registered", async function () {
          const initializeBosonSeller = initializationFacet.interface.encodeFunctionData(
            "initializeBosonSellerAndBuyer",
            [ZeroAddress],
          );
          const selector = initializationFacet.interface.getFunction("initializeBosonSellerAndBuyer").selector;
          const diamond = await ethers.getContractAt("Diamond", fermionProtocolAddress);

          await expect(makeDiamondCut(fermionProtocolAddress, [], fermionProtocolAddress, initializeBosonSeller))
            .to.be.revertedWithCustomError(diamond, "FunctionNotFound")
            .withArgs(selector);
        });
      });
    });
  });
});
