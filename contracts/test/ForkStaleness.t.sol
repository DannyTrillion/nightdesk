// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {IAggregatorV3} from "../src/interfaces/IAggregatorV3.sol";
import {MarketStateOracle} from "../src/MarketStateOracle.sol";
import {Session} from "../src/interfaces/IMarketState.sol";

/// @notice Forks Robinhood Chain mainnet and measures real feed staleness.
///
/// This is the evidence behind the project. Chainlink documents an 86400s
/// heartbeat for these feeds and Robinhood's docs tell integrators to
/// "reject stale prices". Run this on a weekend and every feed fails that
/// test - which means every protocol following the official guidance is
/// offline for most of the week.
///
///     forge test --match-contract ForkStaleness -vv
contract ForkStalenessTest is Test {
    uint256 constant HEARTBEAT = 86_400;

    address constant GOOGL = 0xF6f373a037c30F0e5010d854385cA89185AE638b;
    address constant QQQ = 0x80901d846d5D7B030F26B480776EE3b29374C2ae;
    address constant TSM = 0x874cF94aa8eC88Fd9560094dD065f2fB3E41Fc2F;
    address constant SGOV = 0xa0DF4ee0fFf975306345875E3548Fcc519577A11;
    address constant EWY = 0xEFdf54610B62A7753Ec30bDc380847c12D32e1D1;

    function setUp() public {
        // Skips gracefully when the RPC is unreachable (offline, CI without net).
        try vm.createSelectFork("rh_mainnet") {}
        catch {
            vm.skip(true);
        }
    }

    function test_measureLiveFeedStaleness() public view {
        address[5] memory feeds = [GOOGL, QQQ, TSM, SGOV, EWY];
        string[5] memory names = ["GOOGL", "QQQ", "TSM", "SGOV", "EWY"];

        uint256 stale;
        console.log("heartbeat (s):", HEARTBEAT);
        console.log("---");

        for (uint256 i = 0; i < feeds.length; i++) {
            (, int256 answer,, uint256 updatedAt,) = IAggregatorV3(feeds[i]).latestRoundData();
            uint256 age = block.timestamp - updatedAt;

            console.log(names[i]);
            console.log("  price (8dp):", uint256(answer));
            console.log("  age (hours):", age / 3600);
            console.log("  past heartbeat:", age > HEARTBEAT);

            if (age > HEARTBEAT) stale++;
        }

        console.log("---");
        console.log("stale feeds:", stale, "of", feeds.length);
    }

    /// @notice The same Friday price, scored two ways. Shows what the
    /// primitive buys you: a protocol that stays solvent *and* open.
    function test_confidenceSalvagesAWeekendPrice() public {
        MarketStateOracle oracle = new MarketStateOracle(address(this));

        (,,, uint256 updatedAt,) = IAggregatorV3(GOOGL).latestRoundData();
        uint256 age = block.timestamp - updatedAt;

        if (age <= HEARTBEAT) {
            console.log("market appears live, age (h):", age / 3600);
            return;
        }

        // What a naive integrator does today: hard reject past the heartbeat.
        console.log("naive heartbeat check -> REJECT, protocol halts");

        oracle.attest(Session.Closed, 0);
        (, uint256 reportedAge, uint16 conf,) = oracle.priceWithConfidence(GOOGL);

        console.log("NightDesk age (hours):", reportedAge / 3600);
        console.log("NightDesk confidence (bps):", conf);
        assertGt(conf, 0, "weekend price should remain usable with a haircut");
    }
}
