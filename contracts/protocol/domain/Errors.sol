// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { FermionTypes } from "./Types.sol";

interface FermionErrors {
    // General errors
    error InvalidAddress();
    error ArrayLengthMismatch(uint256 expectedLength, uint256 actualLength);
    error AccessDenied(address caller);
    error InvalidPercentage(uint256 percentage);

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

    // Pause handler
    error NotPaused();
    error RegionPaused(FermionTypes.PausableRegion region);

    // Meta transaction errors
    error NonceUsedAlready();
    error FunctionNotAllowlisted();
    error InvalidFunctionName();
    error InvalidSignature();
    error SignerAndSignatureDoNotMatch();
    error FunctionCallFailed();

    // Fractionalisation errors
    error InvalidLength();
    error InvalidFractionsAmount(uint256 amount, uint256 min, uint256 max);
    error InvalidExitPrice(uint256 amount);
    error AlreadyFractionalized(uint256 tokenId);
    error InvalidBid(uint256 tokenId, uint256 minimalBid, uint256 bid);
    error AuctionEnded(uint256 tokenId, uint256 endedAt);
    error AuctionNotStarted(uint256 tokenId);
    error AuctionOngoing(uint256 tokenId, uint256 validUntil);
    error AuctionFinalized(uint256 tokenId);
    error NotMaxBidder(uint256 tokenId, address caller, address winner);
    error AlreadyRedeemed(uint256 tokenId);
    error NoFractions();
    error InvalidValue(uint256 expected, uint256 actual);
    error BidRemovalNotAllowed(uint256 tokenId);
    error NoBids(uint256 tokenId);
    error NotEnoughLockedVotes(uint256 tokenId, uint256 lockedVotes, uint256 requestedVotes);
    error InitialFractionalisationOnly();
    error MissingFractionalisation();
    error InvalidAmount();
}
