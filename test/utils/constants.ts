export const MIN_FRACTIONS = 10n ** 18n;
export const MAX_FRACTIONS = 2n ** 127n;
export const TOP_BID_LOCK_TIME = 3n * 24n * 60n * 60n; // three days
export const AUCTION_DURATION = 5n * 24n * 60n * 60n; // five days
export const UNLOCK_THRESHOLD = 5000n; // 50%
export const AUCTION_END_BUFFER = 15n * 60n; // 15 minutes
export const MINIMAL_BID_INCREMENT = 1000n; // 10%

export const DEFAULT_FRACTION_AMOUNT = 10n ** 5n * MIN_FRACTIONS;
export const PARTIAL_THRESHOLD_MULTIPLIER = 12n;
export const LIQUIDATION_THRESHOLD_MULTIPLIER = 2n;
export const PARTIAL_AUCTION_DURATION_DIVISOR = 4n;
