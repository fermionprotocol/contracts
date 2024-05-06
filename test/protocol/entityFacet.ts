import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { EntityRole, WalletRole, enumIterator } from "../utils/enums";
import { deployFermionProtocolFixture } from "../utils/common";

describe("Entity", function () {
  let entityFacet;
  let wallets, defaultSigner;
  let fermionErrors;

  before(async function () {
    ({
      facets: { EntityFacet: entityFacet },
      fermionErrors,
      wallets,
      defaultSigner,
    } = await loadFixture(deployFermionProtocolFixture));
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
        const roles = ["Reseller", "Buyer", "Verifier", "Custodian"];
        for (const [index, role] of Object.entries(roles)) {
          const signer = wallets[index];
          const entityId = Number(index) + 1;

          // test event
          const tx = await entityFacet.connect(signer).createEntity([EntityRole[role]], metadataURI);
          await expect(tx)
            .to.emit(entityFacet, "EntityStored")
            .withArgs(signer.address, [EntityRole[role]], metadataURI);

          await expect(tx)
            .to.emit(entityFacet, "EntityWalletAdded")
            .withArgs(entityId, signer.address, [], [[WalletRole.Admin]]);

          // verify state
          await verifyState(signer, [EntityRole[role]], metadataURI);

          for (const entityRole of enumIterator(EntityRole)) {
            const hasRole = await entityFacet.hasRole(entityId, signer.address, entityRole, WalletRole.Admin);
            expect(hasRole).to.be.true;
          }
        }
      });

      it("Create an entity with multiple roles", async function () {
        // test event
        await expect(entityFacet.createEntity([EntityRole.Verifier, EntityRole.Custodian], metadataURI))
          .to.emit(entityFacet, "EntityStored")
          .withArgs(defaultSigner.address, [EntityRole.Verifier, EntityRole.Custodian], metadataURI);

        // verify state
        await verifyState(defaultSigner, [EntityRole.Verifier, EntityRole.Custodian], metadataURI);

        // test the state with different order of roles
        const signer2 = wallets[2];
        await entityFacet
          .connect(signer2)
          .createEntity([EntityRole.Custodian, EntityRole.Buyer, EntityRole.Reseller], metadataURI);
        await verifyState(signer2, [EntityRole.Custodian, EntityRole.Buyer, EntityRole.Reseller], metadataURI);

        const signer3 = wallets[3];
        await entityFacet
          .connect(signer3)
          .createEntity([EntityRole.Reseller, EntityRole.Custodian, EntityRole.Verifier], metadataURI);
        await verifyState(signer3, [EntityRole.Reseller, EntityRole.Custodian, EntityRole.Verifier], metadataURI);
      });

      context("Revert reasons", function () {
        it("An entity already exists", async function () {
          await entityFacet.createEntity([EntityRole.Reseller], metadataURI);

          await expect(entityFacet.createEntity([EntityRole.Reseller], metadataURI)).to.be.revertedWithCustomError(
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
          .to.emit(entityFacet, "EntityStored")
          .withArgs(defaultSigner.address, [EntityRole.Verifier], newMetadataURI);

        // verify state
        await verifyState(defaultSigner, [EntityRole.Verifier], newMetadataURI);

        // test the state with different order of roles
        await entityFacet.updateEntity([EntityRole.Custodian, EntityRole.Verifier, EntityRole.Buyer], metadataURI);
        await verifyState(defaultSigner, [EntityRole.Buyer, EntityRole.Custodian, EntityRole.Verifier], metadataURI);

        await entityFacet.updateEntity(
          [EntityRole.Reseller, EntityRole.Custodian, EntityRole.Verifier],
          newMetadataURI,
        );
        await verifyState(
          defaultSigner,
          [EntityRole.Reseller, EntityRole.Custodian, EntityRole.Verifier],
          newMetadataURI,
        );
      });

      context("Revert reasons", function () {
        it("An entity does not exists", async function () {
          const signer2 = wallets[2];
          await expect(
            entityFacet.connect(signer2).updateEntity([EntityRole.Reseller], metadataURI),
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
          .to.emit(entityFacet, "EntityStored")
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

    context("addEntityWallets", function () {
      const entityId = 1;
      const entityRolesAll = [EntityRole.Reseller, EntityRole.Verifier, EntityRole.Custodian];
      beforeEach(async function () {
        const metadataURI = "https://example.com/metadata.json";
        await entityFacet.createEntity(entityRolesAll, metadataURI);
      });

      it("Add entity wallets", async function () {
        const newWallets = wallets.slice(2, 4).map((wallet) => wallet.address);
        const entityRoles = [[EntityRole.Verifier, EntityRole.Custodian], [EntityRole.Reseller]];
        const walletRoles = [[[WalletRole.Assistant], []], [[WalletRole.Treasury, WalletRole.Admin]]];

        // test event
        const tx = await entityFacet.addEntityWallets(entityId, newWallets, entityRoles, walletRoles);

        for (const [i, wallet] of newWallets.entries()) {
          await expect(tx)
            .to.emit(entityFacet, "EntityWalletAdded")
            .withArgs(entityId, wallet, entityRoles[i], walletRoles[i]);
        }

        // verify state
        const expectedRoles = {};
        const wallet0 = newWallets[0];
        expectedRoles[wallet0] = {};
        expectedRoles[wallet0][EntityRole.Verifier] = {};
        expectedRoles[wallet0][EntityRole.Verifier][WalletRole.Assistant] = true;
        expectedRoles[wallet0][EntityRole.Custodian] = {};
        expectedRoles[wallet0][EntityRole.Custodian][WalletRole.Admin] = true;
        expectedRoles[wallet0][EntityRole.Custodian][WalletRole.Assistant] = true;
        expectedRoles[wallet0][EntityRole.Custodian][WalletRole.Treasury] = true;

        const wallet1 = newWallets[1];
        expectedRoles[wallet1] = {};
        expectedRoles[wallet1][EntityRole.Reseller] = {};
        expectedRoles[wallet1][EntityRole.Reseller][WalletRole.Admin] = true;
        expectedRoles[wallet1][EntityRole.Reseller][WalletRole.Treasury] = true;

        for (const wallet of newWallets) {
          for (const entityRole of enumIterator(EntityRole)) {
            for (const walletRole of enumIterator(WalletRole)) {
              const expectedValue =
                !!expectedRoles[wallet][entityRole] && !!expectedRoles[wallet][entityRole][walletRole];
              const hasRole = await entityFacet.hasRole(entityId, wallet, entityRole, walletRole);

              expect(hasRole).to.equal(expectedValue);
            }
          }
        }
      });

      it("Add wallet with all wallet roles for one entity role", async function () {
        const wallet = wallets[2].address;
        const entityRoles = [[EntityRole.Custodian]];
        const walletRoles = [[[]]];

        // test event
        const tx = await entityFacet.addEntityWallets(entityId, [wallet], entityRoles, walletRoles);

        await expect(tx)
          .to.emit(entityFacet, "EntityWalletAdded")
          .withArgs(entityId, wallet, entityRoles[0], walletRoles[0]);

        // verify state
        for (const walletRole of enumIterator(WalletRole)) {
          const hasRole = await entityFacet.hasRole(entityId, wallet, EntityRole.Custodian, walletRole);
          expect(hasRole).to.be.true;
        }
      });

      it("Add wallet with entity-wide roles", async function () {
        const wallet = wallets[2].address;
        const entityRoles = [[]];
        const walletRoles = [[[WalletRole.Assistant]]];

        // test event
        const tx = await entityFacet.addEntityWallets(entityId, [wallet], entityRoles, walletRoles);

        await expect(tx)
          .to.emit(entityFacet, "EntityWalletAdded")
          .withArgs(entityId, wallet, entityRoles[0], walletRoles[0]);

        // verify state
        for (const entityRole of enumIterator(EntityRole)) {
          const hasRole = await entityFacet.hasRole(entityId, wallet, entityRole, WalletRole.Assistant);
          expect(hasRole).to.be.true;
        }
      });

      context("Revert reasons", function () {
        it("Entity does not exists", async function () {
          await expect(entityFacet.addEntityWallets(0, [], [], [])).to.be.revertedWithCustomError(
            fermionErrors,
            "NoSuchEntity",
          );

          await expect(entityFacet.addEntityWallets(10, [], [], [])).to.be.revertedWithCustomError(
            fermionErrors,
            "NoSuchEntity",
          );
        });

        it("Caller is not an admin for the entity role", async function () {
          const wallet = wallets[2];

          await expect(
            entityFacet
              .connect(wallet)
              .addEntityWallets(
                entityId,
                [wallet.address],
                [[EntityRole.Verifier, EntityRole.Custodian]],
                [[[WalletRole.Admin], []]],
              ),
          )
            .to.be.revertedWithCustomError(fermionErrors, "NotAdmin")
            .withArgs(wallet.address, entityId, EntityRole.Verifier);
        });

        it("Array mismatch", async function () {
          const newWallets = [wallets[2].address];
          const entityRoles = [[EntityRole.Verifier, EntityRole.Custodian], [EntityRole.Reseller]];
          const walletRoles = [[[WalletRole.Admin]]];

          await expect(entityFacet.addEntityWallets(entityId, newWallets, entityRoles, walletRoles))
            .to.be.revertedWithCustomError(fermionErrors, "ArrayLengthMismatch")
            .withArgs(newWallets.length, entityRoles.length);

          entityRoles.pop();
          newWallets.push(wallets[3].address);

          await expect(entityFacet.addEntityWallets(entityId, newWallets, entityRoles, walletRoles))
            .to.be.revertedWithCustomError(fermionErrors, "ArrayLengthMismatch")
            .withArgs(newWallets.length, walletRoles.length);

          newWallets.pop();

          await expect(
            entityFacet.addEntityWallets(entityId, newWallets, [[]], [[[WalletRole.Admin], [WalletRole.Assistant]]]),
          )
            .to.be.revertedWithCustomError(fermionErrors, "ArrayLengthMismatch")
            .withArgs(1, 2);
        });

        it("Entity does not exists", async function () {
          const wallet = wallets[2].address;
          await expect(entityFacet.addEntityWallets(entityId, [wallet], [[EntityRole.Buyer]], [[]]))
            .to.be.revertedWithCustomError(fermionErrors, "EntityHasNoRole")
            .withArgs(entityId, EntityRole.Buyer);
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
          [EntityRole.Verifier, EntityRole.Reseller, EntityRole.Custodian, EntityRole.Buyer],
          newMetadataURI,
        );

        response = await entityFacet.getEntity(defaultSigner.address);
        expect(response.roles.map(String)).to.have.members(
          [EntityRole.Reseller, EntityRole.Buyer, EntityRole.Custodian, EntityRole.Verifier].map(String),
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

    context("hasRole", function () {
      const entityId = 1;
      beforeEach(async function () {
        const metadataURI = "https://example.com/metadata.json";
        await entityFacet.createEntity([EntityRole.Reseller, EntityRole.Verifier, EntityRole.Custodian], metadataURI);
      });

      it("Get entity", async function () {
        const wallet = wallets[2];
        const entityRoles = [[EntityRole.Verifier, EntityRole.Custodian]];
        const walletRoles = [[[WalletRole.Assistant], []]];

        await entityFacet.addEntityWallets(entityId, [wallet], entityRoles, walletRoles);

        let hasRole = await entityFacet.hasRole(entityId, wallet, EntityRole.Verifier, WalletRole.Assistant);
        expect(hasRole).to.be.true;

        hasRole = await entityFacet.hasRole(entityId, wallet, EntityRole.Verifier, WalletRole.Admin);
        expect(hasRole).to.be.false;
      });

      it("Wallet does not belong to an entity", async function () {
        const wallet = wallets[3];
        const hasRole = await entityFacet.hasRole(entityId, wallet, EntityRole.Buyer, WalletRole.Admin);

        expect(hasRole).to.equal(false);
      });

      context("Revert reasons", function () {
        it("An entity does not exists", async function () {
          const wallet = wallets[3];
          await expect(
            entityFacet.hasRole(0, wallet, EntityRole.Buyer, WalletRole.Admin),
          ).to.be.revertedWithCustomError(fermionErrors, "NoSuchEntity");

          await expect(
            entityFacet.hasRole(10, wallet, EntityRole.Buyer, WalletRole.Admin),
          ).to.be.revertedWithCustomError(fermionErrors, "NoSuchEntity");
        });
      });
    });
  });
});
