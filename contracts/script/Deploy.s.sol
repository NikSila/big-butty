// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {FlashTrader} from "../src/FlashTrader.sol";

contract DeployScript is Script {
    function run() external {
        // Aave V3 Pool on Arbitrum
        address aavePool = 0x794a61358D6845594F94dc1DB02A252b5b4814aD;
        address addressesProvider = 0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb;

        vm.startBroadcast();
        FlashTrader trader = new FlashTrader(aavePool, addressesProvider);
        vm.stopBroadcast();

        console.log("FlashTrader deployed at:", address(trader));
    }
}
