// SPDX-License-Identifier: CC0-1.0
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

contract MockERC20 is ERC20 {
    uint256 private burnAmount;
    TrustedForwarderReturnData private trustedForwarderReturnData;
    TransferReturnData private transferReturnData;

    enum TrustedForwarderReturnData {
        Default, // returns address(0)
        TooShort, // returns 1 byte
        TooLong, // returns 33 bytes
        Polluted // returns 32 bytes with unexpected data
    }

    enum TransferReturnData {
        Success, // returns true (1)
        Failure, // returns false (0)
        NoReturn, // returns nothing
        InvalidReturn // returns unexpected value
    }

    constructor() ERC20("MockERC20", "MCK_20") {}

    /**
     * Mints some tokens
     * @param _account - address that gets the tokens
     * @param _amount - amount to mint
     */
    function mint(address _account, uint256 _amount) public {
        _mint(_account, _amount);
    }

    /**
     * Sets the amount that is burned on every transfer
     */
    function setBurnAmount(uint256 _burnAmount) public {
        burnAmount = _burnAmount;
    }

    function setTrustedForwarderReturnData(TrustedForwarderReturnData _returnData) external {
        trustedForwarderReturnData = _returnData;
    }

    function setTransferReturnData(TransferReturnData _returnData) external {
        transferReturnData = _returnData;
    }

    function trustedForwarder() public view returns (address) {
        if (trustedForwarderReturnData == TrustedForwarderReturnData.Default) {
            return address(0);
        } else if (trustedForwarderReturnData == TrustedForwarderReturnData.TooShort) {
            assembly {
                return(0, 1)
            }
        } else if (trustedForwarderReturnData == TrustedForwarderReturnData.TooLong) {
            assembly {
                mstore(0, 0x0000000000000000000000000000000000000000000000000000000000000001) //  true
                return(0, 33) // return 33 bytes
            }
        } else if (trustedForwarderReturnData == TrustedForwarderReturnData.Polluted) {
            assembly {
                mstore(0, 0x1626ba7e000000000000000abcde000000000000000000000000000000000001) //  true with some other data
                return(0, 32)
            }
        }
    }

    function transferFrom(address from, address to, uint256 amount) public virtual override returns (bool) {
        if (transferReturnData == TransferReturnData.Success) {
            return super.transferFrom(from, to, amount);
        } else if (transferReturnData == TransferReturnData.Failure) {
            return false;
        } else if (transferReturnData == TransferReturnData.NoReturn) {
            assembly {
                return(0, 0)
            }
        } else if (transferReturnData == TransferReturnData.InvalidReturn) {
            assembly {
                mstore(0, 0x0000000000000000000000000000000000000000000000000000000000000002) // return 2
                return(0, 32)
            }
        }
    }

    function _update(address from, address to, uint256 amount) internal override {
        if (burnAmount > 0 && to != address(0)) {
            _burn(from, burnAmount);
            amount -= burnAmount;
        }
        super._update(from, to, amount);
    }
}

contract MockERC721 is ERC721 {
    bool private holdTransfer;

    constructor() ERC721("MockERC20", "MCK_20") {}

    /**
     * Mints some tokens
     * @param _account - address that gets the tokens
     * @param _startTokenId - starting token id
     * @param _amount - amount to mint
     */
    function mint(address _account, uint256 _startTokenId, uint256 _amount) public {
        for (uint256 i = 0; i < _amount; i++) {
            _mint(_account, _startTokenId + i);
        }
    }

    function transferFrom(address from, address to, uint256 tokenId) public virtual override {
        if (revertReason == RevertReason.CustomError) {
            revert CustomError();
        }

        if (!holdTransfer) {
            super.transferFrom(from, to, tokenId);
        }
    }

    function setHoldTransfer(bool _holdTransfer) public {
        holdTransfer = _holdTransfer;
    }

    enum RevertReason {
        None,
        CustomError,
        ErrorString,
        ArbitraryBytes,
        DivisionByZero,
        OutOfBounds,
        ReturnTooShort,
        ReturnTooLong,
        PollutedData
    }

    RevertReason private revertReason;

    function setRevertReason(RevertReason _revertReason) external {
        revertReason = _revertReason;
    }

    error CustomError();

    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        if (revertReason == RevertReason.None) {
            return interfaceId == type(IERC721).interfaceId;
        } else if (revertReason == RevertReason.CustomError) {
            revert CustomError();
        } else if (revertReason == RevertReason.ErrorString) {
            revert("Error string");
        } else if (revertReason == RevertReason.ArbitraryBytes) {
            assembly {
                mstore(0, 0xdeadbeefdeadbeef000000000000000000000000000000000000000000000000)
                revert(0, 16)
            }
        } else if (revertReason == RevertReason.DivisionByZero) {
            uint256 a = 0; // division by zero
            uint256 b = 1 / a;
        } else if (revertReason == RevertReason.OutOfBounds) {
            uint256[] memory arr = new uint256[](1);
            arr[1] = 1; // out of bounds
        } else if (revertReason == RevertReason.ReturnTooShort) {
            assembly {
                return(0, 1)
            }
        } else if (revertReason == RevertReason.ReturnTooLong) {
            assembly {
                mstore(0, 0x0000000000000000000000000000000000000000000000000000000000000001) //  true
                return(0, 33)
            }
        } else if (revertReason == RevertReason.PollutedData) {
            assembly {
                mstore(0, 0x1626ba7e000000000000000abcde000000000000000000000000000000000001) //  true with some other data
                return(0, 32)
            }
        }
    }
}
