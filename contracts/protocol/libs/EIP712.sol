// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { IERC1271 } from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import { SignatureErrors, FermionGeneralErrors } from "../domain/Errors.sol";

/**
 * @title
 *
 * @notice
 */
contract EIP712 is SignatureErrors {
    struct Signature {
        bytes32 r;
        bytes32 s;
        uint8 v;
    }

    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256(bytes("EIP712Domain(string name,string version,address verifyingContract,bytes32 salt)"));
    bytes32 internal immutable DOMAIN_SEPARATOR_CACHED;
    uint256 internal immutable CHAIN_ID_CACHED;
    address internal immutable FERMION_PROTOCOL_ADDRESS;

    string internal constant PROTOCOL_NAME = "Fermion Protocol";
    string internal constant PROTOCOL_VERSION = "V0";

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
     * @param _user  - the message signer
     * @param _hashedMessage - hashed message
     * @param _sig - signature, r, s, v
     * @return true if signer is same as _user parameter
     */
    function verify(address _user, bytes32 _hashedMessage, Signature memory _sig) internal view returns (bool) {
        bytes32 typedMessageHash = toTypedMessageHash(_hashedMessage);

        // Check if user is a contract implementing ERC1271
        if (_user.code.length > 0) {
            (bool success, bytes memory returnData) = _user.staticcall(
                abi.encodeCall(IERC1271.isValidSignature, (typedMessageHash, abi.encode(_sig)))
            );

            if (success) {
                if (returnData.length != 32) {
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
                        revert(add(32, returnData), mload(returnData))
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
}
