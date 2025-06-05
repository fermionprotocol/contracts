// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { ADMIN, SLOT_SIZE } from "../domain/Constants.sol";
import { MetaTransactionErrors } from "../domain/Errors.sol";
import { FermionTypes } from "../domain/Types.sol";
import { FermionStorage } from "../libs/Storage.sol";
import { Access } from "../bases/mixins/Access.sol";
import { IMetaTransactionEvents } from "../interfaces/events/IMetaTransactionEvents.sol";
import { EIP712 } from "../libs/EIP712.sol";
import { IFermionFNFT } from "../interfaces/IFermionFNFT.sol";

/**
 * @title MetaTransactionFacet
 *
 * @notice Handles meta-transaction requests.
 */
contract MetaTransactionFacet is Access, EIP712, MetaTransactionErrors, IMetaTransactionEvents {
    bytes32 private constant META_TRANSACTION_TYPEHASH =
        keccak256(
            bytes(
                "MetaTransaction(uint256 nonce,address from,address contractAddress,string functionName,bytes functionSignature)"
            )
        );

    /**
     * @notice Constructor.
     * Store the immutable values and build the domain separator.
     *
     * @param _fermionProtocolAddress - the address of the Fermion Protocol contract
     */
    constructor(address _fermionProtocolAddress) EIP712(_fermionProtocolAddress) {}

    /**
     * @notice Initializes Facet.
     * This function is callable only once.
     *
     * @param _functionNameHashes - a list of hashed function names (keccak256)
     */
    function init(bytes32[] calldata _functionNameHashes) external {
        setAllowlistedFunctionsInternal(_functionNameHashes, true);
        FermionStorage.metaTransaction().fermionAddress = address(this);
    }

    /**
     * @notice Handles the incoming meta transaction.
     *
     * Reverts if:
     * - Metatransaction region is paused
     * - Nonce is already used by the msg.sender for another transaction
     * - Function is not allowlisted to be called using metatransactions
     * - Function name does not match the bytes4 version of the function signature
     * - Sender does not match the recovered signer
     * - Any code executed in the signed transaction reverts
     * - Signature is invalid
     *
     * @param _userAddress - the sender of the transaction
     * @param _functionName - the name of the function to be executed
     * @param _functionSignature - the function signature
     * @param _nonce - the nonce value of the transaction
     * @param _sig - meta transaction signature, r, s, v
     * @param _offerIdWithEpoch - determines where the call is forwarded to. 0 is for Fermion Protocol,
     * a plain offerId is for FermionFNFT associated with offerId, and {epoch+1}{offerId} is for FermionFractions
     * associated with offerId and epoch.
     */
    function executeMetaTransaction(
        address _userAddress,
        string calldata _functionName,
        bytes calldata _functionSignature,
        uint256 _nonce,
        Signature calldata _sig,
        uint256 _offerIdWithEpoch
    ) external payable notPaused(FermionTypes.PausableRegion.MetaTransaction) nonReentrant returns (bytes memory) {
        address userAddress = _userAddress; // stack too deep workaround.
        validateTx(_functionName, _functionSignature, _nonce, userAddress);

        FermionTypes.MetaTransaction memory metaTx;
        metaTx.nonce = _nonce;
        metaTx.from = userAddress;
        metaTx.contractAddress = getContractAddress(_offerIdWithEpoch);
        metaTx.functionName = _functionName;
        metaTx.functionSignature = _functionSignature;

        verify(userAddress, hashMetaTransaction(metaTx), _sig);

        return executeTx(metaTx.contractAddress, userAddress, _functionName, _functionSignature, _nonce);
    }

    /**
     * @notice Gets the destination contract address from the storage.
     *
     * If the offerIdWithEpoch is 0, returns the address of this contract.
     * If upper 128 bits are 0, returns the address of the FermionFNFT contract.
     * Otherwise, subtracts 1 from upper 128 bits to get the epoch and
     * returns the address of the corresponding ERC20 clone.
     *
     * @param _offerIdWithEpoch - determines where the call is forwarded to. 0 is for Fermion Protocol,
     * a plain offerId is for FermionFNFT associated with offerId, and {epoch+1}{offerId} is for FermionFractions
     * associated with offerId and epoch.
     */
    function getContractAddress(uint256 _offerIdWithEpoch) internal view returns (address) {
        if (_offerIdWithEpoch == 0) return address(this);

        uint256 epoch = _offerIdWithEpoch >> 128;
        uint256 offerId = _offerIdWithEpoch & type(uint128).max;

        address FNFTAddress = FermionStorage.protocolLookups().offerLookups[offerId].fermionFNFTAddress;

        if (epoch == 0) return FNFTAddress;

        return IFermionFNFT(FNFTAddress).getERC20FractionsClone(epoch - 1);
    }

    /**
     * @notice Checks nonce and returns true if used already for a specific address.
     *
     * @param _associatedAddress the address for which the nonce should be checked
     * @param _nonce - the nonce that we want to check.
     * @return true if nonce has already been used
     */
    function isUsedNonce(address _associatedAddress, uint256 _nonce) external view returns (bool) {
        return FermionStorage.metaTransaction().usedNonce[_associatedAddress][_nonce];
    }

    /**
     * @notice Manages allow list of functions that can be executed using metatransactions.
     *
     * Emits a FunctionsAllowlisted event if successful.
     *
     * Reverts if:
     * - Metatransaction region is paused
     * - Caller is not a protocol admin
     *
     * @param _functionNameHashes - a list of hashed function names (keccak256)
     * @param _isAllowlisted - new allowlist status
     */
    function setAllowlistedFunctions(
        bytes32[] calldata _functionNameHashes,
        bool _isAllowlisted
    ) external onlyRole(ADMIN) notPaused(FermionTypes.PausableRegion.MetaTransaction) nonReentrant {
        setAllowlistedFunctionsInternal(_functionNameHashes, _isAllowlisted);
    }

    /**
     * @notice Tells if function can be executed as meta transaction or not.
     *
     * @param _functionNameHash - hashed function name (keccak256)
     * @return isAllowlisted - allowlist status
     */
    function isFunctionAllowlisted(bytes32 _functionNameHash) external view returns (bool isAllowlisted) {
        return FermionStorage.metaTransaction().isAllowlisted[_functionNameHash];
    }

    /**
     * @notice Tells if function can be executed as meta transaction or not.
     *
     * @param _functionName - function name
     * @return isAllowlisted - allowlist status
     */
    function isFunctionAllowlisted(string calldata _functionName) external view returns (bool isAllowlisted) {
        return FermionStorage.metaTransaction().isAllowlisted[keccak256(abi.encodePacked(_functionName))];
    }

    /**
     * @notice Validates the nonce and function signature.
     *
     * Reverts if:
     * - Nonce is already used by the msg.sender for another transaction
     * - Function is not allowlisted to be called using metatransactions
     * - Function name does not match the bytes4 version of the function signature
     *
     * @param _functionName - the function name that we want to execute
     * @param _functionSignature - the function signature
     * @param _nonce - the nonce value of the transaction
     * @param _userAddress - the sender of the transaction
     */
    function validateTx(
        string calldata _functionName,
        bytes calldata _functionSignature,
        uint256 _nonce,
        address _userAddress
    ) internal view {
        FermionStorage.MetaTransaction storage mt = FermionStorage.metaTransaction();

        // Nonce should be unused
        if (mt.usedNonce[_userAddress][_nonce]) revert NonceUsedAlready();

        // Function must be allowlisted
        bytes32 functionNameHash = keccak256(abi.encodePacked(_functionName));
        if (!mt.isAllowlisted[functionNameHash]) revert FunctionNotAllowlisted();

        // Function name must correspond to selector
        bytes4 destinationFunctionSig = bytes4(_functionSignature);
        bytes4 functionNameSig = bytes4(functionNameHash);
        if (destinationFunctionSig != functionNameSig) revert InvalidFunctionName();
    }

    /**
     * @notice Returns hashed meta transaction.
     *
     * @param _metaTx - the meta-transaction struct.
     * @return the hash of the meta-transaction details
     */
    function hashMetaTransaction(FermionTypes.MetaTransaction memory _metaTx) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    META_TRANSACTION_TYPEHASH,
                    _metaTx.nonce,
                    _metaTx.from,
                    _metaTx.contractAddress,
                    keccak256(bytes(_metaTx.functionName)),
                    keccak256(_metaTx.functionSignature)
                )
            );
    }

    /**
     * @notice Executes the meta transaction.
     *
     * Reverts if:
     * - Any code executed in the signed transaction reverts
     *
     * @param _contractAddress - the address of the contract to be called, either this contract or one of FermionFNFTs
     * @param _userAddress - the sender of the transaction
     * @param _functionName - the name of the function to be executed
     * @param _functionSignature - the function signature
     * @param _nonce - the nonce value of the transaction
     */
    function executeTx(
        address _contractAddress,
        address _userAddress,
        string calldata _functionName,
        bytes calldata _functionSignature,
        uint256 _nonce
    ) internal returns (bytes memory) {
        // Store the nonce provided to avoid playback of the same tx
        FermionStorage.metaTransaction().usedNonce[_userAddress][_nonce] = true;

        // Invoke local function with an external call
        (bool success, bytes memory returnData) = _contractAddress.call{ value: msg.value }(
            abi.encodePacked(_functionSignature, _userAddress)
        );

        // If error, return error message
        if (!success) {
            if (returnData.length > 0) {
                // bubble up the error
                assembly {
                    revert(add(SLOT_SIZE, returnData), mload(returnData))
                }
            } else {
                // Reverts with default message
                revert FunctionCallFailed();
            }
        }

        emit MetaTransactionExecuted(_userAddress, msg.sender, _functionName, _nonce);
        return returnData;
    }

    /**
     * @notice Internal function that manages allow list of functions that can be executed using metatransactions.
     *
     * Emits a FunctionsAllowlisted event if successful.
     *
     * @param _functionNameHashes - a list of hashed function names (keccak256)
     * @param _isAllowlisted - new allowlist status
     */
    function setAllowlistedFunctionsInternal(bytes32[] calldata _functionNameHashes, bool _isAllowlisted) private {
        FermionStorage.MetaTransaction storage mt = FermionStorage.metaTransaction();

        // set new values
        for (uint256 i = 0; i < _functionNameHashes.length; ) {
            mt.isAllowlisted[_functionNameHashes[i]] = _isAllowlisted;

            unchecked {
                i++;
            }
        }

        // Notify external observers
        emit FunctionsAllowlisted(_functionNameHashes, _isAllowlisted, _msgSender());
    }
}
