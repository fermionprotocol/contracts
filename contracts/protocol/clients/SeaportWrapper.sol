// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { FermionTypes } from "../domain/Types.sol";
import { FermionGeneralErrors } from "../domain/Errors.sol";
import { Common } from "./Common.sol";
import { FermionFNFTBase } from "./FermionFNFTBase.sol";

import { SeaportInterface } from "seaport-types/src/interfaces/SeaportInterface.sol";
import "seaport-types/src/lib/ConsiderationStructs.sol" as SeaportTypes;

import { ContextUpgradeable as Context } from "@openzeppelin/contracts-upgradeable/utils/ContextUpgradeable.sol";
import { ERC2771ContextUpgradeable as ERC2771Context } from "@openzeppelin/contracts-upgradeable/metatx/ERC2771ContextUpgradeable.sol";

/**
 * @title SeaportWrapper
 * @notice Methods for wrapping and unwrapping the Boson rNFTs and use them with openSea
 *
 * Wrapped vouchers can be used in auctions.
 * Fixed price sales are not supported yet.
 *
 */
contract SeaportWrapper is FermionFNFTBase, ERC2771Context {
    struct SeaportConfig {
        address seaport;
        address openSeaConduit;
        bytes32 openSeaConduitKey;
    }

    address private immutable SEAPORT;

    // OpenSea Conduit
    address private immutable OS_CONDUIT;
    bytes32 private immutable OS_CONDUIT_KEY;

    /**
     * @notice Constructor
     *
     * @dev construct ERC2771Context with address 0 and override `trustedForwarder` to return the fermionProtocol address
     */
    constructor(
        address _bosonPriceDiscovery,
        SeaportConfig memory _seaportConfig
    ) FermionFNFTBase(_bosonPriceDiscovery) ERC2771Context(address(0)) {
        if (_seaportConfig.seaport == address(0)) revert FermionGeneralErrors.InvalidAddress();

        SEAPORT = _seaportConfig.seaport;
        OS_CONDUIT = _seaportConfig.openSeaConduit == address(0)
            ? _seaportConfig.seaport
            : _seaportConfig.openSeaConduit;
        OS_CONDUIT_KEY = _seaportConfig.openSeaConduitKey;
    }

    function wrapOpenSea() external {
        _setApprovalForAll(address(this), OS_CONDUIT, true);
    }

    /**
     * @notice Prepares data to finalize the auction using Seaport
     *
     * It ASSUMES that the buyer order matches the buyer order from OpenSea. If this changes, the contract must be updated.
     * Buyer order parameters are validate in the Fermion Protocol before calling this function.
     *
     * @param _tokenId The token id.
     * @param _buyerOrder The Seaport buyer order.
     */
    function finalizeOpenSeaAuction(uint256 _tokenId, SeaportTypes.AdvancedOrder calldata _buyerOrder) external {
        address wrappedVoucherOwner = _ownerOf(_tokenId); // tokenId can be taken from buyer order

        uint256 _price = _buyerOrder.parameters.offer[0].startAmount;
        uint256 _openSeaFee = _buyerOrder.parameters.consideration[1].startAmount;
        uint256 reducedPrice = _price - _openSeaFee;

        address exchangeToken = _buyerOrder.parameters.offer[0].token;

        // prepare match advanced order. Can this be optimized with some simpler order?
        // caller must supply buyers signed order (_buyerOrder)
        SeaportTypes.OfferItem[] memory offer = new SeaportTypes.OfferItem[](1);
        offer[0] = SeaportTypes.OfferItem({
            itemType: SeaportTypes.ItemType.ERC721,
            token: address(this),
            identifierOrCriteria: _tokenId,
            startAmount: 1,
            endAmount: 1
        });

        SeaportTypes.ConsiderationItem[] memory consideration = new SeaportTypes.ConsiderationItem[](2);
        consideration[0] = SeaportTypes.ConsiderationItem({
            itemType: _buyerOrder.parameters.offer[0].itemType,
            token: exchangeToken,
            identifierOrCriteria: 0,
            startAmount: reducedPrice,
            endAmount: reducedPrice,
            recipient: payable(BP_PRICE_DISCOVERY)
        });

        SeaportTypes.AdvancedOrder memory wrapperOrder = SeaportTypes.AdvancedOrder({
            parameters: SeaportTypes.OrderParameters({
                offerer: address(this),
                zone: address(0),
                offer: offer,
                consideration: consideration,
                orderType: SeaportTypes.OrderType.FULL_OPEN,
                startTime: _buyerOrder.parameters.startTime,
                endTime: _buyerOrder.parameters.endTime,
                zoneHash: bytes32(0),
                salt: 0,
                conduitKey: OS_CONDUIT_KEY,
                totalOriginalConsiderationItems: 1
            }),
            numerator: 1,
            denominator: 1,
            signature: "",
            extraData: ""
        });

        SeaportTypes.AdvancedOrder[] memory orders = new SeaportTypes.AdvancedOrder[](2);
        orders[0] = _buyerOrder;
        orders[1] = wrapperOrder;

        SeaportTypes.Fulfillment[] memory fulfillments = new SeaportTypes.Fulfillment[](3);

        // NFT from buyer, to NFT from seller
        fulfillments[0] = SeaportTypes.Fulfillment({
            offerComponents: new SeaportTypes.FulfillmentComponent[](1),
            considerationComponents: new SeaportTypes.FulfillmentComponent[](1)
        });
        fulfillments[0].offerComponents[0] = SeaportTypes.FulfillmentComponent({ orderIndex: 1, itemIndex: 0 });
        fulfillments[0].considerationComponents[0] = SeaportTypes.FulfillmentComponent({ orderIndex: 0, itemIndex: 0 });

        // Payment from buyer to seller
        fulfillments[1] = SeaportTypes.Fulfillment({
            offerComponents: new SeaportTypes.FulfillmentComponent[](1),
            considerationComponents: new SeaportTypes.FulfillmentComponent[](1)
        });
        fulfillments[1].offerComponents[0] = SeaportTypes.FulfillmentComponent({ orderIndex: 0, itemIndex: 0 });
        fulfillments[1].considerationComponents[0] = SeaportTypes.FulfillmentComponent({ orderIndex: 1, itemIndex: 0 });

        // Payment from buyer to OpenSea
        fulfillments[2] = SeaportTypes.Fulfillment({
            offerComponents: new SeaportTypes.FulfillmentComponent[](1),
            considerationComponents: new SeaportTypes.FulfillmentComponent[](1)
        });
        fulfillments[2].offerComponents[0] = SeaportTypes.FulfillmentComponent({ orderIndex: 0, itemIndex: 0 });
        fulfillments[2].considerationComponents[0] = SeaportTypes.FulfillmentComponent({ orderIndex: 0, itemIndex: 1 });

        // transfer to itself to finalize the auction
        _transfer(wrappedVoucherOwner, address(this), _tokenId);

        SeaportInterface(SEAPORT).matchAdvancedOrders(
            orders,
            new SeaportTypes.CriteriaResolver[](0),
            fulfillments,
            address(this)
        );
    }

    ///////// overrides ///////////
    function trustedForwarder() public view virtual override returns (address) {
        return fermionProtocol;
    }

    function _msgSender() internal view virtual override(Context, ERC2771Context) returns (address) {
        return ERC2771Context._msgSender();
    }

    function _msgData() internal view virtual override(Context, ERC2771Context) returns (bytes calldata) {
        return ERC2771Context._msgData();
    }

    function _contextSuffixLength() internal view virtual override(Context, ERC2771Context) returns (uint256) {
        return ERC2771Context._contextSuffixLength();
    }
}
