import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract } from "ethers";
import { EntityRole, PausableRegion, TokenState } from "../utils/enums";
import { deployFermionProtocolFixture, deriveTokenId, deployMockTokens } from "../utils/common";
import {
  getStateModifyingFunctions,
  getStateModifyingFunctionsHashes,
  metaTransactionType,
  prepareDataSignatureParameters,
  randomNonce,
} from "../../scripts/libraries/metaTransaction";
import { deployDiamond, prepareFacetCuts, makeDiamondCut } from "../../scripts/deploy";
import { createBuyerAdvancedOrderClosure } from "../utils/seaport";

const { id, getContractAt, getContractFactory, MaxUint256, toBeHex, ZeroAddress, ZeroHash, parseEther } = ethers;

describe("MetaTransactions", function () {
  let entityFacet: Contract, metaTransactionFacet: Contract, pauseFacet: Contract, offerFacet: Contract;
  let mockToken: Contract;
  let wallets: HardhatEthersSigner[], defaultSigner: HardhatEthersSigner, buyer: HardhatEthersSigner;
  let fermionErrors: Contract;
  let bosonProtocolAddress: string, wrapperImplementationAddress: string;
  let fermionProtocolAddress: string;
  let seaportAddress: string;
  const offerId = "1";
  const exchangeId = "1";

  async function setupFermionFNFTs() {
    // Create three entities
    // Seller, Verifier, Custodian combined
    const metadataURI = "https://example.com/seller-metadata.json";
    await entityFacet.createEntity([EntityRole.Seller, EntityRole.Verifier, EntityRole.Custodian], metadataURI); // "1"

    [mockToken] = await deployMockTokens(["ERC20"]);
    mockToken = mockToken.connect(defaultSigner);
    await mockToken.mint(defaultSigner.address, parseEther("1000"));

    await offerFacet.addSupportedToken(await mockToken.getAddress());

    const sellerId = "1";
    const sellerDeposit = 0n;
    const verifierFee = 0n;
    // Create offer
    const fermionOffer = {
      sellerId,
      sellerDeposit,
      verifierId: sellerId,
      verifierFee,
      custodianId: sellerId,
      custodianFee: {
        amount: parseEther("0.05"),
        period: 30n * 24n * 60n * 60n, // 30 days
      },
      facilitatorId: sellerId,
      facilitatorFeePercent: "0",
      exchangeToken: await mockToken.getAddress(),
      metadataURI: "https://example.com/offer-metadata.json",
      metadataHash: ZeroHash,
    };

    await offerFacet.createOffer(fermionOffer);

    // Mint and wrap some NFTs
    const quantity = "1";
    await offerFacet.mintAndWrapNFTs(offerId, quantity); // offerId = 1; exchangeId = 2

    // Unwrap some NFTs - normal sale and sale with self-verification
    buyer = wallets[5];

    await mockToken.approve(fermionProtocolAddress, 2n * sellerDeposit); // approve to transfer seller deposit during the unwrapping
    const createBuyerAdvancedOrder = createBuyerAdvancedOrderClosure(wallets, seaportAddress, mockToken, offerFacet);
    const { buyerAdvancedOrder, tokenId } = await createBuyerAdvancedOrder(buyer, offerId, exchangeId);
    await offerFacet.unwrapNFT(tokenId, buyerAdvancedOrder);
  }

  before(async function () {
    ({
      diamondAddress: fermionProtocolAddress,
      facets: {
        EntityFacet: entityFacet,
        MetaTransactionFacet: metaTransactionFacet,
        PauseFacet: pauseFacet,
        OfferFacet: offerFacet,
      },
      fermionErrors,
      wallets,
      defaultSigner,
      bosonProtocolAddress,
      wrapperImplementationAddress,
      seaportAddress,
    } = await loadFixture(deployFermionProtocolFixture));
  });

  afterEach(async function () {
    await loadFixture(deployFermionProtocolFixture);
  });

  describe("MetaTransactions facet", function () {
    context("executeMetaTransaction - diamond metatx", function () {
      before(async function () {
        // Set the default executeMetaTransaction method
        metaTransactionFacet.executeMetaTransaction =
          metaTransactionFacet["executeMetaTransaction(address,string,bytes,uint256,bytes32,bytes32,uint8)"];
      });

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
            const entityId = "1";
            await expect(tx)
              .to.emit(metaTransactionFacet, "MetaTransactionExecuted")
              .withArgs(entity.address, defaultSigner.address, message.functionName, message.nonce);
            await expect(tx)
              .to.emit(entityFacet, "EntityStored")
              .withArgs(entityId, entity.address, entityRoles, metadataURI);

            // Verify the state
            const response = await entityFacet["getEntity(address)"](entity.address);
            expect(response.entityId).to.equal(entityId);
            expect(response.roles.map(String)).to.have.members(entityRoles.map(String));
            expect(response.metadataURI).to.equal(metadataURI);

            expect(await metaTransactionFacet.isUsedNonce(entity.address, message.nonce)).to.be.true;
          });

          it("Forwarded call fails", async function () {
            await entityFacet.connect(entity).createEntity([], "https://example.com/metadata.json");

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
            ).to.be.revertedWithCustomError(fermionErrors, "EntityAlreadyExists");
          });
        });

        context("Revert reasons", function () {
          it("Metatransaction region is paused", async function () {
            await pauseFacet.pause([PausableRegion.MetaTransaction]);

            await expect(
              metaTransactionFacet.executeMetaTransaction(
                ZeroAddress,
                "testFunction",
                ZeroHash,
                ZeroHash,
                ZeroHash,
                ZeroHash,
                0,
              ),
            )
              .to.be.revertedWithCustomError(fermionErrors, "RegionPaused")
              .withArgs(PausableRegion.MetaTransaction);
          });

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
            message.functionSignature = entityFacet.interface.encodeFunctionData("updateEntity", ["0", [], ""]);

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
            ).to.be.revertedWithCustomError(fermionErrors, "SignatureValidationFailed");
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
            const functionFragment = metaTransactionFacet.interface.getFunction(
              "executeMetaTransaction(address,string,bytes,uint256,bytes32,bytes32,uint8)",
            );
            const metaTransactionFacetAddress = await diamondLoupe.facetAddress(functionFragment.selector);

            // Deploy a new diamond, from where the existing facet will be called
            const { diamondAddress, initializationFacet } = await deployDiamond(
              bosonProtocolAddress,
              wrapperImplementationAddress,
            );

            // Prepare init call
            const initAddresses = [metaTransactionFacetAddress];
            const initCalldatas = [
              metaTransactionFacet.interface.encodeFunctionData("init", [[id(message.functionName)]]),
            ];
            const functionCall = initializationFacet.interface.encodeFunctionData("initialize", [
              ethers.encodeBytes32String("test"),
              initAddresses,
              initCalldatas,
              [],
              [],
            ]);

            const accessController = await ethers.getContractAt("AccessController", diamondAddress);
            await accessController.grantRole(id("UPGRADER"), wallets[0].address);
            await makeDiamondCut(
              diamondAddress,
              await prepareFacetCuts([metaTransactionFacet.attach(metaTransactionFacetAddress)]),
              await initializationFacet.getAddress(),
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
                [
                  "executeMetaTransaction(address,string,bytes,uint256,bytes32,bytes32,uint8)"
                ](entity.address, message.functionName, message.functionSignature, message.nonce, r, s, v),
            ).to.be.revertedWithCustomError(fermionErrors, "SignatureValidationFailed");
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
        let entity, adminWallet, message;
        beforeEach(async function () {
          const nonce = randomNonce();

          // Deploy contract wallet
          const contractWalletFactory = await getContractFactory("ContractWallet");
          const contractWallet = await contractWalletFactory.deploy();
          await contractWallet.waitForDeployment();
          entity = contractWallet;
          adminWallet = await entity.getAddress();

          // Prepare the message
          message = {
            nonce: nonce,
            from: adminWallet,
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
            adminWallet,
            message.functionName,
            message.functionSignature,
            message.nonce,
            ZeroHash,
            ZeroHash,
            0,
          );

          // Verify the event
          const entityId = "1";
          await expect(tx)
            .to.emit(metaTransactionFacet, "MetaTransactionExecuted")
            .withArgs(adminWallet, defaultSigner.address, message.functionName, message.nonce);
          await expect(tx)
            .to.emit(entityFacet, "EntityStored")
            .withArgs(entityId, adminWallet, entityRoles, metadataURI);

          // Verify the state
          const response = await entityFacet["getEntity(address)"](adminWallet);
          expect(response.entityId).to.equal(entityId);
          expect(response.roles.map(String)).to.have.members(entityRoles.map(String));
          expect(response.metadataURI).to.equal(metadataURI);

          expect(await metaTransactionFacet.isUsedNonce(adminWallet, message.nonce)).to.be.true;
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
              adminWallet,
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
                adminWallet,
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
                adminWallet,
                message.functionName,
                message.functionSignature,
                message.nonce,
                ZeroHash,
                ZeroHash,
                0,
              ),
            ).to.be.revertedWithCustomError(fermionErrors, "SignatureValidationFailed");
          });

          it("Contract reverts", async function () {
            // Prepare the function signature for the facet function.
            message.functionSignature = entityFacet.interface.encodeFunctionData("createEntity", [[], ""]);

            // Contract wallet reverts
            await entity.setValidity(2); // 2=revert

            await expect(
              metaTransactionFacet.executeMetaTransaction(
                adminWallet,
                message.functionName,
                message.functionSignature,
                message.nonce,
                ZeroHash,
                ZeroHash,
                0,
              ),
            ).to.be.revertedWithCustomError(entity, "UnknownValidity");

            // Error string
            await entity.setRevertReason(1); // 1=error string

            await expect(
              metaTransactionFacet.executeMetaTransaction(
                adminWallet,
                message.functionName,
                message.functionSignature,
                message.nonce,
                ZeroHash,
                ZeroHash,
                0,
              ),
            ).to.be.revertedWith("Error string");

            // Arbitrary bytes
            await entity.setRevertReason(2); // 2=arbitrary bytes

            await expect(
              metaTransactionFacet.executeMetaTransaction(
                adminWallet,
                message.functionName,
                message.functionSignature,
                message.nonce,
                ZeroHash,
                ZeroHash,
                0,
              ),
            ).to.be.reverted;

            // Divide by zero
            await entity.setRevertReason(3); // 3=divide by zero

            await expect(
              metaTransactionFacet.executeMetaTransaction(
                adminWallet,
                message.functionName,
                message.functionSignature,
                message.nonce,
                ZeroHash,
                ZeroHash,
                0,
              ),
            ).to.be.revertedWithPanic("0x12");

            // Out of bounds
            await entity.setRevertReason(4); // 4=out of bounds

            await expect(
              metaTransactionFacet.executeMetaTransaction(
                adminWallet,
                message.functionName,
                message.functionSignature,
                message.nonce,
                ZeroHash,
                ZeroHash,
                0,
              ),
            ).to.be.revertedWithPanic("0x32");
          });

          it("Contract returns invalid data", async function () {
            // Prepare the function signature for the facet function.
            message.functionSignature = entityFacet.interface.encodeFunctionData("createEntity", [[], ""]);

            // Contract wallet returns invalid data
            await entity.setValidity(2); // 2=revert
            await entity.setRevertReason(5); // 5=return too short

            await expect(
              metaTransactionFacet.executeMetaTransaction(
                adminWallet,
                message.functionName,
                message.functionSignature,
                message.nonce,
                ZeroHash,
                ZeroHash,
                0,
              ),
            )
              .to.be.revertedWithCustomError(metaTransactionFacet, "UnexpectedDataReturned")
              .withArgs("0x00");

            // Too long return
            await entity.setRevertReason(6); // 6=return too long

            await expect(
              metaTransactionFacet.executeMetaTransaction(
                adminWallet,
                message.functionName,
                message.functionSignature,
                message.nonce,
                ZeroHash,
                ZeroHash,
                0,
              ),
            )
              .to.be.revertedWithCustomError(metaTransactionFacet, "UnexpectedDataReturned")
              .withArgs("0x1626ba7e0000000000000000000000000000000000000000000000000000000000");

            // Polluted return
            await entity.setRevertReason(7); // 7=more data than bytes4

            await expect(
              metaTransactionFacet.executeMetaTransaction(
                adminWallet,
                message.functionName,
                message.functionSignature,
                message.nonce,
                ZeroHash,
                ZeroHash,
                0,
              ),
            )
              .to.be.revertedWithCustomError(metaTransactionFacet, "UnexpectedDataReturned")
              .withArgs("0x1626ba7e000000000000000abcde000000000000000000000000000000000000");
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
            ).to.be.revertedWithCustomError(fermionErrors, "SignatureValidationFailed");
          });
        });
      });
    });

    context("executeMetaTransaction - fermionFNFT metatx", function () {
      let fermionFNFT: Contract;
      let fermionFNFTAddress: string;

      before(async function () {
        // Set the default executeMetaTransaction method
        metaTransactionFacet.executeMetaTransaction =
          metaTransactionFacet[
            "executeMetaTransaction(address,address,string,bytes,uint256,(bytes32,bytes32,uint8),uint256)"
          ];

        fermionFNFTAddress = await offerFacet.predictFermionFNFTAddress(offerId);
        fermionFNFT = await ethers.getContractAt("FermionFNFT", fermionFNFTAddress);
      });

      beforeEach(async function () {
        await loadFixture(setupFermionFNFTs);
      });

      context("Externally owned account", function () {
        let entity, message;
        const tokenId = deriveTokenId(offerId, exchangeId).toString();

        beforeEach(async function () {
          const nonce = randomNonce();
          entity = buyer;

          // Prepare the message
          message = {
            nonce: nonce,
            from: entity.address,
            contractAddress: await fermionFNFT.getAddress(),
            functionName: fermionFNFT.interface.getFunction("setApprovalForAll").format("sighash"),
            functionSignature: fermionFNFT.interface.encodeFunctionData("setApprovalForAll", [
              fermionProtocolAddress,
              tokenId,
            ]),
          };
        });

        context("Forwards a generic meta transaction", async function () {
          it("Forwarded call succeeds", async function () {
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
              fermionFNFTAddress,
              entity.address,
              message.functionName,
              message.functionSignature,
              message.nonce,
              [r, s, v],
              offerId,
            );

            // Verify the event
            await expect(tx)
              .to.emit(metaTransactionFacet, "MetaTransactionExecuted")
              .withArgs(entity.address, defaultSigner.address, message.functionName, message.nonce);
            await expect(tx)
              .to.emit(fermionFNFT, "ApprovalForAll")
              .withArgs(entity.address, fermionProtocolAddress, true);

            // Verify the state
            expect(await fermionFNFT.isApprovedForAll(entity.address, fermionProtocolAddress)).to.be.true;

            expect(await metaTransactionFacet.isUsedNonce(entity.address, message.nonce)).to.be.true;
          });

          it("Forwarded call fails", async function () {
            // Prepare the function signature for the facet function.
            message.functionSignature = fermionFNFT.interface.encodeFunctionData("burn", [tokenId]);
            message.functionName = fermionFNFT.interface.getFunction("burn").format("sighash");

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
                fermionFNFTAddress,
                entity.address,
                message.functionName,
                message.functionSignature,
                message.nonce,
                [r, s, v],
                offerId,
              ),
            )
              .to.be.revertedWithCustomError(fermionFNFT, "InvalidStateOrCaller")
              .withArgs(tokenId, entity.address, TokenState.Unverified);
          });
        });

        context("Revert reasons", function () {
          it("Metatransaction region is paused", async function () {
            await pauseFacet.pause([PausableRegion.MetaTransaction]);

            await expect(
              metaTransactionFacet.executeMetaTransaction(
                fermionFNFTAddress,
                ZeroAddress,
                "testFunction",
                ZeroHash,
                ZeroHash,
                [ZeroHash, ZeroHash, 0],
                offerId,
              ),
            )
              .to.be.revertedWithCustomError(fermionErrors, "RegionPaused")
              .withArgs(PausableRegion.MetaTransaction);
          });

          it("Nonce is already used by the msg.sender for another transaction", async function () {
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
              fermionFNFTAddress,
              entity.address,
              message.functionName,
              message.functionSignature,
              message.nonce,
              [r, s, v],
              offerId,
            );

            // Second transaction should fail
            await expect(
              metaTransactionFacet.executeMetaTransaction(
                fermionFNFTAddress,
                entity.address,
                message.functionName,
                message.functionSignature,
                message.nonce,
                [r, s, v],
                offerId,
              ),
            ).to.be.revertedWithCustomError(fermionErrors, "NonceUsedAlready");
          });

          it("Function is not allowlisted to be called using metatransactions", async function () {
            // Use improper function name
            message.functionName = "setApprovalForAll";

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
                fermionFNFTAddress,
                entity.address,
                message.functionName,
                message.functionSignature,
                message.nonce,
                [r, s, v],
                offerId,
              ),
            ).to.be.revertedWithCustomError(fermionErrors, "FunctionNotAllowlisted");
          });

          it("Function name does not match the bytes4 version of the function signature", async function () {
            // Encode different function than specified in the function name
            message.functionSignature = entityFacet.interface.encodeFunctionData("updateEntity", ["0", [], ""]);

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
                fermionFNFTAddress,
                entity.address,
                message.functionName,
                message.functionSignature,
                message.nonce,
                [r, s, v],
                offerId,
              ),
            ).to.be.revertedWithCustomError(fermionErrors, "InvalidFunctionName");
          });

          it("Sender does not match the recovered signer", async function () {
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
                fermionFNFTAddress,
                entity.address,
                message.functionName,
                message.functionSignature,
                message.nonce,
                [r, s, v],
                offerId,
              ),
            ).to.be.revertedWithCustomError(fermionErrors, "SignatureValidationFailed");
          });

          it("Signature is invalid", async function () {
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
                fermionFNFTAddress,
                entity.address,
                message.functionName,
                message.functionSignature,
                message.nonce,
                [
                  r,
                  toBeHex(MaxUint256), // s is valid only if <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0
                  v,
                ],
                offerId,
              ),
            ).to.be.revertedWithCustomError(fermionErrors, "InvalidSignature");

            await expect(
              metaTransactionFacet.executeMetaTransaction(
                fermionFNFTAddress,
                entity.address,
                message.functionName,
                message.functionSignature,
                message.nonce,
                [
                  r,
                  toBeHex(0n, 32), // s must be non-zero
                  v,
                ],
                offerId,
              ),
            ).to.be.revertedWithCustomError(fermionErrors, "InvalidSignature");

            await expect(
              metaTransactionFacet.executeMetaTransaction(
                fermionFNFTAddress,
                entity.address,
                message.functionName,
                message.functionSignature,
                message.nonce,
                [r, s, 32], // v is valid only if it is 27 or 28
                offerId,
              ),
            ).to.be.revertedWithCustomError(fermionErrors, "InvalidSignature");
          });

          it("Calling the facet from another diamond [test domain separator]", async function () {
            // Get the existing facet address
            const diamondLoupe = await getContractAt("DiamondLoupeFacet", await metaTransactionFacet.getAddress());
            const functionFragment = metaTransactionFacet.interface.getFunction(
              "executeMetaTransaction(address,address,string,bytes,uint256,(bytes32,bytes32,uint8),uint256)",
            );
            const metaTransactionFacetAddress = await diamondLoupe.facetAddress(functionFragment.selector);

            // Deploy a new diamond, from where the existing facet will be called
            const { diamondAddress, initializationFacet } = await deployDiamond(
              bosonProtocolAddress,
              wrapperImplementationAddress,
            );

            // Prepare init call
            const initAddresses = [metaTransactionFacetAddress];
            const initCalldatas = [
              metaTransactionFacet.interface.encodeFunctionData("init", [[id(message.functionName)]]),
            ];
            const functionCall = initializationFacet.interface.encodeFunctionData("initialize", [
              ethers.encodeBytes32String("test"),
              initAddresses,
              initCalldatas,
              [],
              [],
            ]);

            const accessController = await ethers.getContractAt("AccessController", diamondAddress);
            await accessController.grantRole(id("UPGRADER"), wallets[0].address);
            await makeDiamondCut(
              diamondAddress,
              await prepareFacetCuts([metaTransactionFacet.attach(metaTransactionFacetAddress)]),
              await initializationFacet.getAddress(),
              functionCall,
            );

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
                [
                  "executeMetaTransaction(address,address,string,bytes,uint256,(bytes32,bytes32,uint8),uint256)"
                ](diamondAddress, entity.address, message.functionName, message.functionSignature, message.nonce, [r, s, v], 0),
            ).to.be.revertedWithCustomError(fermionErrors, "SignatureValidationFailed");
          });

          it("Invalid contract address", async function () {
            await expect(
              metaTransactionFacet.executeMetaTransaction(
                fermionFNFTAddress,
                ZeroAddress,
                "testFunction",
                ZeroHash,
                ZeroHash,
                [ZeroHash, ZeroHash, 0],
                0,
              ),
            )
              .to.be.revertedWithCustomError(fermionErrors, "InvalidContractAddress")
              .withArgs(fermionFNFTAddress);

            await expect(
              metaTransactionFacet.executeMetaTransaction(
                fermionProtocolAddress,
                ZeroAddress,
                "testFunction",
                ZeroHash,
                ZeroHash,
                [ZeroHash, ZeroHash, 0],
                1,
              ),
            )
              .to.be.revertedWithCustomError(fermionErrors, "InvalidContractAddress")
              .withArgs(fermionProtocolAddress);
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
          it("Metatransaction region is paused", async function () {
            await pauseFacet.pause([PausableRegion.MetaTransaction]);

            await expect(metaTransactionFacet.connect(admin).setAllowlistedFunctions(functionHashList, true))
              .to.be.revertedWithCustomError(fermionErrors, "RegionPaused")
              .withArgs(PausableRegion.MetaTransaction);
          });

          it("caller is not the admin", async function () {
            const accessControl = await getContractAt("IAccessControl", ZeroAddress);
            const randomWallet = wallets[2];
            await expect(metaTransactionFacet.connect(randomWallet).setAllowlistedFunctions(functionHashList, true))
              .to.revertedWithCustomError(accessControl, "AccessControlUnauthorizedAccount")
              .withArgs(randomWallet.address, id("ADMIN"));
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
