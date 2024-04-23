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
import { deployDiamond, prepareFacetCuts, makeDiamondCut } from "../../scripts/deploy";

const { id, getContractAt, getContractFactory, MaxUint256, toBeHex, ZeroAddress, ZeroHash } = ethers;

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
      context("Externally owned account", function () {
        let entity, message;
        beforeEach(async function () {
          const nonce = randomNonce();
          entity = wallets[2];

          // Prepare the message
          message = {
            nonce: nonce,
            from: entity.address,
            contractAddress: await entityFacet.getAddress(),
            functionName: entityFacet.interface.getFunction("createEntity").format("sighash"),
            functionSignature: "0x",
          };
        });

        context("Forwards a generic meta transaction [createEntity]", async function () {
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
          it("Nonce is already used by the msg.sender for another transaction", async function () {
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

            // First transaction should succeed
            await metaTransactionFacet.executeMetaTransaction(
              entity.address,
              message.functionName,
              message.functionSignature,
              message.nonce,
              r,
              s,
              v,
            );

            // Second transaction should fail
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
            ).to.be.revertedWithCustomError(fermionErrors, "NonceUsedAlready");
          });

          it("Function is not allowlisted to be called using metatransactions", async function () {
            // Use improper function name
            message.functionName = "createEntity";

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
            ).to.be.revertedWithCustomError(fermionErrors, "FunctionNotAllowlisted");
          });

          it("Function name does not match the bytes4 version of the function signature", async function () {
            // Encode different function than specified in the function name
            message.functionSignature = entityFacet.interface.encodeFunctionData("updateEntity", [[], ""]);

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
            ).to.be.revertedWithCustomError(fermionErrors, "InvalidFunctionName");
          });

          it("Sender does not match the recovered signer", async function () {
            // Prepare the function signature for the facet function.
            message.functionSignature = entityFacet.interface.encodeFunctionData("createEntity", [[], ""]);

            // Use a different signer
            const { r, s, v } = await prepareDataSignatureParameters(
              defaultSigner,
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
            ).to.be.revertedWithCustomError(fermionErrors, "SignerAndSignatureDoNotMatch");
          });

          it("Signature is invalid", async function () {
            // Prepare the function signature for the facet function.
            message.functionSignature = entityFacet.interface.encodeFunctionData("createEntity", [[], ""]);

            // Use a different signer
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
                toBeHex(MaxUint256), // s is valid only if <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0
                v,
              ),
            ).to.be.revertedWithCustomError(fermionErrors, "InvalidSignature");

            await expect(
              metaTransactionFacet.executeMetaTransaction(
                entity.address,
                message.functionName,
                message.functionSignature,
                message.nonce,
                r,
                toBeHex(0n, 32), // s must be non-zero
                v,
              ),
            ).to.be.revertedWithCustomError(fermionErrors, "InvalidSignature");

            await expect(
              metaTransactionFacet.executeMetaTransaction(
                entity.address,
                message.functionName,
                message.functionSignature,
                message.nonce,
                r,
                s,
                32, // v is valid only if it is 27 or 28
              ),
            ).to.be.revertedWithCustomError(fermionErrors, "InvalidSignature");
          });

          it("Calling the facet from another diamond [test domain separator]", async function () {
            // Get the existing facet address
            const diamondLoupe = await getContractAt("DiamondLoupeFacet", await metaTransactionFacet.getAddress());
            const functionFragment = metaTransactionFacet.interface.getFunction("executeMetaTransaction");
            const metaTransactionFacetAddress = await diamondLoupe.facetAddress(functionFragment.selector);

            // Deploy a new diamond, from where the existing facet will be called
            const diamondAddress = await deployDiamond();

            // Deploy multiInit facet
            const DiamondMutiInit = await ethers.getContractFactory("DiamondMultiInit");
            const diamondMutiInit = await DiamondMutiInit.deploy();
            await diamondMutiInit.waitForDeployment();

            // Prepare init call
            const initAddresses = [metaTransactionFacetAddress];
            const initCalldatas = [
              metaTransactionFacet.interface.encodeFunctionData("init", [[id(message.functionName)]]),
            ];
            const functionCall = diamondMutiInit.interface.encodeFunctionData("multiInit", [
              initAddresses,
              initCalldatas,
            ]);

            await makeDiamondCut(
              diamondAddress,
              await prepareFacetCuts([metaTransactionFacet.attach(metaTransactionFacetAddress)]),
              await diamondMutiInit.getAddress(),
              functionCall,
            );

            // Prepare the function signature for the facet function.
            message.functionSignature = entityFacet.interface.encodeFunctionData("createEntity", [[], ""]);

            // Use a different signer
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
              metaTransactionFacet
                .attach(diamondAddress)
                .executeMetaTransaction(
                  entity.address,
                  message.functionName,
                  message.functionSignature,
                  message.nonce,
                  r,
                  s,
                  v,
                ),
            ).to.be.revertedWithCustomError(fermionErrors, "SignerAndSignatureDoNotMatch");
          });

          it("Forwarded call reverts without a reason", async function () {
            const revertingFacetFactory = await getContractFactory("RevertingFacet");
            const revertingFacet = await revertingFacetFactory.deploy();
            await revertingFacet.waitForDeployment();

            await makeDiamondCut(
              await metaTransactionFacet.getAddress(),
              await prepareFacetCuts([revertingFacet]),
              ZeroAddress,
              "0x",
            );

            const admin = wallets[0];
            await metaTransactionFacet.connect(admin).setAllowlistedFunctions([id("revertWithoutReason()")], true);

            message.functionSignature = revertingFacet.interface.encodeFunctionData("revertWithoutReason");
            message.functionName = "revertWithoutReason()";

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

            // Default revert reason
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
            ).to.be.revertedWithCustomError(fermionErrors, "FunctionCallFailed");
          });
        });
      });

      context("Contract account", function () {
        let entity, entityAddress, message;
        beforeEach(async function () {
          const nonce = randomNonce();

          // Deploy contract wallet
          const contractWalletFactory = await getContractFactory("ContractWallet");
          const contractWallet = await contractWalletFactory.deploy();
          await contractWallet.waitForDeployment();
          entity = contractWallet;
          entityAddress = await entity.getAddress();

          // Prepare the message
          message = {
            nonce: nonce,
            from: entityAddress,
            contractAddress: await entityFacet.getAddress(),
            functionName: entityFacet.interface.getFunction("createEntity").format("sighash"),
            functionSignature: "0x",
          };
        });

        it("Forwards a generic meta transaction [createEntity]", async function () {
          const metadataURI = "https://example.com/metadata.json";
          const entityRoles = [EntityRole.Verifier, EntityRole.Custodian];

          // Prepare the function signature for the facet function.
          message.functionSignature = entityFacet.interface.encodeFunctionData("createEntity", [
            entityRoles,
            metadataURI,
          ]);

          await entity.setValidity(1); // 1=valid

          // Send as meta transaction
          const tx = await metaTransactionFacet.executeMetaTransaction(
            entityAddress,
            message.functionName,
            message.functionSignature,
            message.nonce,
            ZeroHash,
            ZeroHash,
            0,
          );

          // Verify the event
          await expect(tx)
            .to.emit(metaTransactionFacet, "MetaTransactionExecuted")
            .withArgs(entityAddress, defaultSigner.address, message.functionName, message.nonce);
          await expect(tx).to.emit(entityFacet, "EntityUpdated").withArgs(entityAddress, entityRoles, metadataURI);

          // Verify the state
          const response = await entityFacet.getEntity(entityAddress);
          expect(response.roles.map(String)).to.have.members(entityRoles.map(String));
          expect(response.metadataURI).to.equal(metadataURI);

          expect(await metaTransactionFacet.isUsedNonce(entityAddress, message.nonce)).to.be.true;
        });

        context("Revert reasons", function () {
          it("Nonce is already used by the msg.sender for another transaction", async function () {
            const metadataURI = "https://example.com/metadata.json";
            const entityRoles = [EntityRole.Verifier, EntityRole.Custodian];

            // Prepare the function signature for the facet function.
            message.functionSignature = entityFacet.interface.encodeFunctionData("createEntity", [
              entityRoles,
              metadataURI,
            ]);

            await entity.setValidity(1); // 1=valid

            // First transaction should succeed
            await metaTransactionFacet.executeMetaTransaction(
              entityAddress,
              message.functionName,
              message.functionSignature,
              message.nonce,
              ZeroHash,
              ZeroHash,
              0,
            );

            // Second transaction should fail
            await expect(
              metaTransactionFacet.executeMetaTransaction(
                entityAddress,
                message.functionName,
                message.functionSignature,
                message.nonce,
                ZeroHash,
                ZeroHash,
                0,
              ),
            ).to.be.revertedWithCustomError(fermionErrors, "NonceUsedAlready");
          });

          it("Signature is invalid", async function () {
            // Prepare the function signature for the facet function.
            message.functionSignature = entityFacet.interface.encodeFunctionData("createEntity", [[], ""]);

            // Contract wallet returns wrong magic value
            await expect(
              metaTransactionFacet.executeMetaTransaction(
                entityAddress,
                message.functionName,
                message.functionSignature,
                message.nonce,
                ZeroHash,
                ZeroHash,
                0,
              ),
            ).to.be.revertedWithCustomError(fermionErrors, "InvalidSignature");

            // Contract wallet reverts
            await entity.setValidity(2); // 2=revert

            await expect(
              metaTransactionFacet.executeMetaTransaction(
                entityAddress,
                message.functionName,
                message.functionSignature,
                message.nonce,
                ZeroHash,
                ZeroHash,
                0,
              ),
            ).to.be.revertedWithCustomError(fermionErrors, "InvalidSignature");
          });

          it("Contract does not implement `isValidSignature`", async function () {
            // Deploy a contract that does not implement `isValidSignature`
            const test2FacetFactory = await getContractFactory("Test2Facet");
            const test2Facet = await test2FacetFactory.deploy();
            await test2Facet.waitForDeployment();

            // Prepare the function signature for the facet function.
            message.functionSignature = entityFacet.interface.encodeFunctionData("createEntity", [[], ""]);

            // Contract wallet returns wrong magic value
            await expect(
              metaTransactionFacet.executeMetaTransaction(
                await test2Facet.getAddress(),
                message.functionName,
                message.functionSignature,
                message.nonce,
                ZeroHash,
                ZeroHash,
                0,
              ),
            ).to.be.revertedWithCustomError(fermionErrors, "InvalidSignature");
          });
        });
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
