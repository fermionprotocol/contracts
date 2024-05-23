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
import { IVerificationEvents } from "../interfaces/events/IVerificationEvents.sol";

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { IFermionWrapper } from "../interfaces/IFermionWrapper.sol";

/**
 * @title VerificationFacet
 *
 * @notice Handles RWA verification.
 */
contract Verification is Context, FermionErrors, IVerificationEvents {
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
        uint256 offerId = _tokenId >> 128;
        FermionTypes.Offer storage offer = FermionStorage.protocolEntities().offer[offerId];
        uint256 verifierId = offer.verifierId;

        // Check the caller is the the verifier's assistant
        EntityLib.validateWalletRole(
            verifierId,
            msgSender(),
            FermionTypes.EntityRole.Verifier,
            FermionTypes.WalletRole.Assistant
        );

        BOSON_PROTOCOL.completeExchange(_tokenId);

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
        FundsLib.increaseAvailableFunds(0, exchangeToken, verifierFee); // Protocol fees are stored in entity 0

        uint256 remainder = totalAmount - verifierFee - fermionFee;

        if (_verificationStatus == FermionTypes.VerificationStatus.Verified) {
            // transfer the remainder to the seller
            FundsLib.increaseAvailableFunds(offer.sellerId, exchangeToken, remainder);
        } else {
            address wrapperAddress = pl.wrapperAddress[offerId];
            address buyerAddress = IFermionWrapper(wrapperAddress).burn(_tokenId);

            uint256 buyerId = pl.walletId[buyerAddress];

            if (buyerId == 0) {
                FermionTypes.EntityRole[] memory _roles = new FermionTypes.EntityRole[](1);
                _roles[0] = FermionTypes.EntityRole.Buyer;
                EntityLib.createEntity(buyerAddress, _roles, "", pl);
            }

            // transfer the remainder to the buyer
            FundsLib.increaseAvailableFunds(buyerId, exchangeToken, remainder);
        }

        emit VerdictSubmitted(_tokenId, verifierId, _verificationStatus);
    }

    function verified(uint256 _tokenId) internal {}
}
