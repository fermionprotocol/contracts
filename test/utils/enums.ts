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
  Unverified,
  Verified,
  CheckedIn,
  CheckedOut,
  Burned,
}

export enum WalletRole {
  Admin,
  Assistant,
  Treasury,
}

export enum VerificationStatus {
  Verified,
  Rejected,
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
  Finalized,
  Redeemed,
}

export function enumIterator(enumObject: any) {
  return Object.keys(enumObject).filter((key) => !isNaN(Number(key)));
}
