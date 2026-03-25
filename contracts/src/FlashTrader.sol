// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IFlashLoanSimpleReceiver} from "./interfaces/IFlashLoanSimpleReceiver.sol";
import {IPoolAddressesProvider} from "./interfaces/IPoolAddressesProvider.sol";
import {IERC20} from "./interfaces/IERC20.sol";
import {ISwapRouter} from "./interfaces/ISwapRouter.sol";
import {IUniswapV2Router} from "./interfaces/IUniswapV2Router.sol";

/**
 * @title FlashTrader
 * @notice Executes flash loan arbitrage across DEXs on L2 chains.
 *         Borrows from Aave V3, swaps through encoded route, repays loan + fee.
 */
contract FlashTrader is IFlashLoanSimpleReceiver {
    address public owner;
    address public immutable aavePool;
    IPoolAddressesProvider public immutable override ADDRESSES_PROVIDER;
    address public immutable override POOL;

    // Supported DEX router types
    uint8 public constant DEX_UNISWAP_V3 = 1;
    uint8 public constant DEX_SUSHISWAP = 2;

    struct SwapStep {
        uint8 dexType;
        address router;
        address tokenIn;
        address tokenOut;
        uint24 fee;
        uint256 amountIn; // 0 = use full balance
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "FlashTrader: not owner");
        _;
    }

    constructor(address _aavePool, address _addressesProvider) {
        owner = msg.sender;
        aavePool = _aavePool;
        POOL = _aavePool;
        ADDRESSES_PROVIDER = IPoolAddressesProvider(_addressesProvider);
    }

    /**
     * @notice Request a flash loan and execute arbitrage.
     * @param asset The token to borrow
     * @param amount The amount to borrow
     * @param params ABI-encoded SwapStep[] defining the arbitrage route
     */
    function requestFlashLoan(
        address asset,
        uint256 amount,
        bytes calldata params
    ) external onlyOwner {
        // Call Aave V3 flashLoanSimple
        (bool success,) = aavePool.call(
            abi.encodeWithSignature(
                "flashLoanSimple(address,address,uint256,bytes,uint16)",
                address(this), // receiver
                asset,
                amount,
                params,
                0 // referral code
            )
        );
        require(success, "FlashTrader: flash loan failed");
    }

    /**
     * @notice Called by Aave after receiving the flash loan.
     *         Executes the arbitrage route and ensures repayment.
     */
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        require(msg.sender == aavePool, "FlashTrader: caller not pool");
        require(initiator == address(this), "FlashTrader: bad initiator");

        // Decode and execute swap route
        SwapStep[] memory steps = abi.decode(params, (SwapStep[]));
        _executeSwapRoute(steps);

        // Repay flash loan: amount + premium (fee)
        uint256 amountOwed = amount + premium;
        IERC20(asset).approve(aavePool, amountOwed);

        // Send profit to owner
        uint256 balance = IERC20(asset).balanceOf(address(this));
        if (balance > amountOwed) {
            IERC20(asset).transfer(owner, balance - amountOwed);
        }

        return true;
    }

    function _executeSwapRoute(SwapStep[] memory steps) internal {
        for (uint256 i = 0; i < steps.length; i++) {
            SwapStep memory step = steps[i];
            uint256 amountIn = step.amountIn == 0
                ? IERC20(step.tokenIn).balanceOf(address(this))
                : step.amountIn;

            if (step.dexType == DEX_UNISWAP_V3) {
                _swapUniswapV3(step.router, step.tokenIn, step.tokenOut, step.fee, amountIn);
            } else if (step.dexType == DEX_SUSHISWAP) {
                _swapSushiSwap(step.router, step.tokenIn, step.tokenOut, amountIn);
            }
        }
    }

    function _swapUniswapV3(
        address router,
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn
    ) internal {
        IERC20(tokenIn).approve(router, amountIn);

        ISwapRouter.ExactInputSingleParams memory params = ISwapRouter.ExactInputSingleParams({
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            fee: fee,
            recipient: address(this),
            deadline: block.timestamp,
            amountIn: amountIn,
            amountOutMinimum: 0, // In production: use calculated minimum
            sqrtPriceLimitX96: 0
        });

        ISwapRouter(router).exactInputSingle(params);
    }

    function _swapSushiSwap(
        address router,
        address tokenIn,
        address tokenOut,
        uint256 amountIn
    ) internal {
        IERC20(tokenIn).approve(router, amountIn);

        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;

        IUniswapV2Router(router).swapExactTokensForTokens(
            amountIn,
            0, // amountOutMin — flash loan reverts if unprofitable anyway
            path,
            address(this),
            block.timestamp
        );
    }

    // ── Admin functions ──────────────────────────────────────────────

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "FlashTrader: zero address");
        owner = newOwner;
    }

    function rescueTokens(address token, uint256 amount) external onlyOwner {
        IERC20(token).transfer(owner, amount);
    }

    receive() external payable {}
}
