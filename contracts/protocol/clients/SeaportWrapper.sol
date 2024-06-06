// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { Common, TokenState, InvalidStateOrCaller } from "./Common.sol";
import { FermionFNFTBase } from "./FermionFNFTBase.sol";
import { IFermionWrapper } from "../interfaces/IFermionWrapper.sol";

import { OwnableUpgradeable as Ownable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

import { SeaportInterface } from "seaport-types/src/interfaces/SeaportInterface.sol";
import "seaport-types/src/lib/ConsiderationStructs.sol" as SeaportTypes;

/**
 * @title SeaportWrapper
 * @notice Methods for wrapping and unwrapping the Boson rNFTs and use them with openSea
 *
 * Wrapped vouchers can be used in auctions.
 * Fixed price sales are not supported yet.
 *
 */
contract SeaportWrapper is Ownable, FermionFNFTBase {
    struct SeaportConfig {
        address seaport;
        address openSeaConduit;
        bytes32 openSeaConduitKey;
    }

    address private immutable SEAPORT;

    // OpenSea Conduit
    address private immutable OS_CONDUIT;
    bytes32 private immutable OS_CONDUIT_KEY;

    address private immutable THIS_CONTRACT = address(this);

    /**
     * @notice Constructor
     *
     */
    constructor(
        address _bosonPriceDiscovery,
        SeaportConfig memory _seaportConfig
    ) FermionFNFTBase(_bosonPriceDiscovery) {
        SEAPORT = _seaportConfig.seaport;
        OS_CONDUIT = _seaportConfig.openSeaConduit == address(0)
            ? _seaportConfig.seaport
            : _seaportConfig.openSeaConduit;
        OS_CONDUIT_KEY = _seaportConfig.openSeaConduitKey;
    }

    /**
     * @notice Initializes the contract
     *
     * Reverts if:
     * - Contract is already initialized
     *
     * @param _owner The address of the owner
     */
    function initialize(address _owner) internal virtual {
        if (address(this) == THIS_CONTRACT) {
            revert InvalidInitialization();
        }
        __Ownable_init(_owner);
    }

    function wrapOpenSea() internal {
        _setApprovalForAll(address(this), OS_CONDUIT, true);
    }

    /**
     * @notice Prepares data to finalize the auction using Seaport
     *
     * @param _tokenId The token id.
     * @param _buyerOrder The Seaport buyer order.
     */
    function finalizeOpenSeaAuction(
        uint256 _tokenId,
        SeaportTypes.AdvancedOrder calldata _buyerOrder
    ) internal returns (uint256 reducedPrice, address exchangeToken) {
        address wrappedVoucherOwner = _ownerOf(_tokenId); // tokenId can be taken from buyer order

        uint256 _price = _buyerOrder.parameters.offer[0].startAmount;
        uint256 _openSeaFee = _buyerOrder.parameters.consideration[1].startAmount; // toDo: make check that this is the fee
        reducedPrice = _price - _openSeaFee;

        exchangeToken = _buyerOrder.parameters.offer[0].token;

        // prepare match advanced order. Can this be optimized with some simpler order?
        // caller must supply buyers signed order (_buyerOrder)
        // ToDo: verify that buyerOrder matches the expected format
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
            recipient: payable(BP_PRICE_DISCOVERY) // can this be BP_PRICE_DISCOVERY? (reduce one transfer)
        });

        SeaportTypes.AdvancedOrder memory wrapperOrder = SeaportTypes.AdvancedOrder({
            parameters: SeaportTypes.OrderParameters({
                offerer: address(this),
                zone: address(0), // ToDo: is 0 ok, or do we need _buyerOrder.parameters.zone, or sth buyer can't influence
                offer: offer,
                consideration: consideration,
                orderType: SeaportTypes.OrderType.FULL_OPEN,
                startTime: _buyerOrder.parameters.startTime,
                endTime: _buyerOrder.parameters.endTime,
                zoneHash: bytes32(0), // ToDo: is 0 ok, or do we need, or do we need _buyerOrder.parameters.zoneHash, or sth buyer can't influence
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

        reducedPrice = 0; // it was already transferred to BP_PRICE_DISCOVERY, no need for wrapper to do it again is transferred to BP_PRICE_DISCOVERY
    }

    /**
     * @notice Transfers the contract ownership to a new owner
     *
     * Reverts if:
     * - Caller is not the Fermion Protocol
     *
     * N.B. transferring ownership to 0 are allowed, since they can still be change via Fermion Protocol
     *
     * @param _newOwner The address of the new owner
     */
    function transferOwnership(address _newOwner) public override {
        if (fermionProtocol != _msgSender()) {
            revert OwnableUnauthorizedAccount(_msgSender());
        }
        _transferOwnership(_newOwner);
    }

    /**
     * @notice Wrapped vouchers cannot be transferred. To transfer them, invoke a function that unwraps them first.
     *
     *
     * @param _to The address to transfer the wrapped tokens to.
     * @param _tokenId The token id.
     * @param _auth The address that is allowed to transfer the token.
     */
    function _update(address _to, uint256 _tokenId, address _auth) internal override returns (address) {
        TokenState state = Common._getFermionCommonStorage().tokenState[_tokenId];
        if (state == TokenState.Wrapped && _msgSender() != OS_CONDUIT) {
            revert InvalidStateOrCaller(_tokenId, _msgSender(), TokenState.Wrapped);
        }
        return super._update(_to, _tokenId, _auth);
    }
}
