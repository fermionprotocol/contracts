// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { FermionStorage } from "../libs/Storage.sol";
import { LibDiamond } from "../../diamond/libraries/LibDiamond.sol";
import { FermionErrors } from "../domain/Errors.sol";

import { IInitialziationEvents } from "../interfaces/events/IInitializationEvents.sol";

import { IBosonProtocol } from "../interfaces/IBosonProtocol.sol";

/**
 * @title BosonProtocolInitializationHandler
 *
 * @notice Handle initializion of protocol
 *
 */
contract InitializationFacet is FermionErrors, IInitialziationEvents {
    address private immutable THIS_ADDRESS; // used to prevent invocation of initialize directly on deployed contract. Variable is not used by the protocol.

    /**
     * @notice Constructor
     *
     * @dev This constructor is used to prevent invocation of initialize directly on deployed contract.
     */
    constructor() {
        THIS_ADDRESS = address(this);
    }

    /**
     * @notice Initializes the protocol after the deployment.
     * This function is callable only once for each version
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
     * @notice Creates the Boson Seller in the existing Boson Protocol
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
    function initializeBosonSellerAndBuyer(address _bosonProtocolAddress) external noDirectInitialization {
        if (_bosonProtocolAddress == address(0)) revert InvalidAddress();

        IBosonProtocol bosonProtocol = IBosonProtocol(_bosonProtocolAddress);
        uint256 bosonSellerId = bosonProtocol.getNextAccountId();

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

        IBosonProtocol.Buyer memory buyer = IBosonProtocol.Buyer({
            id: bosonSellerId + 1,
            wallet: payable(address(this)),
            active: true
        });

        bosonProtocol.createBuyer(buyer);

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
