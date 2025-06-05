import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, ContractFactory, ZeroAddress } from "ethers";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployFermionProtocolFixture } from "../utils/common";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("PriceOracleRegistryFacet", function () {
  let priceOracleRegistryFacet: Contract;
  let fermionErrors: Contract;
  let wallets: HardhatEthersSigner[];
  let mockOracle: Contract;
  let MockPriceOracle: ContractFactory;

  before(async function () {
    ({
      facets: { PriceOracleRegistryFacet: priceOracleRegistryFacet },
      fermionErrors,
      wallets,
    } = await loadFixture(deployFermionProtocolFixture));
    MockPriceOracle = await ethers.getContractFactory("MockPriceOracle");
    mockOracle = await MockPriceOracle.deploy();
    await mockOracle.setPrice(ethers.parseEther("1.5"));
  });

  describe("Price Oracle Registry", function () {
    context("Add Price Oracle", function () {
      it("Should add a valid price oracle", async function () {
        const identifier = ethers.encodeBytes32String("GOLD");

        const tx = await priceOracleRegistryFacet.addPriceOracle(await mockOracle.getAddress(), identifier);
        await expect(tx)
          .to.emit(priceOracleRegistryFacet, "PriceOracleAdded")
          .withArgs(await mockOracle.getAddress(), identifier);

        const isApproved = await priceOracleRegistryFacet.isPriceOracleApproved(await mockOracle.getAddress());
        expect(isApproved).to.equal(true);

        const oracleIdentifier = await priceOracleRegistryFacet.getPriceOracleIdentifier(await mockOracle.getAddress());
        expect(oracleIdentifier).to.equal(identifier);
      });

      it("Should revert when adding an oracle with zero address", async function () {
        const identifier = ethers.encodeBytes32String("REAL_ESTATE");
        await expect(priceOracleRegistryFacet.addPriceOracle(ZeroAddress, identifier)).to.be.revertedWithCustomError(
          fermionErrors,
          "InvalidAddress",
        );
      });

      it("Should revert when adding an oracle with an empty identifier", async function () {
        await expect(
          priceOracleRegistryFacet.addPriceOracle(await mockOracle.getAddress(), ethers.ZeroHash),
        ).to.be.revertedWithCustomError(fermionErrors, "InvalidIdentifier");
      });

      it("Should revert when adding an already approved oracle", async function () {
        const identifier = ethers.encodeBytes32String("REAL_ESTATE");

        await expect(
          priceOracleRegistryFacet.addPriceOracle(await mockOracle.getAddress(), identifier),
        ).to.be.revertedWithCustomError(fermionErrors, "OracleAlreadyApproved");
      });

      it("Should revert when oracle returns invalid price", async function () {
        const identifier = ethers.encodeBytes32String("INVALID_ORACLE");
        const newMockOracle: Contract = await MockPriceOracle.deploy();
        await newMockOracle.setPrice(0);

        await expect(
          priceOracleRegistryFacet.addPriceOracle(await newMockOracle.getAddress(), identifier),
        ).to.be.revertedWithCustomError(fermionErrors, "OracleReturnedInvalidPrice");
      });

      it("Should revert when oracle validation fails", async function () {
        const identifier = ethers.encodeBytes32String("FAILING_ORACLE");

        const newMockOracle: Contract = await MockPriceOracle.deploy();
        await newMockOracle.setPrice(ethers.parseEther("1.5"));
        await newMockOracle.enableInvalidPriceRevert(true);

        await expect(
          priceOracleRegistryFacet.addPriceOracle(await newMockOracle.getAddress(), identifier),
        ).to.be.revertedWithCustomError(fermionErrors, "OracleValidationFailed");
      });
    });

    context("Remove Price Oracle", function () {
      it("Should remove a valid price oracle", async function () {
        const oracleAddress = await mockOracle.getAddress();
        await mockOracle.setPrice(ethers.parseEther("2.0"));

        const tx = await priceOracleRegistryFacet.removePriceOracle(oracleAddress);
        await expect(tx).to.emit(priceOracleRegistryFacet, "PriceOracleRemoved").withArgs(oracleAddress);

        const isApproved = await priceOracleRegistryFacet.isPriceOracleApproved(oracleAddress);
        expect(isApproved).to.equal(false);

        const oracleIdentifier = await priceOracleRegistryFacet.getPriceOracleIdentifier(oracleAddress);
        expect(oracleIdentifier).to.equal(ethers.ZeroHash);
      });

      it("Should revert when removing a non-approved oracle", async function () {
        const nonApprovedOracle = wallets[3].address;

        await expect(priceOracleRegistryFacet.removePriceOracle(nonApprovedOracle)).to.be.revertedWithCustomError(
          fermionErrors,
          "OracleNotApproved",
        );
      });
    });

    context("Authorization and Access Control", function () {
      let accessControl: Contract;

      before(async function () {
        accessControl = await ethers.getContractAt("IAccessControl", ethers.ZeroAddress);
      });

      it("Should revert when caller is not an admin for adding an oracle", async function () {
        const identifier = ethers.encodeBytes32String("RANDOM_ID");
        const randomWallet = wallets[2];
        await expect(
          priceOracleRegistryFacet.connect(randomWallet).addPriceOracle(await mockOracle.getAddress(), identifier),
        ).to.be.revertedWithCustomError(accessControl, "AccessControlUnauthorizedAccount");
      });

      it("Should revert when caller is not an admin for removing an oracle", async function () {
        const randomWallet = wallets[2];
        await expect(
          priceOracleRegistryFacet.connect(randomWallet).removePriceOracle(await mockOracle.getAddress()),
        ).to.be.revertedWithCustomError(accessControl, "AccessControlUnauthorizedAccount");
      });
    });
  });
});
