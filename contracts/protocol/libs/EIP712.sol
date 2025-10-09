// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { SLOT_SIZE } from "../domain/Constants.sol";
import { IERC1271 } from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import { SignatureErrors, FermionGeneralErrors } from "../domain/Errors.sol";

/**
 * @title
 *
 * @notice
 */
contract EIP712 is SignatureErrors {
    struct ECDSASignature {
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
                    block.chainid
                )
            );
    }

    /**
     * @notice Verifies that the signer really signed the message.
     * It works for both ECDSA signatures and ERC1271 signatures.
     *
     * Reverts if:
     * - User is the zero address
     * - User is a contract that does not implement ERC1271.isValidSignature or fallback
     * - User is a contract that implements ERC1271.isValidSignature or fallback, but returns an unexpected value (including wrong magic value, wrong return data size, etc.)
     * - User is a contract that reverts when called with the signature
     * - User is an EOA (including smart accounts that do not implement ERC1271) but the signature is not a valid ECDSA signature
     * - Recovered signer does not match the user address
     *
     * @param _user  - the message signer
     * @param _hashedMessage - hashed message
     * @param _signature - signature. 
                           If the user is ordinary EOA, it must be ECDSA signature in the format of concatenated r,s,v values. 
                           If the user is a contract, it must be a valid ERC1271 signature.
                           If the user is a EIP-7702 smart account, it can be either a valid ERC1271 signature or a valid ECDSA signature.
     */
    function verify(address _user, bytes32 _hashedMessage, bytes calldata _signature) internal view {
        if (_user == address(0)) revert FermionGeneralErrors.InvalidAddress();

        bytes32 typedMessageHash = toTypedMessageHash(_hashedMessage);

        // Check if user is a contract implementing ERC1271
        bytes memory returnData; // Make this available for later if needed
        bool isValidSignatureCallSuccess;
        if (_user.code.length > 0) {
            (isValidSignatureCallSuccess, returnData) = _user.staticcall(
                abi.encodeCall(IERC1271.isValidSignature, (typedMessageHash, _signature))
            );

            // if the call succeeded, check the return value, only if it's correctly formatted (bytes4)
            // if the returned value matches the expected selector, the signature is valid.
            // in all other cases, try the ECDSA signature verification below and if that fails, bubble up the error
            if (
                isValidSignatureCallSuccess &&
                returnData.length == SLOT_SIZE &&
                (uint256(bytes32(returnData)) & type(uint224).max) == 0 &&
                abi.decode(returnData, (bytes4)) == IERC1271.isValidSignature.selector
            ) {
                return;
            }
        }

        address signer;
        // If the user is not a contract or the call to ERC1271 failed, we assume it's an ECDSA signature
        if (_signature.length == 65) {
            ECDSASignature memory ecdsaSig = ECDSASignature({
                r: bytes32(_signature[0:32]),
                s: bytes32(_signature[32:64]),
                v: uint8(_signature[64])
            });

            // Ensure signature is unique
            // See https://github.com/OpenZeppelin/openzeppelin-contracts/blob/04695aecbd4d17dddfd55de766d10e3805d6f42f/contracts/cryptography/ECDSA.sol#63
            if (
                uint256(ecdsaSig.s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0 ||
                (ecdsaSig.v != 27 && ecdsaSig.v != 28)
            ) revert InvalidSignature();

            signer = ecrecover(typedMessageHash, ecdsaSig.v, ecdsaSig.r, ecdsaSig.s);
            if (signer == address(0)) revert InvalidSignature();
        }

        if (signer != _user) {
            // ECDSA failed, while EIP-1271 verification call succeeded but returned something different than the magic value
            if (isValidSignatureCallSuccess) revert FermionGeneralErrors.UnexpectedDataReturned(returnData);

            // If both ECDSA and EIP-1271 verification call failed, bubble up the revert reason
            if (returnData.length > 0) {
                /// @solidity memory-safe-assembly
                assembly {
                    revert(add(SLOT_SIZE, returnData), mload(returnData))
                }
            }

            revert SignatureValidationFailed();
        }
    }
}
