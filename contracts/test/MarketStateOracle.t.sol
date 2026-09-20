// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {MarketStateOracle} from "../src/MarketStateOracle.sol";
import {IMarketState, Session} from "../src/interfaces/IMarketState.sol";

contract MockAggregator {
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
        return "MOCK / USD";
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, updatedAt, updatedAt, 1);
    }
}

contract MarketStateOracleTest is Test {
    MarketStateOracle oracle;
    MockAggregator feed;

    address attestor = address(0xA11CE);
    address stranger = address(0xBAD);

    function setUp() public {
        vm.warp(1_700_000_000);
        oracle = new MarketStateOracle(attestor);
        feed = new MockAggregator(350_00000000, block.timestamp); // $350.00, fresh
    }

    // --- access control ---

    function test_onlyAttestorCanAttest() public {
        vm.prank(stranger);
        vm.expectRevert(MarketStateOracle.NotAuthorized.selector);
        oracle.attest(Session.Open, 0);
    }

    function test_rejectsHaircutAboveBps() public {
        vm.prank(attestor);
        vm.expectRevert(MarketStateOracle.InvalidHaircut.selector);
        oracle.attest(Session.Closed, 10_001);
    }

    // --- the core safety property ---

    function test_sessionDecaysToUnknownWhenAgentGoesQuiet() public {
        vm.prank(attestor);
        oracle.attest(Session.Open, 0);
        assertEq(uint8(oracle.session()), uint8(Session.Open));

        // Agent stops reporting. A stale attestation must not keep looking live.
        vm.warp(block.timestamp + 31 minutes);
        assertEq(uint8(oracle.session()), uint8(Session.Unknown), "must fail closed");
    }

    function test_unknownSessionScoresZeroConfidence() public {
        // No attestation at all.
        (,, uint16 conf,) = oracle.priceWithConfidence(address(feed));
        assertEq(conf, 0, "no attestation must mean no confidence");
    }

    // --- confidence model ---

    function test_freshPriceDuringOpenIsFullConfidence() public {
        vm.prank(attestor);
        oracle.attest(Session.Open, 0);
        (int256 price, uint256 age, uint16 conf, Session s) = oracle.priceWithConfidence(address(feed));
        assertEq(price, 350_00000000);
        assertEq(age, 0);
        assertEq(conf, 10_000);
        assertEq(uint8(s), uint8(Session.Open));
    }

    function test_confidenceDecaysLinearlyWithinSession() public {
        vm.prank(attestor);
        oracle.attest(Session.Open, 0);

        vm.warp(block.timestamp + 30 minutes); // half of the 1h open window
        vm.prank(attestor);
        oracle.attest(Session.Open, 0); // keep attestation fresh

        (,, uint16 conf,) = oracle.priceWithConfidence(address(feed));
        assertApproxEqAbs(conf, 5_000, 1, "half the window should be ~half confidence");
    }

    /// @dev The whole reason this project exists: a price that is worthless
    /// during trading hours is still the best estimate available on a Sunday.
    function test_weekendPriceKeepsSomeConfidenceWhereOpenSessionWouldNot() public {
        uint256 ageSeconds = 43 hours; // measured on RH mainnet, Sun 2026-09-20
        vm.warp(block.timestamp + ageSeconds);

        vm.prank(attestor);
        oracle.attest(Session.Open, 0);
        (,, uint16 openConf,) = oracle.priceWithConfidence(address(feed));
        assertEq(openConf, 0, "43h old during Open is garbage");

        vm.prank(attestor);
        oracle.attest(Session.Closed, 0);
        (,, uint16 closedConf,) = oracle.priceWithConfidence(address(feed));
        assertGt(closedConf, 0, "same price over a weekend is still usable");
        console.log("weekend confidence at 43h:", closedConf);
    }

    function test_agentHaircutCutsConfidenceOnEventRisk() public {
        vm.warp(block.timestamp + 12 hours);

        vm.prank(attestor);
        oracle.attest(Session.Closed, 0);
        (,, uint16 calm,) = oracle.priceWithConfidence(address(feed));

        // Agent sees a shock overnight and haircuts by 50%.
        vm.prank(attestor);
        oracle.attest(Session.Closed, 5_000);
        (,, uint16 shocked,) = oracle.priceWithConfidence(address(feed));

        assertApproxEqAbs(shocked, calm / 2, 2, "haircut should halve confidence");
    }

    function test_haircutDoesNotApplyDuringOpenSession() public {
        vm.prank(attestor);
        oracle.attest(Session.Open, 9_000);
        (,, uint16 conf,) = oracle.priceWithConfidence(address(feed));
        assertEq(conf, 10_000, "live price discovery overrides event-risk haircut");
    }

    // --- per-asset halts ---

    function test_assetHaltOverridesOpenMarket() public {
        address asset = address(0xDEAD);
        vm.startPrank(attestor);
        oracle.attest(Session.Open, 0);
        oracle.setAssetSession(asset, Session.Halted);
        vm.stopPrank();

        assertEq(uint8(oracle.session()), uint8(Session.Open));
        assertEq(uint8(oracle.sessionOf(asset)), uint8(Session.Halted));
    }

    function testFuzz_confidenceNeverExceedsBps(uint32 age, uint8 sessionSeed, uint16 haircut) public {
        haircut = uint16(bound(haircut, 0, 10_000));
        Session s = Session(uint8(bound(sessionSeed, 1, 6)));

        vm.prank(attestor);
        oracle.attest(s, haircut);

        feed.set(100_00000000, block.timestamp - bound(age, 0, 400 hours));
        (,, uint16 conf,) = oracle.priceWithConfidence(address(feed));
        assertLe(conf, 10_000);
    }
}
