/**
 * Fermion Protocol Enums: ExchangeState
 */

export enum EntityRole {
  Seller,
  Buyer,
  Verifier,
  Custodian,
}

export enum TokenState {
  Inexistent,
  Wrapped,
  Unwrapping,
  Unverified,
  Verified,
  CheckedIn,
  CheckedOut,
  Burned,
}

export enum AccountRole {
  Manager,
  Assistant,
  Treasury,
}

export enum VerificationStatus {
  Verified,
  Rejected,
  Pending,
}

export enum CheckoutRequestStatus {
  None,
  CheckedIn,
  CheckOutRequested,
  CheckOutRequestCleared,
  CheckedOut,
}

export enum PausableRegion {
  Config,
  MetaTransaction,
  Funds,
  Entity,
  Offer,
  Verification,
  Custody,
  CustodyVault,
}

export enum AuctionState {
  NotStarted,
  Ongoing,
  Reserved,
  Finalized,
  Redeemed,
}

export const enum PriceUpdateProposalState {
  NotInit = 0, // Explicitly represents an uninitialized state
  Active = 1,
  Executed = 2,
  Failed = 3,
}

export enum WrapType {
  SELF_SALE,
  OS_AUCTION,
  OS_FIXED_PRICE,
}

export function enumIterator(enumObject: any) {
  return Object.keys(enumObject).filter((key) => !isNaN(Number(key)));
}
