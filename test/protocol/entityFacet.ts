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

    async function verifyState(signer, roles, metadataURI) {
      const response = await entityFacet.getEntity(signer.address);
      expect(response.roles.map(String)).to.have.members(roles.map(String));
      expect(response.metadataURI).to.equal(metadataURI);
    }

    context("createEntity", function () {
      it("Create an entity", async function () {
        const roles = ["Agent", "Buyer", "Verifier", "Custodian"];
        for (const [index, role] of Object.entries(roles)) {
          const signer = wallets[index];

          // test event
          await expect(entityFacet.connect(signer).createEntity([EntityRole[role]], metadataURI))
            .to.emit(entityFacet, "EntityUpdated")
            .withArgs(signer.address, [EntityRole[role]], metadataURI);

          // verify state
          await verifyState(signer, [EntityRole[role]], metadataURI);
        }
      });

      it("Create an entity with multiple roles", async function () {
        // test event
        await expect(entityFacet.createEntity([EntityRole.Verifier, EntityRole.Custodian], metadataURI))
          .to.emit(entityFacet, "EntityUpdated")
          .withArgs(defaultSigner.address, [EntityRole.Verifier, EntityRole.Custodian], metadataURI);

        // verify state
        await verifyState(defaultSigner, [EntityRole.Verifier, EntityRole.Custodian], metadataURI);

        // test the state with different order of roles
        const signer2 = wallets[2];
        await entityFacet
          .connect(signer2)
          .createEntity([EntityRole.Custodian, EntityRole.Buyer, EntityRole.Agent], metadataURI);
        await verifyState(signer2, [EntityRole.Custodian, EntityRole.Buyer, EntityRole.Agent], metadataURI);

        const signer3 = wallets[3];
        await entityFacet
          .connect(signer3)
          .createEntity([EntityRole.Agent, EntityRole.Custodian, EntityRole.Verifier], metadataURI);
        await verifyState(signer3, [EntityRole.Agent, EntityRole.Custodian, EntityRole.Verifier], metadataURI);
      });

      context("Revert reasons", function () {
        it("An entity already exists", async function () {
          await entityFacet.createEntity([EntityRole.Agent], metadataURI);

          await expect(entityFacet.createEntity([EntityRole.Agent], metadataURI)).to.be.revertedWithCustomError(
            fermionErrors,
            "EntityAlreadyExists",
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

    context("updateEntity", function () {
      beforeEach(async function () {
        await entityFacet.createEntity([EntityRole.Verifier, EntityRole.Custodian], metadataURI);
      });

      it("Update an entity", async function () {
        const newMetadataURI = "https://example.com/metadata2.json";

        // test event
        await expect(entityFacet.updateEntity([EntityRole.Verifier], newMetadataURI))
          .to.emit(entityFacet, "EntityUpdated")
          .withArgs(defaultSigner.address, [EntityRole.Verifier], newMetadataURI);

        // verify state
        await verifyState(defaultSigner, [EntityRole.Verifier], newMetadataURI);

        // test the state with different order of roles
        await entityFacet.updateEntity([EntityRole.Custodian, EntityRole.Verifier, EntityRole.Buyer], metadataURI);
        await verifyState(defaultSigner, [EntityRole.Buyer, EntityRole.Custodian, EntityRole.Verifier], metadataURI);

        await entityFacet.updateEntity([EntityRole.Agent, EntityRole.Custodian, EntityRole.Verifier], newMetadataURI);
        await verifyState(defaultSigner, [EntityRole.Agent, EntityRole.Custodian, EntityRole.Verifier], newMetadataURI);
      });

      context("Revert reasons", function () {
        it("An entity does not exists", async function () {
          const signer2 = wallets[2];
          await expect(
            entityFacet.connect(signer2).updateEntity([EntityRole.Agent], metadataURI),
          ).to.be.revertedWithCustomError(fermionErrors, "NoSuchEntity");
        });

        it("Missing entity roles", async function () {
          await expect(entityFacet.updateEntity([], metadataURI)).to.be.revertedWithCustomError(
            fermionErrors,
            "InvalidEntityRoles",
          );
        });
      });
    });

    context("deleteEntity", function () {
      beforeEach(async function () {
        await entityFacet.createEntity([EntityRole.Verifier, EntityRole.Custodian], metadataURI);
      });

      it("Delete an entity", async function () {
        // test event
        await expect(entityFacet.deleteEntity())
          .to.emit(entityFacet, "EntityUpdated")
          .withArgs(defaultSigner.address, [], "");

        // verify state
        await expect(verifyState(defaultSigner, [], "")).to.be.revertedWithCustomError(fermionErrors, "NoSuchEntity");
      });

      context("Revert reasons", function () {
        it("An entity does not exists", async function () {
          const signer2 = wallets[2];
          await expect(entityFacet.connect(signer2).deleteEntity()).to.be.revertedWithCustomError(
            fermionErrors,
            "NoSuchEntity",
          );
        });
      });
    });

    context("getEntity", function () {
      it("Get an entity", async function () {
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
        it("An entity does not exists", async function () {
          const signer2 = wallets[2];
          await expect(entityFacet.getEntity(signer2.address)).to.be.revertedWithCustomError(
            fermionErrors,
            "NoSuchEntity",
          );
        });
      });
    });
  });
});
