// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { FermionStorage } from "../libs/Storage.sol";
import { LibDiamond } from "../../diamond/libraries/LibDiamond.sol";
import { FermionErrors } from "../domain/Errors.sol";

import { IInitialziationEvents } from "../interfaces/events/IInitializationEvents.sol";

import { IBosonProtocol } from "../interfaces/IBosonProtocol.sol";
import { IDiamondLoupe } from "../../diamond/interfaces/IDiamondLoupe.sol";
import { IDiamondCut } from "../../diamond/interfaces/IDiamondCut.sol";
import { IERC173 } from "../../diamond/interfaces/IERC173.sol";
import { IERC165 } from "../../diamond/interfaces/IERC165.sol";

/**
 * @title FermionProtocolInitializationHandler
 *
 * @notice Handle initialization of protocol
 *
 */
contract InitializationFacet is FermionErrors, IInitialziationEvents {
    address private immutable THIS_ADDRESS; // used to prevent invocation of 'initialize' directly on deployed contract. Variable is not used by the protocol.

    /**
     * @notice Constructor
     *
     * @dev This constructor is used to prevent invocation of 'initialize' directly on deployed contract.
     */
    constructor() {
        THIS_ADDRESS = address(this);
    }

    /**
     * @notice Initializes the protocol after the deployment.
     *
     * Reverts if:
     * - Is invoked directly on the deployed contract (not via proxy)
     * - Version is not set
     * - Length of _addresses and _calldata arrays do not match
     * - Any of delegate calls to _addresses reverts
     *
     * @param _version - version of the protocol
     * @param _addresses - array of facet addresses to call initialize methods
     * @param _calldata -  array of facets initialize methods encoded as calldata
     *                    _calldata order must match _addresses order
     * @param _interfacesToRemove - array of interfaces to remove from the diamond
     * @param _interfacesToAdd - array of interfaces to add to the diamond
     */
    function initialize(
        bytes32 _version,
        address[] calldata _addresses,
        bytes[] calldata _calldata,
        bytes4[] calldata _interfacesToAdd,
        bytes4[] calldata _interfacesToRemove
    ) external noDirectInitialization {
        if (_version == bytes32(0)) revert VersionMustBeSet();
        if (_addresses.length != _calldata.length)
            revert AddressesAndCalldataLengthMismatch(_addresses.length, _calldata.length);

        // Delegate call to initialize methods of facets declared in _addresses
        for (uint256 i = 0; i < _addresses.length; i++) {
            LibDiamond.initializeDiamondCut(_addresses[i], _calldata[i]);
        }

        LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
        addRemoveInterfaces(ds, _interfacesToRemove, false);
        addRemoveInterfaces(ds, _interfacesToAdd, true);

        FermionStorage.protocolStatus().version = _version;

        emit ProtocolInitialized(_version);
    }

    /**
     * @notice First Diamond initialization.
     * Creates the Boson Seller in the existing Boson Protocol and registers the default interfaces.
     *
     * Must be called before Fermion can be used. Subsequent upgrades should use the initialize function.
     *
     * Reverts if:
     * - Is invoked directly on the deployed contract (not via proxy)
     * - Boson Protocol address is not set
     * - Call to Boson protocol reverts (because Boson Seller already exists or the protocol is paused)
     *
     * @param _bosonProtocolAddress - address of the Boson Protocol
     */
    function initializeDiamond(address _bosonProtocolAddress) external noDirectInitialization {
        initializeBosonSellerAndBuyerAndDR(_bosonProtocolAddress);

        LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
        ds.supportedInterfaces[type(IERC165).interfaceId] = true;
        ds.supportedInterfaces[type(IDiamondCut).interfaceId] = true;
        ds.supportedInterfaces[type(IDiamondLoupe).interfaceId] = true;
        ds.supportedInterfaces[type(IERC173).interfaceId] = true;
    }

    /**
     * @notice Creates the Boson Seller in the existing Boson Protocol and
     *
     * Must be called before Fermion can be used, normaly called as part of the initial deployment.
     *
     * Reverts if:
     * - Is invoked directly on the deployed contract (not via proxy)
     * - Boson Protocol address is not set
     * - Call to Boson protocol reverts (because Boson Seller already exists or the protocol is paused)
     *
     * @param _bosonProtocolAddress - address of the Boson Protocol
     */
    function initializeBosonSellerAndBuyerAndDR(address _bosonProtocolAddress) internal {
        if (_bosonProtocolAddress == address(0)) revert InvalidAddress();

        IBosonProtocol bosonProtocol = IBosonProtocol(_bosonProtocolAddress);
        uint256 bosonSellerId = bosonProtocol.getNextAccountId();

        // Create a seller
        IBosonProtocol.Seller memory seller = IBosonProtocol.Seller({
            id: bosonSellerId,
            assistant: address(this),
            admin: address(this),
            clerk: address(0),
            treasury: payable(address(this)),
            active: true,
            metadataUri: ""
        });

        IBosonProtocol.AuthToken memory authToken;
        IBosonProtocol.VoucherInitValues memory voucherInitValues;

        bosonProtocol.createSeller(seller, authToken, voucherInitValues);

        // Create a buyer
        IBosonProtocol.Buyer memory buyer = IBosonProtocol.Buyer({
            id: bosonSellerId + 1,
            wallet: payable(address(this)),
            active: true
        });

        bosonProtocol.createBuyer(buyer);

        // Create a dispute resolver
        IBosonProtocol.DisputeResolver memory disputeResolver = IBosonProtocol.DisputeResolver({
            id: bosonSellerId + 2,
            escalationResponsePeriod: 1, // not used, but 0 is restricted by Boson
            assistant: address(this),
            admin: address(this),
            clerk: address(0),
            treasury: payable(address(this)),
            metadataUri: "",
            active: true
        });

        IBosonProtocol.DisputeResolverFee[] memory disputeResolverFees;
        uint256[] memory sellerAllowList = new uint256[](1);
        sellerAllowList[0] = bosonSellerId;
        bosonProtocol.createDisputeResolver(disputeResolver, disputeResolverFees, sellerAllowList);

        FermionStorage.protocolStatus().bosonSellerId = bosonSellerId;
    }

    /**
     * @notice Gets the current protocol version.
     *
     */
    function getVersion() external view returns (string memory version) {
        FermionStorage.ProtocolStatus storage status = FermionStorage.protocolStatus();
        version = string(abi.encodePacked(status.version));
    }

    /**
     * @notice Adds or removes supported interfaces
     *
     * @param ds - diamond storage pointer
     * @param _interfaces - array of interfaces to add or remove
     * @param _isSupported - true if adding, false if removing
     */
    function addRemoveInterfaces(
        LibDiamond.DiamondStorage storage ds,
        bytes4[] calldata _interfaces,
        bool _isSupported
    ) internal {
        for (uint256 i = 0; i < _interfaces.length; i++) {
            ds.supportedInterfaces[(_interfaces[i])] = _isSupported;
        }
    }

    modifier noDirectInitialization() {
        if (address(this) == THIS_ADDRESS) revert DirectInitializationNotAllowed();
        _;
    }
}
