import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { PausableRegion } from "../utils/enums";
import { deployFermionProtocolFixture } from "../utils/common";
import { Contract, ZeroAddress } from "ethers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import fermionConfig from "./../../fermion.config";

describe("Entity", function () {
  let configFacet: Contract, pauseFacet: Contract;
  let wallets: HardhatEthersSigner[];
  let fermionErrors: Contract;

  before(async function () {
    ({
      facets: { ConfigFacet: configFacet, PauseFacet: pauseFacet },
      fermionErrors,
      wallets,
    } = await loadFixture(deployFermionProtocolFixture));
  });

  afterEach(async function () {
    await loadFixture(deployFermionProtocolFixture);
  });

  describe("Config facet", function () {
    it("Check the initial values", async function () {
      expect(await configFacet.getTreasuryAddress()).to.equal(fermionConfig.protocolParameters.treasury);
      expect(await configFacet.getProtocolFeePercentage()).to.equal(
        fermionConfig.protocolParameters.protocolFeePercentage,
      );
      expect(await configFacet.getVerificationTimeout()).to.equal(fermionConfig.protocolParameters.verificationTimeout);
    });

    it("Set the treasury address", async function () {
      const newTreasury = wallets[2].address;
      const tx = await configFacet.setTreasuryAddress(newTreasury);
      await expect(tx).to.emit(configFacet, "TreasuryAddressChanged").withArgs(newTreasury);

      expect(await configFacet.getTreasuryAddress()).to.equal(newTreasury);
    });

    it("Set the protocol fee percentage", async function () {
      const newPercentage = 1000;
      const tx = await configFacet.setProtocolFeePercentage(newPercentage);
      await expect(tx).to.emit(configFacet, "ProtocolFeePercentageChanged").withArgs(newPercentage);

      expect(await configFacet.getProtocolFeePercentage()).to.equal(newPercentage);
    });

    it("Set the verification timeout", async function () {
      const newTimeout = 60n * 60n * 24n * 14n;
      const tx = await configFacet.setVerificationTimeout(newTimeout);
      await expect(tx).to.emit(configFacet, "VerificationTimeoutChanged").withArgs(newTimeout);

      expect(await configFacet.getVerificationTimeout()).to.equal(newTimeout);
    });

    context("Revert reasons", function () {
      it("Caller is not the admin", async function () {
        const accessControl = await ethers.getContractAt("IAccessControl", ethers.ZeroAddress);
        const adminRole = ethers.id("ADMIN");

        const randomWallet = wallets[2];

        await expect(configFacet.connect(randomWallet).setTreasuryAddress(randomWallet.address))
          .to.be.revertedWithCustomError(accessControl, "AccessControlUnauthorizedAccount")
          .withArgs(randomWallet, adminRole);

        await expect(configFacet.connect(randomWallet).setProtocolFeePercentage(1000))
          .to.be.revertedWithCustomError(accessControl, "AccessControlUnauthorizedAccount")
          .withArgs(randomWallet, adminRole);

        await expect(configFacet.connect(randomWallet).setVerificationTimeout(24n * 60n * 60n * 14n))
          .to.be.revertedWithCustomError(accessControl, "AccessControlUnauthorizedAccount")
          .withArgs(randomWallet, adminRole);
      });

      it("Region is paused", async function () {
        await pauseFacet.pause([PausableRegion.Config]);

        await expect(configFacet.setTreasuryAddress(ZeroAddress))
          .to.be.revertedWithCustomError(fermionErrors, "RegionPaused")
          .withArgs(PausableRegion.Config);

        await expect(configFacet.setProtocolFeePercentage(1000))
          .to.be.revertedWithCustomError(fermionErrors, "RegionPaused")
          .withArgs(PausableRegion.Config);

        await expect(configFacet.setVerificationTimeout(24n * 60n * 60n * 14n))
          .to.be.revertedWithCustomError(fermionErrors, "RegionPaused")
          .withArgs(PausableRegion.Config);
      });

      it("Zero treasury address", async function () {
        await expect(configFacet.setTreasuryAddress(ZeroAddress)).to.be.revertedWithCustomError(
          fermionErrors,
          "InvalidAddress",
        );
      });

      it("Invalid protocol percentage", async function () {
        const percentage = 10001n;
        await expect(configFacet.setProtocolFeePercentage(percentage))
          .to.be.revertedWithCustomError(fermionErrors, "InvalidPercentage")
          .withArgs(percentage);
      });

      it("Zero verification timeout", async function () {
        await expect(configFacet.setVerificationTimeout(0n)).to.be.revertedWithCustomError(
          fermionErrors,
          "ZeroNotAllowed",
        );
      });
    });
  });
});
