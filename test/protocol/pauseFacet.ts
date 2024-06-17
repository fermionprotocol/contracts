import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployFermionProtocolFixture } from "../utils/common";
import { expect } from "chai";
import { Contract } from "ethers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { PausableRegion, enumIterator } from "../utils/enums";
import { ethers } from "hardhat";

describe("Pause", function () {
  let pauseFacet: Contract;
  let fermionErrors: Contract;
  let wallets: HardhatEthersSigner[];

  before(async function () {
    ({
      facets: { PauseFacet: pauseFacet },
      fermionErrors,
      wallets,
    } = await loadFixture(deployFermionProtocolFixture));
  });

  afterEach(async function () {
    await loadFixture(deployFermionProtocolFixture);
  });

  context("pause", async function () {
    it("should pause the specified regions", async function () {
      // Regions to pause
      const regions = [PausableRegion.Entity, PausableRegion.Funds, PausableRegion.Verification];

      // Pause the protocol, testing for the event
      await expect(pauseFacet.pause(regions)).to.emit(pauseFacet, "ProtocolPaused").withArgs(regions);

      // Check that regions are paused
      const pausedRegions = await pauseFacet.getPausedRegions();
      expect(pausedRegions.map(String)).to.have.members(regions.map(String));
    });

    it("should pause all regions when no regions are specified", async function () {
      // Pause the protocol, testing for the event
      await expect(pauseFacet.pause([])).to.emit(pauseFacet, "ProtocolPaused").withArgs([]);

      // Check that all regions are paused
      const pausedRegions = await pauseFacet.getPausedRegions();
      expect(pausedRegions.map(String)).to.have.members(enumIterator(PausableRegion).map(String));
    });

    it("Can incrementally pause regions", async function () {
      // Regions to pause
      const regions = [PausableRegion.Entity, PausableRegion.Funds, PausableRegion.Verification];

      // Pause protocol
      await pauseFacet.pause(regions);

      const newRegions = [PausableRegion.Offer, PausableRegion.Custody];

      // Pause the protocol, testing for the events
      await expect(pauseFacet.pause(newRegions)).to.emit(pauseFacet, "ProtocolPaused").withArgs(newRegions);

      // Check that both old and news regions are pause
      const pausedRegions = await pauseFacet.getPausedRegions();
      expect(pausedRegions.map(String)).to.have.members([...regions, ...newRegions].map(String));
    });

    it("If region is already paused, shouldn't increment", async function () {
      // Regions to pause
      const regions = [PausableRegion.Entity, PausableRegion.Funds, PausableRegion.Verification];

      // Pause protocol
      await pauseFacet.pause(regions);

      // Pause protocol again
      await pauseFacet.pause([PausableRegion.Funds]);

      // Check that regions remains the same
      const pausedRegions = await pauseFacet.getPausedRegions();
      expect(pausedRegions.map(String)).to.have.members(regions.map(String));
    });

    context("Revert Reasons", async function () {
      it("Caller does not have admin role", async function () {
        const randomSigner = wallets[2];
        // Attempt to pause without PAUSER role, expecting revert
        const accessControl = await ethers.getContractAt("IAccessControl", ethers.ZeroAddress);
        await expect(pauseFacet.connect(randomSigner).pause([]))
          .to.revertedWithCustomError(accessControl, "AccessControlUnauthorizedAccount")
          .withArgs(randomSigner.address, ethers.id("PAUSER"));
      });
    });
  });

  context("unpause", async function () {
    it("Unpause all regions", async function () {
      const regions = [PausableRegion.Entity, PausableRegion.Funds, PausableRegion.Custody];

      // Pause protocol
      await pauseFacet.pause(regions);

      // Unpause the protocol, testing for the event
      await expect(pauseFacet.unpause([])).to.emit(pauseFacet, "ProtocolUnpaused").withArgs([]);

      // All should be unpaused
      const pausedRegions = await pauseFacet.getPausedRegions();
      expect(pausedRegions).to.deep.equal([]);
    });

    it("should be possible to pause again after an unpause", async function () {
      let regions = [PausableRegion.Entity, PausableRegion.Funds];

      // Pause protocol
      await pauseFacet.pause(regions);

      // Unpause the protocol, testing for the event
      await pauseFacet.unpause(regions);

      // Pause the protocol, testing for the event
      regions = [PausableRegion.Funds];

      await expect(pauseFacet.pause(regions)).to.emit(pauseFacet, "ProtocolPaused").withArgs(regions);
    });

    it("Can unpause individual regions", async function () {
      // Regions to paused
      const regions = [PausableRegion.Entity, PausableRegion.Funds, PausableRegion.Custody];

      // Pause protocol
      await pauseFacet.pause(regions);

      // Unpause protocol
      await pauseFacet.unpause([PausableRegion.Funds]);

      // Check that Offer is not in the paused regions anymore
      const pausedRegions = await pauseFacet.getPausedRegions();
      expect(pausedRegions).to.deep.equal([PausableRegion.Entity, PausableRegion.Custody]);
    });

    context("Revert Reasons", async function () {
      it("Caller does not have admin role", async function () {
        // Pause protocol
        await pauseFacet.pause([PausableRegion.Custody]);

        const randomSigner = wallets[2];
        // Attempt to unpause without PAUSER role, expecting revert
        const accessControl = await ethers.getContractAt("IAccessControl", ethers.ZeroAddress);
        await expect(pauseFacet.connect(randomSigner).unpause([]))
          .to.revertedWithCustomError(accessControl, "AccessControlUnauthorizedAccount")
          .withArgs(randomSigner.address, ethers.id("PAUSER"));
      });

      it("Protocol is not currently paused", async function () {
        // Attempt to unpause while not paused, expecting revert
        await expect(pauseFacet.unpause([])).to.revertedWithCustomError(fermionErrors, "NotPaused");
      });
    });
  });

  context("getPausedRegions()", async function () {
    it("should return the correct pause status", async function () {
      // Regions to paused
      const regions = [PausableRegion.Entity, PausableRegion.Funds, PausableRegion.Custody];

      await pauseFacet.pause(regions);

      const pausedRegions = await pauseFacet.getPausedRegions();

      expect(pausedRegions.map(String)).to.have.members(regions.map(String));
    });
  });
});
