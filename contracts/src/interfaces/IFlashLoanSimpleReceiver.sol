// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPoolAddressesProvider} from "./IPoolAddressesProvider.sol";

interface IFlashLoanSimpleReceiver {
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool);

    function ADDRESSES_PROVIDER() external view returns (IPoolAddressesProvider);
    function POOL() external view returns (address);
}
