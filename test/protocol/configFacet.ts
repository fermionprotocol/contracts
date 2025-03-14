import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { PausableRegion } from "../utils/enums";
import { deployFermionProtocolFixture, deployMockTokens } from "../utils/common";
import { Contract, parseUnits, ZeroAddress } from "ethers";
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
      expect(await configFacet.getMaxRoyaltyPercentage()).to.equal(
        fermionConfig.protocolParameters.maxRoyaltyPercentage,
      );
      expect(await configFacet.getDefaultVerificationTimeout()).to.equal(
        fermionConfig.protocolParameters.defaultVerificationTimeout,
      );
      expect(await configFacet.getMaxVerificationTimeout()).to.equal(
        fermionConfig.protocolParameters.maxVerificationTimeout,
      );
      if ("openSeaFeePercentage" in fermionConfig.protocolParameters) {
        expect(await configFacet.getOpenSeaFeePercentage()).to.equal(
          fermionConfig.protocolParameters.openSeaFeePercentage,
        );
      }
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

    it("Set the max royalty percentage", async function () {
      const newPercentage = 80_00;
      const tx = await configFacet.setMaxRoyaltyPercentage(newPercentage);
      await expect(tx).to.emit(configFacet, "MaxRoyaltyPercentageChanged").withArgs(newPercentage);

      expect(await configFacet.getMaxRoyaltyPercentage()).to.equal(newPercentage);
    });

    it("Set the protocol fee table", async function () {
      const FIVE_PERCENT = 500;
      const TEN_PERCENT = 1000;
      const TWENTY_PERCENT = 2000;

      const feePriceRanges = [
        parseUnits("1", "ether").toString(),
        parseUnits("2", "ether").toString(),
        parseUnits("5", "ether").toString(),
      ];
      const feePercentages = [FIVE_PERCENT, TEN_PERCENT, TWENTY_PERCENT];
      const usdcAddress = await wallets[3].getAddress();
      await expect(configFacet.setProtocolFeeTable(usdcAddress, feePriceRanges, feePercentages))
        .to.emit(configFacet, "FeeTableUpdated")
        .withArgs(usdcAddress, feePriceRanges, feePercentages);

      let exchangeAmount, feeTier;
      // check if for every price within a price range the corresponding percentage is returned
      for (let i = 0; i < feePriceRanges.length; i++) {
        exchangeAmount = feePriceRanges[i];
        feeTier = feePercentages[i];
        expect(await configFacet.getProtocolFeePercentage(usdcAddress, exchangeAmount)).to.equal(feeTier);
      }

      // check for a way bigger price value, it should return the highest fee tier
      exchangeAmount = BigInt(feePriceRanges[feePriceRanges.length - 1]) * BigInt(2);
      feeTier = feePercentages[feePercentages.length - 1];
      expect(await configFacet.getProtocolFeePercentage(usdcAddress, exchangeAmount)).to.equal(feeTier);

      let [retrievedRanges, retrievedPercentages] = await configFacet.getProtocolFeeTable(usdcAddress);
      expect(retrievedRanges).to.deep.equal(feePriceRanges, "Incorrect price ranges");
      expect(retrievedPercentages).to.deep.equal(feePercentages, "Incorrect fee percentages");

      // Delete the protocol fee table
      await configFacet.setProtocolFeeTable(usdcAddress, [], []);
      const defaultFeePercentage = await configFacet.getProtocolFeePercentage();
      expect(await configFacet.getProtocolFeePercentage(usdcAddress, exchangeAmount)).to.equal(defaultFeePercentage);

      [retrievedRanges, retrievedPercentages] = await configFacet.getProtocolFeeTable(usdcAddress);
      expect(retrievedRanges.map((r: { toString: () => any }) => r.toString())).to.deep.equal(
        [],
        "Incorrect price ranges",
      );
      expect(retrievedPercentages.map((p: { toNumber: () => any }) => p.toNumber())).to.deep.equal(
        [],
        "Incorrect fee percentages",
      );
    });

    it("Set the default verification timeout", async function () {
      const newTimeout = 60n * 60n * 24n * 14n;
      const tx = await configFacet.setDefaultVerificationTimeout(newTimeout);
      await expect(tx).to.emit(configFacet, "DefaultVerificationTimeoutChanged").withArgs(newTimeout);

      expect(await configFacet.getDefaultVerificationTimeout()).to.equal(newTimeout);
    });

    it("Set the max verification timeout", async function () {
      const newTimeout = 60n * 60n * 24n * 60n;
      const tx = await configFacet.setMaxVerificationTimeout(newTimeout);
      await expect(tx).to.emit(configFacet, "MaxVerificationTimeoutChanged").withArgs(newTimeout);

      expect(await configFacet.getMaxVerificationTimeout()).to.equal(newTimeout);
    });

    it("Set the fermion FNFT implementation address", async function () {
      // Deploy a mock contract, since UpgradeableBeacon requires a contract address
      const [newImplementation] = await deployMockTokens(["ERC20"]);
      const newAddress = await newImplementation.getAddress();
      const tx = await configFacet.setFNFTImplementationAddress(newAddress);
      await expect(tx).to.emit(configFacet, "FermionFNFTImplementationChanged").withArgs(newAddress);

      expect(await configFacet.getFNFTImplementationAddress()).to.equal(newAddress);
    });

    it("Set the OpenSea fee percentage", async function () {
      const newPercentage = 300; // 3%
      const tx = await configFacet.setOpenSeaFeePercentage(newPercentage);
      await expect(tx).to.emit(configFacet, "OpenSeaFeePercentageChanged").withArgs(newPercentage);

      expect(await configFacet.getOpenSeaFeePercentage()).to.equal(newPercentage);
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

        await expect(configFacet.connect(randomWallet).setMaxRoyaltyPercentage(1000))
          .to.be.revertedWithCustomError(accessControl, "AccessControlUnauthorizedAccount")
          .withArgs(randomWallet, adminRole);

        await expect(configFacet.connect(randomWallet).setDefaultVerificationTimeout(24n * 60n * 60n * 14n))
          .to.be.revertedWithCustomError(accessControl, "AccessControlUnauthorizedAccount")
          .withArgs(randomWallet, adminRole);

        await expect(configFacet.connect(randomWallet).setMaxVerificationTimeout(24n * 60n * 60n * 60n))
          .to.be.revertedWithCustomError(accessControl, "AccessControlUnauthorizedAccount")
          .withArgs(randomWallet, adminRole);

        await expect(configFacet.connect(randomWallet).setFNFTImplementationAddress(wallets[10].address))
          .to.be.revertedWithCustomError(accessControl, "AccessControlUnauthorizedAccount")
          .withArgs(randomWallet, adminRole);

        await expect(
          configFacet
            .connect(randomWallet)
            .setProtocolFeeTable(wallets[10].address, [1000, 1000, 1000], [500, 500, 500]),
        )
          .to.be.revertedWithCustomError(accessControl, "AccessControlUnauthorizedAccount")
          .withArgs(randomWallet, adminRole);

        await expect(configFacet.connect(randomWallet).setOpenSeaFeePercentage(300))
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

        await expect(configFacet.setMaxRoyaltyPercentage(1000))
          .to.be.revertedWithCustomError(fermionErrors, "RegionPaused")
          .withArgs(PausableRegion.Config);

        await expect(configFacet.setDefaultVerificationTimeout(24n * 60n * 60n * 14n))
          .to.be.revertedWithCustomError(fermionErrors, "RegionPaused")
          .withArgs(PausableRegion.Config);

        await expect(configFacet.setMaxVerificationTimeout(24n * 60n * 60n * 60n))
          .to.be.revertedWithCustomError(fermionErrors, "RegionPaused")
          .withArgs(PausableRegion.Config);

        await expect(configFacet.setFNFTImplementationAddress(wallets[10].address))
          .to.be.revertedWithCustomError(fermionErrors, "RegionPaused")
          .withArgs(PausableRegion.Config);

        await expect(configFacet.setOpenSeaFeePercentage(300))
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

        await expect(configFacet.setProtocolFeeTable(wallets[10].address, [1000, 2000, 3000], [500, 1000, percentage]))
          .to.be.revertedWithCustomError(fermionErrors, "InvalidPercentage")
          .withArgs(percentage);
      });

      it("Invalid max royalty percentage", async function () {
        const percentage = 10001n;
        await expect(configFacet.setMaxRoyaltyPercentage(percentage))
          .to.be.revertedWithCustomError(fermionErrors, "InvalidPercentage")
          .withArgs(percentage);
      });

      it("price ranges are not in ascending order", async function () {
        const newPriceRanges = [
          parseUnits("1", "ether").toString(),
          parseUnits("3", "ether").toString(),
          parseUnits("2", "ether").toString(),
        ];

        await expect(
          configFacet.setProtocolFeeTable(wallets[10].address, newPriceRanges, [500, 1000, 2000]),
        ).to.revertedWithCustomError(fermionErrors, "NonAscendingOrder");
      });

      it("price ranges and percent tiers are different length", async function () {
        await expect(
          configFacet.setProtocolFeeTable(wallets[10].address, [1000, 1000, 1000, 1000], [500, 1000, 2000]),
        ).to.revertedWithCustomError(fermionErrors, "ArrayLengthMismatch");

        await expect(
          configFacet.setProtocolFeeTable(wallets[10].address, [1000, 1000, 1000], [500, 1000, 2000, 3000]),
        ).to.revertedWithCustomError(fermionErrors, "ArrayLengthMismatch");
      });

      it("Zero default verification timeout", async function () {
        await expect(configFacet.setDefaultVerificationTimeout(0n)).to.be.revertedWithCustomError(
          fermionErrors,
          "ZeroNotAllowed",
        );
      });

      it("Zero max verification timeout", async function () {
        await expect(configFacet.setMaxVerificationTimeout(0n)).to.be.revertedWithCustomError(
          fermionErrors,
          "ZeroNotAllowed",
        );
      });

      it("Default verification timeout is grater than max verification timeout", async function () {
        const defaultVerificationTimeout = fermionConfig.protocolParameters.maxVerificationTimeout + 1n;
        await expect(configFacet.setDefaultVerificationTimeout(defaultVerificationTimeout))
          .to.be.revertedWithCustomError(fermionErrors, "VerificationTimeoutTooLong")
          .withArgs(defaultVerificationTimeout, fermionConfig.protocolParameters.maxVerificationTimeout);
      });

      it("Zero FNFT implementation address", async function () {
        await expect(configFacet.setFNFTImplementationAddress(ZeroAddress)).to.be.revertedWithCustomError(
          fermionErrors,
          "InvalidAddress",
        );
      });

      it("New implementation does not have the code", async function () {
        const beacon = await ethers.getContractAt("UpgradeableBeacon", ZeroAddress);
        await expect(configFacet.setFNFTImplementationAddress(wallets[10].address)).to.be.revertedWithCustomError(
          beacon,
          "BeaconInvalidImplementation",
        );
      });

      it("Invalid OpenSea fee percentage", async function () {
        const percentage = 10001n;
        await expect(configFacet.setOpenSeaFeePercentage(percentage))
          .to.be.revertedWithCustomError(fermionErrors, "InvalidPercentage")
          .withArgs(percentage);
      });
    });
  });
});
