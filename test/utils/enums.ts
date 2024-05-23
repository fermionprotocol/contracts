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
  Fractionalised,
  CheckedOut,
  Burned,
}

export enum WalletRole {
  Admin,
  Assistant,
  Treasury,
}

export enum VerificationStatus {
  Pending,
  Verified,
  Rejected,
}

export function enumIterator(enumObject: any) {
  return Object.keys(enumObject).filter((key) => !isNaN(Number(key)));
}
