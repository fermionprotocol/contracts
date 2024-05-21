// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { BOSON_DR_ID_OFFSET } from "../domain/Constants.sol";
import { FermionErrors } from "../domain/Errors.sol";
import { FermionTypes } from "../domain/Types.sol";
import { FermionStorage } from "../libs/Storage.sol";
import { EntityLib } from "../libs/EntityLib.sol";
import { FundsLib } from "../libs/Funds.sol";
import { Context } from "../libs/Context.sol";
import { IBosonProtocol, IBosonVoucher } from "../interfaces/IBosonProtocol.sol";
import { IOfferEvents } from "../interfaces/events/IOfferEvents.sol";
import { SeaportInterface } from "../interfaces/Seaport.sol";

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";

import { IFermionWrapper } from "../interfaces/IFermionWrapper.sol";

/**
 * @title OfferFacet
 *
 * @notice Handles offer listing.
 */
contract OfferFacet is Context, FermionErrors, IOfferEvents {
    using SafeERC20 for IERC20;

    IBosonProtocol private immutable BOSON_PROTOCOL;

    constructor(address _bosonProtocol) {
        BOSON_PROTOCOL = IBosonProtocol(_bosonProtocol);
    }

    /**
     * @notice Create an offer
     *
     * Emits an OfferCreated event
     *
     * Reverts if:
     * - Caller is not the seller's assistant
     * - Invalid verifier or custodian ID is provided
     *
     * @param _offer Offer to list
     */
    function createOffer(FermionTypes.Offer calldata _offer) external {
        // Caller must be the seller's assistant
        EntityLib.validateWalletRole(
            _offer.sellerId,
            msgSender(),
            FermionTypes.EntityRole.Seller,
            FermionTypes.WalletRole.Assistant
        );

        // Validate verifier and custodian IDs
        FermionStorage.ProtocolEntities storage pe = FermionStorage.protocolEntities();
        EntityLib.validateEntityRole(
            _offer.verifierId,
            pe.entityData[_offer.verifierId].roles,
            FermionTypes.EntityRole.Verifier
        );
        EntityLib.validateEntityRole(
            _offer.custodianId,
            pe.entityData[_offer.custodianId].roles,
            FermionTypes.EntityRole.Custodian
        );

        // Create offer in Boson
        uint256 bosonSellerId = FermionStorage.protocolStatus().bosonSellerId;
        IBosonProtocol.Offer memory bosonOffer;
        bosonOffer.sellerId = bosonSellerId;
        // bosonOffer.price = _offer.verifierFee; // Boson currently requires price to be 0; this will be enabled with 2.4.2 release
        bosonOffer.sellerDeposit = _offer.sellerDeposit;
        // bosonOffer.buyerCancelPenalty = _offer.verifierFee; // Boson currently requires buyerCancelPenalty to be 0; this will be enabled with 2.4.2 release
        bosonOffer.quantityAvailable = type(uint256).max; // unlimited offer
        bosonOffer.exchangeToken = _offer.exchangeToken;
        bosonOffer.priceType = IBosonProtocol.PriceType.Discovery;
        bosonOffer.metadataUri = _offer.metadataURI;
        bosonOffer.metadataHash = _offer.metadataHash;
        bosonOffer.royaltyInfo = new IBosonProtocol.RoyaltyInfo[](1);
        // bosonOffer.voided and bosonOffer.collectionIndex are not set, the defaults are fine

        IBosonProtocol.OfferDates memory bosonOfferDates;
        bosonOfferDates.validUntil = type(uint256).max; // unlimited offer. Sellers can limit it when they list preminted vouchers on external marketplaces
        // bosonOfferDates.validFrom, bosonOfferDates.voucherRedeemableFrom, bosonOfferDates.voucherRedeemableUntil are not set, the defaults are fine

        IBosonProtocol.OfferDurations memory bosonOfferDurations;
        bosonOfferDurations.disputePeriod = type(uint256).max; // TBD: how to limit the time verifier has to respond
        bosonOfferDurations.voucherValid = 1; // It could be 0, since in fermion offers, commit and redeem happen atomically, but Boson does not allow it
        bosonOfferDurations.resolutionPeriod = 7 days; // Not needed for fermion, but Boson requires it

        uint256 bosonOfferId = BOSON_PROTOCOL.getNextOfferId();

        BOSON_PROTOCOL.createOffer(
            bosonOffer,
            bosonOfferDates,
            bosonOfferDurations,
            bosonSellerId + BOSON_DR_ID_OFFSET,
            0, // no agent
            type(uint256).max // no fee limit
        );

        // Store fermion offer properties
        FermionStorage.protocolEntities().offer[bosonOfferId] = _offer;

        emit OfferCreated(_offer.sellerId, _offer.verifierId, _offer.custodianId, _offer, bosonOfferId);
    }

    /**
     * @notice Mint and wrap NFTs
     *
     * Reserves range in Boson protocol, premints Boson rNFT, creates wrapper and wrap NFTs
     *
     * Emits an NFTsMinted and NFTsWrapped event
     *
     * Reverts if:
     * - Caller is not the seller's assistant
     * - Not enough funds are sent to cover the seller deposit
     * - Deposit is in ERC20 and the caller sends native currency
     * - ERC20 token transfer fails
     *
     * @param _offerId - the offer ID
     * @param _quantity - the number of NFTs to mint
     */
    function mintAndWrapNFTs(uint256 _offerId, uint256 _quantity) external payable {
        (IBosonVoucher bosonVoucher, uint256 startingNFTId) = mintNFTs(_offerId, _quantity);
        wrapNFTS(_offerId, bosonVoucher, startingNFTId, _quantity, FermionStorage.protocolStatus());
    }

    /**
     * @notice Unwraps NFT, but skips the auction and keeps the F-NFT with the seller
     *
     * Price is 0, so the caller must provide the verification fee in the exchange token
     *
     * N.B. currently, the F-NFT owner will be the assistant that wrapped it, not the caller of this function
     * This behavior can be changed in the future
     *
     * @param _tokenId - the token ID
     */
    function unwrapNFTToSelf(uint256 _tokenId) external payable {
        SeaportInterface.AdvancedOrder memory _emptyOrder;
        unwrapNFT(_tokenId, _emptyOrder, true);
    }

    /**
     * @notice Unwraps F-NFT, uses seaport to sell the NFT
     *
     * @param _tokenId - the token ID
     * @param _buyerOrder - the Seaport buyer order
     */
    function unwrapNFT(uint256 _tokenId, SeaportInterface.AdvancedOrder calldata _buyerOrder) external {
        unwrapNFT(_tokenId, _buyerOrder, false);
    }

    /**
     * @notice Unwraps F-NFT, uses seaport to sell the NFT
     *
     * Emits VerificationInitiated event
     *
     * Reverts if:
     * - Caller is not the seller's assistant
     * - It is self sale and the caller does not provide the verification fee
     * - It is a normal sale and the price is not high enough to cover the verification fee
     *
     * @param _tokenId - the token ID
     * @param _buyerOrder - the Seaport buyer order (if not self sale)
     * @param _selfSale - if true, the NFT is unwrapped to the seller
     */
    function unwrapNFT(uint256 _tokenId, SeaportInterface.AdvancedOrder memory _buyerOrder, bool _selfSale) internal {
        uint256 offerId = _tokenId >> 128;
        FermionTypes.Offer storage offer = FermionStorage.protocolEntities().offer[offerId];
        address msgSender = msgSender();

        // Check the caller is the the seller's assistant
        EntityLib.validateWalletRole(
            offer.sellerId,
            msgSender,
            FermionTypes.EntityRole.Seller,
            FermionTypes.WalletRole.Assistant
        );
        address wrapperAddress = FermionStorage.protocolLookups().wrapperAddress[offerId];

        IBosonProtocol.PriceDiscovery memory _priceDiscovery;
        _priceDiscovery.side = IBosonProtocol.Side.Wrapper;
        _priceDiscovery.priceDiscoveryContract = wrapperAddress;
        _priceDiscovery.conduit = wrapperAddress;
        if (_selfSale) {
            address exchangeToken = offer.exchangeToken;
            uint256 verifierFee = offer.verifierFee;
            FundsLib.validateIncomingPayment(exchangeToken, verifierFee);
            IERC20(exchangeToken).safeTransferFrom(address(this), wrapperAddress, verifierFee);

            _priceDiscovery.price = verifierFee;
            _priceDiscovery.priceDiscoveryData = abi.encodeCall(
                IFermionWrapper.unwrapToSelf,
                (_tokenId, exchangeToken, verifierFee)
            );
        } else {
            _priceDiscovery.price =
                _buyerOrder.parameters.offer[0].startAmount -
                _buyerOrder.parameters.consideration[1].startAmount;
            if (_priceDiscovery.price < offer.verifierFee) {
                revert PriceTooLow(_priceDiscovery.price, offer.verifierFee); // ToDo: it does not take BP fee into account
            }
            _priceDiscovery.priceDiscoveryData = abi.encodeCall(IFermionWrapper.unwrap, (_tokenId, _buyerOrder));
        }

        BOSON_PROTOCOL.commitToPriceDiscoveryOffer(payable(address(this)), _tokenId, _priceDiscovery);

        emit VerificationInitiated(offerId, offer.verifierId, _tokenId);
    }

    /**
     * @notice Add a supported token to the Boson dispute resolver. This is necessary for a succesful offer creation.
     *
     * Not restricted with onlyAdmin. The purpose of this method is to allow the seller to add supported tokens in boson if they
     * want to use them in their offers and not already added by the protocol.
     *
     * @param _tokenAddress Token address
     */
    function addSupportedToken(address _tokenAddress) external {
        IBosonProtocol.DisputeResolverFee[] memory disputeResolverFees = new IBosonProtocol.DisputeResolverFee[](1);
        disputeResolverFees[0] = IBosonProtocol.DisputeResolverFee({
            tokenAddress: _tokenAddress,
            tokenName: "",
            feeAmount: 0
        });

        uint256 bosonDisputeResolverId = FermionStorage.protocolStatus().bosonSellerId + BOSON_DR_ID_OFFSET;
        BOSON_PROTOCOL.addFeesToDisputeResolver(bosonDisputeResolverId, disputeResolverFees);
    }

    /**
     * @notice Get an offer by ID
     *
     * @param _offerId Offer ID
     *
     * @return offer Offer details
     */
    function getOffer(uint256 _offerId) external view returns (FermionTypes.Offer memory offer) {
        return FermionStorage.protocolEntities().offer[_offerId];
    }

    /**
     * @notice Predict the address of the wrapper contract
     *
     * @dev This is primarily used for testing purposes. Might be removed in the future.
     *
     * @param _startingNFTId - the starting NFT ID
     *
     * @return address - the predicted address
     */
    function predictFermionWrapperAddress(uint256 _startingNFTId) external view returns (address) {
        return
            Clones.predictDeterministicAddress(
                FermionStorage.protocolStatus().wrapperBeaconProxy,
                bytes32(_startingNFTId)
            );
    }

    /**
     * @notice Mint NFTs
     *
     * Reserves range in Boson protocol, premints Boson rNFT, creates wrapper and wrap NFTs
     *
     * Emits an NFTsMinted event
     *
     * Reverts if:
     * - Caller is not the seller's assistant
     * - Not enough funds are sent to cover the seller deposit
     * - Deposit is in ERC20 and the caller sends native currency
     * - ERC20 token transfer fails
     *
     * @param _offerId - the offer ID
     * @param _quantity - the number of NFTs to mint
     */
    function mintNFTs(
        uint256 _offerId,
        uint256 _quantity
    ) internal returns (IBosonVoucher bosonVoucher, uint256 startingNFTId) {
        if (_quantity == 0) {
            revert InvalidQuantity(_quantity);
        }
        FermionStorage.ProtocolStatus storage ps = FermionStorage.protocolStatus();
        FermionTypes.Offer storage offer = FermionStorage.protocolEntities().offer[_offerId];
        address msgSender = msgSender();

        // Check the caller is the the seller's assistant
        EntityLib.validateWalletRole(
            offer.sellerId,
            msgSender,
            FermionTypes.EntityRole.Seller,
            FermionTypes.WalletRole.Assistant
        );

        // Validate that the seller deposit is provided
        uint256 sellerDeposit = offer.sellerDeposit;
        if (sellerDeposit > 0) {
            uint256 totalDeposit = sellerDeposit * _quantity;

            // Transfer the deposit to the protocol.
            address exchangeToken = offer.exchangeToken;
            FundsLib.validateIncomingPayment(exchangeToken, totalDeposit);
            // Deposit to the boson protocol
            if (exchangeToken != address(0)) {
                IERC20(exchangeToken).forceApprove(address(BOSON_PROTOCOL), totalDeposit);
            }
            uint256 bosonSellerId = ps.bosonSellerId;
            BOSON_PROTOCOL.depositFunds{ value: msg.value }(bosonSellerId, exchangeToken, totalDeposit);
        }

        uint256 nextExchangeId = BOSON_PROTOCOL.getNextExchangeId();
        startingNFTId = nextExchangeId | (_offerId << 128);

        // Reserve range in Boson
        BOSON_PROTOCOL.reserveRange(_offerId, _quantity, address(this)); // The recipient is this contract, so the NFTs can be wrapped later on

        // Premint NFTs on boson voucher
        bosonVoucher = IBosonVoucher(ps.bosonNftCollection);
        bosonVoucher.preMint(_offerId, _quantity);

        // emit event
        emit NFTsMinted(_offerId, startingNFTId, _quantity);
    }

    /**
     * @notice Wrap Boson rNFTs
     *
     * Creates wrapper and wrap NFTs
     *
     * Emits an NFTsWrapped event
     *
     * @param _offerId - the offer ID
     * @param _bosonVoucher - the Boson rNFT voucher contract
     * @param _startingNFTId - the starting NFT ID
     * @param _quantity - the number of NFTs to wrap
     * @param ps - the protocol status storage pointer
     */
    function wrapNFTS(
        uint256 _offerId,
        IBosonVoucher _bosonVoucher,
        uint256 _startingNFTId,
        uint256 _quantity,
        FermionStorage.ProtocolStatus storage ps
    ) internal {
        address msgSender = msgSender();

        // create wrapper
        // opt1: minimal clone
        address wrapperAddress = Clones.cloneDeterministic(ps.wrapperBeaconProxy, bytes32(_startingNFTId)); // ToDo: investigate the salt options

        // opt2: beacon proxy <= alternative approach. Keep for now, estimate gas after more functions are implemented
        // deployment: ~80k more per deployment. But the next calls should be cheaper.
        // address wrapperAddress = address(new BeaconProxy{salt: bytes32(_startingNFTId)}(ps.wrapperBeacon, ""));

        FermionStorage.protocolLookups().wrapperAddress[_offerId] = wrapperAddress;
        IFermionWrapper(wrapperAddress).initialize(address(_bosonVoucher), msgSender);

        // wrap NFTs
        _bosonVoucher.setApprovalForAll(wrapperAddress, true);
        IFermionWrapper(wrapperAddress).wrapForAuction(_startingNFTId, _quantity, msgSender);
        _bosonVoucher.setApprovalForAll(wrapperAddress, false);

        emit NFTsWrapped(_offerId, wrapperAddress, _startingNFTId, _quantity);
    }
}
