import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { deployDiamond, deployFacets, prepareFacetCuts, makeDiamondCut } from "../../scripts/deploy";
import { EntityRole } from "../utils/enums";

describe("Entity", function () {
  let entityFacet;
  let wallets, defaultSigner;
  let fermionErrors;

  // We define a fixture to reuse the same setup in every test.
  // We use loadFixture to run this setup once, snapshot that state,
  // and reset Hardhat Network to that snapshot in every test.
  // ToDo: move into shared fixtures
  async function deployFermionProtocolFixture() {
    const diamondAddress = await deployDiamond();
    const facetNames = ["EntityFacet"];
    const facets = await deployFacets(facetNames);

    await makeDiamondCut(diamondAddress, await prepareFacetCuts(Object.values(facets)));

    return { diamondAddress, entityFacet: facets["EntityFacet"] };
  }

  before(async function () {
    wallets = await ethers.getSigners();
    defaultSigner = wallets[1];

    const { diamondAddress, entityFacet: ef } = await loadFixture(deployFermionProtocolFixture);
    entityFacet = ef.connect(defaultSigner).attach(diamondAddress);
    fermionErrors = await ethers.getContractAt("FermionErrors", diamondAddress);
  });

  afterEach(async function () {
    await loadFixture(deployFermionProtocolFixture);
  });

  describe("Entity facet", function () {
    const metadataURI = "https://example.com/metadata.json";

    it("Create entity", async function () {
      const roles = ["Agent", "Buyer", "Verifier", "Custodian"];
      for (const [index, role] of Object.entries(roles)) {
        const signer = wallets[index];

        await expect(entityFacet.connect(signer).createEntity([EntityRole[role]], metadataURI))
          .to.emit(entityFacet, "EntityUpdated")
          .withArgs(signer.address, [EntityRole[role]], metadataURI);
      }
    });

    it("Create entity with multiple roles", async function () {
      await expect(entityFacet.createEntity([EntityRole.Verifier, EntityRole.Custodian], metadataURI))
        .to.emit(entityFacet, "EntityUpdated")
        .withArgs(defaultSigner.address, [EntityRole.Verifier, EntityRole.Custodian], metadataURI);
    });

    it("Update entity", async function () {
      await entityFacet.createEntity([EntityRole.Verifier, EntityRole.Custodian], metadataURI);

      const newMetadataURI = "https://example.com/metadata2.json";
      await expect(entityFacet.updateEntity([EntityRole.Verifier], newMetadataURI))
        .to.emit(entityFacet, "EntityUpdated")
        .withArgs(defaultSigner.address, [EntityRole.Verifier], newMetadataURI);
    });

    it("Get entity", async function () {
      await entityFacet.createEntity([EntityRole.Verifier, EntityRole.Custodian], metadataURI);

      let response = await entityFacet.getEntity(defaultSigner.address);
      expect(response.roles.map(String)).to.have.members([EntityRole.Verifier, EntityRole.Custodian].map(String));
      expect(response.metadataURI).to.equal(metadataURI);

      const newMetadataURI = "https://example.com/metadata2.json";
      await entityFacet.updateEntity(
        [EntityRole.Verifier, EntityRole.Agent, EntityRole.Custodian, EntityRole.Buyer],
        newMetadataURI,
      );

      response = await entityFacet.getEntity(defaultSigner.address);
      expect(response.roles.map(String)).to.have.members(
        [EntityRole.Agent, EntityRole.Buyer, EntityRole.Custodian, EntityRole.Verifier].map(String),
      );
      expect(response.metadataURI).to.equal(newMetadataURI);
    });

    context("Revert reasons", function () {
      it("Entity already exists", async function () {
        await entityFacet.createEntity([EntityRole.Agent], metadataURI);

        await expect(entityFacet.createEntity([EntityRole.Agent], metadataURI)).to.be.revertedWithCustomError(
          fermionErrors,
          "EntityAlreadyExists",
        );
      });

      it("Entity does not exists", async function () {
        await expect(entityFacet.updateEntity([EntityRole.Agent], metadataURI)).to.be.revertedWithCustomError(
          fermionErrors,
          "NoSuchEntity",
        );
      });

      it("Missing entity roles", async function () {
        await expect(entityFacet.createEntity([], metadataURI)).to.be.revertedWithCustomError(
          fermionErrors,
          "InvalidEntityRoles",
        );
      });
    });
  });
});
