// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title Native Claims Storage Library
 * @notice Provides storage for native currency claims that can be used by both protocol and client contracts
 */
library NativeClaims {
    // keccak256(abi.encode(uint256(keccak256("native.claims.storage")) - 1)) & ~bytes32(uint256(0xff));
    bytes32 private constant STORAGE_SLOT = 0xaf833ba755a88e67fdf7592ad2cd23cb88eeb39ba7091cbf219ca880c31f2a00;

    event ClaimAdded(address indexed claimer, uint256 amount);
    event ClaimCleared(address indexed claimer);

    struct Storage {
        mapping(address => uint256) claims;
    }

    function _getStorage() internal pure returns (Storage storage $) {
        bytes32 slot = STORAGE_SLOT;
        assembly {
            $.slot := slot
        }
    }

    function _getClaimAmount(address _claimer) internal view returns (uint256) {
        return _getStorage().claims[_claimer];
    }

    function _addClaim(address _claimer, uint256 _amount) internal {
        _getStorage().claims[_claimer] += _amount;
        emit ClaimAdded(_claimer, _amount);
    }

    function _clearClaim(address _claimer) internal {
        _getStorage().claims[_claimer] = 0;
        emit ClaimCleared(_claimer);
    }
}
