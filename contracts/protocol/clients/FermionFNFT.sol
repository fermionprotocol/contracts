// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { SLOT_SIZE } from "../domain/Constants.sol";
import { FermionTypes } from "../domain/Types.sol";
import { IFermionWrapper } from "../interfaces/IFermionWrapper.sol";
import { IFermionFractions } from "../interfaces/IFermionFractions.sol";
import { IFermionFNFT } from "../interfaces/IFermionFNFT.sol";
import { IFermionFractions } from "../interfaces/IFermionFractions.sol";
import { FermionFractions } from "./FermionFractions.sol";
import { FermionWrapper } from "./FermionWrapper.sol";
import { Common } from "./Common.sol";
import { FundsLib } from "../libs/FundsLib.sol";
import { ERC721Upgradeable as ERC721 } from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import { ContextUpgradeable as Context } from "@openzeppelin/contracts-upgradeable/utils/ContextUpgradeable.sol";
import { ERC2771ContextUpgradeable as ERC2771Context } from "@openzeppelin/contracts-upgradeable/metatx/ERC2771ContextUpgradeable.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import { IERC2981 } from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import { Strings } from "@openzeppelin/contracts/utils/Strings.sol";

/**
 * @title Fermion F-NFT contract
 * @notice Wrapping, unwrapping, fractionalisation, buyout auction and claiming of Boson Vouchers
 *
 */
contract FermionFNFT is FermionFractions, FermionWrapper, ERC2771Context, IFermionFNFT {
    address private immutable THIS_CONTRACT = address(this);

    /**
     * @notice Constructor
     *
     * @dev construct ERC2771Context with address 0 and override `trustedForwarder` to return the fermionProtocol address
     */
    constructor(
        address _bosonPriceDiscovery,
        address _seaportWrapper,
        address _strictAuthorizedTransferSecurityRegistry,
        address _wrappedNative,
        address _fnftFractionMint,
        address _fermionFNFTPriceManager,
        address _fnftBuyoutAuction
    )
        FermionWrapper(_bosonPriceDiscovery, _seaportWrapper, _strictAuthorizedTransferSecurityRegistry, _wrappedNative)
        ERC2771Context(address(0))
        FundsLib(bytes32(0))
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
     */
    function initialize(
        address _voucherAddress,
        address _owner,
        address _exchangeToken,
        uint256 _offerId,
        string memory _metadataUri
    ) external initializer {
        if (address(this) == THIS_CONTRACT) {
            revert InvalidInitialization();
        }

        fermionProtocol = msg.sender;
        voucherAddress = _voucherAddress;

        initializeWrapper(_owner, _metadataUri);
        intializeFractions(_exchangeToken);

        string memory _offerIdString = Strings.toString(_offerId);
        __ERC721_init(string.concat("Fermion FNFT ", _offerIdString), string.concat("FFNFT_", _offerIdString));
    }

    /**
     * @notice Updates the name of the token
     * @dev Only callable by the contract owner
     * @param _name The new name for the token
     */
    function setName(string memory _name) external onlyOwner {
        Common._getERC721Storage()._name = _name;
    }

    /**
     * @notice Updates the symbol of the token
     * @dev Only callable by the contract owner
     * @param _symbol The new symbol for the token
     */
    function setSymbol(string memory _symbol) external onlyOwner {
        Common._getERC721Storage()._symbol = _symbol;
    }

    /**
     * @notice Updates both the name and symbol of the token in a single transaction
     * @dev Only callable by the contract owner
     * @param _name The new name for the token
     * @param _symbol The new symbol for the token
     */
    function setNameAndSymbol(string memory _name, string memory _symbol) external onlyOwner {
        ERC721Storage storage $ = Common._getERC721Storage();
        $._name = _name;
        $._symbol = _symbol;
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
        Common.checkStateAndCaller(_tokenId, FermionTypes.TokenState.Unverified, _msgSender(), fermionProtocol);

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
            fermionProtocol
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

    ///////// overrides ///////////
    function balanceOf(
        address owner
    ) public view virtual override(IERC721, ERC721, FermionFractions) returns (uint256) {
        return ERC721.balanceOf(owner);
    }

    function balanceOfERC20(address owner) public view virtual returns (uint256) {
        return FermionFractions.balanceOf(owner);
    }

    function transfer(
        address to,
        uint256 value
    ) public virtual override(IFermionFractions, FermionFractions) returns (bool) {
        return FermionFractions.transfer(to, value);
    }

    function transferFrom(address from, address to, uint256 tokenIdOrValue) public virtual override(IERC721, ERC721) {
        if (tokenIdOrValue > type(uint128).max) {
            ERC721.transferFrom(from, to, tokenIdOrValue);
        } else {
            bool success = transferFractionsFrom(from, to, tokenIdOrValue);
            assembly {
                return(success, SLOT_SIZE)
            }
        }
    }

    function approve(address to, uint256 tokenIdOrBalance) public virtual override(IERC721, ERC721) {
        if (tokenIdOrBalance == type(uint256).max) {
            // Unlimited approval in this contract should be represented by type(uint128).max
            tokenIdOrBalance = type(uint128).max;
        }

        if (tokenIdOrBalance > type(uint128).max) {
            ERC721.approve(to, tokenIdOrBalance);
        } else {
            bool success = approveFractions(to, tokenIdOrBalance);
            assembly {
                return(success, SLOT_SIZE)
            }
        }
    }

    /**
     * @dev See {IERC721Metadata-tokenURI}.
     */
    function tokenURI(uint256 tokenId) public view virtual override(FermionWrapper, ERC721) returns (string memory) {
        return FermionWrapper.tokenURI(tokenId);
    }

    function _update(
        address _to,
        uint256 _tokenId,
        address _auth
    ) internal override(ERC721, FermionWrapper) returns (address) {
        address from = FermionWrapper._update(_to, _tokenId, _auth);
        if (from == address(0)) Common.changeTokenState(_tokenId, FermionTypes.TokenState.Wrapped);

        return from;
    }

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

    function transferOwnership(address _newOwner) public override(FermionWrapper, IFermionWrapper) {
        super.transferOwnership(_newOwner);
    }
}
