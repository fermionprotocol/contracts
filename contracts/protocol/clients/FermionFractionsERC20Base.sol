// SPDX-License-Identifier: MIT
// OpenZeppelin Contracts (last updated v5.0.0) (token/ERC20/ERC20.sol)

pragma solidity 0.8.24;

import { ContextUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/ContextUpgradeable.sol";
import { IERC20Errors } from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import { Common } from "../clients/Common.sol";
import { FermionTypes } from "../domain/Types.sol";

/**
 * @dev Implementation of the {IERC20} interface.
 *
 * It's a fork of OpenZeppelin's ERC20 contract with the following changes:
 * - _transfer renamed to _transferFractions
 * - _approve renamed to _approveFractions
 * - _transferFrom renamed to _transferFractionsFrom
 * - _mint renamed to _mintFractions
 * - public methods `transferFrom` and `approve` are not defined in this contract. They are defined as part of
 *   the FermionFNFT overrides, where ERC721 and ERC20 are combined. This is done, since otherwise the ERC20 and ERC721
 *   have different return types and cannot be overriden in the usual way.
 *
 * The contract implements an epoch-based balance tracking system:
 * - Each epoch represents a distinct period where token balances and total supply are tracked separately
 * - Each epoch maintains its own balance mapping and total supply
 * - The current epoch's balances and total supply are used for all standard ERC20 token operations
 * - Non standard functions that allows to transfer tokens, query balances and total supply in a specific epoch as well.
 * NOTE: New epoch is advanced only when initial mintFractions is called (initial mintFractions can be called also when buyout auction parameters need to be updated)
 */
abstract contract FermionFractionsERC20Base is ContextUpgradeable, IERC20Errors {
    event FractionsTransfer(address indexed from, address indexed to, uint256 value, uint256 epoch);

    // ERC20
    /// @custom:storage-location erc7201:openzeppelin.storage.ERC20
    struct ERC20Storage {
        mapping(address account => uint256) _balances;
        mapping(address account => mapping(address spender => uint256)) _allowances;
        uint256 _totalSupply;
        uint256 _currentEpoch;
        mapping(uint256 epoch => mapping(address account => uint256)) _epochBalances;
        mapping(uint256 epoch => mapping(address account => mapping(address spender => uint256))) _epochAllowances;
        mapping(uint256 epoch => uint256) _epochTotalSupply;
    }

    // keccak256(abi.encode(uint256(keccak256("openzeppelin.storage.ERC20")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant ERC20StorageLocation = 0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00;

    function _getERC20Storage() internal pure returns (ERC20Storage storage $) {
        assembly {
            $.slot := ERC20StorageLocation
        }
    }

    /**
     * @dev Returns the number of decimals used to get its user representation.
     * For example, if `decimals` equals `2`, a balance of `505` tokens should
     * be displayed to a user as `5.05` (`505 / 10 ** 2`).
     *
     * Tokens usually opt for a value of 18, imitating the relationship between
     * Ether and Wei. This is the default value returned by this function, unless
     * it's overridden.
     *
     * NOTE: This information is only used for _display_ purposes: it in
     * no way affects any of the arithmetic of the contract, including
     * {IERC20-balanceOf} and {IERC20-transfer}.
     */
    function decimals() public view virtual returns (uint8) {
        return 18;
    }

    /**
     * @dev See {IERC20-totalSupply}.
     */
    function totalSupply() public view virtual returns (uint256) {
        ERC20Storage storage $ = _getERC20Storage();
        return $._currentEpoch == 0 ? $._totalSupply : $._epochTotalSupply[$._currentEpoch];
    }

    /**
     * @dev Returns the total supply for a specific epoch.
     */
    function totalSupply(uint256 epoch) public view virtual returns (uint256) {
        ERC20Storage storage $ = _getERC20Storage();
        return epoch == 0 ? $._totalSupply : $._epochTotalSupply[epoch];
    }

    /**
     * @notice Returns the liquid number of fractions for current epoch. Represents fractions of F-NFTs that are fractionalised
     */
    function liquidSupply() public view virtual returns (uint256) {
        FermionTypes.BuyoutAuctionStorage storage $ = Common._getBuyoutAuctionStorage(_getERC20Storage()._currentEpoch);
        return totalSupply() - $.unrestricedRedeemableSupply - $.lockedRedeemableSupply - $.pendingRedeemableSupply;
    }

    /**
     * @dev See {IERC20-balanceOf}.
     */
    function balanceOf(address account) public view virtual returns (uint256) {
        ERC20Storage storage $ = _getERC20Storage();
        return $._currentEpoch == 0 ? $._balances[account] : $._epochBalances[$._currentEpoch][account];
    }

    /**
     * @dev Returns the balance of an account for a specific epoch.
     */
    function balanceOf(address account, uint256 epoch) public view virtual returns (uint256) {
        ERC20Storage storage $ = _getERC20Storage();
        return epoch == 0 ? $._balances[account] : $._epochBalances[epoch][account];
    }

    /**
     * @dev See {IERC20-transfer}.
     *
     * Requirements:
     *
     * - `to` cannot be the zero address.
     * - the caller must have a balance of at least `value`.
     */
    function transfer(address to, uint256 value) public virtual returns (bool) {
        address owner = _msgSender();
        _transferFractions(owner, to, value, _getERC20Storage()._currentEpoch);
        return true;
    }

    /**
     * @dev Non standard transfer function that allows to transfer tokens in a specific epoch
     *
     * Requirements:
     *
     * - `to` cannot be the zero address.
     * - the caller must have a balance of at least `value` in the current epoch.
     */
    function transferInEpoch(address to, uint256 value, uint256 epoch) public virtual returns (bool) {
        address owner = _msgSender();
        _transferFractions(owner, to, value, epoch);
        return true;
    }

    /**
     * @dev See {IERC20-allowance}.
     */
    function allowance(address owner, address spender) public view virtual returns (uint256) {
        ERC20Storage storage $ = _getERC20Storage();
        uint256 currentEpoch = $._currentEpoch;
        uint256 spenderAllowance = currentEpoch == 0
            ? $._allowances[owner][spender]
            : $._epochAllowances[currentEpoch][owner][spender];
        if (spenderAllowance == type(uint128).max) spenderAllowance = type(uint256).max; // Update the value to make allowance consistent with standard approaches for infinite allowance
        return spenderAllowance;
    }

    /**
     * @dev Returns the allowance for a specific epoch.
     */
    function allowance(address owner, address spender, uint256 epoch) public view virtual returns (uint256) {
        ERC20Storage storage $ = _getERC20Storage();
        uint256 spenderAllowance = epoch == 0
            ? $._allowances[owner][spender]
            : $._epochAllowances[epoch][owner][spender];
        if (spenderAllowance == type(uint128).max) spenderAllowance = type(uint256).max;
        return spenderAllowance;
    }

    /**
     * @dev See {IERC20-approve}.
     *
     * NOTE: If `value` is the maximum `uint256`, the allowance is not updated on
     * `transferFrom`. This is semantically equivalent to an infinite approval.
     *
     * Requirements:
     *
     * - `spender` cannot be the zero address.
     */
    function approveFractions(address spender, uint256 value) internal virtual returns (bool) {
        address owner = _msgSender();
        _approve(owner, spender, value);
        return true;
    }

    /**
     * @dev See {IERC20-transferFrom}.
     *
     * Emits an {Approval} event indicating the updated allowance. This is not
     * required by the EIP. See the note at the beginning of {ERC20}.
     *
     * NOTE: Does not update the allowance if the current allowance
     * is the maximum `uint256`.
     *
     * Requirements:
     *
     * - `from` and `to` cannot be the zero address.
     * - `from` must have a balance of at least `value`.
     * - the caller must have allowance for ``from``'s tokens of at least
     * `value`.
     */
    function transferFractionsFrom(address from, address to, uint256 value) internal virtual returns (bool) {
        address spender = _msgSender();
        uint256 currentEpoch = _getERC20Storage()._currentEpoch;
        _spendAllowance(from, spender, value, currentEpoch);
        _transferFractions(from, to, value, currentEpoch);
        return true;
    }

    /**
     * @dev Moves a `value` amount of tokens from `from` to `to`.
     *
     * This internal function is equivalent to {transfer}, and can be used to
     * e.g. implement automatic token fees, slashing mechanisms, etc.
     *
     * Emits a {Transfer} event.
     *
     * NOTE: This function is not virtual, {_update} should be overridden instead.
     */
    function _transferFractions(address from, address to, uint256 value, uint256 epoch) internal {
        if (from == address(0)) {
            revert ERC20InvalidSender(address(0));
        }
        if (to == address(0)) {
            revert ERC20InvalidReceiver(address(0));
        }
        _update(from, to, value, epoch);
    }

    /**
     * @dev Transfers a `value` amount of tokens from `from` to `to`, or alternatively mints (or burns) if `from`
     * (or `to`) is the zero address. All customizations to transfers, mints, and burns should be done by overriding
     * this function.
     *
     * Emits a {Transfer} event.
     */
    function _update(address from, address to, uint256 value, uint256 epoch) internal virtual {
        ERC20Storage storage $ = _getERC20Storage();
        // Get reference to the correct balances mapping
        mapping(address => uint256) storage balances = epoch == 0 ? $._balances : $._epochBalances[epoch];

        if (epoch == $._currentEpoch) {
            _adjustVotesOnTransfer(from, value, epoch);
        }

        if (from == address(0)) {
            // Overflow check required: The rest of the code assumes that totalSupply never overflows
            if (epoch == 0) {
                $._totalSupply += value;
            } else {
                $._epochTotalSupply[epoch] += value;
            }
        } else {
            uint256 fromBalance = balances[from];
            if (fromBalance < value) {
                revert ERC20InsufficientBalance(from, fromBalance, value);
            }
            unchecked {
                balances[from] = fromBalance - value;
            }
        }

        if (to == address(0)) {
            unchecked {
                // Overflow not possible: value <= totalSupply or value <= fromBalance <= totalSupply.
                if (epoch == 0) {
                    $._totalSupply -= value;
                } else {
                    $._epochTotalSupply[epoch] -= value;
                }
            }
        } else {
            unchecked {
                // Overflow not possible: balance + value is at most totalSupply, which we know fits into a uint256.
                balances[to] += value;
            }
        }

        // NB: not emitting standard ERC20 transfer event since it clashes with ERC721 Transfer event and it could lead to inconsistentcies
        emit FractionsTransfer(from, to, value, epoch);
    }

    /**
     * @dev Creates a `value` amount of tokens and assigns them to `account`, by transferring it from address(0).
     * Relies on the `_update` mechanism
     *
     * Emits a {Transfer} event with `from` set to the zero address.
     *
     * NOTE: This function is not virtual, {_update} should be overridden instead.
     */
    function _mintFractions(address account, uint256 value) internal {
        if (account == address(0)) {
            revert ERC20InvalidReceiver(address(0));
        }
        _update(address(0), account, value, _getERC20Storage()._currentEpoch);
    }

    /**
     * @dev Destroys a `value` amount of tokens from `account`, lowering the total supply.
     * Relies on the `_update` mechanism.
     *
     * Emits a {Transfer} event with `to` set to the zero address.
     *
     * NOTE: This function is not virtual, {_update} should be overridden instead
     */
    function _burn(address account, uint256 value, uint256 epoch) internal {
        if (account == address(0)) {
            revert ERC20InvalidSender(address(0));
        }
        _update(account, address(0), value, epoch);
    }

    /**
     * @dev Sets `value` as the allowance of `spender` over the `owner` s tokens.
     *
     * This internal function is equivalent to `approve`, and can be used to
     * e.g. set automatic allowances for certain subsystems, etc.
     *
     * Emits an {Approval} event.
     *
     * Requirements:
     *
     * - `owner` cannot be the zero address.
     * - `spender` cannot be the zero address.
     *
     * Overrides to this logic should be done to the variant with an additional `bool emitEvent` argument.
     */
    function _approve(address owner, address spender, uint256 value) internal {
        _approve(owner, spender, value, true, _getERC20Storage()._currentEpoch);
    }

    /**
     * @dev Variant of {_approve} with an optional flag to enable or disable the {Approval} event also accepting an epoch.
     *
     * By default (when calling {_approve}) the flag is set to true. On the other hand, approval changes made by
     * `_spendAllowance` during the `transferFrom` operation set the flag to false. This saves gas by not emitting any
     * `Approval` event during `transferFrom` operations.
     *
     * Anyone who wishes to continue emitting `Approval` events on the`transferFrom` operation can force the flag to
     * true using the following override:
     * ```
     * function _approve(address owner, address spender, uint256 value, bool) internal virtual override {
     *     super._approve(owner, spender, value, true);
     * }
     * ```
     *
     * Requirements are the same as {_approve}.
     */
    function _approve(address owner, address spender, uint256 value, bool emitEvent, uint256 epoch) internal virtual {
        if (owner == address(0)) {
            revert ERC20InvalidApprover(address(0));
        }
        if (spender == address(0)) {
            revert ERC20InvalidSpender(address(0));
        }

        ERC20Storage storage $ = _getERC20Storage();

        if (epoch == 0) {
            $._allowances[owner][spender] = value;
        } else {
            $._epochAllowances[epoch][owner][spender] = value;
        }

        if (value == type(uint128).max) value = type(uint256).max; // Update the value to make events consistent with standard approaches for infinite allowance

        if (emitEvent) {
            emit IERC721.Approval(owner, spender, value);
        }
    }

    /**
     * @dev Updates `owner` s allowance for `spender` based on spent `value`.
     *
     * Does not update the allowance value in case of infinite allowance.
     * Revert if not enough allowance is available.
     *
     * Does not emit an {Approval} event.
     */
    function _spendAllowance(address owner, address spender, uint256 value, uint256 epoch) internal virtual {
        uint256 currentAllowance = allowance(owner, spender, epoch);
        if (currentAllowance != type(uint256).max) {
            if (currentAllowance < value) {
                revert ERC20InsufficientAllowance(spender, currentAllowance, value);
            }
            unchecked {
                _approve(owner, spender, currentAllowance - value, false, epoch);
            }
        }
    }

    /**
     * @notice Adjusts the voter's records on transfer by removing votes if the remaining balance cannot support them.
     *         This ensures the proposal's vote count remains accurate.
     *
     * @dev If the voter has no active votes or the current proposal is not active, no adjustments are made.
     *      If the voter's remaining balance after the transfer is greater than or equal to their vote count,
     *      no votes are removed. Otherwise, votes are reduced proportionally.
     *
     * @param voter The address of the voter whose votes are being adjusted.
     * @param amount The number of fractions being transferred.
     */
    function _adjustVotesOnTransfer(address voter, uint256 amount, uint256 epoch) internal {
        FermionTypes.BuyoutAuctionStorage storage $ = Common._getBuyoutAuctionStorage(epoch);
        FermionTypes.PriceUpdateProposal storage proposal = $.currentProposal;

        if (proposal.state != FermionTypes.PriceUpdateProposalState.Active) {
            return; // Proposal is not active
        }

        FermionTypes.PriceUpdateVoter storage voterData = proposal.voters[voter];
        uint256 voteCount = voterData.voteCount;

        if (voteCount == 0 || voterData.proposalId != proposal.proposalId) {
            return; // Voter has no active votes
        }

        uint256 remainingBalance = FermionFractionsERC20Base.balanceOf(voter, epoch) - amount;

        if (remainingBalance >= voteCount) {
            return; // Remaining balance is sufficient to support existing votes
        }

        uint256 votesToRemove = voteCount - remainingBalance;
        voterData.voteCount = remainingBalance;

        unchecked {
            if (voterData.votedYes) {
                proposal.yesVotes -= votesToRemove;
            } else {
                proposal.noVotes -= votesToRemove;
            }
        }
    }

    /**
     * @dev Advances to the next epoch if the current epoch's total supply is 0.
     * This function should be called when transitioning to a new epoch.
     * @return newEpoch The new epoch
     */
    function _advanceEpoch() internal returns (uint256 newEpoch) {
        ERC20Storage storage $ = _getERC20Storage();
        uint256 currentEpoch = $._currentEpoch;
        uint256 currentTotalSupply = currentEpoch == 0 ? $._totalSupply : $._epochTotalSupply[currentEpoch];

        if (currentTotalSupply != 0) {
            newEpoch = currentEpoch + 1;
            $._currentEpoch = newEpoch;
        }
    }
}
