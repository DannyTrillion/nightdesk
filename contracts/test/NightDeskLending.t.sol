// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {NightDeskLending, IERC20} from "../src/NightDeskLending.sol";
import {MarketStateOracle} from "../src/MarketStateOracle.sol";
import {IMarketState, Session} from "../src/interfaces/IMarketState.sol";

contract MockToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint8 public immutable decimals;

    constructor(uint8 d) {
        decimals = d;
    }

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        return true;
    }

    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        if (allowance[f][msg.sender] != type(uint256).max) allowance[f][msg.sender] -= a;
        balanceOf[f] -= a;
        balanceOf[t] += a;
        return true;
    }
}

contract MockFeed {
    int256 public answer;
    uint256 public updatedAt;

    constructor(int256 a, uint256 u) {
        answer = a;
        updatedAt = u;
    }

    function set(int256 a, uint256 u) external {
        answer = a;
        updatedAt = u;
    }

    function decimals() external pure returns (uint8) {
        return 8;
    }

    function description() external pure returns (string memory) {
        return "MOCK";
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, updatedAt, updatedAt, 1);
    }
}

contract NightDeskLendingTest is Test {
    MarketStateOracle oracle;
    NightDeskLending lending;
    MockToken stock; // 18dp Stock Token
    MockToken usdg; // 6dp debt asset
    MockFeed feed;

    address attestor = address(0xA11CE);
    address alice = address(0xA);
    address keeper = address(0xBEEF);

    function setUp() public {
        vm.warp(1_700_000_000);

        oracle = new MarketStateOracle(attestor);
        stock = new MockToken(18);
        usdg = new MockToken(6);
        feed = new MockFeed(350_00000000, block.timestamp); // $350

        lending = new NightDeskLending(IMarketState(address(oracle)), IERC20(address(usdg)), 6);
        lending.listMarket(address(stock), address(feed), 18);

        usdg.mint(address(lending), 1_000_000e6);
        stock.mint(alice, 100e18); // 100 shares @ $350 = $35,000
        usdg.mint(keeper, 1_000_000e6);

        vm.prank(alice);
        stock.approve(address(lending), type(uint256).max);
        vm.prank(keeper);
        usdg.approve(address(lending), type(uint256).max);
    }

    function _deposit(uint256 amount) internal {
        vm.prank(alice);
        lending.deposit(address(stock), amount);
    }

    function _attest(Session s, uint16 haircut) internal {
        vm.prank(attestor);
        oracle.attest(s, haircut);
    }

    // --- the listing bug this test exists to catch ---

    function test_listedMarketIsActuallyTracked() public view {
        assertEq(lending.listedCount(), 1, "listMarket must register the asset");
    }

    function test_relistingDoesNotDuplicate() public {
        lending.listMarket(address(stock), address(feed), 18);
        assertEq(lending.listedCount(), 1, "relisting must not double-count collateral");
    }

    // --- baseline: full confidence behaves like a normal market ---

    function test_fullConfidenceGivesBaseLtv() public {
        _deposit(100e18);
        _attest(Session.Open, 0);

        // $35,000 collateral at 70% LTV
        assertEq(lending.borrowCapacity(alice), 24_500e6);
    }

    function test_borrowAndRepay() public {
        _deposit(100e18);
        _attest(Session.Open, 0);

        vm.prank(alice);
        lending.borrow(10_000e6);
        assertEq(usdg.balanceOf(alice), 10_000e6);
        assertEq(lending.debt(alice), 10_000e6);

        vm.startPrank(alice);
        usdg.approve(address(lending), type(uint256).max);
        lending.repay(10_000e6);
        vm.stopPrank();
        assertEq(lending.debt(alice), 0);
    }

    function test_cannotBorrowBeyondCapacity() public {
        _deposit(100e18);
        _attest(Session.Open, 0);

        vm.prank(alice);
        vm.expectRevert(NightDeskLending.InsufficientCollateral.selector);
        lending.borrow(24_501e6);
    }

    // --- the actual thesis ---

    /// @notice Borrowing power tapers as the price ages instead of switching off.
    function test_borrowCapacityTapersThroughTheWeekend() public {
        _deposit(100e18);

        uint256[] memory capacities = new uint256[](4);
        // 80h is past the 72h closed-session decay window; 36h is inside it.
        uint256[4] memory ageHours = [uint256(0), 18, 36, 80];

        for (uint256 i = 0; i < 4; i++) {
            feed.set(350_00000000, block.timestamp - ageHours[i] * 1 hours);
            _attest(Session.Closed, 0);
            capacities[i] = lending.borrowCapacity(alice);
            console.log("age(h)", ageHours[i], "capacity(usdg)", capacities[i] / 1e6);
        }

        assertGt(capacities[0], capacities[1], "capacity must shrink as price ages");
        assertGt(capacities[1], capacities[2]);
        assertGt(capacities[2], capacities[3]);
        assertEq(capacities[3], 0, "past the 72h window the price is worthless");
        assertGt(capacities[2], 0, "but at 36h it must still be open for business");

        // The contrast the project exists to demonstrate: a naive integrator
        // rejecting anything past the 24h heartbeat is at zero from 18h on.
        console.log("naive heartbeat integrator capacity past 24h: 0");
    }

    /// @notice The agent's event haircut flows through to real borrowing power.
    function test_agentHaircutReducesBorrowingPower() public {
        _deposit(100e18);
        feed.set(350_00000000, block.timestamp - 12 hours);

        _attest(Session.Closed, 0);
        uint256 calm = lending.borrowCapacity(alice);

        _attest(Session.Closed, 5_000); // agent sees a shock
        uint256 shocked = lending.borrowCapacity(alice);

        assertApproxEqRel(shocked, calm / 2, 0.01e18, "a 50% haircut should halve borrowing power");
    }

    function test_cannotBorrowWhenConfidenceCollapses() public {
        _deposit(100e18);
        feed.set(350_00000000, block.timestamp - 70 hours); // nearly worthless
        _attest(Session.Closed, 0);

        // Derive the expected confidence rather than hardcoding it, so the
        // test tracks the decay curve instead of pinning one magic number.
        uint16 expected = _confidence();
        uint16 floor = lending.MIN_CONFIDENCE_BORROW_BPS();
        assertLt(expected, floor);

        // Read `floor` before pranking: an external call inside expectRevert's
        // arguments consumes the prank, and borrow() would run as this contract.
        bytes memory err =
            abi.encodeWithSelector(NightDeskLending.ConfidenceTooLow.selector, expected, floor);

        vm.prank(alice);
        vm.expectRevert(err);
        lending.borrow(1e6);
    }

    function test_agentOutageBlocksNewBorrowing() public {
        _deposit(100e18);
        _attest(Session.Open, 0);
        vm.warp(block.timestamp + 31 minutes); // attestation expires

        bytes memory err = abi.encodeWithSelector(
            NightDeskLending.ConfidenceTooLow.selector, uint16(0), lending.MIN_CONFIDENCE_BORROW_BPS()
        );

        vm.prank(alice);
        vm.expectRevert(err);
        lending.borrow(1e6);
    }

    // --- the asymmetry, which is the whole safety argument ---

    /// @notice A borrower must not lose collateral to a price nobody can verify.
    function test_liquidationBlockedWhenPriceIsUnverifiable() public {
        _deposit(100e18);
        _attest(Session.Open, 0);
        vm.prank(alice);
        lending.borrow(24_000e6);

        // Price collapses AND the market closes - the dangerous combination.
        feed.set(200_00000000, block.timestamp - 50 hours);
        _attest(Session.Closed, 0);

        uint16 conf = _confidence();
        assertLt(conf, lending.MIN_CONFIDENCE_LIQUIDATE_BPS());

        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                NightDeskLending.ConfidenceTooLow.selector, conf, lending.MIN_CONFIDENCE_LIQUIDATE_BPS()
            )
        );
        lending.liquidate(alice, address(stock), 1_000e6);
    }

    /// @notice But once the market reopens and the price is real, liquidation works.
    function test_liquidationProceedsOnceMarketReopens() public {
        _deposit(100e18);
        _attest(Session.Open, 0);
        vm.prank(alice);
        lending.borrow(24_000e6);

        feed.set(200_00000000, block.timestamp); // fresh print, market open
        _attest(Session.Open, 0);

        assertGe(lending.healthBps(alice), lending.LIQUIDATION_LTV_BPS(), "position should be unhealthy");

        uint256 before = stock.balanceOf(keeper);
        vm.prank(keeper);
        lending.liquidate(alice, address(stock), 5_000e6);

        assertGt(stock.balanceOf(keeper), before, "keeper should receive seized collateral");
        assertEq(lending.debt(alice), 19_000e6);
    }

    function test_healthyPositionCannotBeLiquidated() public {
        _deposit(100e18);
        _attest(Session.Open, 0);
        vm.prank(alice);
        lending.borrow(1_000e6);

        vm.prank(keeper);
        vm.expectRevert(NightDeskLending.PositionHealthy.selector);
        lending.liquidate(alice, address(stock), 100e6);
    }

    function _confidence() internal view returns (uint16) {
        (,, uint16 c,) = oracle.priceWithConfidence(address(feed));
        return c;
    }
}
