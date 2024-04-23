import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { EntityRole } from "../utils/enums";
import { deployFermionProtocolFixture } from "../utils/common";
import {
  getStateModifyingFunctions,
  getStateModifyingFunctionsHashes,
  metaTransactionType,
  prepareDataSignatureParameters,
  randomNonce,
} from "../utils/metaTransaction";

const { id } = ethers;

describe("MetaTransactions", function () {
  let entityFacet: any, metaTransactionFacet: any;
  let wallets, defaultSigner;
  let fermionErrors;

  before(async function () {
    ({
      facets: { EntityFacet: entityFacet, MetaTransactionFacet: metaTransactionFacet },
      fermionErrors,
      wallets,
      defaultSigner,
    } = await loadFixture(deployFermionProtocolFixture));
  });

  afterEach(async function () {
    await loadFixture(deployFermionProtocolFixture);
  });

  describe("MetaTransactions facet", function () {
    context("executeMetaTransaction", function () {
      context("Forwards a generic meta transaction [createEntity]", async function () {
        let entity, message;
        beforeEach(async function () {
          const nonce = randomNonce();
          entity = wallets[2];

          // Prepare the message
          message = {
            nonce: nonce,
            from: entity.address,
            contractAddress: await entityFacet.getAddress(),
            functionName: "createEntity(uint8[],string)",
            functionSignature: "",
          };

          // ToDo: allowlist all when doing the initial deployment
          const deployer = wallets[0];
          await metaTransactionFacet.connect(deployer).setAllowlistedFunctions([id(message.functionName)], true);
        });

        it("Forwarded call succeeds", async function () {
          const metadataURI = "https://example.com/metadata.json";
          const entityRoles = [EntityRole.Verifier, EntityRole.Custodian];

          // Prepare the function signature for the facet function.
          message.functionSignature = entityFacet.interface.encodeFunctionData("createEntity", [
            entityRoles,
            metadataURI,
          ]);

          // Collect the signature components
          const { r, s, v } = await prepareDataSignatureParameters(
            entity,
            {
              MetaTransaction: metaTransactionType,
            },
            "MetaTransaction",
            message,
            await metaTransactionFacet.getAddress(),
          );

          // Send as meta transaction
          const tx = await metaTransactionFacet.executeMetaTransaction(
            entity.address,
            message.functionName,
            message.functionSignature,
            message.nonce,
            r,
            s,
            v,
          );

          // Verify the event
          await expect(tx)
            .to.emit(metaTransactionFacet, "MetaTransactionExecuted")
            .withArgs(entity.address, defaultSigner.address, message.functionName, message.nonce);
          await expect(tx).to.emit(entityFacet, "EntityUpdated").withArgs(entity.address, entityRoles, metadataURI);

          // Verify the state
          const response = await entityFacet.getEntity(entity.address);
          expect(response.roles.map(String)).to.have.members(entityRoles.map(String));
          expect(response.metadataURI).to.equal(metadataURI);

          expect(await metaTransactionFacet.isUsedNonce(entity.address, message.nonce)).to.be.true;
        });

        it("Forwarded call fails", async function () {
          // Prepare the function signature for the facet function.
          message.functionSignature = entityFacet.interface.encodeFunctionData("createEntity", [[], ""]);

          // Collect the signature components
          const { r, s, v } = await prepareDataSignatureParameters(
            entity,
            {
              MetaTransaction: metaTransactionType,
            },
            "MetaTransaction",
            message,
            await metaTransactionFacet.getAddress(),
          );

          await expect(
            metaTransactionFacet.executeMetaTransaction(
              entity.address,
              message.functionName,
              message.functionSignature,
              message.nonce,
              r,
              s,
              v,
            ),
          ).to.be.revertedWithCustomError(fermionErrors, "InvalidEntityRoles");
        });
      });

      context("Revert reasons", function () {
        // * - Nonce is already used by the msg.sender for another transaction
        // * - Function is not allowlisted to be called using metatransactions
        // * - Function name does not match the bytes4 version of the function signature
        // * - Sender does not match the recovered signer
        // * - Any code executed in the signed transaction reverts
        // * - Signature is invalid
      });
    });

    context("Allowlisted functions", function () {
      const facetNames = ["EntityFacet", "MetaTransactionFacet"];
      let functionList: string[], functionHashList: string[];
      let admin;
      beforeEach(async function () {
        // A list of random functions
        functionList = [
          "testFunction1(uint256)",
          "testFunction2(uint256)",
          "testFunction3((uint256,address,bool))",
          "testFunction4(uint256[])",
        ];

        functionHashList = functionList.map((func) => id(func));

        admin = wallets[0];
      });

      context("👉 setAllowlistedFunctions()", async function () {
        it("should emit a FunctionsAllowlisted event", async function () {
          // Enable functions
          await expect(metaTransactionFacet.connect(admin).setAllowlistedFunctions(functionHashList, true))
            .to.emit(metaTransactionFacet, "FunctionsAllowlisted")
            .withArgs(functionHashList, true, admin.address);

          // Disable functions
          await expect(metaTransactionFacet.connect(admin).setAllowlistedFunctions(functionHashList, false))
            .to.emit(metaTransactionFacet, "FunctionsAllowlisted")
            .withArgs(functionHashList, false, admin.address);
        });

        it("should update state", async function () {
          // Functions should be disabled by default
          for (const func of functionHashList) {
            expect(await metaTransactionFacet["isFunctionAllowlisted(bytes32)"](func)).to.be.false;
          }

          // Enable functions
          await metaTransactionFacet.connect(admin).setAllowlistedFunctions(functionHashList, true);

          // Functions should be enabled
          for (const func of functionHashList) {
            expect(await metaTransactionFacet["isFunctionAllowlisted(bytes32)"](func)).to.be.true;
          }

          // Disable functions
          await metaTransactionFacet.connect(admin).setAllowlistedFunctions(functionHashList, false);

          // Functions should be disabled
          for (const func of functionHashList) {
            expect(await metaTransactionFacet["isFunctionAllowlisted(bytes32)"](func)).to.be.false;
          }
        });

        context("💔 Revert Reasons", async function () {
          it("caller is not the admin", async function () {
            await expect(metaTransactionFacet.setAllowlistedFunctions(functionHashList, true))
              .to.revertedWithCustomError(metaTransactionFacet, "NotContractOwner")
              .withArgs(defaultSigner.address, admin.address);
          });
        });
      });

      context("👉 isFunctionAllowlisted(bytes32)", async function () {
        it("after initialization all state modifying functions should be allowlisted", async function () {
          const stateModifyingFunctionsHashes = await getStateModifyingFunctionsHashes(facetNames, [
            "executeMetaTransaction",
          ]);

          // Functions should be enabled
          for (const func of stateModifyingFunctionsHashes) {
            expect(await metaTransactionFacet["isFunctionAllowlisted(bytes32)"](func)).to.be.true;
          }
        });

        it("should return correct value", async function () {
          // Functions should be disabled by default
          for (const func of functionHashList) {
            expect(await metaTransactionFacet["isFunctionAllowlisted(bytes32)"](func)).to.be.false;
          }

          // Enable functions
          await metaTransactionFacet.connect(admin).setAllowlistedFunctions(functionHashList, true);

          // Functions should be enabled
          for (const func of functionHashList) {
            expect(await metaTransactionFacet["isFunctionAllowlisted(bytes32)"](func)).to.be.true;
          }

          // Disable functions
          await metaTransactionFacet.connect(admin).setAllowlistedFunctions(functionHashList, false);

          // Functions should be disabled
          for (const func of functionHashList) {
            expect(await metaTransactionFacet["isFunctionAllowlisted(bytes32)"](func)).to.be.false;
          }
        });
      });

      context("👉 isFunctionAllowlisted(string)", async function () {
        it("after initialization all state modifying functions should be allowlisted", async function () {
          // Get list of state modifying functions
          const stateModifyingFunctions = await getStateModifyingFunctions(facetNames, [
            "executeMetaTransaction",
            "init",
          ]);

          for (const func of stateModifyingFunctions) {
            expect(await metaTransactionFacet["isFunctionAllowlisted(string)"](func)).to.be.true;
          }
        });

        it("should return correct value", async function () {
          // Functions should be disabled by default
          for (const func of functionList) {
            expect(await metaTransactionFacet["isFunctionAllowlisted(string)"](func)).to.be.false;
          }

          // Enable functions
          await metaTransactionFacet.connect(admin).setAllowlistedFunctions(functionHashList, true);

          // Functions should be enabled
          for (const func of functionList) {
            expect(await metaTransactionFacet["isFunctionAllowlisted(string)"](func)).to.be.true;
          }

          // Disable functions
          await metaTransactionFacet.connect(admin).setAllowlistedFunctions(functionHashList, false);

          // Functions should be disabled
          for (const func of functionList) {
            expect(await metaTransactionFacet["isFunctionAllowlisted(string)"](func)).to.be.false;
          }
        });
      });
    });
  });
});
