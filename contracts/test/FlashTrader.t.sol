// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FlashTrader} from "../src/FlashTrader.sol";

// Basic unit test scaffold — Foundry fork tests against live Aave recommended
contract FlashTraderTest {
    FlashTrader trader;

    address constant MOCK_POOL = address(0x1);
    address constant MOCK_PROVIDER = address(0x2);

    function setUp() public {
        trader = new FlashTrader(MOCK_POOL, MOCK_PROVIDER);
    }

    function testOwnerIsDeployer() public view {
        assert(trader.owner() == address(this));
    }

    function testTransferOwnership() public {
        address newOwner = address(0x123);
        trader.transferOwnership(newOwner);
        assert(trader.owner() == newOwner);
    }
}
