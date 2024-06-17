// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

uint256 constant BYTE_SIZE = 8;
uint256 constant BOSON_DR_ID_OFFSET = 2; // Boson DR id is 2 higher than the seller id
uint256 constant HUNDRED_PERCENT = 100_00;
uint256 constant AUCTION_END_BUFFER = 15 minutes;
uint256 constant MINIMAL_BID_INCREMENT = 10_00; // 10%

// Fractionalization
uint256 constant MIN_FRACTIONS = 1e18;
uint256 constant MAX_FRACTIONS = 1 << 127;

// Default parameters
uint256 constant TOP_BID_LOCK_TIME = 3 days;
uint256 constant AUCTION_DURATION = 5 days;
uint256 constant UNLOCK_THRESHOLD = 50_00; // 50%

// Forceful fractionalisation
uint256 constant DEFAULT_FRACTION_AMOUNT = 1e6 * MIN_FRACTIONS;
uint256 constant PARTIAL_THRESHOLD_MULTIPLIER = 12;
uint256 constant LIQUIDATION_THRESHOLD_MULTIPLIER = 3;
uint256 constant PARTIAL_AUCTION_DURATION_DIVISOR = 4;
