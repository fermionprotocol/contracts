// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {
    ERC20PermitUpgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { IFermionFNFTPriceManager } from "../interfaces/IFermionFNFTPriceManager.sol";
import { IFermionFractionsERC20 } from "../interfaces/IFermionFractionsERC20.sol";
import { ContextUpgradeable as Context } from "@openzeppelin/contracts-upgradeable/utils/ContextUpgradeable.sol";
import {
    ERC2771ContextUpgradeable as ERC2771Context
} from "@openzeppelin/contracts-upgradeable/metatx/ERC2771ContextUpgradeable.sol";

/**
 * @dev Implementation of the Fermion Fractions ERC20 epoch token.
 * This implementation is designed to be used with minimal proxies (EIP-1167).
 */
contract FermionFractionsERC20 is
    Initializable,
    ERC20PermitUpgradeable,
    ERC2771Context,
    OwnableUpgradeable,
    IFermionFractionsERC20
{
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(address _fermionProtocol) ERC2771Context(_fermionProtocol) {
        _disableInitializers();
    }

    /**
     * @dev Initializes the contract with the given parameters.
     * This function replaces the constructor for proxy patterns and can only be called once.
     */
    function initialize(string memory name_, string memory symbol_, address owner_) external initializer {
        __ERC20_init(name_, symbol_);
        __ERC20Permit_init(name_);
        __Ownable_init(owner_);
    }

    /**
     * @dev Creates `value` tokens and assigns them to `account`.
     * Can only be called by the owner.
     */
    function mint(address account, uint256 value) external onlyOwner {
        _mint(account, value);
    }

    /**
     * @dev Destroys `value` tokens from `account`.
     * Can only be called by the owner.
     */
    function burn(address account, uint256 value) external onlyOwner {
        _burn(account, value);
    }

    function transferFractionsFrom(address from, address to, uint256 value) external onlyOwner {
        if (from == address(0)) {
            revert ERC20InvalidSender(address(0));
        }
        if (to == address(0)) {
            revert ERC20InvalidReceiver(address(0));
        }
        _transfer(from, to, value);
    }

    /**
     * @dev Override the _update function to notify the owner (FermionFNFT contract) about transfers.
     * This allows the FermionFNFT contract to adjust votes when necessary to maintain voting integrity.
     * The notifications is only sent for transfers and burns (excluding mints as they have no effect on voting power adjustments).
     */
    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);

        if (from != address(0)) {
            IFermionFNFTPriceManager(owner()).adjustVotesOnTransfer(from);
        }
    }

    function _msgSender() internal view virtual override(Context, ERC2771Context) returns (address) {
        return ERC2771Context._msgSender();
    }

    function _msgData() internal view virtual override(Context, ERC2771Context) returns (bytes calldata) {
        return ERC2771Context._msgData();
    }

    function _contextSuffixLength() internal view virtual override(Context, ERC2771Context) returns (uint256) {
        return ERC2771Context._contextSuffixLength();
    }
}
