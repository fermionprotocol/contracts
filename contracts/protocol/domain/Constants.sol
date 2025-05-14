// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;
import { FermionTypes } from "./Types.sol";

// Access Control Roles
bytes32 constant ADMIN = keccak256("ADMIN"); // Role Admin
bytes32 constant PAUSER = keccak256("PAUSER"); // Role for pausing the protocol
bytes32 constant UPGRADER = keccak256("UPGRADER"); // Role for performing contract and config upgrades
bytes32 constant FEE_COLLECTOR = keccak256("FEE_COLLECTOR"); // Role for collecting fees from the protocol

uint256 constant BYTE_SIZE = 8;
uint256 constant SLOT_SIZE = 32;
uint256 constant BOSON_DR_ID_OFFSET = 2; // Boson DR id is 2 higher than the seller id
uint256 constant HUNDRED_PERCENT = 100_00;
uint256 constant AUCTION_END_BUFFER = 15 minutes;
uint256 constant MINIMAL_BID_INCREMENT = 10_00; // 10%

// Fractionalization
uint256 constant MIN_FRACTIONS = 1e18;
uint256 constant MAX_FRACTIONS = 1 << 127;

// buyout exit price governance update
uint256 constant MIN_QUORUM_PERCENT = 20_00; // 20% is the minumum quorum percent for DAO exit price update
uint256 constant MIN_GOV_VOTE_DURATION = 1 days;
uint256 constant MAX_GOV_VOTE_DURATION = 7 days;
uint256 constant DEFAULT_GOV_VOTE_DURATION = 3 days;

// Default parameters
uint256 constant TOP_BID_LOCK_TIME = 3 days;
uint256 constant AUCTION_DURATION = 5 days;
uint256 constant UNLOCK_THRESHOLD = 50_00; // 50%

// Forceful fractionalisation
uint256 constant DEFAULT_FRACTION_AMOUNT = 1e5 * MIN_FRACTIONS;
uint256 constant PARTIAL_THRESHOLD_MULTIPLIER = 12;
uint256 constant LIQUIDATION_THRESHOLD_MULTIPLIER = 2;
uint256 constant PARTIAL_AUCTION_DURATION_DIVISOR = 4;

FermionTypes.EntityRole constant ANY_ENTITY_ROLE = FermionTypes.EntityRole(0);
