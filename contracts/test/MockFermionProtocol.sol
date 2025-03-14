// SPDX-License-Identifier: CC0-1.0
pragma solidity 0.8.24;

import { FermionTypes } from "../protocol/domain/Types.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title MockFermionProtocol
 *
 * @notice A mock proxy contract acts as a Fermion protocol in tests
 *
 */
contract MockFermion {
    address private immutable DESTINATION;
    address private immutable EXCHANGE_TOKEN;
    address private destinationOverride;
    int256 private amountToRelease;
    uint256 private royalties;
    uint256 private royaltyPercentage;
    address private royaltyRecipient;

    mapping(address => bytes32) private approvedOracles;

    constructor(address _destination, address _exchangeToken) {
        DESTINATION = _destination;
        EXCHANGE_TOKEN = _exchangeToken;
    }

    function setupCustodianOfferVault(
        uint256,
        uint256,
        FermionTypes.CustodianVaultParameters calldata,
        uint256
    ) external pure returns (uint256) {
        return 0;
    }

    function addItemToCustodianOfferVault(uint256, uint256, uint256) external pure returns (uint256) {
        return 0;
    }

    function removeItemFromCustodianOfferVault(uint256, uint256) external returns (int256 released) {
        // return funds if set so
        released = amountToRelease;
        if (released > 0) {
            IERC20(EXCHANGE_TOKEN).transfer(DESTINATION, uint256(released));
        }
    }

    function repayDebt(uint256, uint256) external {
        //do nothing
    }

    function setDestinationOverride(address _destination) external {
        destinationOverride = _destination;
    }

    function setAmountToRelease(int256 _amount) external {
        amountToRelease = _amount;
    }

    mapping(uint256 => string) public revisedMetadata;
    function getRevisedMetadata(uint256 _tokenId) external view returns (string memory) {
        return revisedMetadata[_tokenId];
    }

    function setRevisedMetadata(uint256 _tokenId, string memory _metadata) external {
        revisedMetadata[_tokenId] = _metadata;
    }

    function addPriceOracle(address oracleAddress, bytes32 identifier) external {
        require(oracleAddress != address(0), "Invalid oracle address");
        approvedOracles[oracleAddress] = identifier;
    }

    function removePriceOracle(address oracleAddress) external {
        require(approvedOracles[oracleAddress] != bytes32(0), "Oracle not approved");
        delete approvedOracles[oracleAddress];
    }

    function isPriceOracleApproved(address oracleAddress) external view returns (bool) {
        return approvedOracles[oracleAddress] != bytes32(0);
    }

    function getPriceOracleIdentifier(address oracleAddress) external view returns (bytes32) {
        return approvedOracles[oracleAddress];
    }

    function setRoyalties(uint256 _royalties) external {
        royalties = _royalties;
    }

    function collectRoyalties(uint256, uint256 _proceeds) external returns (uint256) {
        IERC20(EXCHANGE_TOKEN).transfer(msg.sender, _proceeds - royalties);
        return royalties;
    }

    function setRoyaltyInfo(uint256 _royaltyPercentage, address _royaltyRecipient) external {
        royaltyPercentage = _royaltyPercentage;
        royaltyRecipient = _royaltyRecipient;
    }

    function getEIP2981Royalties(uint256) external view returns (address, uint256) {
        return (royaltyRecipient, royaltyPercentage);
    }

    /**
     * @notice Gets the current OpenSea fee percentage.
     * @return the OpenSea fee percentage (50 = 0.5%)
     */
    function getOpenSeaFeePercentage() external pure returns (uint16) {
        return 50; // 0.5%
    }

    fallback() external payable {
        address to = destinationOverride == address(0) ? DESTINATION : destinationOverride;
        // Delegate calls to the destination
        (bool success, bytes memory data) = to.call(abi.encodePacked(msg.data, address(this)));

        delete destinationOverride;
    }
}
