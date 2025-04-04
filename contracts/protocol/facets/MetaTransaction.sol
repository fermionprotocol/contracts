// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { ADMIN, SLOT_SIZE } from "../domain/Constants.sol";
import { MetaTransactionErrors, FermionGeneralErrors } from "../domain/Errors.sol";
import { FermionTypes } from "../domain/Types.sol";
import { FermionStorage } from "../libs/Storage.sol";
import { Access } from "../libs/Access.sol";
import { IERC1271 } from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import { IMetaTransactionEvents } from "../interfaces/events/IMetaTransactionEvents.sol";

/**
 * @title MetaTransactionFacet
 *
 * @notice Handles meta-transaction requests.
 */
contract MetaTransactionFacet is Access, MetaTransactionErrors, IMetaTransactionEvents {
    struct Signature {
        bytes32 r;
        bytes32 s;
        uint8 v;
    }

    string private constant PROTOCOL_NAME = "Fermion Protocol";
    string private constant PROTOCOL_VERSION = "V0";
    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256(bytes("EIP712Domain(string name,string version,address verifyingContract,bytes32 salt)"));
    bytes32 private constant META_TRANSACTION_TYPEHASH =
        keccak256(
            bytes(
                "MetaTransaction(uint256 nonce,address from,address contractAddress,string functionName,bytes functionSignature)"
            )
        );

    bytes32 private immutable DOMAIN_SEPARATOR_CACHED;
    uint256 private immutable CHAIN_ID_CACHED;
    address private immutable FERMION_PROTOCOL_ADDRESS;

    /**
     * @notice Constructor.
     * Store the immutable values and build the domain separator.
     *
     * @param _fermionProtocolAddress - the address of the Fermion Protocol contract
     */
    constructor(address _fermionProtocolAddress) {
        if (_fermionProtocolAddress == address(0)) revert FermionGeneralErrors.InvalidAddress();

        FERMION_PROTOCOL_ADDRESS = _fermionProtocolAddress;
        CHAIN_ID_CACHED = block.chainid;

        DOMAIN_SEPARATOR_CACHED = buildDomainSeparator(PROTOCOL_NAME, PROTOCOL_VERSION, FERMION_PROTOCOL_ADDRESS);
    }

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
     * @param _offerId - the offer ID, if FermionFNFT is called. 0 for this contract.
     */
    function executeMetaTransaction(
        address _userAddress,
        string calldata _functionName,
        bytes calldata _functionSignature,
        uint256 _nonce,
        Signature calldata _sig,
        uint256 _offerId
    ) external payable notPaused(FermionTypes.PausableRegion.MetaTransaction) nonReentrant returns (bytes memory) {
        address userAddress = _userAddress; // stack too deep workaround.
        validateTx(_functionName, _functionSignature, _nonce, userAddress);

        FermionTypes.MetaTransaction memory metaTx;
        metaTx.nonce = _nonce;
        metaTx.from = userAddress;
        metaTx.contractAddress = _offerId == 0
            ? address(this)
            : FermionStorage.protocolLookups().offerLookups[_offerId].fermionFNFTAddress;
        metaTx.functionName = _functionName;
        metaTx.functionSignature = _functionSignature;

        if (!verify(userAddress, hashMetaTransaction(metaTx), _sig)) revert SignatureValidationFailed();

        return executeTx(metaTx.contractAddress, userAddress, _functionName, _functionSignature, _nonce);
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

    /**
     * @notice Generates the domain separator hash.
     * @dev Using the chainId as the salt enables the client to be active on one chain
     * while a metatx is signed for a contract on another chain. That could happen if the client is,
     * for instance, a metaverse scene that runs on one chain while the contracts it interacts with are deployed on another chain.
     *
     * @param _name - the name of the protocol
     * @param _version -  The version of the protocol
     * @param _contract - the address of the contract
     * @return the domain separator hash
     */
    function buildDomainSeparator(
        string memory _name,
        string memory _version,
        address _contract
    ) internal view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    EIP712_DOMAIN_TYPEHASH,
                    keccak256(bytes(_name)),
                    keccak256(bytes(_version)),
                    _contract,
                    CHAIN_ID_CACHED
                )
            );
    }

    /**
     * @notice Recovers the Signer from the Signature components.
     *
     * Reverts if:
     * - Signer is the zero address
     *
     * @param _user  - the sender of the transaction
     * @param _hashedMetaTx - hashed meta transaction
     * @param _sig - meta transaction signature, r, s, v
     * @return true if signer is same as _user parameter
     */
    function verify(address _user, bytes32 _hashedMetaTx, Signature memory _sig) internal view returns (bool) {
        bytes32 typedMessageHash = toTypedMessageHash(_hashedMetaTx);

        // Check if user is a contract implementing ERC1271
        if (_user.code.length > 0) {
            (bool success, bytes memory returnData) = _user.staticcall(
                abi.encodeCall(IERC1271.isValidSignature, (typedMessageHash, abi.encode(_sig)))
            );

            if (success) {
                if (returnData.length != SLOT_SIZE) {
                    revert FermionGeneralErrors.UnexpectedDataReturned(returnData);
                } else {
                    // Make sure that the lowest 224 bits (28 bytes) are not set
                    if (uint256(bytes32(returnData)) & type(uint224).max != 0) {
                        revert FermionGeneralErrors.UnexpectedDataReturned(returnData);
                    }
                    return abi.decode(returnData, (bytes4)) == IERC1271.isValidSignature.selector;
                }
            } else {
                if (returnData.length == 0) {
                    revert SignatureValidationFailed();
                } else {
                    /// @solidity memory-safe-assembly
                    assembly {
                        revert(add(SLOT_SIZE, returnData), mload(returnData))
                    }
                }
            }
        }

        // Ensure signature is unique
        // See https://github.com/OpenZeppelin/openzeppelin-contracts/blob/04695aecbd4d17dddfd55de766d10e3805d6f42f/contracts/cryptography/ECDSA.sol#63
        if (
            uint256(_sig.s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0 ||
            (_sig.v != 27 && _sig.v != 28)
        ) revert InvalidSignature();

        address signer = ecrecover(typedMessageHash, _sig.v, _sig.r, _sig.s);
        if (signer == address(0)) revert InvalidSignature();
        return signer == _user;
    }

    /**
     * @notice Gets the domain separator from storage if matches with the chain id and diamond address, else, build new domain separator.
     *
     * @return the domain separator
     */
    function getDomainSeparator() internal view returns (bytes32) {
        if (address(this) == FERMION_PROTOCOL_ADDRESS && block.chainid == CHAIN_ID_CACHED) {
            return DOMAIN_SEPARATOR_CACHED;
        }

        return buildDomainSeparator(PROTOCOL_NAME, PROTOCOL_VERSION, address(this));
    }

    /**
     * @notice Generates EIP712 compatible message hash.
     *
     * @dev Accepts message hash and returns hash message in EIP712 compatible form
     * so that it can be used to recover signer from signature signed using EIP712 formatted data
     * https://eips.ethereum.org/EIPS/eip-712
     * "\\x19" makes the encoding deterministic
     * "\\x01" is the version byte to make it compatible to EIP-191
     *
     * @param _messageHash  - the message hash
     * @return the EIP712 compatible message hash
     */
    function toTypedMessageHash(bytes32 _messageHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", getDomainSeparator(), _messageHash));
    }
}
