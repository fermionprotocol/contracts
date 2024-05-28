// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { FermionTypes } from "../domain/Types.sol";
import { FermionStorage } from "../libs/Storage.sol";
import { EntityLib } from "../libs/EntityLib.sol";
import { FundsLib } from "../libs/FundsLib.sol";
import { Context } from "../libs/Context.sol";
import { IBosonProtocol } from "../interfaces/IBosonProtocol.sol";
import { IVerificationEvents } from "../interfaces/events/IVerificationEvents.sol";
import { IFermionWrapper } from "../interfaces/IFermionWrapper.sol";

/**
 * @title VerificationFacet
 *
 * @notice Handles RWA verification.
 */
contract VerificationFacet is Context, IVerificationEvents {
    IBosonProtocol private immutable BOSON_PROTOCOL;

    constructor(address _bosonProtocol) {
        BOSON_PROTOCOL = IBosonProtocol(_bosonProtocol);
    }

    /**
     * @notice Submit a verdict
     *
     * Emits an VerdictSubmitted event
     *
     * Reverts if:
     * - Caller is not the verifier's assistant
     *
     * @param _tokenId - the token ID
     * @param _verificationStatus - the verification status
     */
    function submitVerdict(uint256 _tokenId, FermionTypes.VerificationStatus _verificationStatus) external {
        (uint256 offerId, FermionTypes.Offer storage offer) = FermionStorage.getOfferFromTokenId(_tokenId);
        uint256 verifierId = offer.verifierId;

        // Check the caller is the the verifier's assistant
        EntityLib.validateWalletRole(
            verifierId,
            msgSender(),
            FermionTypes.EntityRole.Verifier,
            FermionTypes.WalletRole.Assistant
        );

        BOSON_PROTOCOL.completeExchange(_tokenId & type(uint128).max);

        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        address exchangeToken = offer.exchangeToken;
        uint256 totalAmount = offer.sellerDeposit + pl.offerPrice[offerId];

        {
            uint256 bosonSellerId = FermionStorage.protocolStatus().bosonSellerId;
            address[] memory tokenList = new address[](1);
            uint256[] memory amountList = new uint256[](1);
            tokenList[0] = exchangeToken;
            amountList[0] = totalAmount;
            BOSON_PROTOCOL.withdrawFunds(bosonSellerId, tokenList, amountList);
        }

        // pay the verifier
        uint256 verifierFee = offer.verifierFee;
        FundsLib.increaseAvailableFunds(verifierId, exchangeToken, verifierFee);

        // fermion fee
        uint256 fermionFee = 0; //ToDo
        FundsLib.increaseAvailableFunds(0, exchangeToken, fermionFee); // Protocol fees are stored in entity 0

        uint256 remainder = totalAmount - verifierFee - fermionFee;

        if (_verificationStatus == FermionTypes.VerificationStatus.Verified) {
            // transfer the remainder to the seller
            FundsLib.increaseAvailableFunds(offer.sellerId, exchangeToken, remainder);
            IFermionWrapper(pl.wrapperAddress[offerId]).pushToNextTokenState(
                _tokenId,
                IFermionWrapper.TokenState.Verified
            );
        } else {
            address buyerAddress = IFermionWrapper(pl.wrapperAddress[offerId]).burn(_tokenId);

            uint256 buyerId = pl.walletId[buyerAddress];

            if (buyerId == 0) {
                FermionTypes.EntityRole[] memory _roles = new FermionTypes.EntityRole[](1);
                _roles[0] = FermionTypes.EntityRole.Buyer;
                buyerId = EntityLib.createEntity(buyerAddress, _roles, "", pl);
            }

            // transfer the remainder to the buyer
            FundsLib.increaseAvailableFunds(buyerId, exchangeToken, remainder);
        }

        emit VerdictSubmitted(verifierId, _tokenId, _verificationStatus);
    }
}
