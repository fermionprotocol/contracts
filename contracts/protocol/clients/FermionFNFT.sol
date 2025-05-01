// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { FermionTypes } from "../domain/Types.sol";
import { IFermionWrapper } from "../interfaces/IFermionWrapper.sol";
import { IFermionFractions } from "../interfaces/IFermionFractions.sol";
import { IFermionFNFT } from "../interfaces/IFermionFNFT.sol";
import { FermionFNFTBase } from "./FermionFNFTBase.sol";
import { FermionFractions } from "./FermionFractions.sol";
import { FermionWrapper } from "./FermionWrapper.sol";
import { Common } from "./Common.sol";
import { ERC721Upgradeable as ERC721 } from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import { IERC2981 } from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import { Strings } from "@openzeppelin/contracts/utils/Strings.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";

/**
 * @title Fermion F-NFT contract
 * @notice Wrapping, unwrapping, fractionalisation, buyout auction and claiming of Boson Vouchers
 *
 */
contract FermionFNFT is FermionFractions, FermionWrapper, IFermionFNFT, ReentrancyGuardUpgradeable {
    address private immutable THIS_CONTRACT = address(this);

    /**
     * @notice Constructor
     */
    constructor(
        address _bosonPriceDiscovery,
        address _fermionProtocol,
        address _seaportWrapper,
        address _strictAuthorizedTransferSecurityRegistry,
        address _wrappedNative,
        address _fnftFractionMint,
        address _fermionFNFTPriceManager,
        address _fnftBuyoutAuction
    )
        FermionFNFTBase(_bosonPriceDiscovery, _fermionProtocol)
        FermionWrapper(_seaportWrapper, _strictAuthorizedTransferSecurityRegistry, _wrappedNative)
        FermionFractions(_fnftFractionMint, _fermionFNFTPriceManager, _fnftBuyoutAuction)
    {}

    /**
     * @notice Initializes the contract
     *
     * Reverts if:
     * - Contract is already initialized
     *
     * @param _voucherAddress The address of the Boson Voucher contract
     * @param _owner The address of the owner
     * @param _exchangeToken The address of the exchange token
     * @param _offerId The offer id
     * @param _metadataUri The metadata URI, used for all tokens and contract URI
     * @param _tokenMetadata - optional token metadata (name and symbol)
     */
    function initialize(
        address _voucherAddress,
        address _owner,
        address _exchangeToken,
        uint256 _offerId,
        string calldata _metadataUri,
        FermionTypes.TokenMetadata memory _tokenMetadata
    ) external initializer {
        if (address(this) == THIS_CONTRACT) {
            revert InvalidInitialization();
        }

        __ReentrancyGuard_init();

        voucherAddress = _voucherAddress;

        initializeWrapper(_owner, _metadataUri);
        intializeFractions(_exchangeToken);

        bool useDefaultName = bytes(_tokenMetadata.name).length == 0;
        bool useDefaultSymbol = bytes(_tokenMetadata.symbol).length == 0;

        if (useDefaultName || useDefaultSymbol) {
            string memory _offerIdString = Strings.toString(_offerId);
            if (useDefaultName) _tokenMetadata.name = string.concat("Fermion FNFT ", _offerIdString);
            if (useDefaultSymbol) _tokenMetadata.symbol = string.concat("FFNFT_", _offerIdString);
        }

        __ERC721_init(_tokenMetadata.name, _tokenMetadata.symbol);
    }

    /**
     * @dev Returns true if this contract implements the interface defined by
     * `interfaceId`. See the corresponding
     * https://eips.ethereum.org/EIPS/eip-165#how-interfaces-are-identified[EIP section]
     * to learn more about how these ids are created.
     */
    function supportsInterface(bytes4 _interfaceId) public view virtual override(ERC721, IERC165) returns (bool) {
        return
            super.supportsInterface(_interfaceId) ||
            _interfaceId == type(IFermionWrapper).interfaceId ||
            _interfaceId == type(IFermionFractions).interfaceId ||
            _interfaceId == type(IFermionFNFT).interfaceId ||
            _interfaceId == type(IERC2981).interfaceId;
    }

    /**
     * @notice Burns the token and returns the voucher owner
     *
     * Reverts if:
     * - Caller is not the Fermion Protocol
     * - Token is not in the Unverified state
     *
     * @param _tokenId The token id.
     */
    function burn(uint256 _tokenId) external returns (address wrappedVoucherOwner) {
        Common.checkStateAndCaller(_tokenId, FermionTypes.TokenState.Unverified, _msgSender(), FERMION_PROTOCOL);

        wrappedVoucherOwner = ownerOf(_tokenId);

        _burn(_tokenId);
        Common.changeTokenState(_tokenId, FermionTypes.TokenState.Burned);
    }

    /**
     * @notice Pushes the F-NFT to next token state
     *
     * Reverts if:
     * - Caller is not the Fermion Protocol
     * - The new token state is not consecutive to the current state
     *
     * N.B. Not checking if the new state is valid, since the caller is the Fermion Protocol, which is trusted
     *
     * @param _tokenId The token id.
     * @param _newState The new token state
     */
    function pushToNextTokenState(uint256 _tokenId, FermionTypes.TokenState _newState) external {
        Common.checkStateAndCaller(
            _tokenId,
            FermionTypes.TokenState(uint8(_newState) - 1),
            _msgSender(),
            FERMION_PROTOCOL
        );
        Common.changeTokenState(_tokenId, _newState);
        if (_newState == FermionTypes.TokenState.CheckedOut) {
            _burn(_tokenId);
        }
    }

    /**
     * @notice Returns the current token stat
     *
     * @param _tokenId The token id.
     * @return The token state
     */
    function tokenState(uint256 _tokenId) external view returns (FermionTypes.TokenState) {
        return Common._getFermionCommonStorage().tokenState[_tokenId];
    }

    /**
     * @notice Returns the address of the ERC20 clone for a specific epoch
     * Users should interact with this contract directly for ERC20 operations
     *
     * @param _epoch The epoch
     * @return The address of the ERC20 clone
     */
    function getERC20FractionsClone(uint256 _epoch) external view returns (address) {
        return Common._getFermionFractionsStorage().epochToClone[_epoch];
    }

    /**
     * @notice Returns the address of the ERC20 clone for the current epoch
     * Users should interact with this contract directly for ERC20 operations
     *
     * @return The address of the ERC20 clone
     */
    function getERC20FractionsClone() external view returns (address) {
        return Common._getFermionFractionsStorage().epochToClone[Common._getFermionFractionsStorage().currentEpoch];
    }

    function currentEpoch() external view returns (uint256) {
        return Common._getFermionFractionsStorage().currentEpoch;
    }

    function transferOwnership(address _newOwner) public override(FermionWrapper, IFermionWrapper) {
        super.transferOwnership(_newOwner);
    }

    /**
     * @notice Participate in the auction for a specific token.
     * @dev This function is overridden to enforce non-reentrancy restrictions
     
     * Emits a Bid event if successful.
     *
     * Reverts if:
     * - The price is less than a minimal increment above the existing bid
     * - The auction has ended
     * - The caller does not pay the price
     *
     * @param _tokenId The token Id
     * @param _price The bidding price
     * @param _fractions The number of fractions to use for the bid, in addition to the fractions already locked during the votes
     */
    function bid(uint256 _tokenId, uint256 _price, uint256 _fractions) external payable override nonReentrant {
        forwardCall(FNFT_BUYOUT_AUCTION);
    }
}
