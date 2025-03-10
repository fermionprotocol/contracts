import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { EntityRole, PausableRegion, AccountRole, enumIterator } from "../utils/enums";
import { deployFermionProtocolFixture } from "../utils/common";
import { BigNumberish, Contract, ZeroAddress } from "ethers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("Entity", function () {
  let entityFacet: Contract, offerFacet: Contract, pauseFacet: Contract;
  let wallets: HardhatEthersSigner[], defaultSigner: HardhatEthersSigner;
  let fermionErrors: Contract;

  before(async function () {
    ({
      facets: { EntityFacet: entityFacet, OfferFacet: offerFacet, PauseFacet: pauseFacet },
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

    async function verifyState(
      signer: HardhatEthersSigner,
      entityId: BigNumberish,
      roles: EntityRole[],
      metadataURI: string,
    ) {
      const response = await entityFacet["getEntity(address)"](signer.address);
      expect(response.entityId).to.equal(entityId);
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
            .withArgs(entityId, signer.address, [EntityRole[role]], metadataURI);

          await expect(tx)
            .to.emit(entityFacet, "EntityAccountAdded")
            .withArgs(entityId, signer.address, [], [[AccountRole.Manager]]);

          // verify state
          await verifyState(signer, entityId, [EntityRole[role]], metadataURI);

          for (const entityRole of enumIterator(EntityRole)) {
            const hasRole = await entityFacet.hasAccountRole(entityId, signer.address, entityRole, AccountRole.Manager);
            expect(hasRole).to.be.equal(true);
          }
        }
      });

      it("Create an entity with multiple roles", async function () {
        const entityId = "1";
        // test event
        await expect(entityFacet.createEntity([EntityRole.Verifier, EntityRole.Custodian], metadataURI))
          .to.emit(entityFacet, "EntityStored")
          .withArgs(entityId, defaultSigner.address, [EntityRole.Verifier, EntityRole.Custodian], metadataURI);

        // verify state
        await verifyState(defaultSigner, entityId, [EntityRole.Verifier, EntityRole.Custodian], metadataURI);

        // test the state with different order of roles
        const signer2 = wallets[2];
        await entityFacet
          .connect(signer2)
          .createEntity([EntityRole.Custodian, EntityRole.Buyer, EntityRole.Seller], metadataURI);
        await verifyState(signer2, "2", [EntityRole.Custodian, EntityRole.Buyer, EntityRole.Seller], metadataURI);

        const signer3 = wallets[3];
        await entityFacet
          .connect(signer3)
          .createEntity([EntityRole.Seller, EntityRole.Custodian, EntityRole.Verifier], metadataURI);
        await verifyState(signer3, "3", [EntityRole.Seller, EntityRole.Custodian, EntityRole.Verifier], metadataURI);
      });

      it("Create an entity without any role", async function () {
        const entityId = "1";
        // test event
        await expect(entityFacet.createEntity([], metadataURI))
          .to.emit(entityFacet, "EntityStored")
          .withArgs(entityId, defaultSigner.address, [], metadataURI);

        // verify state
        await verifyState(defaultSigner, entityId, [], metadataURI);
      });

      context("Revert reasons", function () {
        it("Entity region is paused", async function () {
          await pauseFacet.pause([PausableRegion.Entity]);

          await expect(entityFacet.createEntity([EntityRole.Seller], metadataURI))
            .to.be.revertedWithCustomError(fermionErrors, "RegionPaused")
            .withArgs(PausableRegion.Entity);
        });

        it("An entity already exists", async function () {
          await entityFacet.createEntity([EntityRole.Seller], metadataURI);

          await expect(entityFacet.createEntity([EntityRole.Seller], metadataURI)).to.be.revertedWithCustomError(
            fermionErrors,
            "EntityAlreadyExists",
          );
        });
      });
    });

    context("updateEntity", function () {
      const entityId = "1";
      const newMetadataURI = "https://example.com/metadata2.json";

      beforeEach(async function () {
        await entityFacet.createEntity([EntityRole.Verifier, EntityRole.Custodian], metadataURI);
      });

      it("Update an entity", async function () {
        // test event
        await expect(entityFacet.updateEntity(entityId, [EntityRole.Verifier], newMetadataURI))
          .to.emit(entityFacet, "EntityStored")
          .withArgs(entityId, defaultSigner.address, [EntityRole.Verifier], newMetadataURI);

        // verify state
        await verifyState(defaultSigner, entityId, [EntityRole.Verifier], newMetadataURI);

        // test the state with different order of roles
        await entityFacet.updateEntity(
          entityId,
          [EntityRole.Custodian, EntityRole.Verifier, EntityRole.Buyer],
          metadataURI,
        );
        await verifyState(
          defaultSigner,
          entityId,
          [EntityRole.Buyer, EntityRole.Custodian, EntityRole.Verifier],
          metadataURI,
        );

        await entityFacet.updateEntity(
          entityId,
          [EntityRole.Seller, EntityRole.Custodian, EntityRole.Verifier],
          newMetadataURI,
        );
        await verifyState(
          defaultSigner,
          entityId,
          [EntityRole.Seller, EntityRole.Custodian, EntityRole.Verifier],
          newMetadataURI,
        );
      });

      it("Remove entity roles (but keep the entity)", async function () {
        // test event
        await expect(entityFacet.updateEntity(entityId, [], newMetadataURI))
          .to.emit(entityFacet, "EntityStored")
          .withArgs(entityId, defaultSigner.address, [], newMetadataURI);

        // verify state
        await verifyState(defaultSigner, entityId, [], newMetadataURI);
      });

      it("Pending admin can update roles", async function () {
        const newAdmin = wallets[2];
        await entityFacet.setAdmin(entityId, newAdmin.address);

        await expect(
          entityFacet
            .connect(newAdmin)
            .updateEntity(entityId, [EntityRole.Buyer, EntityRole.Custodian], newMetadataURI),
        )
          .to.emit(entityFacet, "EntityStored")
          .withArgs(entityId, newAdmin.address, [EntityRole.Buyer, EntityRole.Custodian], newMetadataURI);

        // verify state
        await verifyState(newAdmin, entityId, [EntityRole.Buyer, EntityRole.Custodian], newMetadataURI);
        await expect(entityFacet["getEntity(address)"](defaultSigner.address))
          .to.be.revertedWithCustomError(fermionErrors, "NoSuchEntity")
          .withArgs(0);
      });

      context("Revert reasons", function () {
        it("Entity region is paused", async function () {
          await pauseFacet.pause([PausableRegion.Entity]);

          await expect(entityFacet.updateEntity(entityId, [EntityRole.Seller], metadataURI))
            .to.be.revertedWithCustomError(fermionErrors, "RegionPaused")
            .withArgs(PausableRegion.Entity);
        });

        it("An entity does not exist", async function () {
          await expect(entityFacet.updateEntity(0, [EntityRole.Seller], metadataURI))
            .to.be.revertedWithCustomError(fermionErrors, "NoSuchEntity")
            .withArgs(0);

          await expect(entityFacet.updateEntity(10, [EntityRole.Seller], metadataURI))
            .to.be.revertedWithCustomError(fermionErrors, "NoSuchEntity")
            .withArgs(10);
        });

        it("Caller is not the admin", async function () {
          const signer2 = wallets[2];
          await expect(entityFacet.connect(signer2).updateEntity(entityId, [EntityRole.Seller], metadataURI))
            .to.be.revertedWithCustomError(fermionErrors, "NotAdmin")
            .withArgs(entityId, signer2.address);
        });
      });
    });

    context("addEntityAccounts", function () {
      const entityId = 1;
      const entityRolesAll = [EntityRole.Seller, EntityRole.Verifier, EntityRole.Custodian];
      beforeEach(async function () {
        const metadataURI = "https://example.com/metadata.json";
        await entityFacet.createEntity(entityRolesAll, metadataURI);
      });

      it("Add entity wallets", async function () {
        const newAccounts = wallets.slice(2, 4).map((wallet) => wallet.address);
        const entityRoles = [[EntityRole.Verifier, EntityRole.Custodian], [EntityRole.Seller]];
        const walletRoles = [[[AccountRole.Assistant], []], [[AccountRole.Treasury, AccountRole.Manager]]];

        // test event
        const tx = await entityFacet.addEntityAccounts(entityId, newAccounts, entityRoles, walletRoles);

        for (const [i, wallet] of newAccounts.entries()) {
          await expect(tx)
            .to.emit(entityFacet, "EntityAccountAdded")
            .withArgs(entityId, wallet, entityRoles[i], walletRoles[i]);
        }

        // verify state
        const expectedRoles = {};
        const wallet0 = newAccounts[0];
        expectedRoles[wallet0] = {};
        expectedRoles[wallet0][EntityRole.Verifier] = {};
        expectedRoles[wallet0][EntityRole.Verifier][AccountRole.Assistant] = true;
        expectedRoles[wallet0][EntityRole.Custodian] = {};
        expectedRoles[wallet0][EntityRole.Custodian][AccountRole.Manager] = true;
        expectedRoles[wallet0][EntityRole.Custodian][AccountRole.Assistant] = true;
        expectedRoles[wallet0][EntityRole.Custodian][AccountRole.Treasury] = true;

        const wallet1 = newAccounts[1];
        expectedRoles[wallet1] = {};
        expectedRoles[wallet1][EntityRole.Seller] = {};
        expectedRoles[wallet1][EntityRole.Seller][AccountRole.Manager] = true;
        expectedRoles[wallet1][EntityRole.Seller][AccountRole.Treasury] = true;

        for (const wallet of newAccounts) {
          for (const entityRole of enumIterator(EntityRole)) {
            for (const walletRole of enumIterator(AccountRole)) {
              const expectedValue =
                !!expectedRoles[wallet][entityRole] && !!expectedRoles[wallet][entityRole][walletRole];
              const hasRole = await entityFacet.hasAccountRole(entityId, wallet, entityRole, walletRole);

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
        const tx = await entityFacet.addEntityAccounts(entityId, [wallet], entityRoles, walletRoles);

        await expect(tx)
          .to.emit(entityFacet, "EntityAccountAdded")
          .withArgs(entityId, wallet, entityRoles[0], walletRoles[0]);

        // verify state
        for (const walletRole of enumIterator(AccountRole)) {
          const hasRole = await entityFacet.hasAccountRole(entityId, wallet, EntityRole.Custodian, walletRole);
          expect(hasRole).to.be.equal(true);
        }
      });

      it("Add wallet with entity-wide roles", async function () {
        const wallet = wallets[2].address;
        const entityRoles = [[]];
        const walletRoles = [[[AccountRole.Assistant]]];

        // test event
        const tx = await entityFacet.addEntityAccounts(entityId, [wallet], entityRoles, walletRoles);

        await expect(tx)
          .to.emit(entityFacet, "EntityAccountAdded")
          .withArgs(entityId, wallet, entityRoles[0], walletRoles[0]);

        // verify state
        for (const entityRole of enumIterator(EntityRole)) {
          const hasRole = await entityFacet.hasAccountRole(entityId, wallet, entityRole, AccountRole.Assistant);
          expect(hasRole).to.be.equal(true);
        }
      });

      context("Revert reasons", function () {
        it("Entity region is paused", async function () {
          await pauseFacet.pause([PausableRegion.Entity]);

          await expect(entityFacet.addEntityAccounts(0, [], [], []))
            .to.be.revertedWithCustomError(fermionErrors, "RegionPaused")
            .withArgs(PausableRegion.Entity);
        });

        it("Entity does not exist", async function () {
          await expect(entityFacet.addEntityAccounts(0, [], [], []))
            .to.be.revertedWithCustomError(fermionErrors, "NoSuchEntity")
            .withArgs(0);

          await expect(entityFacet.addEntityAccounts(10, [], [], []))
            .to.be.revertedWithCustomError(fermionErrors, "NoSuchEntity")
            .withArgs(10);
        });

        it("Caller is not a manager for the entity role", async function () {
          const wallet = wallets[2];

          await expect(
            entityFacet
              .connect(wallet)
              .addEntityAccounts(
                entityId,
                [wallet.address],
                [[EntityRole.Verifier, EntityRole.Custodian]],
                [[[AccountRole.Manager], []]],
              ),
          )
            .to.be.revertedWithCustomError(fermionErrors, "NotRoleManager")
            .withArgs(wallet.address, entityId, EntityRole.Verifier);
        });

        it("Caller is not an entity-wide manager", async function () {
          const wallet = wallets[2];

          // make the wallet an manager for all roles, but not an entity-wide manager
          await entityFacet.addEntityAccounts(
            entityId,
            [wallet.address],
            [[EntityRole.Seller, EntityRole.Verifier, EntityRole.Custodian]],
            [[[AccountRole.Manager], [AccountRole.Manager], [AccountRole.Manager]]],
          );

          await expect(
            entityFacet
              .connect(wallet)
              .addEntityAccounts(entityId, [wallets[3].address], [[]], [[[AccountRole.Assistant]]]),
          )
            .to.be.revertedWithCustomError(fermionErrors, "NotEntityWideRole")
            .withArgs(wallet.address, entityId, AccountRole.Manager);
        });

        it("Array mismatch", async function () {
          const newAccounts = [wallets[2].address];
          const entityRoles = [[EntityRole.Verifier, EntityRole.Custodian], [EntityRole.Seller]];
          const walletRoles = [[[AccountRole.Manager]]];

          await expect(entityFacet.addEntityAccounts(entityId, newAccounts, entityRoles, walletRoles))
            .to.be.revertedWithCustomError(fermionErrors, "ArrayLengthMismatch")
            .withArgs(newAccounts.length, entityRoles.length);

          entityRoles.pop();
          walletRoles.push([[]], [[]], [[]]);

          await expect(entityFacet.addEntityAccounts(entityId, newAccounts, entityRoles, walletRoles))
            .to.be.revertedWithCustomError(fermionErrors, "ArrayLengthMismatch")
            .withArgs(newAccounts.length, walletRoles.length);

          await expect(
            entityFacet.addEntityAccounts(
              entityId,
              newAccounts,
              [[]],
              [[[AccountRole.Manager], [AccountRole.Assistant]]],
            ),
          )
            .to.be.revertedWithCustomError(fermionErrors, "ArrayLengthMismatch")
            .withArgs(1, 2);

          await expect(
            entityFacet.addEntityAccounts(
              entityId,
              newAccounts,
              [[EntityRole.Verifier, EntityRole.Custodian, EntityRole.Seller]],
              [[[AccountRole.Manager], [AccountRole.Assistant]]],
            ),
          )
            .to.be.revertedWithCustomError(fermionErrors, "ArrayLengthMismatch")
            .withArgs(3, 2);
        });

        it("Entity does not have the role", async function () {
          const wallet = wallets[2].address;
          await expect(
            entityFacet.addEntityAccounts(entityId, [wallet], [[EntityRole.Buyer]], [[[AccountRole.Manager]]]),
          )
            .to.be.revertedWithCustomError(fermionErrors, "EntityHasNoRole")
            .withArgs(entityId, EntityRole.Buyer);
        });
      });
    });

    context("removeEntityAccounts", function () {
      const entityId = 1;
      const entityRolesAll = [EntityRole.Seller, EntityRole.Verifier, EntityRole.Custodian];
      let entityAccounts: string[];

      beforeEach(async function () {
        const metadataURI = "https://example.com/metadata.json";
        await entityFacet.createEntity(entityRolesAll, metadataURI);

        entityAccounts = wallets.slice(2, 4).map((wallet) => wallet.address);
        const entityRoles = [[EntityRole.Verifier, EntityRole.Custodian], [EntityRole.Seller]];
        const walletRoles = [[[AccountRole.Assistant], []], [[AccountRole.Treasury, AccountRole.Manager]]];

        await entityFacet.addEntityAccounts(entityId, entityAccounts, entityRoles, walletRoles);
      });

      it("Remove entity wallets", async function () {
        const entityRoles = [[EntityRole.Verifier, EntityRole.Custodian], [EntityRole.Seller]];
        const walletRoles = [[[], [AccountRole.Manager]], [[AccountRole.Treasury]]];

        // test event
        const tx = await entityFacet.removeEntityAccounts(entityId, entityAccounts, entityRoles, walletRoles);

        for (const [i, wallet] of entityAccounts.entries()) {
          await expect(tx)
            .to.emit(entityFacet, "EntityAccountRemoved")
            .withArgs(entityId, wallet, entityRoles[i], walletRoles[i]);
        }

        // verify state
        const expectedRoles = {};
        const wallet0 = entityAccounts[0];
        expectedRoles[wallet0] = {};
        expectedRoles[wallet0][EntityRole.Custodian] = {};
        expectedRoles[wallet0][EntityRole.Custodian][AccountRole.Assistant] = true;
        expectedRoles[wallet0][EntityRole.Custodian][AccountRole.Treasury] = true;

        const wallet1 = entityAccounts[1];
        expectedRoles[wallet1] = {};
        expectedRoles[wallet1][EntityRole.Seller] = {};
        expectedRoles[wallet1][EntityRole.Seller][AccountRole.Manager] = true;

        for (const wallet of entityAccounts) {
          for (const entityRole of enumIterator(EntityRole)) {
            for (const walletRole of enumIterator(AccountRole)) {
              const expectedValue =
                !!expectedRoles[wallet][entityRole] && !!expectedRoles[wallet][entityRole][walletRole];
              const hasRole = await entityFacet.hasAccountRole(entityId, wallet, entityRole, walletRole);

              expect(hasRole).to.equal(expectedValue);
            }
          }
        }
      });

      it("Remove all wallet roles for one entity role", async function () {
        const wallet = entityAccounts[1];
        const entityRoles = [[EntityRole.Seller]];
        const walletRoles = [[[]]];

        // test event
        const tx = await entityFacet.removeEntityAccounts(entityId, [wallet], entityRoles, walletRoles);

        await expect(tx)
          .to.emit(entityFacet, "EntityAccountRemoved")
          .withArgs(entityId, wallet, entityRoles[0], walletRoles[0]);

        // verify state
        for (const walletRole of enumIterator(AccountRole)) {
          const hasRole = await entityFacet.hasAccountRole(entityId, wallet, EntityRole.Custodian, walletRole);
          expect(hasRole).to.be.equal(false);
        }
      });

      it("Remove entity-wide wallet roles", async function () {
        const wallet = wallets[4].address;
        const entityRoles = [[]];
        const walletRoles = [[[AccountRole.Assistant]]];

        // test event
        await entityFacet.addEntityAccounts(entityId, [wallet], entityRoles, walletRoles);

        // verify state
        for (const entityRole of enumIterator(EntityRole)) {
          const hasRole = await entityFacet.hasAccountRole(entityId, wallet, entityRole, AccountRole.Assistant);
          expect(hasRole).to.be.equal(true);
        }

        await entityFacet.removeEntityAccounts(entityId, [wallet], entityRoles, walletRoles);

        // verify state
        for (const entityRole of enumIterator(EntityRole)) {
          const hasRole = await entityFacet.hasAccountRole(entityId, wallet, entityRole, AccountRole.Assistant);
          expect(hasRole).to.be.equal(false);
        }
      });

      it("Removing entity-wide wallet roles does not remove specific wallet roles", async function () {
        const wallet = wallets[4].address;
        const entityRoles = [[], [EntityRole.Custodian]];
        const walletRoles = [[[AccountRole.Assistant]], [[AccountRole.Assistant]]];

        // test event
        await entityFacet.addEntityAccounts(entityId, [wallet, wallet], entityRoles, walletRoles);

        // verify state
        for (const entityRole of enumIterator(EntityRole)) {
          const hasRole = await entityFacet.hasAccountRole(entityId, wallet, entityRole, AccountRole.Assistant);
          expect(hasRole).to.be.equal(true);
        }

        // remove entity-wide roles, but keep the specific wallet roles
        await entityFacet.removeEntityAccounts(entityId, [wallet], entityRoles.slice(0, 1), walletRoles.slice(0, 1));

        // verify state
        for (const entityRole of enumIterator(EntityRole)) {
          const expectedRole = entityRole == String(EntityRole.Custodian);
          const hasRole = await entityFacet.hasAccountRole(entityId, wallet, entityRole, AccountRole.Assistant);
          expect(hasRole).to.equal(expectedRole);
        }
      });

      it("Remove unassigned role", async function () {
        const wallet = entityAccounts[1];
        const entityRoles = [[EntityRole.Seller]];
        const walletRoles = [[[AccountRole.Assistant]]];

        // check the assigned roles
        expect(await entityFacet.hasAccountRole(entityId, wallet, EntityRole.Seller, AccountRole.Manager)).to.be.equal(
          true,
        );
        expect(
          await entityFacet.hasAccountRole(entityId, wallet, EntityRole.Seller, AccountRole.Assistant),
        ).to.be.equal(false);
        expect(await entityFacet.hasAccountRole(entityId, wallet, EntityRole.Seller, AccountRole.Treasury)).to.be.equal(
          true,
        );

        // test event
        await expect(entityFacet.removeEntityAccounts(entityId, [wallet], entityRoles, walletRoles))
          .to.emit(entityFacet, "EntityAccountRemoved")
          .withArgs(entityId, wallet, entityRoles[0], walletRoles[0]);

        // verify state, nothing should change
        expect(await entityFacet.hasAccountRole(entityId, wallet, EntityRole.Seller, AccountRole.Manager)).to.be.equal(
          true,
        );
        expect(
          await entityFacet.hasAccountRole(entityId, wallet, EntityRole.Seller, AccountRole.Assistant),
        ).to.be.equal(false);
        expect(await entityFacet.hasAccountRole(entityId, wallet, EntityRole.Seller, AccountRole.Treasury)).to.be.equal(
          true,
        );
      });

      context("Revert reasons", function () {
        it("Entity region is paused", async function () {
          await pauseFacet.pause([PausableRegion.Entity]);

          await expect(entityFacet.removeEntityAccounts(0, [], [], []))
            .to.be.revertedWithCustomError(fermionErrors, "RegionPaused")
            .withArgs(PausableRegion.Entity);
        });

        it("Entity does not exist", async function () {
          await expect(entityFacet.removeEntityAccounts(0, [], [], []))
            .to.be.revertedWithCustomError(fermionErrors, "NoSuchEntity")
            .withArgs(0);

          await expect(entityFacet.removeEntityAccounts(10, [], [], []))
            .to.be.revertedWithCustomError(fermionErrors, "NoSuchEntity")
            .withArgs(10);
        });

        it("Caller is not a manager for the entity role", async function () {
          const wallet = wallets[2];

          await expect(
            entityFacet
              .connect(wallet)
              .removeEntityAccounts(
                entityId,
                [wallet.address],
                [[EntityRole.Verifier, EntityRole.Custodian]],
                [[[AccountRole.Manager], []]],
              ),
          )
            .to.be.revertedWithCustomError(fermionErrors, "NotRoleManager")
            .withArgs(wallet.address, entityId, EntityRole.Verifier);
        });

        it("Caller is not an entity-wide manager", async function () {
          const wallet = wallets[2];

          // make the wallet a manager for all roles, but not an entity-wide manager
          await entityFacet.addEntityAccounts(
            entityId,
            [wallet.address],
            [[EntityRole.Seller, EntityRole.Verifier, EntityRole.Custodian]],
            [[[AccountRole.Manager], [AccountRole.Manager], [AccountRole.Manager]]],
          );

          await expect(
            entityFacet
              .connect(wallet)
              .removeEntityAccounts(entityId, [wallets[3].address], [[]], [[[AccountRole.Assistant]]]),
          )
            .to.be.revertedWithCustomError(fermionErrors, "NotEntityWideRole")
            .withArgs(wallet.address, entityId, AccountRole.Manager);
        });

        it("Array mismatch", async function () {
          const newAccounts = [wallets[2].address];
          const entityRoles = [[EntityRole.Verifier, EntityRole.Custodian], [EntityRole.Seller]];
          const walletRoles = [[[AccountRole.Manager]]];

          await expect(entityFacet.removeEntityAccounts(entityId, newAccounts, entityRoles, walletRoles))
            .to.be.revertedWithCustomError(fermionErrors, "ArrayLengthMismatch")
            .withArgs(newAccounts.length, entityRoles.length);

          entityRoles.pop();
          walletRoles.push([[]], [[]], [[]]);

          await expect(entityFacet.removeEntityAccounts(entityId, newAccounts, entityRoles, walletRoles))
            .to.be.revertedWithCustomError(fermionErrors, "ArrayLengthMismatch")
            .withArgs(newAccounts.length, walletRoles.length);

          await expect(
            entityFacet.removeEntityAccounts(
              entityId,
              newAccounts,
              [[]],
              [[[AccountRole.Manager], [AccountRole.Assistant]]],
            ),
          )
            .to.be.revertedWithCustomError(fermionErrors, "ArrayLengthMismatch")
            .withArgs(1, 2);

          await expect(
            entityFacet.removeEntityAccounts(
              entityId,
              newAccounts,
              [[EntityRole.Verifier, EntityRole.Custodian, EntityRole.Seller]],
              [[[AccountRole.Manager], [AccountRole.Assistant]]],
            ),
          )
            .to.be.revertedWithCustomError(fermionErrors, "ArrayLengthMismatch")
            .withArgs(3, 2);
        });

        it("Entity does not have the role", async function () {
          const wallet = wallets[2].address;
          await expect(
            entityFacet.removeEntityAccounts(entityId, [wallet], [[EntityRole.Buyer]], [[[AccountRole.Manager]]]),
          )
            .to.be.revertedWithCustomError(fermionErrors, "EntityHasNoRole")
            .withArgs(entityId, EntityRole.Buyer);
        });
      });
    });

    context("setAdmin", function () {
      const entityId = 1;
      const metadataURI = "https://example.com/metadata.json";

      beforeEach(async function () {
        await entityFacet.createEntity([EntityRole.Seller, EntityRole.Verifier, EntityRole.Custodian], metadataURI);
      });

      it("Set entity admin", async function () {
        const newAdmin = wallets[2];

        // test event
        const tx = await entityFacet.setAdmin(entityId, newAdmin.address);
        await expect(tx).to.emit(entityFacet, "AdminPending").withArgs(entityId, newAdmin.address);

        // verify state. The new admin does not get the roles yet
        for (const entityRole of enumIterator(EntityRole)) {
          const hasRole = await entityFacet.hasAccountRole(entityId, newAdmin.address, entityRole, AccountRole.Manager);
          expect(hasRole).to.be.equal(false);
        }
      });

      it("When new admin perform first admin action, the entity admin is changed", async function () {
        const newAdmin = wallets[2];
        await entityFacet.setAdmin(entityId, newAdmin.address);
        const entity = await entityFacet["getEntity(address)"](defaultSigner.address);

        // before new admin performs any action, the entity admin is the old admin
        await expect(entityFacet["getEntity(address)"](newAdmin.address))
          .to.be.revertedWithCustomError(fermionErrors, "NoSuchEntity")
          .withArgs(0);

        // make some action with the new admin
        const tx = entityFacet.connect(newAdmin).setAdmin(entityId, wallets[3].address);
        await expect(tx).to.not.be.reverted;
        await expect(tx)
          .to.emit(entityFacet, "EntityAccountAdded")
          .withArgs(entityId, newAdmin.address, [], [[AccountRole.Manager]]);
        await expect(tx)
          .to.emit(entityFacet, "EntityAccountRemoved")
          .withArgs(entityId, defaultSigner.address, [], [[AccountRole.Manager]]);

        // entity is referenced by the new admin signer
        await verifyState(newAdmin, entityId, entity.roles, entity.metadataURI);
        await expect(entityFacet["getEntity(address)"](defaultSigner.address))
          .to.be.revertedWithCustomError(fermionErrors, "NoSuchEntity")
          .withArgs(0);

        // old admin should not be able to perform entity admin actions, but can perform wallet admin actions
        await expect(entityFacet.setAdmin(entityId, newAdmin.address))
          .to.be.revertedWithCustomError(fermionErrors, "NotAdmin")
          .withArgs(entityId, defaultSigner.address);

        await expect(
          entityFacet.addEntityAccounts(
            entityId,
            [wallets[3].address],
            [[EntityRole.Verifier]],
            [[[AccountRole.Assistant]]],
          ),
        ).to.not.be.reverted;

        // old admin can create a new entity
        await expect(entityFacet.createEntity([EntityRole.Seller, EntityRole.Custodian], metadataURI)).to.not.be
          .reverted;
      });

      it("Unset entity admin", async function () {
        const newAdmin = wallets[2];

        // first set it
        await entityFacet.setAdmin(entityId, newAdmin.address);

        // unset it
        const tx = await entityFacet.setAdmin(entityId, ZeroAddress);
        await expect(tx).to.emit(entityFacet, "AdminPending").withArgs(entityId, ZeroAddress);

        // verify state
        for (const entityRole of enumIterator(EntityRole)) {
          const hasRole = await entityFacet.hasAccountRole(entityId, newAdmin.address, entityRole, AccountRole.Manager);
          expect(hasRole).to.be.equal(false);
        }

        // New admin should not be able to perform admin actions
        await expect(entityFacet.connect(newAdmin).setAdmin(entityId, newAdmin.address))
          .to.be.revertedWithCustomError(fermionErrors, "NotAdmin")
          .withArgs(entityId, newAdmin.address);
      });

      context("Revert reasons", function () {
        it("Entity region is paused", async function () {
          await pauseFacet.pause([PausableRegion.Entity]);

          await expect(entityFacet.setAdmin(entityId, ZeroAddress))
            .to.be.revertedWithCustomError(fermionErrors, "RegionPaused")
            .withArgs(PausableRegion.Entity);
        });

        it("Entity does not exist", async function () {
          const newAdmin = wallets[2];

          await expect(entityFacet.setAdmin(0, newAdmin.address))
            .to.be.revertedWithCustomError(fermionErrors, "NoSuchEntity")
            .withArgs(0);

          await expect(entityFacet.setAdmin(10, newAdmin.address))
            .to.be.revertedWithCustomError(fermionErrors, "NoSuchEntity")
            .withArgs(10);
        });

        it("Caller is not an admin for the entity role", async function () {
          const newAdmin = wallets[2];

          await expect(entityFacet.connect(newAdmin).setAdmin(entityId, newAdmin.address))
            .to.be.revertedWithCustomError(fermionErrors, "NotAdmin")
            .withArgs(entityId, newAdmin.address);
        });

        it("Caller is an admin for another entity", async function () {
          const newAdmin = wallets[2];

          await entityFacet.connect(newAdmin).createEntity([EntityRole.Seller, EntityRole.Custodian], metadataURI);

          await expect(entityFacet.connect(newAdmin).setAdmin(entityId, newAdmin.address))
            .to.be.revertedWithCustomError(fermionErrors, "NotAdmin")
            .withArgs(entityId, newAdmin.address);
        });
      });
    });

    context("facilitators", function () {
      const sellerId = 1n;
      const facilitator1Id = 2n;
      const facilitator2Id = 3n;
      let facilitator1: HardhatEthersSigner;
      let facilitator2: HardhatEthersSigner;
      const metadataURI = "https://example.com/metadata.json";

      before(async function () {
        facilitator1 = wallets[2];
        facilitator2 = wallets[3];
      });

      beforeEach(async function () {
        await entityFacet.createEntity([EntityRole.Seller], metadataURI); // seller
        await entityFacet.connect(facilitator1).createEntity([EntityRole.Seller], metadataURI); // facilitator1
        await entityFacet.connect(facilitator2).createEntity([EntityRole.Seller], metadataURI); // facilitator2
      });

      context("addFacilitators", function () {
        it("Seller can add facilitators", async function () {
          const facilitators = [facilitator1Id, facilitator2Id];

          const tx = await entityFacet.addFacilitators(sellerId, facilitators);

          for (const facilitatorId of facilitators) {
            await expect(tx).to.emit(entityFacet, "FacilitatorAdded").withArgs(sellerId, facilitatorId);
          }

          // verify state
          expect(await entityFacet.getSellersFacilitators(sellerId)).to.eql(facilitators);
          expect(await entityFacet.isSellersFacilitator(sellerId, facilitator1Id)).to.be.equal(true);
          expect(await entityFacet.isSellersFacilitator(sellerId, facilitator2Id)).to.be.equal(true);

          // add another facilitator
          const facilitator3Id = 4n;
          const facilitator3 = wallets[4];
          await entityFacet.connect(facilitator3).createEntity([EntityRole.Seller], metadataURI); // facilitator3

          await expect(entityFacet.addFacilitators(sellerId, [facilitator3Id]))
            .to.emit(entityFacet, "FacilitatorAdded")
            .withArgs(sellerId, facilitator3Id);

          // verify state
          expect(await entityFacet.getSellersFacilitators(sellerId)).to.eql([...facilitators, facilitator3Id]);
          expect(await entityFacet.isSellersFacilitator(sellerId, facilitator3Id)).to.be.equal(true);
        });

        it("Adding empty list does nothing", async function () {
          await expect(entityFacet.addFacilitators(sellerId, [])).to.not.emit(entityFacet, "FacilitatorAdded");

          // verify state
          expect(await entityFacet.getSellersFacilitators(sellerId)).to.eql([]);

          const facilitators = [facilitator1Id, facilitator2Id];
          await entityFacet.addFacilitators(sellerId, facilitators);
          await entityFacet.addFacilitators(sellerId, []);

          expect(await entityFacet.getSellersFacilitators(sellerId)).to.eql(facilitators);
          expect(await entityFacet.isSellersFacilitator(sellerId, facilitator1Id)).to.be.equal(true);
          expect(await entityFacet.isSellersFacilitator(sellerId, facilitator2Id)).to.be.equal(true);
        });

        context("Revert reasons", function () {
          it("Entity region is paused", async function () {
            await pauseFacet.pause([PausableRegion.Entity]);

            await expect(entityFacet.addFacilitators(sellerId, [facilitator1Id]))
              .to.be.revertedWithCustomError(fermionErrors, "RegionPaused")
              .withArgs(PausableRegion.Entity);
          });

          it("Entity does not exist", async function () {
            await expect(entityFacet.addFacilitators(0, []))
              .to.be.revertedWithCustomError(fermionErrors, "NoSuchEntity")
              .withArgs(0);

            await expect(entityFacet.addFacilitators(10, []))
              .to.be.revertedWithCustomError(fermionErrors, "NoSuchEntity")
              .withArgs(10);
          });

          it("Caller is not an admin", async function () {
            const newAdmin = wallets[2];

            await expect(entityFacet.connect(newAdmin).addFacilitators(sellerId, []))
              .to.be.revertedWithCustomError(fermionErrors, "NotAdmin")
              .withArgs(sellerId, newAdmin.address);
          });

          it("Facilitator does not exist", async function () {
            await expect(entityFacet.addFacilitators(sellerId, [0]))
              .to.be.revertedWithCustomError(fermionErrors, "EntityHasNoRole")
              .withArgs(0, EntityRole.Seller);

            await expect(entityFacet.addFacilitators(sellerId, [10]))
              .to.be.revertedWithCustomError(fermionErrors, "EntityHasNoRole")
              .withArgs(10, EntityRole.Seller);
          });

          it("Facilitator does not have the seller role", async function () {
            const entityId = 4n;
            const entity = wallets[4];
            await entityFacet.connect(entity).createEntity([EntityRole.Verifier], metadataURI); // facilitator3

            await expect(entityFacet.addFacilitators(sellerId, [entityId]))
              .to.be.revertedWithCustomError(fermionErrors, "EntityHasNoRole")
              .withArgs(entityId, EntityRole.Seller);
          });

          it("Facilitator is already a facilitator", async function () {
            await entityFacet.addFacilitators(sellerId, [facilitator1Id, facilitator2Id]);

            await expect(entityFacet.addFacilitators(sellerId, [facilitator1Id]))
              .to.be.revertedWithCustomError(fermionErrors, "FacilitatorAlreadyExists")
              .withArgs(sellerId, facilitator1Id);
          });

          it("Duplicate entry", async function () {
            await expect(entityFacet.addFacilitators(sellerId, [facilitator1Id, facilitator1Id]))
              .to.be.revertedWithCustomError(fermionErrors, "FacilitatorAlreadyExists")
              .withArgs(sellerId, facilitator1Id);
          });
        });
      });

      context("removeFacilitators", function () {
        const facilitator3Id = 4n;
        const facilitator4Id = 5n;
        let facilitator3: HardhatEthersSigner;
        let facilitator4: HardhatEthersSigner;

        before(async function () {
          facilitator3 = wallets[4];
          facilitator4 = wallets[5];
        });

        beforeEach(async function () {
          await entityFacet.connect(facilitator3).createEntity([EntityRole.Seller], metadataURI); // facilitator1
          await entityFacet.connect(facilitator4).createEntity([EntityRole.Seller], metadataURI); // facilitator2

          await entityFacet.addFacilitators(sellerId, [facilitator1Id, facilitator2Id, facilitator3Id, facilitator4Id]);
        });

        it("Seller can remove a facilitator", async function () {
          const facilitators = [facilitator1Id];

          await expect(entityFacet.removeFacilitators(sellerId, facilitators))
            .to.emit(entityFacet, "FacilitatorRemoved")
            .withArgs(sellerId, facilitator1Id);

          // verify state
          const expectedFacilitators = [facilitator4Id, facilitator2Id, facilitator3Id];
          expect(await entityFacet.getSellersFacilitators(sellerId)).to.eql(expectedFacilitators);

          expect(await entityFacet.isSellersFacilitator(sellerId, facilitator1Id)).to.be.equal(false);
          expect(await entityFacet.isSellersFacilitator(sellerId, facilitator2Id)).to.be.equal(true);
          expect(await entityFacet.isSellersFacilitator(sellerId, facilitator3Id)).to.be.equal(true);
          expect(await entityFacet.isSellersFacilitator(sellerId, facilitator4Id)).to.be.equal(true);
        });

        it("Removing multiple facilitators", async function () {
          const facilitators = [facilitator4Id, facilitator2Id];

          const tx = await entityFacet.removeFacilitators(sellerId, facilitators);

          for (const facilitatorId of facilitators) {
            await expect(tx).to.emit(entityFacet, "FacilitatorRemoved").withArgs(sellerId, facilitatorId);
          }

          // verify state
          const expectedFacilitators = [facilitator1Id, facilitator3Id];
          expect(await entityFacet.getSellersFacilitators(sellerId)).to.eql(expectedFacilitators);

          expect(await entityFacet.isSellersFacilitator(sellerId, facilitator1Id)).to.be.equal(true);
          expect(await entityFacet.isSellersFacilitator(sellerId, facilitator2Id)).to.be.equal(false);
          expect(await entityFacet.isSellersFacilitator(sellerId, facilitator3Id)).to.be.equal(true);
          expect(await entityFacet.isSellersFacilitator(sellerId, facilitator4Id)).to.be.equal(false);
        });

        it("Removing a facilitator that was not added", async function () {
          await expect(entityFacet.removeFacilitators(sellerId, [6])).to.not.emit(entityFacet, "FacilitatorRemoved");

          // verify state
          expect(await entityFacet.getSellersFacilitators(sellerId)).to.eql([
            facilitator1Id,
            facilitator2Id,
            facilitator3Id,
            facilitator4Id,
          ]);

          expect(await entityFacet.isSellersFacilitator(sellerId, facilitator1Id)).to.be.equal(true);
          expect(await entityFacet.isSellersFacilitator(sellerId, facilitator2Id)).to.be.equal(true);
          expect(await entityFacet.isSellersFacilitator(sellerId, facilitator3Id)).to.be.equal(true);
          expect(await entityFacet.isSellersFacilitator(sellerId, facilitator4Id)).to.be.equal(true);
        });

        it("Remove the same facilitator twice", async function () {
          const facilitators = [facilitator2Id, facilitator2Id];

          await expect(entityFacet.removeFacilitators(sellerId, facilitators))
            .to.emit(entityFacet, "FacilitatorRemoved")
            .withArgs(sellerId, facilitator2Id);

          // verify state
          const expectedFacilitators = [facilitator1Id, facilitator4Id, facilitator3Id];
          expect(await entityFacet.getSellersFacilitators(sellerId)).to.eql(expectedFacilitators);

          expect(await entityFacet.isSellersFacilitator(sellerId, facilitator1Id)).to.be.equal(true);
          expect(await entityFacet.isSellersFacilitator(sellerId, facilitator2Id)).to.be.equal(false);
          expect(await entityFacet.isSellersFacilitator(sellerId, facilitator3Id)).to.be.equal(true);
          expect(await entityFacet.isSellersFacilitator(sellerId, facilitator4Id)).to.be.equal(true);
        });

        context("Revert reasons", function () {
          it("Entity region is paused", async function () {
            await pauseFacet.pause([PausableRegion.Entity]);

            await expect(entityFacet.removeFacilitators(sellerId, [facilitator1Id]))
              .to.be.revertedWithCustomError(fermionErrors, "RegionPaused")
              .withArgs(PausableRegion.Entity);
          });

          it("Entity does not exist", async function () {
            await expect(entityFacet.removeFacilitators(0, []))
              .to.be.revertedWithCustomError(fermionErrors, "NoSuchEntity")
              .withArgs(0);

            await expect(entityFacet.removeFacilitators(10, []))
              .to.be.revertedWithCustomError(fermionErrors, "NoSuchEntity")
              .withArgs(10);
          });

          it("Caller is not an admin", async function () {
            const newAdmin = wallets[2];

            await expect(entityFacet.connect(newAdmin).removeFacilitators(sellerId, []))
              .to.be.revertedWithCustomError(fermionErrors, "NotAdmin")
              .withArgs(sellerId, newAdmin.address);
          });
        });
      });
    });

    context("changeAccount", function () {
      const entityId = 1;
      const entityRoles = [[EntityRole.Custodian, EntityRole.Verifier]];
      let wallet: HardhatEthersSigner;

      beforeEach(async function () {
        await entityFacet.createEntity([EntityRole.Seller, EntityRole.Verifier, EntityRole.Custodian], metadataURI);
        wallet = wallets[2];
        const walletRoles = [[[], []]];

        await entityFacet.addEntityAccounts(entityId, [wallet.address], entityRoles, walletRoles);
      });

      it("new wallet has all roles", async function () {
        const newAccount = wallets[3].address;

        // test event
        await expect(entityFacet.connect(wallet).changeAccount(newAccount))
          .to.emit(entityFacet, "AccountChanged")
          .withArgs(wallet.address, newAccount);

        // verify state
        for (const entityRole of entityRoles[0]) {
          for (const walletRole of enumIterator(AccountRole)) {
            const newAccounthasRole = await entityFacet.hasAccountRole(entityId, newAccount, entityRole, walletRole);
            expect(newAccounthasRole).to.be.equal(true);

            const oldAccounthasRole = await entityFacet.hasAccountRole(
              entityId,
              wallet.address,
              entityRole,
              walletRole,
            );
            expect(oldAccounthasRole).to.be.equal(false);
          }
        }
      });

      context("Revert reasons", function () {
        it("Entity region is paused", async function () {
          await pauseFacet.pause([PausableRegion.Entity]);

          const newAdmin = wallets[2];
          await expect(entityFacet.changeAccount(newAdmin.address))
            .to.be.revertedWithCustomError(fermionErrors, "RegionPaused")
            .withArgs(PausableRegion.Entity);
        });

        it("New wallet is the same as the old", async function () {
          await expect(entityFacet.changeAccount(defaultSigner.address)).to.be.revertedWithCustomError(
            fermionErrors,
            "NewAccountSameAsOld",
          );
        });

        it("Caller is an entity admin", async function () {
          const newAdmin = wallets[2];

          await expect(entityFacet.changeAccount(newAdmin.address)).to.be.revertedWithCustomError(
            fermionErrors,
            "ChangeNotAllowed",
          );
        });

        it("Caller is not a wallet for any entity", async function () {
          const wallet = wallets[3];

          await expect(entityFacet.connect(wallet).changeAccount(wallets[2].address))
            .to.be.revertedWithCustomError(fermionErrors, "NoSuchEntity")
            .withArgs(0);
        });

        it("New wallet is already a wallet for an entity", async function () {
          const newAccount = wallets[3];
          await entityFacet.addEntityAccounts(entityId, [newAccount.address], entityRoles, [[[], []]]);

          await expect(entityFacet.connect(wallet).changeAccount(newAccount.address))
            .to.be.revertedWithCustomError(fermionErrors, "AccountAlreadyExists")
            .withArgs(newAccount.address);
        });
      });
    });

    context("transferWrapperContractOwnership", function () {
      const entityId = "1";
      const bosonOfferId = "1";
      const sellerId = "1";
      const facilitatorId = "2";
      let wrapper: Contract;
      let facilitator: HardhatEthersSigner;

      beforeEach(async function () {
        facilitator = wallets[2];
        await entityFacet.createEntity([EntityRole.Seller, EntityRole.Verifier, EntityRole.Custodian], metadataURI);
        await entityFacet
          .connect(facilitator)
          .createEntity([EntityRole.Seller, EntityRole.Verifier, EntityRole.Custodian], metadataURI);
        await entityFacet.addFacilitators(sellerId, [facilitatorId]);

        const fermionOffer = {
          sellerId,
          sellerDeposit: "0",
          verifierId: sellerId,
          verifierFee: "0",
          custodianId: sellerId,
          custodianFee: {
            amount: 0n,
            period: 30n * 24n * 60n * 60n, // 30 days
          },
          facilitatorId,
          facilitatorFeePercent: "0",
          exchangeToken: ZeroAddress,
          withPhygital: false,
          metadata: {
            URI: "https://example.com/offer-metadata.json",
            hash: "",
          },
        };

        await offerFacet.addSupportedToken(ZeroAddress);
        await offerFacet.createOffer(fermionOffer);
        await offerFacet.mintAndWrapNFTs(bosonOfferId, "1");

        const wrapperAddress = await offerFacet.predictFermionFNFTAddress(bosonOfferId);
        wrapper = await ethers.getContractAt("FermionFNFT", wrapperAddress);
      });

      it("Transfer ownership to another assistant", async function () {
        const newAssistant = wallets[4].address;

        await entityFacet.addEntityAccounts(
          sellerId,
          [newAssistant],
          [[EntityRole.Seller]],
          [[[AccountRole.Assistant]]],
        );

        // test event
        await expect(entityFacet.transferWrapperContractOwnership(bosonOfferId, newAssistant))
          .to.emit(wrapper, "OwnershipTransferred")
          .withArgs(defaultSigner.address, newAssistant);

        // verify state
        expect(await wrapper.owner()).to.equal(newAssistant);
      });

      it("Transfer ownership to facilitator", async function () {
        // Transfer to facilitator's super admin
        // test event
        await expect(entityFacet.transferWrapperContractOwnership(bosonOfferId, facilitator.address))
          .to.emit(wrapper, "OwnershipTransferred")
          .withArgs(defaultSigner.address, facilitator.address);

        // verify state
        expect(await wrapper.owner()).to.equal(facilitator.address);

        // Transfer to facilitator's assistant
        const facilitatorAssistant = wallets[4].address;
        await entityFacet
          .connect(facilitator)
          .addEntityAccounts(facilitatorId, [facilitatorAssistant], [[EntityRole.Seller]], [[[AccountRole.Assistant]]]);

        // test event
        await expect(entityFacet.transferWrapperContractOwnership(bosonOfferId, facilitatorAssistant))
          .to.emit(wrapper, "OwnershipTransferred")
          .withArgs(facilitator.address, facilitatorAssistant);

        // verify state
        expect(await wrapper.owner()).to.equal(facilitatorAssistant);
      });

      context("Revert reasons", function () {
        it("Entity region is paused", async function () {
          await pauseFacet.pause([PausableRegion.Entity]);

          await expect(entityFacet.transferWrapperContractOwnership(bosonOfferId, ZeroAddress))
            .to.be.revertedWithCustomError(fermionErrors, "RegionPaused")
            .withArgs(PausableRegion.Entity);
        });

        it("An offer does not exist", async function () {
          await expect(entityFacet.transferWrapperContractOwnership(0, ZeroAddress))
            .to.be.revertedWithCustomError(fermionErrors, "NoSuchOffer")
            .withArgs(0);

          await expect(entityFacet.transferWrapperContractOwnership(10, ZeroAddress))
            .to.be.revertedWithCustomError(fermionErrors, "NoSuchOffer")
            .withArgs(10);
        });

        it("Caller is not the admin", async function () {
          const signer2 = wallets[2];
          await expect(entityFacet.connect(signer2).transferWrapperContractOwnership(bosonOfferId, ZeroAddress))
            .to.be.revertedWithCustomError(fermionErrors, "NotAdmin")
            .withArgs(entityId, signer2.address);
        });

        it("New owner is not the assistant", async function () {
          const newOwner = wallets[4].address;
          await expect(entityFacet.transferWrapperContractOwnership(bosonOfferId, newOwner))
            .to.be.revertedWithCustomError(fermionErrors, "AccountHasNoRole")
            .withArgs(entityId, newOwner, EntityRole.Seller, AccountRole.Assistant);
        });
      });
    });

    context("getEntity", function () {
      context("By address", function () {
        it("Get an entity", async function () {
          const entityId = "1";
          await entityFacet.createEntity([EntityRole.Verifier, EntityRole.Custodian], metadataURI);

          let response = await entityFacet["getEntity(address)"](defaultSigner.address);
          expect(response.entityId).to.equal(entityId);
          expect(response.roles.map(String)).to.have.members([EntityRole.Verifier, EntityRole.Custodian].map(String));
          expect(response.metadataURI).to.equal(metadataURI);

          const newMetadataURI = "https://example.com/metadata2.json";
          await entityFacet.updateEntity(
            entityId,
            [EntityRole.Verifier, EntityRole.Seller, EntityRole.Custodian, EntityRole.Buyer],
            newMetadataURI,
          );

          response = await entityFacet["getEntity(address)"](defaultSigner.address);
          expect(response.entityId).to.equal(entityId);
          expect(response.roles.map(String)).to.have.members(
            [EntityRole.Seller, EntityRole.Buyer, EntityRole.Custodian, EntityRole.Verifier].map(String),
          );
          expect(response.metadataURI).to.equal(newMetadataURI);
        });

        context("Revert reasons", function () {
          it("An entity does not exist", async function () {
            const signer2 = wallets[2];
            await expect(entityFacet["getEntity(address)"](signer2.address))
              .to.be.revertedWithCustomError(fermionErrors, "NoSuchEntity")
              .withArgs(0);
          });
        });
      });

      context("By entity id", function () {
        it("Get an entity", async function () {
          const entityId = "1";
          await entityFacet.createEntity([EntityRole.Verifier, EntityRole.Custodian], metadataURI);

          let response = await entityFacet["getEntity(uint256)"](entityId);
          expect(response.adminAccount).to.equal(defaultSigner.address);
          expect(response.roles.map(String)).to.have.members([EntityRole.Verifier, EntityRole.Custodian].map(String));
          expect(response.metadataURI).to.equal(metadataURI);

          const newMetadataURI = "https://example.com/metadata2.json";
          await entityFacet.updateEntity(
            entityId,
            [EntityRole.Verifier, EntityRole.Seller, EntityRole.Custodian, EntityRole.Buyer],
            newMetadataURI,
          );

          response = await entityFacet["getEntity(uint256)"](entityId);
          expect(response.adminAccount).to.equal(defaultSigner.address);
          expect(response.roles.map(String)).to.have.members(
            [EntityRole.Seller, EntityRole.Buyer, EntityRole.Custodian, EntityRole.Verifier].map(String),
          );
          expect(response.metadataURI).to.equal(newMetadataURI);
        });

        context("Revert reasons", function () {
          it("An entity does not exist", async function () {
            await expect(entityFacet["getEntity(uint256)"](0))
              .to.be.revertedWithCustomError(fermionErrors, "NoSuchEntity")
              .withArgs(0);

            await expect(entityFacet["getEntity(uint256)"](10))
              .to.be.revertedWithCustomError(fermionErrors, "NoSuchEntity")
              .withArgs(10);
          });
        });
      });
    });

    context("hasRole", function () {
      const entityId = 1;
      beforeEach(async function () {
        const metadataURI = "https://example.com/metadata.json";
        await entityFacet.createEntity([EntityRole.Seller, EntityRole.Verifier, EntityRole.Custodian], metadataURI);
      });

      it("hasRole returns correct values", async function () {
        const wallet = wallets[2];
        const entityRoles = [[EntityRole.Verifier, EntityRole.Custodian]];
        const walletRoles = [[[AccountRole.Assistant], []]];

        await entityFacet.addEntityAccounts(entityId, [wallet], entityRoles, walletRoles);

        let hasRole = await entityFacet.hasAccountRole(entityId, wallet, EntityRole.Verifier, AccountRole.Assistant);
        expect(hasRole).to.be.equal(true);

        hasRole = await entityFacet.hasAccountRole(entityId, wallet, EntityRole.Verifier, AccountRole.Manager);
        expect(hasRole).to.be.equal(false);
      });

      it("Account does not belong to an entity", async function () {
        const wallet = wallets[3];
        const hasRole = await entityFacet.hasAccountRole(entityId, wallet, EntityRole.Buyer, AccountRole.Manager);

        expect(hasRole).to.equal(false);
      });

      context("Revert reasons", function () {
        it("An entity does not exist", async function () {
          const wallet = wallets[3];
          await expect(entityFacet.hasAccountRole(0, wallet, EntityRole.Buyer, AccountRole.Manager))
            .to.be.revertedWithCustomError(fermionErrors, "NoSuchEntity")
            .withArgs(0);

          await expect(entityFacet.hasAccountRole(10, wallet, EntityRole.Buyer, AccountRole.Manager))
            .to.be.revertedWithCustomError(fermionErrors, "NoSuchEntity")
            .withArgs(10);
        });
      });
    });

    context("hasEntityRole", function () {
      const entityId = 1;
      beforeEach(async function () {
        const metadataURI = "https://example.com/metadata.json";
        await entityFacet.createEntity([EntityRole.Seller, EntityRole.Verifier, EntityRole.Custodian], metadataURI);
      });

      it("hasEntityRole returns correct values", async function () {
        expect(await entityFacet.hasEntityRole(entityId, EntityRole.Seller)).to.be.equal(true);
        expect(await entityFacet.hasEntityRole(entityId, EntityRole.Verifier)).to.be.equal(true);
        expect(await entityFacet.hasEntityRole(entityId, EntityRole.Custodian)).to.be.equal(true);
        expect(await entityFacet.hasEntityRole(entityId, EntityRole.Buyer)).to.be.equal(false);
      });

      context("Revert reasons", function () {
        it("An entity does not exist", async function () {
          await expect(entityFacet.hasEntityRole(0, EntityRole.Buyer))
            .to.be.revertedWithCustomError(fermionErrors, "NoSuchEntity")
            .withArgs(0);

          await expect(entityFacet.hasEntityRole(10, EntityRole.Seller))
            .to.be.revertedWithCustomError(fermionErrors, "NoSuchEntity")
            .withArgs(10);
        });
      });
    });
  });
});
