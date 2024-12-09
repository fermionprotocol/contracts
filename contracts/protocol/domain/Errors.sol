// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { FermionTypes } from "./Types.sol";

interface FermionGeneralErrors {
    // General errors
    error InvalidAddress();
    error ArrayLengthMismatch(uint256 expectedLength, uint256 actualLength);
    error AccessDenied(address caller);
    error InvalidPercentage(uint256 percentage);
    error ZeroNotAllowed();
    error UnexpectedDataReturned(bytes data);
    // Array elements that are not in ascending order (i.e arr[i-1] > arr[i])
    error NonAscendingOrder();
}

interface InitializationErrors {
    // Initialization errors
    error DirectInitializationNotAllowed();
    error VersionMustBeSet();
    error AddressesAndCalldataLengthMismatch(uint256 addressesLength, uint256 calldataLength);
}

interface EntityErrors {
    // Entity errors
    error EntityAlreadyExists();
    error NoSuchEntity(uint256 entityId);
    error NotRoleManager(address manager, uint256 entityId, FermionTypes.EntityRole role);
    error NotEntityWideRole(address account, uint256 entityId, FermionTypes.AccountRole role);
    error NotAdmin(uint256 entityId, address admin);
    error AlreadyAdmin(uint256 entityId, address admin);
    error EntityHasNoRole(uint256 entityId, FermionTypes.EntityRole role);
    error AccountHasNoRole(
        uint256 entityId,
        address account,
        FermionTypes.EntityRole entityRole,
        FermionTypes.AccountRole accountRole
    );
    error ChangeNotAllowed();
    error NotSellersFacilitator(uint256 sellerId, uint256 facilitatorId);
    error FacilitatorAlreadyExists(uint256 sellerId, uint256 facilitatorId);
    error AccountAlreadyExists(address account);
    error NewAccountSameAsOld();
}

interface OfferErrors {
    // Offer errors
    error InvalidQuantity(uint256 quantity);
    error NoSuchOffer(uint256 offerId);
    error InvalidOpenSeaOrder();
}

interface VerificationErrors {
    // Verification errors
    error VerificationTimeoutNotPassed(uint256 verificationTimeout, uint256 currentTime);
    error VerificationTimeoutTooLong(uint256 verificationTimeout, uint256 maxVerificationTimeout);
    error EmptyMetadata();
    error DigestMismatch(bytes32 expected, bytes32 actual);
    error AlreadyVerified(FermionTypes.VerificationStatus status);
}

interface CustodyErrors {
    // Custody errors
    error NotTokenBuyer(uint256 tokenId, address owner, address caller);
    error InvalidTaxAmount();
    error InvalidCheckoutRequestStatus(
        uint256 tokenId,
        FermionTypes.CheckoutRequestStatus expectedStatus,
        FermionTypes.CheckoutRequestStatus actualStatus
    );
}

interface AuctionErrors {
    error InvalidBid(uint256 tokenId, uint256 minimalBid, uint256 bid);
    error AuctionEnded(uint256 tokenId, uint256 endedAt);
    error AuctionNotStarted(uint256 tokenId);
    error AuctionOngoing(uint256 tokenId, uint256 validUntil);
    error AuctionFinalized(uint256 tokenId);
    error NoFractionsAvailable(uint256 tokenId);
    error NoBids(uint256 tokenId);
}

interface CustodianVaultErrors is AuctionErrors {
    // Custodian vault
    error InactiveVault(uint256 tokenId);
    error PeriodNotOver(uint256 tokenId, uint256 periodEnd);
    error InvalidPartialAuctionThreshold();
    error InsufficientBalanceToFractionalise(uint256 tokenId, uint256 minimalDeposit);
}

interface FundsErrors {
    // Funds errors
    error WrongValueReceived(uint256 expected, uint256 actual);
    error NativeNotAllowed();
    error ERC721NotAllowed(address tokenAddress);
    error PriceTooLow(uint256 price, uint256 minimumPrice);
    error ZeroDepositNotAllowed();
    error NothingToWithdraw();
    error TokenTransferFailed(address to, uint256 amount, bytes errorMessage);
    error InsufficientAvailableFunds(uint256 availableFunds, uint256 requestedFunds);
}

interface PauseErrors {
    // Pause handler
    error NotPaused();
    error RegionPaused(FermionTypes.PausableRegion region);
}

interface MetaTransactionErrors {
    // Meta transaction errors
    error NonceUsedAlready();
    error FunctionNotAllowlisted();
    error InvalidFunctionName();
    error FunctionCallFailed();
}

interface SignatureErrors {
    error InvalidSignature(); // Somethihing is wrong with the signature
    error SignatureValidationFailed(); // Signature might be correct, but the validation failed
    error InvalidSigner(address expected, address actual);
}

interface FractionalisationErrors is AuctionErrors {
    // Fractionalisation errors
    error InvalidLength();
    error InvalidFractionsAmount(uint256 amount, uint256 min, uint256 max);
    error InvalidExitPrice(uint256 amount);
    error AlreadyFractionalized(uint256 tokenId);

    error NotMaxBidder(uint256 tokenId, address caller, address winner);
    error AlreadyRedeemed(uint256 tokenId);
    error NoFractions();
    error InvalidValue(uint256 expected, uint256 actual);
    error BidRemovalNotAllowed(uint256 tokenId);
    error MaxBidderCannotVote(uint256 tokenId);
    error NotEnoughLockedVotes(uint256 tokenId, uint256 lockedVotes, uint256 requestedVotes);
    error InitialFractionalisationOnly();
    error MissingFractionalisation();
    error InvalidAmount();
    error TokenNotFractionalised(uint256 tokenId);
    error InvalidAuctionIndex(uint256 auctionIndex, uint256 numberOfAuctions); // auctionIndex should be less than numberOfAuctions
    error AuctionReserved(uint256 tokenId);
}

interface FermionErrors is
    FermionGeneralErrors,
    InitializationErrors,
    EntityErrors,
    OfferErrors,
    VerificationErrors,
    CustodyErrors,
    CustodianVaultErrors,
    FundsErrors,
    PauseErrors,
    MetaTransactionErrors,
    FractionalisationErrors,
    SignatureErrors
{}
