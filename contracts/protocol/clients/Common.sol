// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

enum TokenState {
    Inexistent,
    Wrapped,
    Unverified,
    Verified,
    CheckedIn,
    CheckedOut,
    Burned
}

error InvalidStateOrCaller(uint256 tokenId, address sender, TokenState state);
event TokenStateChange(uint256 indexed tokenId, TokenState state);

library Common {
    struct CommonStorage {
        // Token state
        mapping(uint256 => TokenState) tokenState;
        // Exchange token
        address exchangeToken;
    }

    bytes32 private constant CommonStorageLocation = keccak256("Fermion.common.storage"); // pre-calculate and store the slot

    function _getFermionCommonStorage() internal pure returns (CommonStorage storage $) {
        bytes32 position = CommonStorageLocation;
        assembly {
            $.slot := position
        }
    }

    /**
     * @notice Checks it the token is in the expected state and the caller is the expected address
     *
     * Reverts if:
     * - Token is not in the expected state
     * - Caller is not the expected address
     *
     * @param _tokenId The token id
     * @param _expectedState The expected state
     * @param _expectedCaller The expected caller
     */
    function checkStateAndCaller(uint256 _tokenId, TokenState _expectedState, address _expectedCaller) internal view {
        TokenState state = _getFermionCommonStorage().tokenState[_tokenId];
        if (state != _expectedState || msg.sender != _expectedCaller) {
            revert InvalidStateOrCaller(_tokenId, msg.sender, state);
        }
    }

    /**
     * @notice Changes the state of a token
     *
     * Emits an TokenStateChange event
     *
     * @param _tokenId The token id
     * @param _state The new state
     */
    function changeTokenState(uint256 _tokenId, TokenState _state) internal {
        _getFermionCommonStorage().tokenState[_tokenId] = _state;
        emit TokenStateChange(_tokenId, _state);
    }
}
