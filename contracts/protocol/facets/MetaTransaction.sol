// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { ADMIN } from "../domain/Constants.sol";
import { MetaTransactionErrors } from "../domain/Errors.sol";
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
     * @param _sigR - r part of the signer's signature
     * @param _sigS - s part of the signer's signature
     * @param _sigV - v part of the signer's signature
     */
    function executeMetaTransaction(
        address _userAddress,
        string calldata _functionName,
        bytes calldata _functionSignature,
        uint256 _nonce,
        bytes32 _sigR,
        bytes32 _sigS,
        uint8 _sigV
    ) external payable notPaused(FermionTypes.PausableRegion.MetaTransaction) returns (bytes memory) {
        address userAddress = _userAddress; // stack too deep workaround. ToDo: Consider using a struct for signature
        validateTx(_functionName, _functionSignature, _nonce, userAddress);

        FermionTypes.MetaTransaction memory metaTx;
        metaTx.nonce = _nonce;
        metaTx.from = _userAddress;
        metaTx.contractAddress = address(this);
        metaTx.functionName = _functionName;
        metaTx.functionSignature = _functionSignature;

        if (!verify(_userAddress, hashMetaTransaction(metaTx), _sigR, _sigS, _sigV))
            revert SignerAndSignatureDoNotMatch();

        return executeTx(_userAddress, _functionName, _functionSignature, _nonce);
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
    ) external onlyRole(ADMIN) notPaused(FermionTypes.PausableRegion.MetaTransaction) {
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
        bytes4 destinationFunctionSig = convertBytesToBytes4(_functionSignature);
        bytes4 functionNameSig = bytes4(functionNameHash);
        if (destinationFunctionSig != functionNameSig) revert InvalidFunctionName();
    }

    /**
     * @notice Converts the given bytes to bytes4.
     *
     * @param _inBytes - the incoming bytes
     * @return _outBytes4 -  The outgoing bytes4
     */
    function convertBytesToBytes4(bytes memory _inBytes) internal pure returns (bytes4 _outBytes4) {
        assembly {
            _outBytes4 := mload(add(_inBytes, 32))
        }
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
     * @param _userAddress - the sender of the transaction
     * @param _functionName - the name of the function to be executed
     * @param _functionSignature - the function signature
     * @param _nonce - the nonce value of the transaction
     */
    function executeTx(
        address _userAddress,
        string calldata _functionName,
        bytes calldata _functionSignature,
        uint256 _nonce
    ) internal returns (bytes memory) {
        // Store the nonce provided to avoid playback of the same tx
        FermionStorage.metaTransaction().usedNonce[_userAddress][_nonce] = true;

        // Invoke local function with an external call
        (bool success, bytes memory returnData) = address(this).call{ value: msg.value }(
            abi.encodePacked(_functionSignature, _userAddress)
        );

        // If error, return error message
        if (!success) {
            if (returnData.length > 0) {
                // bubble up the error
                assembly {
                    revert(add(32, returnData), mload(returnData))
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
     * @param _sigR - r part of the signer's signature
     * @param _sigS - s part of the signer's signature
     * @param _sigV - v part of the signer's signature
     * @return true if signer is same as _user parameter
     */
    function verify(
        address _user,
        bytes32 _hashedMetaTx,
        bytes32 _sigR,
        bytes32 _sigS,
        uint8 _sigV
    ) internal view returns (bool) {
        // Check if user is a contract implementing ERC1271
        if (_user.code.length > 0) {
            try IERC1271(_user).isValidSignature(_hashedMetaTx, abi.encodePacked(_sigR, _sigS, _sigV)) returns (
                bytes4 magicValue
            ) {
                if (magicValue != IERC1271.isValidSignature.selector) revert InvalidSignature();
                return true;
            } catch {
                revert InvalidSignature();
            }
        }

        // Ensure signature is unique
        // See https://github.com/OpenZeppelin/openzeppelin-contracts/blob/04695aecbd4d17dddfd55de766d10e3805d6f42f/contracts/cryptography/ECDSA.sol#63
        if (
            uint256(_sigS) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0 ||
            (_sigV != 27 && _sigV != 28)
        ) revert InvalidSignature();

        address signer = ecrecover(toTypedMessageHash(_hashedMetaTx), _sigV, _sigR, _sigS);
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
