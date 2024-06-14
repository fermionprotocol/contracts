// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

// Access Control Roles
bytes32 constant ADMIN = keccak256("ADMIN"); // Role Admin
bytes32 constant PAUSER = keccak256("PAUSER"); // Role for pausing the protocol
bytes32 constant UPGRADER = keccak256("UPGRADER"); // Role for performing contract and config upgrades
bytes32 constant FEE_COLLECTOR = keccak256("FEE_COLLECTOR"); // Role for collecting fees from the protocol

uint256 constant BYTE_SIZE = 8;
uint256 constant BOSON_DR_ID_OFFSET = 2; // Boson DR id is 2 higher than the seller id
uint256 constant HUNDRED_PERCENT = 100_00;
uint256 constant AUCTION_END_BUFFER = 15 minutes;
uint256 constant MINIMAL_BID_INCREMENT = 10_00; // 10%

// Fractionalization
uint256 constant MIN_FRACTIONS = 1e18;
uint256 constant MAX_FRACTIONS = 1 << 127;
uint256 constant TOP_BID_LOCK_TIME = 3 days;
uint256 constant AUCTION_DURATION = 5 days;
uint256 constant UNLOCK_THRESHOLD = 50_00; // 50%
