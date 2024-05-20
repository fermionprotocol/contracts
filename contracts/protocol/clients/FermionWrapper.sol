// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import { ERC721 } from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/**
 * @title FermionWrapper
 * @notice Wraps Boson Vouchers so they can be used with Opensea. Possibly with other marketplaces in the future.
 *
 * Features:
 *
 * Out-of-band setup:
 *
 * Usage:
 *
 */
contract FermionWrapper is Ownable, ERC721 {
    error AlreadyInitialized();

    enum TokenState {
        Inexistent,
        Wrapped,
        Unwrapped,
        Fractionalised,
        Burned
    }

    mapping(uint256 => TokenState) public tokenState;

    // Contract addresses
    address private voucherAddress;
    address private fermionProtocol;
    address private immutable OS_CONDUIT;

    /**
     * @notice Constructor
     *
     */
    constructor(
        address _openSeaConduit
    )
        ERC721("Fermion F-NFT", "FMION-NFT") // todo: add make correct names + symbol
        Ownable(msg.sender)
    {
        OS_CONDUIT = _openSeaConduit;
    }

    function initialize(address _voucherAddress, address _owner) external {
        if (owner() != address(0)) {
            revert AlreadyInitialized();
        }

        fermionProtocol = msg.sender;
        voucherAddress = _voucherAddress;
        _transferOwnership(_owner);
    }

    /**
     * @dev Returns true if this contract implements the interface defined by
     * `interfaceId`. See the corresponding
     * https://eips.ethereum.org/EIPS/eip-165#how-interfaces-are-identified[EIP section]
     * to learn more about how these ids are created.
     */
    function supportsInterface(bytes4 _interfaceId) public view virtual override(ERC721) returns (bool) {
        return (_interfaceId == type(IERC721).interfaceId || _interfaceId == type(IERC165).interfaceId);
    }

    /**
     * @notice Wraps the vouchers, transfer true vouchers to this contract and mint wrapped vouchers
     *
     * Reverts if:
     * - Caller does not own the Boson rNFTs
     *
     * @param _firstTokenId The first token id.
     * @param _length The number of tokens to wrap.
     * @param _to The address to mint the wrapped tokens to.
     */
    function wrapForAuction(uint256 _firstTokenId, uint256 _length, address _to) external {
        wrap(_firstTokenId, _length, _to);
    }

    /**
     * @notice Transfers the contract ownership to a new owner
     *
     * Reverts if:
     * - Caller is not the Fermion Protocol
     *
     * N.B. transferring ownership to 0 are allowed, since they can still be change via Fermion Protocol
     *
     * @param _newOwner The address of the new owner
     */
    function transferOwnership(address _newOwner) public override {
        if (fermionProtocol != _msgSender()) {
            revert OwnableUnauthorizedAccount(_msgSender());
        }
        _transferOwnership(_newOwner);
    }

    /**
     * @notice Wraps the vouchers, transfer true vouchers to this contract and mint wrapped vouchers
     *
     * @param _firstTokenId The first token id.
     * @param _length The number of tokens to wrap.
     * @param _to The address to mint the wrapped tokens to.
     */
    function wrap(uint256 _firstTokenId, uint256 _length, address _to) internal {
        for (uint256 i = 0; i < _length; i++) {
            uint256 tokenId = _firstTokenId + i;

            // Transfer vouchers to this contract
            // Instead of msg.sender it could be voucherAddress, if vouchers were preminted to contract itself
            // Not using safeTransferFrom since this contract is the recipient and we are sure it can handle the vouchers
            IERC721(voucherAddress).transferFrom(msg.sender, address(this), tokenId);

            // Mint to the specified address
            _safeMint(_to, tokenId);
            tokenState[tokenId] = TokenState.Wrapped;
        }
        _setApprovalForAll(address(this), OS_CONDUIT, true); // ToDo: investigate: maybe do it per tokenId?
    }
}
