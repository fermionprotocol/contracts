// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { FermionTypes } from "./Types.sol";

interface FermionErrors {
    // General errors
    error InvalidAddress();
    error ArrayLengthMismatch(uint256 expectedLength, uint256 actualLength);

    // Initialization errors
    error DirectInitializationNotAllowed();
    error VersionMustBeSet();
    error AddressesAndCalldataLengthMismatch(uint256 addressesLength, uint256 calldataLength);

    // Entity errors
    error EntityAlreadyExists();
    error NoSuchEntity(uint256 entityId);
    error NotAdmin(address admin, uint256 entityId, FermionTypes.EntityRole role);
    error NotEntityAdmin(uint256 entityId, address admin);
    error NotEntityTreasury(uint256 entityId, address treasury);
    error NotEntityAssistant(uint256 entityId, address assistant);
    error AlreadyAdmin(uint256 entityId, address admin);
    error EntityHasNoRole(uint256 entityId, FermionTypes.EntityRole role);
    error WalletHasNoRole(
        uint256 entityId,
        address wallet,
        FermionTypes.EntityRole entityRole,
        FermionTypes.WalletRole walletRole
    );
    error ChangeNotAllowed();

    // Offer errors
    error InvalidQuantity(uint256 quantity);
    error NoSuchOffer(uint256 offerId);
    error InvalidOrder();

    // Custody errors
    error NotTokenBuyer(uint256 tokenId, address owner, address caller);
    error InvalidTaxAmount();
    error InvalidCheckoutRequestStatus(
        uint256 tokenId,
        FermionTypes.CheckoutRequestStatus expectedStatus,
        FermionTypes.CheckoutRequestStatus actualStatus
    );

    // Funds errors
    error WrongValueReceived(uint256 expected, uint256 actual);
    error NativeNotAllowed();
    error PriceTooLow(uint256 price, uint256 minimumPrice);
    error ZeroDepositNotAllowed();
    error NothingToWithdraw();
    error TokenTransferFailed(address to, uint256 amount, bytes errorMessage);
    error InsufficientAvailableFunds(uint256 availableFunds, uint256 requestedFunds);

    // Meta transaction errors
    error NonceUsedAlready();
    error FunctionNotAllowlisted();
    error InvalidFunctionName();
    error InvalidSignature();
    error SignerAndSignatureDoNotMatch();
    error FunctionCallFailed();
}
