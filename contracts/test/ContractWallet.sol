// SPDX-License-Identifier: CC0-1.0
pragma solidity 0.8.24;

import { IERC1271 } from "@openzeppelin/contracts/interfaces/IERC1271.sol";

contract ContractWallet is IERC1271 {
    error UnknownValidity();

    enum Validity {
        Invalid,
        Valid,
        Unknown
    }

    Validity private validity;

    function setValidity(Validity _validity) external {
        validity = _validity;
    }

    /**
     * @notice Different possible reutnrs, depending on the validity state
     */
    function isValidSignature(bytes32, bytes calldata) external view override returns (bytes4) {
        // Validate signatures
        if (validity == Validity.Valid) {
            return IERC1271.isValidSignature.selector;
        } else if (validity == Validity.Invalid) {
            return 0xffffffff;
        }

        revert UnknownValidity();
    }
}

contract ContractWalletWithReceive is ContractWallet {
    error NotAcceptingMoney();

    event FundsReceived(address indexed sender, uint256 value);

    bool private acceptingMoney = true;

    function setAcceptingMoney(bool _acceptingMoney) external {
        acceptingMoney = _acceptingMoney;
    }

    receive() external payable {
        if (!acceptingMoney) {
            revert NotAcceptingMoney();
        }

        emit FundsReceived(msg.sender, msg.value);
    }
}
