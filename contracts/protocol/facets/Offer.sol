// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { BOSON_DR_ID_OFFSET, HUNDRED_PERCENT, OS_FEE_PERCENTAGE } from "../domain/Constants.sol";
import { OfferErrors, EntityErrors, FundsErrors, FermionGeneralErrors, VerificationErrors } from "../domain/Errors.sol";
import { FermionTypes } from "../domain/Types.sol";
import { Access } from "../libs/Access.sol";
import { FermionStorage } from "../libs/Storage.sol";
import { EntityLib } from "../libs/EntityLib.sol";
import { FundsLib } from "../libs/FundsLib.sol";
import { Context } from "../libs/Context.sol";
import { IBosonProtocol, IBosonVoucher } from "../interfaces/IBosonProtocol.sol";
import { IOfferEvents } from "../interfaces/events/IOfferEvents.sol";
import { IVerificationEvents } from "../interfaces/events/IVerificationEvents.sol";

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";
import "seaport-types/src/lib/ConsiderationStructs.sol" as SeaportTypes;

import { IFermionWrapper } from "../interfaces/IFermionWrapper.sol";
import { FermionFNFTLib } from "../libs/FermionFNFTLib.sol";

/**
 * @title OfferFacet
 *
 * @notice Handles offer listing.
 */
contract OfferFacet is Context, OfferErrors, Access, IOfferEvents {
    using SafeERC20 for IERC20;
    using FermionFNFTLib for address;

    enum WrapType {
        SELF_SALE,
        OS_AUCTION,
        OS_FIXED_PRICE
    }

    IBosonProtocol private immutable BOSON_PROTOCOL;
    address private immutable BOSON_TOKEN;

    constructor(address _bosonProtocol) {
        if (_bosonProtocol == address(0)) revert FermionGeneralErrors.InvalidAddress();

        BOSON_PROTOCOL = IBosonProtocol(_bosonProtocol);
        BOSON_TOKEN = IBosonProtocol(_bosonProtocol).getTokenAddress();
    }

    /**
     * @notice Create an offer
     *
     * Emits an OfferCreated event
     *
     * Reverts if:
     * - Offer region is paused
     * - Caller is not the seller's assistant or facilitator
     * - Invalid verifier or custodian ID is provided
     *
     * @param _offer Offer to list
     */
    function createOffer(
        FermionTypes.Offer calldata _offer
    ) external notPaused(FermionTypes.PausableRegion.Offer) nonReentrant {
        if (
            _offer.sellerId != _offer.facilitatorId &&
            !FermionStorage.protocolLookups().sellerLookups[_offer.sellerId].isSellersFacilitator[_offer.facilitatorId]
        ) {
            revert EntityErrors.NotSellersFacilitator(_offer.sellerId, _offer.facilitatorId);
        }
        EntityLib.validateSellerAssistantOrFacilitator(_offer.sellerId, _offer.facilitatorId);

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

        // Fermion offer parameter validation
        if (_offer.facilitatorFeePercent > HUNDRED_PERCENT) {
            revert FermionGeneralErrors.InvalidPercentage(_offer.facilitatorFeePercent);
        }

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
        pe.offer[bosonOfferId] = _offer;

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
     * - Offer region is paused
     * - Caller is not the seller's assistant or facilitator
     *
     * @param _offerId - the offer ID
     * @param _quantity - the number of NFTs to mint
     */
    function mintAndWrapNFTs(
        uint256 _offerId,
        uint256 _quantity
    ) external notPaused(FermionTypes.PausableRegion.Offer) nonReentrant {
        (IBosonVoucher bosonVoucher, uint256 startingNFTId) = mintNFTs(_offerId, _quantity);
        wrapNFTS(
            _offerId,
            bosonVoucher,
            startingNFTId,
            _quantity,
            WrapType.OS_AUCTION,
            FermionStorage.protocolStatus()
        );
    }

    /**
     * @notice Mint and wrap NFTs and makes a fixed price offer on seaport
     *
     * Emits an NFTsMinted and NFTsWrapped event
     *
     * Reverts if:
     * - Offer region is paused
     * - Caller is not the seller's assistant or facilitator
     *
     * @param _offerId - the offer ID
     * @param _prices The prices for each token.
     * @param _endTimes The end times for each token.
     */
    function mintWrapAndListNFTs(
        uint256 _offerId,
        uint256[] calldata _prices,
        uint256[] calldata _endTimes
    ) external notPaused(FermionTypes.PausableRegion.Offer) nonReentrant {
        if (_prices.length != _endTimes.length)
            revert FermionGeneralErrors.ArrayLengthMismatch(_prices.length, _endTimes.length);

        uint256 quantity = _prices.length;
        (IBosonVoucher bosonVoucher, uint256 startingNFTId) = mintNFTs(_offerId, quantity);
        (address wrapperAddress, address exchangeToken) = wrapNFTS(
            _offerId,
            bosonVoucher,
            startingNFTId,
            quantity,
            WrapType.OS_FIXED_PRICE,
            FermionStorage.protocolStatus()
        );

        wrapperAddress.listFixedPriceOffer(startingNFTId, _prices, _endTimes, exchangeToken);
    }

    /**
     * @notice Unwraps F-NFT, uses seaport to sell the NFT
     * Reverts if:
     * - Offer region is paused
     * - Caller is not the seller's assistant or facilitator
     * - If seller deposit is non zero and there are not enough funds to cover it
     * - The price is not high enough to cover the verification fee
     *
     * @param _tokenId - the token ID
     * @param _wrapType - the wrap type
     * @param _data - additional data, depending on the wrap type
     */
    function unwrapNFT(uint256 _tokenId, WrapType _wrapType, bytes calldata _data) external payable {
        unwrapNFT(_tokenId, _wrapType, _data, 0);
    }

    /**
     * @notice Same as unwrapNFT, but also sets the verification timeout
     *
     * @param _tokenId - the token ID
     * @param _wrapType - the wrap type
     * @param _data - additional data, depending on the wrap type
     * @param _verificationTimeout - the verification timeout in UNIX timestamp
     */
    function unwrapNFTAndSetVerificationTimeout(
        uint256 _tokenId,
        WrapType _wrapType,
        bytes calldata _data,
        uint256 _verificationTimeout
    ) external payable {
        unwrapNFT(_tokenId, _wrapType, _data, _verificationTimeout);
    }

    /**
     * @notice Unwraps F-NFT, uses seaport to sell the NFT
     *
     * Emits VerificationInitiated and ItemPriceObserved events
     *
     * Reverts if:
     * - Caller is not the seller's assistant or facilitator
     * - If seller deposit is non zero and there are not enough funds to cover it
     * - It is self sale and the caller does not provide the verification fee
     * - It is a normal sale and the price is not high enough to cover the verification fee
     * - The buyer order validation fails:
     *   - There is more than 1 offer in the order
     *   - There are more than 2 considerations in the order
     *   - OpenSea fee is higher than the price
     *   - OpenSea fee is higher than the expected fee
     * - The verification timeout is too long
     *
     * @param _tokenId - the token ID
     * @param _wrapType - the wrap type
     * @param _data - additional data, depending on the wrap type
     * @param _verificationTimeout - the verification timeout in UNIX timestamp
     */
    function unwrapNFT(
        uint256 _tokenId,
        WrapType _wrapType,
        bytes calldata _data,
        uint256 _verificationTimeout
    ) internal notPaused(FermionTypes.PausableRegion.Offer) nonReentrant {
        uint256 tokenId = _tokenId;
        (uint256 offerId, FermionTypes.Offer storage offer) = FermionStorage.getOfferFromTokenId(_tokenId);

        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();

        pl.offerLookups[offerId].fermionFNFTAddress.pushToNextTokenState(_tokenId, FermionTypes.TokenState.Unwrapping);

        FermionStorage.TokenLookups storage tokenLookups = pl.tokenLookups[_tokenId];
        {
            {
                address exchangeToken = offer.exchangeToken;

                // Check the caller is the the seller's assistant
                {
                    uint256 sellerId = offer.sellerId;
                    EntityLib.validateSellerAssistantOrFacilitator(sellerId, offer.facilitatorId);

                    handleBosonSellerDeposit(sellerId, exchangeToken, offer.sellerDeposit);
                }

                address wrapperAddress = pl.offerLookups[offerId].fermionFNFTAddress;

                IBosonProtocol.PriceDiscovery memory _priceDiscovery;
                _priceDiscovery.side = IBosonProtocol.Side.Wrapper;
                _priceDiscovery.priceDiscoveryContract = wrapperAddress;
                _priceDiscovery.conduit = wrapperAddress;
                {
                    uint256 bosonProtocolFee;
                    // TODO: refactor to use mapping(WrapType=>function(_priceDiscovery)) instead of using if-else
                    if (_wrapType == WrapType.SELF_SALE) {
                        // uint256 exchangeAmount = abi.decode(_data, (uint256)); // reference to PR #295
                        {
                            uint256 minimalPrice;
                            (minimalPrice, bosonProtocolFee) = getMinimalPriceAndBosonProtocolFee(
                                exchangeToken,
                                offer.verifierFee,
                                0
                            );
                            if (minimalPrice > 0) {
                                FundsLib.validateIncomingPayment(exchangeToken, minimalPrice);
                                FundsLib.transferFundsFromProtocol(
                                    exchangeToken,
                                    payable(wrapperAddress),
                                    minimalPrice
                                );
                            }

                            _priceDiscovery.price = minimalPrice;
                        }
                        _priceDiscovery.priceDiscoveryData = abi.encodeCall(
                            IFermionWrapper.unwrapToSelf,
                            (_tokenId, exchangeToken, _priceDiscovery.price)
                        );
                    } else if (_wrapType == WrapType.OS_AUCTION) {
                        SeaportTypes.AdvancedOrder memory _buyerOrder = abi.decode(_data, (SeaportTypes.AdvancedOrder));
                        if (
                            _buyerOrder.parameters.offer.length != 1 ||
                            _buyerOrder.parameters.consideration.length > 2 ||
                            _buyerOrder.parameters.consideration[1].startAmount >
                            (_buyerOrder.parameters.offer[0].startAmount * OS_FEE_PERCENTAGE) / HUNDRED_PERCENT + 1 || // allow +1 in case they round up; minimal exposure
                            _buyerOrder.parameters.offer[0].startAmount <
                            _buyerOrder.parameters.consideration[1].startAmount // in most cases, previous check will catch this, except if the offer is 0 and the consideration is 1
                        ) {
                            revert InvalidOpenSeaOrder();
                        }

                        unchecked {
                            _priceDiscovery.price =
                                _buyerOrder.parameters.offer[0].startAmount -
                                _buyerOrder.parameters.consideration[1].startAmount;
                        }
                        {
                            uint256 minimalPrice;
                            (minimalPrice, bosonProtocolFee) = getMinimalPriceAndBosonProtocolFee(
                                exchangeToken,
                                offer.verifierFee,
                                _priceDiscovery.price
                            );
                            if (_priceDiscovery.price < minimalPrice) {
                                revert FundsErrors.PriceTooLow(_priceDiscovery.price, minimalPrice);
                            }
                        }
                        _priceDiscovery.priceDiscoveryData = abi.encodeCall(
                            IFermionWrapper.unwrap,
                            (tokenId, _buyerOrder)
                        );
                    } else if (_wrapType == WrapType.OS_FIXED_PRICE) {
                        _priceDiscovery.price = abi.decode(_data, (uint256)); // If this does not match the true price, Boson Protocol will revert
                        _priceDiscovery.priceDiscoveryData = abi.encodeCall(
                            IFermionWrapper.unwrapFixedPriced,
                            (tokenId, exchangeToken)
                        );
                    }

                    tokenLookups.itemPrice = _priceDiscovery.price - bosonProtocolFee;
                }

                BOSON_PROTOCOL.commitToPriceDiscoveryOffer(payable(address(this)), tokenId, _priceDiscovery);
                BOSON_PROTOCOL.redeemVoucher(tokenId & type(uint128).max); // Exchange id is in the lower 128 bits
            }
        }

        uint256 itemVerificationTimeout;
        FermionStorage.ProtocolConfig storage pc = FermionStorage.protocolConfig();
        uint256 maxItemVerificationTimeout = block.timestamp + pc.maxVerificationTimeout;
        if (_verificationTimeout == 0) {
            itemVerificationTimeout = block.timestamp + pc.defaultVerificationTimeout;
        } else {
            if (_verificationTimeout > maxItemVerificationTimeout) {
                revert VerificationErrors.VerificationTimeoutTooLong(_verificationTimeout, maxItemVerificationTimeout);
            }
            itemVerificationTimeout = _verificationTimeout;
        }
        tokenLookups.itemVerificationTimeout = itemVerificationTimeout;
        tokenLookups.itemMaxVerificationTimeout = maxItemVerificationTimeout;

        // The price that Fermion operates with (the price without the OpenSea and Boson protocol fee)
        emit ItemPriceObserved(_tokenId, tokenLookups.itemPrice);

        emit IVerificationEvents.VerificationInitiated(
            offerId,
            offer.verifierId,
            tokenId,
            itemVerificationTimeout,
            maxItemVerificationTimeout
        );
    }

    /**
     * Handle Boson seller deposit
     *
     * If the seller deposit is non zero, the amount must be deposited into Boson so unwrapping can succed.
     * It the seller has some available funds in Fermion, they are used first.
     * Otherwise, the seller must provide the missing amount.
     *
     * Reverts if:
     * - The available funds are not enough and:
     *   - Not enough funds are sent to cover the seller deposit
     *   - Deposit is in ERC20 and the caller sends native currency
     *   - ERC20 token transfer fails
     *
     * @param _sellerId - the seller ID
     * @param _exchangeToken - the exchange token
     * @param _sellerDeposit - the seller deposit
     */
    function handleBosonSellerDeposit(uint256 _sellerId, address _exchangeToken, uint256 _sellerDeposit) internal {
        // Validate that the seller deposit is provided
        if (_sellerDeposit > 0) {
            // Use the available funds first
            // If there is not enough, the seller must provide the missing amount
            uint256 availableFunds = FermionStorage.protocolLookups().entityLookups[_sellerId].availableFunds[
                _exchangeToken
            ];

            if (availableFunds >= _sellerDeposit) {
                FundsLib.decreaseAvailableFunds(_sellerId, _exchangeToken, _sellerDeposit);
            } else {
                // For offers in native token, the seller deposit cannot be sent at the time of unwrapping.
                // It must be deposited in advance, using `depositFunds` method.
                if (_exchangeToken == address(0)) revert FundsErrors.NativeNotAllowed();

                FundsLib.decreaseAvailableFunds(_sellerId, _exchangeToken, availableFunds); // Use all available funds

                uint256 remainder;
                unchecked {
                    remainder = _sellerDeposit - availableFunds;
                }

                // Transfer the remainder from the seller
                FundsLib.validateIncomingPayment(_exchangeToken, remainder);
            }

            // Deposit to the boson protocol
            uint256 msgValue;
            if (_exchangeToken != address(0)) {
                IERC20(_exchangeToken).forceApprove(address(BOSON_PROTOCOL), _sellerDeposit);
            } else {
                msgValue = _sellerDeposit;
            }
            uint256 bosonSellerId = FermionStorage.protocolStatus().bosonSellerId;
            BOSON_PROTOCOL.depositFunds{ value: msgValue }(bosonSellerId, _exchangeToken, _sellerDeposit);
        }
    }

    /**
     * @notice calculate the minimal price in order to cover the verifier fee and the Boson protocol fee
     *
     * @param _exchangeToken - the token used for the exchange
     * @param _verifierFee - the verifier fee
     * @param _price - the price (if not selfSale)
     * @return minimalPrice - the minimal price
     */
    function getMinimalPriceAndBosonProtocolFee(
        address _exchangeToken,
        uint256 _verifierFee,
        uint256 _price
    ) internal view returns (uint256 minimalPrice, uint256 bosonProtocolFee) {
        if (_exchangeToken == BOSON_TOKEN) {
            bosonProtocolFee = BOSON_PROTOCOL.getProtocolFeeFlatBoson();
            minimalPrice = _verifierFee + bosonProtocolFee;
        } else {
            if (_verifierFee == 0 && _price == 0) return (0, 0); // to avoid the contract call
            uint256 bosonProtocolFeePercentage = BOSON_PROTOCOL.getProtocolFeePercentage();
            if (_verifierFee > 0) {
                minimalPrice = (HUNDRED_PERCENT * _verifierFee) / (HUNDRED_PERCENT - bosonProtocolFeePercentage);
                if (_price == 0) _price = minimalPrice; // self sale
            }
            bosonProtocolFee = (_price * bosonProtocolFeePercentage) / HUNDRED_PERCENT; // price is guaranteed to be > 0, so this must always be calculated
        }
    }

    /**
     * @notice Add a supported token to the Boson dispute resolver. This is necessary for a succesful offer creation.
     *
     * Not restricted with onlyAdmin. The purpose of this method is to allow the seller to add supported tokens in boson if they
     * want to use them in their offers and not already added by the protocol.
     *
     * Reverts if:
     * - Offer region is paused
     * - Call to Boson protocol reverts
     *
     * @param _tokenAddress Token address
     */
    function addSupportedToken(
        address _tokenAddress
    ) external notPaused(FermionTypes.PausableRegion.Offer) nonReentrant {
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
     * @notice Predict the address of the Fermion FNFT contract
     *
     * @dev This is primarily used for testing purposes. Might be removed in the future.
     *
     * @param _offerId - the offer ID
     *
     * @return address - the predicted address
     */
    function predictFermionFNFTAddress(uint256 _offerId) external view returns (address) {
        return
            Clones.predictDeterministicAddress(
                FermionStorage.protocolStatus().fermionFNFTBeaconProxy,
                bytes32(_offerId)
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
     * - Caller is not the seller's assistant or facilitator
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
        FermionTypes.Offer storage offer = FermionStorage.protocolEntities().offer[_offerId];

        // Check the caller is the the seller's assistant or facilitator
        EntityLib.validateSellerAssistantOrFacilitator(offer.sellerId, offer.facilitatorId);

        uint256 nextExchangeId = BOSON_PROTOCOL.getNextExchangeId();
        startingNFTId = nextExchangeId | (_offerId << 128);

        // Reserve range in Boson
        BOSON_PROTOCOL.reserveRange(_offerId, _quantity, address(this)); // The recipient is this contract, so the NFTs can be wrapped later on

        // Premint NFTs on boson voucher
        bosonVoucher = IBosonVoucher(FermionStorage.protocolStatus().bosonNftCollection);
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
     * @param _wrapType - the wrap type
     * @param ps - the protocol status storage pointer
     */
    function wrapNFTS(
        uint256 _offerId,
        IBosonVoucher _bosonVoucher,
        uint256 _startingNFTId,
        uint256 _quantity,
        WrapType _wrapType,
        FermionStorage.ProtocolStatus storage ps
    ) internal returns (address wrapperAddress, address _exchangeToken) {
        address msgSender = _msgSender();
        FermionStorage.OfferLookups storage offerLookup = FermionStorage.protocolLookups().offerLookups[_offerId];

        wrapperAddress = offerLookup.fermionFNFTAddress;
        if (wrapperAddress == address(0)) {
            // Currently, the wrapper is created for each offer, since BOSON_PROTOCOL.reserveRange can be called only once
            // so else path is not possible. This is here for future proofing.

            // create wrapper
            wrapperAddress = Clones.cloneDeterministic(ps.fermionFNFTBeaconProxy, bytes32(_offerId));
            offerLookup.fermionFNFTAddress = wrapperAddress;

            FermionTypes.Offer storage offer = FermionStorage.protocolEntities().offer[_offerId];
            _exchangeToken = offer.exchangeToken;
            wrapperAddress.initialize(address(_bosonVoucher), msgSender, _exchangeToken, _offerId, offer.metadataURI);
        }

        // wrap NFTs
        _bosonVoucher.setApprovalForAll(wrapperAddress, true);
        wrapperAddress.wrap(_startingNFTId, _quantity, _wrapType == WrapType.OS_AUCTION ? msgSender : wrapperAddress);
        _bosonVoucher.setApprovalForAll(wrapperAddress, false);

        emit NFTsWrapped(_offerId, wrapperAddress, _startingNFTId, _quantity);
    }
}
