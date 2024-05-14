import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { EntityRole, WalletRole, enumIterator } from "../utils/enums";
import { deployFermionProtocolFixture } from "../utils/common";
import { Contract } from "ethers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("Entity", function () {
  let entityFacet: Contract;
  let wallets: HardhatEthersSigner[], defaultSigner: HardhatEthersSigner;
  let fermionErrors: Contract;

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

    async function verifyState(signer: HardhatEthersSigner, roles, metadataURI: string) {
      const response = await entityFacet.getEntity(signer.address);
      expect(response.roles.map(String)).to.have.members(roles.map(String));
      expect(response.metadataURI).to.equal(metadataURI);
    }

    context("createEntity", function () {
      it("Create an entity", async function () {
        const roles = ["Seller", "Buyer", "Verifier", "Custodian"];
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
          .createEntity([EntityRole.Custodian, EntityRole.Buyer, EntityRole.Seller], metadataURI);
        await verifyState(signer2, [EntityRole.Custodian, EntityRole.Buyer, EntityRole.Seller], metadataURI);

        const signer3 = wallets[3];
        await entityFacet
          .connect(signer3)
          .createEntity([EntityRole.Seller, EntityRole.Custodian, EntityRole.Verifier], metadataURI);
        await verifyState(signer3, [EntityRole.Seller, EntityRole.Custodian, EntityRole.Verifier], metadataURI);
      });

      context("Revert reasons", function () {
        it("An entity already exists", async function () {
          await entityFacet.createEntity([EntityRole.Seller], metadataURI);

          await expect(entityFacet.createEntity([EntityRole.Seller], metadataURI)).to.be.revertedWithCustomError(
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

        await entityFacet.updateEntity([EntityRole.Seller, EntityRole.Custodian, EntityRole.Verifier], newMetadataURI);
        await verifyState(
          defaultSigner,
          [EntityRole.Seller, EntityRole.Custodian, EntityRole.Verifier],
          newMetadataURI,
        );
      });

      context("Revert reasons", function () {
        it("An entity does not exist", async function () {
          const signer2 = wallets[2];
          await expect(
            entityFacet.connect(signer2).updateEntity([EntityRole.Seller], metadataURI),
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
        it("An entity does not exist", async function () {
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
      const entityRolesAll = [EntityRole.Seller, EntityRole.Verifier, EntityRole.Custodian];
      beforeEach(async function () {
        const metadataURI = "https://example.com/metadata.json";
        await entityFacet.createEntity(entityRolesAll, metadataURI);
      });

      it("Add entity wallets", async function () {
        const newWallets = wallets.slice(2, 4).map((wallet) => wallet.address);
        const entityRoles = [[EntityRole.Verifier, EntityRole.Custodian], [EntityRole.Seller]];
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
        expectedRoles[wallet1][EntityRole.Seller] = {};
        expectedRoles[wallet1][EntityRole.Seller][WalletRole.Admin] = true;
        expectedRoles[wallet1][EntityRole.Seller][WalletRole.Treasury] = true;

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
        it("Entity does not exist", async function () {
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

        it("Caller is not an entity admin", async function () {
          const wallet = wallets[2];

          // make the wallet an admin for all roles, but not an entity-wide admin
          await entityFacet.addEntityWallets(
            entityId,
            [wallet.address],
            [[EntityRole.Seller, EntityRole.Verifier, EntityRole.Custodian]],
            [[[WalletRole.Admin], [WalletRole.Admin], [WalletRole.Admin]]],
          ),
            await expect(
              entityFacet
                .connect(wallet)
                .addEntityWallets(entityId, [wallets[3].address], [[]], [[[WalletRole.Assistant]]]),
            )
              .to.be.revertedWithCustomError(fermionErrors, "NotEntityAdmin")
              .withArgs(entityId, wallet.address);
        });

        it("Array mismatch", async function () {
          const newWallets = [wallets[2].address];
          const entityRoles = [[EntityRole.Verifier, EntityRole.Custodian], [EntityRole.Seller]];
          const walletRoles = [[[WalletRole.Admin]]];

          await expect(entityFacet.addEntityWallets(entityId, newWallets, entityRoles, walletRoles))
            .to.be.revertedWithCustomError(fermionErrors, "ArrayLengthMismatch")
            .withArgs(newWallets.length, entityRoles.length);

          entityRoles.pop();
          walletRoles.push([[]], [[]], [[]]);

          await expect(entityFacet.addEntityWallets(entityId, newWallets, entityRoles, walletRoles))
            .to.be.revertedWithCustomError(fermionErrors, "ArrayLengthMismatch")
            .withArgs(newWallets.length, walletRoles.length);

          await expect(
            entityFacet.addEntityWallets(entityId, newWallets, [[]], [[[WalletRole.Admin], [WalletRole.Assistant]]]),
          )
            .to.be.revertedWithCustomError(fermionErrors, "ArrayLengthMismatch")
            .withArgs(1, 2);

          await expect(
            entityFacet.addEntityWallets(
              entityId,
              newWallets,
              [[EntityRole.Verifier, EntityRole.Custodian, EntityRole.Seller]],
              [[[WalletRole.Admin], [WalletRole.Assistant]]],
            ),
          )
            .to.be.revertedWithCustomError(fermionErrors, "ArrayLengthMismatch")
            .withArgs(3, 2);
        });

        it("Entity does not have the role", async function () {
          const wallet = wallets[2].address;
          await expect(entityFacet.addEntityWallets(entityId, [wallet], [[EntityRole.Buyer]], [[[WalletRole.Admin]]]))
            .to.be.revertedWithCustomError(fermionErrors, "EntityHasNoRole")
            .withArgs(entityId, EntityRole.Buyer);
        });
      });
    });

    context("removeEntityWallets", function () {
      const entityId = 1;
      const entityRolesAll = [EntityRole.Seller, EntityRole.Verifier, EntityRole.Custodian];
      let entityWallets: string[];

      beforeEach(async function () {
        const metadataURI = "https://example.com/metadata.json";
        await entityFacet.createEntity(entityRolesAll, metadataURI);

        entityWallets = wallets.slice(2, 4).map((wallet) => wallet.address);
        const entityRoles = [[EntityRole.Verifier, EntityRole.Custodian], [EntityRole.Seller]];
        const walletRoles = [[[WalletRole.Assistant], []], [[WalletRole.Treasury, WalletRole.Admin]]];

        await entityFacet.addEntityWallets(entityId, entityWallets, entityRoles, walletRoles);
      });

      it("Remove entity wallets", async function () {
        const entityRoles = [[EntityRole.Verifier, EntityRole.Custodian], [EntityRole.Seller]];
        const walletRoles = [[[], [WalletRole.Admin]], [[WalletRole.Treasury]]];

        // test event
        const tx = await entityFacet.removeEntityWallets(entityId, entityWallets, entityRoles, walletRoles);

        for (const [i, wallet] of entityWallets.entries()) {
          await expect(tx)
            .to.emit(entityFacet, "EntityWalletRemoved")
            .withArgs(entityId, wallet, entityRoles[i], walletRoles[i]);
        }

        // verify state
        const expectedRoles = {};
        const wallet0 = entityWallets[0];
        expectedRoles[wallet0] = {};
        expectedRoles[wallet0][EntityRole.Custodian] = {};
        expectedRoles[wallet0][EntityRole.Custodian][WalletRole.Assistant] = true;
        expectedRoles[wallet0][EntityRole.Custodian][WalletRole.Treasury] = true;

        const wallet1 = entityWallets[1];
        expectedRoles[wallet1] = {};
        expectedRoles[wallet1][EntityRole.Seller] = {};
        expectedRoles[wallet1][EntityRole.Seller][WalletRole.Admin] = true;

        for (const wallet of entityWallets) {
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

      it("Remove all wallet roles for one entity role", async function () {
        const wallet = entityWallets[1];
        const entityRoles = [[EntityRole.Seller]];
        const walletRoles = [[[]]];

        // test event
        const tx = await entityFacet.removeEntityWallets(entityId, [wallet], entityRoles, walletRoles);

        await expect(tx)
          .to.emit(entityFacet, "EntityWalletRemoved")
          .withArgs(entityId, wallet, entityRoles[0], walletRoles[0]);

        // verify state
        for (const walletRole of enumIterator(WalletRole)) {
          const hasRole = await entityFacet.hasRole(entityId, wallet, EntityRole.Custodian, walletRole);
          expect(hasRole).to.be.false;
        }
      });

      it("Remove entity-wide wallet roles", async function () {
        const wallet = wallets[4].address;
        const entityRoles = [[]];
        const walletRoles = [[[WalletRole.Assistant]]];

        // test event
        await entityFacet.addEntityWallets(entityId, [wallet], entityRoles, walletRoles);

        // verify state
        for (const entityRole of enumIterator(EntityRole)) {
          const hasRole = await entityFacet.hasRole(entityId, wallet, entityRole, WalletRole.Assistant);
          expect(hasRole).to.be.true;
        }

        await entityFacet.removeEntityWallets(entityId, [wallet], entityRoles, walletRoles);

        // verify state
        for (const entityRole of enumIterator(EntityRole)) {
          const hasRole = await entityFacet.hasRole(entityId, wallet, entityRole, WalletRole.Assistant);
          expect(hasRole).to.be.false;
        }
      });

      it("Removing entity-wide wallet roles does not remove specific wallet roles", async function () {
        const wallet = wallets[4].address;
        const entityRoles = [[], [EntityRole.Custodian]];
        const walletRoles = [[[WalletRole.Assistant]], [[WalletRole.Assistant]]];

        // test event
        await entityFacet.addEntityWallets(entityId, [wallet, wallet], entityRoles, walletRoles);

        // verify state
        for (const entityRole of enumIterator(EntityRole)) {
          const hasRole = await entityFacet.hasRole(entityId, wallet, entityRole, WalletRole.Assistant);
          expect(hasRole).to.be.true;
        }

        // remove entity-wide roles, but keep the specific wallet roles
        await entityFacet.removeEntityWallets(entityId, [wallet], entityRoles.slice(0, 1), walletRoles.slice(0, 1));

        // verify state
        for (const entityRole of enumIterator(EntityRole)) {
          const expectedRole = entityRole == String(EntityRole.Custodian);
          const hasRole = await entityFacet.hasRole(entityId, wallet, entityRole, WalletRole.Assistant);
          expect(hasRole).to.equal(expectedRole);
        }
      });

      it("Remove unassigned role", async function () {
        const wallet = entityWallets[1];
        const entityRoles = [[EntityRole.Seller]];
        const walletRoles = [[[WalletRole.Assistant]]];

        // check the assigned roles
        expect(await entityFacet.hasRole(entityId, wallet, EntityRole.Seller, WalletRole.Admin)).to.be.true;
        expect(await entityFacet.hasRole(entityId, wallet, EntityRole.Seller, WalletRole.Assistant)).to.be.false;
        expect(await entityFacet.hasRole(entityId, wallet, EntityRole.Seller, WalletRole.Treasury)).to.be.true;

        // test event
        await expect(entityFacet.removeEntityWallets(entityId, [wallet], entityRoles, walletRoles))
          .to.emit(entityFacet, "EntityWalletRemoved")
          .withArgs(entityId, wallet, entityRoles[0], walletRoles[0]);

        // verify state, nothing should change
        expect(await entityFacet.hasRole(entityId, wallet, EntityRole.Seller, WalletRole.Admin)).to.be.true;
        expect(await entityFacet.hasRole(entityId, wallet, EntityRole.Seller, WalletRole.Assistant)).to.be.false;
        expect(await entityFacet.hasRole(entityId, wallet, EntityRole.Seller, WalletRole.Treasury)).to.be.true;
      });

      context("Revert reasons", function () {
        it("Entity does not exist", async function () {
          await expect(entityFacet.removeEntityWallets(0, [], [], [])).to.be.revertedWithCustomError(
            fermionErrors,
            "NoSuchEntity",
          );

          await expect(entityFacet.removeEntityWallets(10, [], [], [])).to.be.revertedWithCustomError(
            fermionErrors,
            "NoSuchEntity",
          );
        });

        it("Caller is not an admin for the entity role", async function () {
          const wallet = wallets[2];

          await expect(
            entityFacet
              .connect(wallet)
              .removeEntityWallets(
                entityId,
                [wallet.address],
                [[EntityRole.Verifier, EntityRole.Custodian]],
                [[[WalletRole.Admin], []]],
              ),
          )
            .to.be.revertedWithCustomError(fermionErrors, "NotAdmin")
            .withArgs(wallet.address, entityId, EntityRole.Verifier);
        });

        it("Caller is not an entity admin", async function () {
          const wallet = wallets[2];

          // make the wallet an admin for all roles, but not an entity-wide admin
          await entityFacet.addEntityWallets(
            entityId,
            [wallet.address],
            [[EntityRole.Seller, EntityRole.Verifier, EntityRole.Custodian]],
            [[[WalletRole.Admin], [WalletRole.Admin], [WalletRole.Admin]]],
          ),
            await expect(
              entityFacet
                .connect(wallet)
                .removeEntityWallets(entityId, [wallets[3].address], [[]], [[[WalletRole.Assistant]]]),
            )
              .to.be.revertedWithCustomError(fermionErrors, "NotEntityAdmin")
              .withArgs(entityId, wallet.address);
        });

        it("Array mismatch", async function () {
          const newWallets = [wallets[2].address];
          const entityRoles = [[EntityRole.Verifier, EntityRole.Custodian], [EntityRole.Seller]];
          const walletRoles = [[[WalletRole.Admin]]];

          await expect(entityFacet.removeEntityWallets(entityId, newWallets, entityRoles, walletRoles))
            .to.be.revertedWithCustomError(fermionErrors, "ArrayLengthMismatch")
            .withArgs(newWallets.length, entityRoles.length);

          entityRoles.pop();
          walletRoles.push([[]], [[]], [[]]);

          await expect(entityFacet.removeEntityWallets(entityId, newWallets, entityRoles, walletRoles))
            .to.be.revertedWithCustomError(fermionErrors, "ArrayLengthMismatch")
            .withArgs(newWallets.length, walletRoles.length);

          await expect(
            entityFacet.removeEntityWallets(entityId, newWallets, [[]], [[[WalletRole.Admin], [WalletRole.Assistant]]]),
          )
            .to.be.revertedWithCustomError(fermionErrors, "ArrayLengthMismatch")
            .withArgs(1, 2);

          await expect(
            entityFacet.removeEntityWallets(
              entityId,
              newWallets,
              [[EntityRole.Verifier, EntityRole.Custodian, EntityRole.Seller]],
              [[[WalletRole.Admin], [WalletRole.Assistant]]],
            ),
          )
            .to.be.revertedWithCustomError(fermionErrors, "ArrayLengthMismatch")
            .withArgs(3, 2);
        });

        it("Entity does not have the role", async function () {
          const wallet = wallets[2].address;
          await expect(
            entityFacet.removeEntityWallets(entityId, [wallet], [[EntityRole.Buyer]], [[[WalletRole.Admin]]]),
          )
            .to.be.revertedWithCustomError(fermionErrors, "EntityHasNoRole")
            .withArgs(entityId, EntityRole.Buyer);
        });
      });
    });

    context("setEntityAdmin", function () {
      const entityId = 1;
      const metadataURI = "https://example.com/metadata.json";

      beforeEach(async function () {
        await entityFacet.createEntity([EntityRole.Seller, EntityRole.Verifier, EntityRole.Custodian], metadataURI);
      });

      it("Set entity admin", async function () {
        const newAdmin = wallets[2];

        // test event
        const tx = await entityFacet.setEntityAdmin(entityId, newAdmin.address, true);
        await expect(tx)
          .to.emit(entityFacet, "EntityWalletAdded")
          .withArgs(entityId, newAdmin.address, [], [[WalletRole.Admin]]);

        // verify state
        for (const entityRole of enumIterator(EntityRole)) {
          const hasRole = await entityFacet.hasRole(entityId, newAdmin.address, entityRole, WalletRole.Admin);
          expect(hasRole).to.be.true;
        }
      });

      it("When new admin perform first admin action, the entity admin is changed", async function () {
        const newAdmin = wallets[2];
        await entityFacet.setEntityAdmin(entityId, newAdmin.address, true);
        const entity = await entityFacet.getEntity(defaultSigner.address);

        // before new admin performs any action, the entity admin is the old admin
        await expect(entityFacet.getEntity(newAdmin.address)).to.be.revertedWithCustomError(
          fermionErrors,
          "NoSuchEntity",
        );

        // make some action with the new admin
        await expect(entityFacet.connect(newAdmin).setEntityAdmin(entityId, newAdmin.address, true)).to.not.be.reverted;

        // entity is referenced by the new admin signer
        await verifyState(newAdmin, entity.roles, entity.metadataURI);
        await expect(entityFacet.getEntity(defaultSigner.address)).to.be.revertedWithCustomError(
          fermionErrors,
          "NoSuchEntity",
        );

        // old admin should not be able to perform entity admin actions, but can perform wallet admin actions
        await expect(entityFacet.setEntityAdmin(entityId, newAdmin.address, true))
          .to.be.revertedWithCustomError(fermionErrors, "NotEntityAdmin")
          .withArgs(entityId, defaultSigner.address);

        await expect(
          entityFacet.addEntityWallets(
            entityId,
            [wallets[3].address],
            [[EntityRole.Verifier]],
            [[[WalletRole.Assistant]]],
          ),
        ).to.not.be.reverted;

        // old admin can create a new entity
        await expect(entityFacet.createEntity([EntityRole.Seller, EntityRole.Custodian], metadataURI)).to.not.be
          .reverted;
      });

      it("Unset entity admin", async function () {
        const newAdmin = wallets[2];

        // first set it
        await entityFacet.setEntityAdmin(entityId, newAdmin.address, true);

        // unset it
        const tx = await entityFacet.setEntityAdmin(entityId, newAdmin.address, false);
        await expect(tx)
          .to.emit(entityFacet, "EntityWalletRemoved")
          .withArgs(entityId, newAdmin.address, [], [[WalletRole.Admin]]);

        // verify state
        for (const entityRole of enumIterator(EntityRole)) {
          const hasRole = await entityFacet.hasRole(entityId, newAdmin.address, entityRole, WalletRole.Admin);
          expect(hasRole).to.be.false;
        }

        // New admin should not be able to perform admin actions
        await expect(entityFacet.connect(newAdmin).setEntityAdmin(entityId, newAdmin.address, true))
          .to.be.revertedWithCustomError(fermionErrors, "NotEntityAdmin")
          .withArgs(entityId, newAdmin.address);
      });

      context("Revert reasons", function () {
        it("Entity does not exist", async function () {
          const newAdmin = wallets[2];

          await expect(entityFacet.setEntityAdmin(0, newAdmin.address, true)).to.be.revertedWithCustomError(
            fermionErrors,
            "NoSuchEntity",
          );

          await expect(entityFacet.setEntityAdmin(10, newAdmin.address, true)).to.be.revertedWithCustomError(
            fermionErrors,
            "NoSuchEntity",
          );
        });

        it("Caller is not an admin for the entity role", async function () {
          const newAdmin = wallets[2];

          await expect(entityFacet.connect(newAdmin).setEntityAdmin(entityId, newAdmin.address, true))
            .to.be.revertedWithCustomError(fermionErrors, "NotEntityAdmin")
            .withArgs(entityId, newAdmin.address);
        });

        it("Caller is not an admin for another entity", async function () {
          const newAdmin = wallets[2];

          await entityFacet.connect(newAdmin).createEntity([EntityRole.Seller, EntityRole.Custodian], metadataURI);

          await expect(entityFacet.connect(newAdmin).setEntityAdmin(entityId, newAdmin.address, true))
            .to.be.revertedWithCustomError(fermionErrors, "NotEntityAdmin")
            .withArgs(entityId, newAdmin.address);
        });
      });
    });

    context("changeWallet", function () {
      const entityId = 1;
      const entityRoles = [[EntityRole.Custodian, EntityRole.Verifier]];
      let wallet: HardhatEthersSigner;

      beforeEach(async function () {
        await entityFacet.createEntity([EntityRole.Seller, EntityRole.Verifier, EntityRole.Custodian], metadataURI);
        wallet = wallets[2];
        const walletRoles = [[[], []]];

        await entityFacet.addEntityWallets(entityId, [wallet.address], entityRoles, walletRoles);
      });

      it("new wallet has all roles", async function () {
        const newWallet = wallets[3].address;

        // test event
        await expect(entityFacet.connect(wallet).changeWallet(newWallet))
          .to.emit(entityFacet, "WalletChanged")
          .withArgs(wallet.address, newWallet);

        // verify state
        for (const entityRole of entityRoles[0]) {
          for (const walletRole of enumIterator(WalletRole)) {
            const newWallethasRole = await entityFacet.hasRole(entityId, newWallet, entityRole, walletRole);
            expect(newWallethasRole).to.be.true;

            const oldWallethasRole = await entityFacet.hasRole(entityId, wallet.address, entityRole, walletRole);
            expect(oldWallethasRole).to.be.false;
          }
        }
      });

      context("Revert reasons", function () {
        it("Caller is an entity adming", async function () {
          const newAdmin = wallets[2];

          await expect(entityFacet.changeWallet(newAdmin.address)).to.be.revertedWithCustomError(
            fermionErrors,
            "ChangeNotAllowed",
          );
        });

        it("Caller is not a wallet for any enitity", async function () {
          const wallet = wallets[3];

          await expect(entityFacet.connect(wallet).changeWallet(wallets[2].address)).to.be.revertedWithCustomError(
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
          [EntityRole.Verifier, EntityRole.Seller, EntityRole.Custodian, EntityRole.Buyer],
          newMetadataURI,
        );

        response = await entityFacet.getEntity(defaultSigner.address);
        expect(response.roles.map(String)).to.have.members(
          [EntityRole.Seller, EntityRole.Buyer, EntityRole.Custodian, EntityRole.Verifier].map(String),
        );
        expect(response.metadataURI).to.equal(newMetadataURI);
      });

      context("Revert reasons", function () {
        it("An entity does not exist", async function () {
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
        await entityFacet.createEntity([EntityRole.Seller, EntityRole.Verifier, EntityRole.Custodian], metadataURI);
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
        it("An entity does not exist", async function () {
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
