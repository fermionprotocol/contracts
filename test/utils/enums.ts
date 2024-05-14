/**
 * Fermion Protocol Enums: ExchangeState
 */

export enum EntityRole {
  Seller,
  Buyer,
  Verifier,
  Custodian,
}

export enum WalletRole {
  Admin,
  Assistant,
  Treasury,
}

export function enumIterator(enumObject: any) {
  return Object.keys(enumObject).filter((key) => !isNaN(Number(key)));
}
