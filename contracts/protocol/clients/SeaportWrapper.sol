// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { FermionGeneralErrors, WrapperErrors } from "../domain/Errors.sol";
import { FermionFNFTBase } from "./FermionFNFTBase.sol";
import { HUNDRED_PERCENT } from "../domain/Constants.sol";
import { Common } from "./Common.sol";
import { IFermionConfig } from "../interfaces/IFermionConfig.sol";

import { SeaportInterface } from "seaport-types/src/interfaces/SeaportInterface.sol";
import "seaport-types/src/lib/ConsiderationStructs.sol" as SeaportTypes;
import { FermionTypes } from "../domain/Types.sol";

/**
 * @title SeaportWrapper
 * @notice Methods for wrapping and unwrapping the Boson rNFTs and use them with OpenSea
 *
 * This contract supports two use cases:
 * - Wrapped vouchers owned by the seller can be used in OpenSea auctions (the auction must be created directly on OpenSea).
 * - This contract can be used to create a fixed price sales, where owner is this contract.
 *
 */
contract SeaportWrapper is FermionFNFTBase {
    struct SeaportConfig {
        address seaport;
        address openSeaConduit;
        bytes32 openSeaConduitKey;
        address openSeaSignedZone;
        bytes32 openSeaZoneHash;
        address payable openSeaRecipient;
    }

    struct FixedPriceParams {
        uint16 openSeaFeePercentage;
        SeaportTypes.ItemType itemType;
    }

    address private immutable SEAPORT;

    // OpenSea Conduit
    address private immutable OS_CONDUIT;
    bytes32 private immutable OS_CONDUIT_KEY;
    address private immutable OS_SIGNED_ZONE;
    bytes32 private immutable OS_ZONE_HASH;
    address payable private immutable OS_RECIPIENT;

    /**
     * @notice Constructor
     *
     */
    constructor(
        address _bosonPriceDiscovery,
        address _fermionProtocol,
        SeaportConfig memory _seaportConfig
    ) FermionFNFTBase(_bosonPriceDiscovery, _fermionProtocol) {
        if (_seaportConfig.seaport == address(0)) revert FermionGeneralErrors.InvalidAddress();

        SEAPORT = _seaportConfig.seaport;
        OS_CONDUIT = _seaportConfig.openSeaConduit == address(0)
            ? _seaportConfig.seaport
            : _seaportConfig.openSeaConduit;
        OS_CONDUIT_KEY = _seaportConfig.openSeaConduitKey;
        OS_SIGNED_ZONE = _seaportConfig.openSeaSignedZone;
        OS_ZONE_HASH = _seaportConfig.openSeaZoneHash;
        OS_RECIPIENT = _seaportConfig.openSeaRecipient;
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

        // reduce the price by the royalties
        for (uint256 i = 2; i < _buyerOrder.parameters.consideration.length; i++) {
            reducedPrice -= _buyerOrder.parameters.consideration[i].startAmount;
        }

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

        SeaportTypes.Fulfillment[] memory fulfillments = new SeaportTypes.Fulfillment[](
            _buyerOrder.parameters.consideration.length + 1
        );

        // NFT from seller to buyer
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

        uint256 orderParamsConsiderationLength = _buyerOrder.parameters.consideration.length;
        // Payment from buyer to OpenSea and royalty recipients
        for (uint256 i = 1; i < orderParamsConsiderationLength; ++i) {
            fulfillments[i + 1] = SeaportTypes.Fulfillment({
                offerComponents: new SeaportTypes.FulfillmentComponent[](1),
                considerationComponents: new SeaportTypes.FulfillmentComponent[](1)
            });
            fulfillments[i + 1].offerComponents[0] = SeaportTypes.FulfillmentComponent({ orderIndex: 0, itemIndex: 0 });
            fulfillments[i + 1].considerationComponents[0] = SeaportTypes.FulfillmentComponent({
                orderIndex: 0,
                itemIndex: i
            });
        }

        // transfer to itself to finalize the auction
        _transfer(wrappedVoucherOwner, address(this), _tokenId);

        SeaportInterface(SEAPORT).matchAdvancedOrders(
            orders,
            new SeaportTypes.CriteriaResolver[](0),
            fulfillments,
            address(this)
        );
    }

    /**
     * @notice List fixed price orders on OpenSea. This contract is the owner and creates the openSea order using the validate function on Seaport.
     *
     * N.B. if an order is cancelled, it cannot be listed again with the same price and end time since all other parameters (including the salt) are the same.
     * Changing the price or end time will allow the order to be listed again.
     *
     * @param _firstTokenId The first token id.
     * @param _prices The prices for each token.
     * @param _endTimes The end times for each token.
     * @param _royaltyInfo The royalty info.
     * @param _exchangeToken The token to be used for the exchange.
     */
    function listFixedPriceOrders(
        uint256 _firstTokenId,
        uint256[] calldata _prices,
        uint256[] calldata _endTimes,
        FermionTypes.RoyaltyInfo calldata _royaltyInfo,
        address _exchangeToken
    ) external {
        SeaportTypes.Order[] memory orders = new SeaportTypes.Order[](_prices.length);

        mapping(uint256 => uint256) storage fixedPrice = Common._getFermionCommonStorage().fixedPrice;

        FixedPriceParams memory params = FixedPriceParams({
            openSeaFeePercentage: IFermionConfig(FERMION_PROTOCOL).getOpenSeaFeePercentage(),
            itemType: _exchangeToken == address(0) ? SeaportTypes.ItemType.NATIVE : SeaportTypes.ItemType.ERC20
        });

        for (uint256 i; i < _prices.length; ++i) {
            SeaportTypes.ConsiderationItem[] memory consideration = new SeaportTypes.ConsiderationItem[](
                2 + _royaltyInfo.recipients.length
            );
            uint256 reducedPrice;
            SeaportTypes.OfferItem[] memory offer = new SeaportTypes.OfferItem[](1);

            {
                uint256 tokenId = _firstTokenId + i;
                uint256 tokenPrice = _prices[i];
                if (tokenPrice == 0) revert WrapperErrors.ZeroPriceNotAllowed(); // although it is possible to validate zero price offer, it's impossible to fulfill it

                // Create order
                offer[0] = SeaportTypes.OfferItem({
                    itemType: SeaportTypes.ItemType.ERC721,
                    token: address(this),
                    identifierOrCriteria: tokenId,
                    startAmount: 1,
                    endAmount: 1
                });

                {
                    uint256 openSeaFee = (tokenPrice * params.openSeaFeePercentage) / HUNDRED_PERCENT;
                    reducedPrice = tokenPrice - openSeaFee;

                    consideration[1] = SeaportTypes.ConsiderationItem({
                        itemType: params.itemType,
                        token: _exchangeToken,
                        identifierOrCriteria: 0,
                        startAmount: openSeaFee, // If this is too small, OS won't show the order. This can happen if the price is too low.
                        endAmount: openSeaFee,
                        recipient: OS_RECIPIENT
                    });
                }

                for (uint256 j = 0; j < _royaltyInfo.recipients.length; j++) {
                    uint256 royaltyAmount = (_royaltyInfo.bps[j] * tokenPrice) / HUNDRED_PERCENT;
                    consideration[j + 2] = SeaportTypes.ConsiderationItem({
                        itemType: params.itemType,
                        token: _exchangeToken,
                        identifierOrCriteria: 0,
                        startAmount: royaltyAmount,
                        endAmount: royaltyAmount,
                        recipient: payable(_royaltyInfo.recipients[j])
                    });

                    reducedPrice -= royaltyAmount;
                }
                fixedPrice[tokenId] = reducedPrice;
            }

            consideration[0] = SeaportTypes.ConsiderationItem({
                itemType: params.itemType,
                token: _exchangeToken,
                identifierOrCriteria: 0,
                startAmount: reducedPrice,
                endAmount: reducedPrice,
                recipient: payable(address(this))
            });

            bool transferValidatorDisabled = Common._getFermionCommonStorage().transferValidator == address(0);

            orders[i] = SeaportTypes.Order({
                parameters: SeaportTypes.OrderParameters({
                    offerer: address(this),
                    zone: transferValidatorDisabled ? address(0) : OS_SIGNED_ZONE,
                    offer: offer,
                    consideration: consideration,
                    orderType: (transferValidatorDisabled || OS_SIGNED_ZONE == address(0))
                        ? SeaportTypes.OrderType.FULL_OPEN
                        : SeaportTypes.OrderType.FULL_RESTRICTED,
                    startTime: block.timestamp - 1 minutes,
                    endTime: _endTimes[i],
                    zoneHash: transferValidatorDisabled ? bytes32(0) : OS_ZONE_HASH,
                    salt: 0,
                    conduitKey: OS_CONDUIT_KEY,
                    totalOriginalConsiderationItems: 2 + _royaltyInfo.recipients.length
                }),
                signature: ""
            });
        }

        if (!SeaportInterface(SEAPORT).validate(orders)) revert WrapperErrors.UnsuccessfulExternalCall();
    }

    /**
     * @notice Cancel fixed price orders on OpenSea.
     *
     * Reverts if:
     * - The token id does not exist.
     * - The contract is not the owner of the token.
     *
     * @param _orders The orders to cancel.
     */
    function cancelFixedPriceOrders(SeaportTypes.OrderComponents[] calldata _orders) external {
        mapping(uint256 => uint256) storage fixedPrice = Common._getFermionCommonStorage().fixedPrice;
        for (uint256 i; i < _orders.length; ++i) {
            uint256 tokenId = _orders[i].offer[0].identifierOrCriteria;

            if (ownerOf(tokenId) != address(this))
                revert WrapperErrors.InvalidOwner(tokenId, address(this), ownerOf(tokenId));

            fixedPrice[tokenId] = 0;
        }

        if (!SeaportInterface(SEAPORT).cancel(_orders)) revert WrapperErrors.UnsuccessfulExternalCall();
    }
}
