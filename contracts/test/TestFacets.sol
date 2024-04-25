// SPDX-License-Identifier: CC0-1.0
pragma solidity 0.8.24;

// Example library to show a simple example of diamond storage

library TestLib {
    bytes32 internal constant DIAMOND_STORAGE_POSITION = keccak256("diamond.standard.test.storage");

    struct TestState {
        address myAddress;
        uint256 myNum;
    }

    function diamondStorage() internal pure returns (TestState storage ds) {
        bytes32 position = DIAMOND_STORAGE_POSITION;
        assembly {
            ds.slot := position
        }
    }

    function setMyAddress(address _myAddress) internal {
        TestState storage testState = diamondStorage();
        testState.myAddress = _myAddress;
    }

    function getMyAddress() internal view returns (address) {
        TestState storage testState = diamondStorage();
        return testState.myAddress;
    }
}

contract Test1Facet {
    event TestEvent(address something);

    function test1Func1() external {
        TestLib.setMyAddress(address(this));
    }

    function test1Func2() external view returns (address) {
        return TestLib.getMyAddress();
    }
    function test1Func3() external {}

    function test1Func4() external {}

    function test1Func5() external {}

    function test1Func6() external {}

    function test1Func7() external {}

    function test1Func8() external {}

    function test1Func9() external {}

    function test1Func10() external {}

    function test1Func11() external {}

    function test1Func12() external {}

    function test1Func13() external {}

    function test1Func14() external {}

    function test1Func15() external {}

    function test1Func16() external {}

    function test1Func17() external {}

    function test1Func18() external {}

    function test1Func19() external {}

    function test1Func20() external {}

    function supportsInterface(bytes4 _interfaceID) external view returns (bool) {}
}

contract Test2Facet {
    function test2Func1() external {}

    function test2Func2() external {}

    function test2Func3() external {}

    function test2Func4() external {}

    function test2Func5() external {}

    function test2Func6() external {}

    function test2Func7() external {}

    function test2Func8() external {}

    function test2Func9() external {}

    function test2Func10() external {}

    function test2Func11() external {}

    function test2Func12() external {}

    function test2Func13() external {}

    function test2Func14() external {}

    function test2Func15() external {}

    function test2Func16() external {}

    function test2Func17() external {}

    function test2Func18() external {}

    function test2Func19() external {}

    function test2Func20() external {}
}

contract RevertingFacet {
    function revertWithoutReason() external pure {
        revert();
    }
}
