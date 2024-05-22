// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import { ERC721 } from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IFermionWrapper } from "../interfaces/IFermionWrapper.sol";
import { SeaportInterface } from "../interfaces/Seaport.sol";

/**
 * @title FermionWrapper
 * @notice Wraps Boson Vouchers so they can be used with Opensea. Possibly with other marketplaces in the future.
 *
 * Features:
 *
 * Out-of-band setup:
 *
 * Usage:
 *
 */
contract FermionWrapper is Ownable, ERC721, IFermionWrapper {
    using SafeERC20 for IERC20;

    mapping(uint256 => TokenState) public tokenState;

    // Contract addresses
    address private voucherAddress;
    address private fermionProtocol;
    address private immutable OS_CONDUIT;
    bytes32 private immutable OS_CONDUIT_KEY;
    address private immutable BP_PRICE_DISCOVERY; // Boson protocol Price Discovery client
    address private immutable SEAPORT;

    /**
     * @notice Constructor
     *
     */
    constructor(
        address _openSeaConduit,
        bytes32 _openSeaConduitKey,
        address _bosonPriceDiscovery,
        address _seaport
    )
        ERC721("Fermion F-NFT", "FMION-NFT") // todo: add make correct names + symbol
        Ownable(msg.sender)
    {
        OS_CONDUIT = _openSeaConduit == address(0) ? _seaport : _openSeaConduit;
        OS_CONDUIT_KEY = _openSeaConduitKey;
        BP_PRICE_DISCOVERY = _bosonPriceDiscovery;
        SEAPORT = _seaport;
    }

    /**
     * @notice Initializes the contract
     *
     * Reverts if:
     * - Contract is already initialized
     *
     * @param _voucherAddress The address of the Boson Voucher contract
     * @param _owner The address of the owner
     */
    function initialize(address _voucherAddress, address _owner) external {
        if (owner() != address(0)) {
            revert AlreadyInitialized();
        }

        fermionProtocol = msg.sender;
        voucherAddress = _voucherAddress;
        _transferOwnership(_owner);
    }

    /**
     * @dev Returns true if this contract implements the interface defined by
     * `interfaceId`. See the corresponding
     * https://eips.ethereum.org/EIPS/eip-165#how-interfaces-are-identified[EIP section]
     * to learn more about how these ids are created.
     */
    function supportsInterface(bytes4 _interfaceId) public view virtual override(ERC721, IERC165) returns (bool) {
        return super.supportsInterface(_interfaceId) || _interfaceId == type(IFermionWrapper).interfaceId;
    }

    /**
     * @notice Wraps the vouchers, transfer true vouchers to this contract and mint wrapped vouchers
     *
     * Reverts if:
     * - Caller does not own the Boson rNFTs
     *
     * @param _firstTokenId The first token id.
     * @param _length The number of tokens to wrap.
     * @param _to The address to mint the wrapped tokens to.
     */
    function wrapForAuction(uint256 _firstTokenId, uint256 _length, address _to) external {
        wrap(_firstTokenId, _length, _to);
    }

    /**
     * @notice Unwraps the voucher, finalizes the auction, transfers the Boson rNFT to Fermion Protocol and F-NFT to the buyer
     *
     * @param _tokenId The token id.
     * @param _buyerOrder The Seaport buyer order.
     */
    function unwrap(uint256 _tokenId, SeaportInterface.AdvancedOrder calldata _buyerOrder) external {
        unwrap(_tokenId);

        // If the seller is the buyer, they skipped the auction. Price is 0, owner is already correct and the OS autcion can be skipped
        (uint256 price, address exchangeToken) = finalizeAuction(_tokenId, _buyerOrder);

        // Transfer token to protocol
        if (price > 0) {
            IERC20(exchangeToken).safeTransfer(BP_PRICE_DISCOVERY, price);
        }
    }

    /**
     * @notice Unwraps the voucher, but skip the OS auction and leave the F-NFT with the seller
     *
     * @param _tokenId The token id.
     */
    function unwrapToSelf(uint256 _tokenId, address _exchangeToken, uint256 _verifierFee) external {
        unwrap(_tokenId);

        if (_verifierFee > 0) {
            IERC20(_exchangeToken).safeTransfer(BP_PRICE_DISCOVERY, _verifierFee);
        }
    }

    /**
     * @notice Puts the F-NFT from wrapped to unverified state and transfers Boson rNFT to fermion protocol
     *
     * @param _tokenId The token id.
     */
    function unwrap(uint256 _tokenId) internal {
        address msgSender = _msgSender();

        if (tokenState[_tokenId] != TokenState.Wrapped || msgSender != BP_PRICE_DISCOVERY) {
            revert TransferNotAllowed(_tokenId, msgSender, tokenState[_tokenId]);
        }

        tokenState[_tokenId] = TokenState.Unverified; // Moving to next state, also enabling the transfer and prevent reentrancy

        // transfer Boson Voucher to Fermion protocol. Not using safeTransferFrom since we are sure Fermion Protocol can handle the voucher
        IERC721(voucherAddress).transferFrom(address(this), fermionProtocol, _tokenId);
    }

    /**
     * @notice Prepares data to finalize the auction using Seaport
     *
     * @param _tokenId The token id.
     * @param _buyerOrder The Seaport buyer order.
     */
    function finalizeAuction(
        uint256 _tokenId,
        SeaportInterface.AdvancedOrder calldata _buyerOrder
    ) internal returns (uint256 price, address exchangeToken) {
        address wrappedVoucherOwner = ownerOf(_tokenId); // tokenId can be taken from buyer order

        // transfer to itself to finalize the auction
        _transfer(wrappedVoucherOwner, address(this), _tokenId);

        uint256 _price = _buyerOrder.parameters.offer[0].startAmount;
        uint256 _openSeaFee = _buyerOrder.parameters.consideration[1].startAmount; // toDo: make check that this is the fee
        uint256 reducedPrice = _price - _openSeaFee;

        price = reducedPrice;
        exchangeToken = _buyerOrder.parameters.offer[0].token;

        // prepare match advanced order. Can this be optimized with some simpler order?
        // caller must supply buyers signed order (_buyerOrder)
        // ToDo: verify that buyerOrder matches the expected format
        SeaportInterface.OfferItem[] memory offer = new SeaportInterface.OfferItem[](1);
        offer[0] = SeaportInterface.OfferItem({
            itemType: SeaportInterface.ItemType.ERC721,
            token: address(this),
            identifierOrCriteria: _tokenId,
            startAmount: 1,
            endAmount: 1
        });

        SeaportInterface.ConsiderationItem[] memory consideration = new SeaportInterface.ConsiderationItem[](2);
        consideration[0] = SeaportInterface.ConsiderationItem({
            itemType: _buyerOrder.parameters.offer[0].itemType,
            token: exchangeToken,
            identifierOrCriteria: 0,
            startAmount: reducedPrice,
            endAmount: reducedPrice,
            recipient: payable(address(this))
        });

        SeaportInterface.AdvancedOrder memory wrapperOrder = SeaportInterface.AdvancedOrder({
            parameters: SeaportInterface.OrderParameters({
                offerer: address(this),
                zone: address(0), // ToDo: is 0 ok, or do we need _buyerOrder.parameters.zone, or sth buyer can't influence
                offer: offer,
                consideration: consideration,
                orderType: SeaportInterface.OrderType.FULL_OPEN,
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

        SeaportInterface.AdvancedOrder[] memory orders = new SeaportInterface.AdvancedOrder[](2);
        orders[0] = _buyerOrder;
        orders[1] = wrapperOrder;

        SeaportInterface.Fulfillment[] memory fulfillments = new SeaportInterface.Fulfillment[](3);

        // NFT from buyer, to NFT from seller
        fulfillments[0] = SeaportInterface.Fulfillment({
            offerComponents: new SeaportInterface.FulfillmentComponent[](1),
            considerationComponents: new SeaportInterface.FulfillmentComponent[](1)
        });
        fulfillments[0].offerComponents[0] = SeaportInterface.FulfillmentComponent({ orderIndex: 1, itemIndex: 0 });
        fulfillments[0].considerationComponents[0] = SeaportInterface.FulfillmentComponent({
            orderIndex: 0,
            itemIndex: 0
        });

        // Payment from buyer to seller
        fulfillments[1] = SeaportInterface.Fulfillment({
            offerComponents: new SeaportInterface.FulfillmentComponent[](1),
            considerationComponents: new SeaportInterface.FulfillmentComponent[](1)
        });
        fulfillments[1].offerComponents[0] = SeaportInterface.FulfillmentComponent({ orderIndex: 0, itemIndex: 0 });
        fulfillments[1].considerationComponents[0] = SeaportInterface.FulfillmentComponent({
            orderIndex: 1,
            itemIndex: 0
        });

        // Payment from buyer to OpenSea
        fulfillments[2] = SeaportInterface.Fulfillment({
            offerComponents: new SeaportInterface.FulfillmentComponent[](1),
            considerationComponents: new SeaportInterface.FulfillmentComponent[](1)
        });
        fulfillments[2].offerComponents[0] = SeaportInterface.FulfillmentComponent({ orderIndex: 0, itemIndex: 0 });
        fulfillments[2].considerationComponents[0] = SeaportInterface.FulfillmentComponent({
            orderIndex: 0,
            itemIndex: 1
        });

        SeaportInterface(SEAPORT).matchAdvancedOrders(
            orders,
            new SeaportInterface.CriteriaResolver[](0),
            fulfillments,
            address(this)
        );
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
     * @notice Wraps the vouchers, transfer true vouchers to this contract and mint wrapped vouchers
     *
     * @param _firstTokenId The first token id.
     * @param _length The number of tokens to wrap.
     * @param _to The address to mint the wrapped tokens to.
     */
    function wrap(uint256 _firstTokenId, uint256 _length, address _to) internal {
        for (uint256 i = 0; i < _length; i++) {
            uint256 tokenId = _firstTokenId + i;

            // Transfer vouchers to this contract
            // Not using safeTransferFrom since this contract is the recipient and we are sure it can handle the vouchers
            IERC721(voucherAddress).transferFrom(msg.sender, address(this), tokenId);

            // Mint to the specified address
            _safeMint(_to, tokenId);
            tokenState[tokenId] = TokenState.Wrapped;
        }
        _setApprovalForAll(address(this), OS_CONDUIT, true);
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
        if (tokenState[_tokenId] == TokenState.Wrapped && _msgSender() != OS_CONDUIT) {
            revert TransferNotAllowed(_tokenId, _msgSender(), TokenState.Wrapped);
        }
        return super._update(_to, _tokenId, _auth);
    }
}
