export const MIN_FRACTIONS = 10n ** 18n;
export const MAX_FRACTIONS = 2n ** 127n;
export const TOP_BID_LOCK_TIME = 3n * 24n * 60n * 60n; // three days
export const AUCTION_DURATION = 5n * 24n * 60n * 60n; // five days
export const UNLOCK_THRESHOLD = 5000n; // 50%
export const AUCTION_END_BUFFER = 15n * 60n; // 15 minutes
export const MINIMAL_BID_INCREMENT = 1000n; // 10%
export const HUNDRED_PERCENT = 100_00n; // 100%

export const DEFAULT_FRACTION_AMOUNT = 10n ** 6n * MIN_FRACTIONS;
export const PARTIAL_THRESHOLD_MULTIPLIER = 12n;
export const LIQUIDATION_THRESHOLD_MULTIPLIER = 3n;
export const PARTIAL_AUCTION_DURATION_DIVISOR = 4n;
export const MIN_GOV_VOTE_DURATION = 86_400; // 1 day
export const MAX_GOV_VOTE_DURATION = 604_800; // 7 days
export const DEFAULT_GOV_VOTE_DURATION = 259_200; // 3 days
