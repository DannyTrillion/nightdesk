// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Trading session of the underlying US equity market.
/// Robinhood Chain itself never halts, so this describes the *underlying*,
/// which is what actually governs whether a price can be trusted.
enum Session {
    Unknown, // no fresh attestation; assume the worst
    Closed, // weekend or holiday
    PreMarket, // 04:00-09:30 ET
    Open, // 09:30-16:00 ET, the only session with continuous price discovery
    PostMarket, // 16:00-20:00 ET
    Overnight, // 20:00-04:00 ET
    Halted // asset-specific halt
}

/// @notice The primitive Robinhood Chain is missing: an onchain answer to
/// "is the underlying market open, and how much should I trust this price?"
///
/// Stock Tokens trade 24/7 but their Chainlink feeds update 24/5. For roughly
/// 81% of the week a consumer contract is choosing between a stale price and
/// no price. This contract replaces that binary with graduated confidence.
interface IMarketState {
    /// @notice Current session for the market as a whole.
    function session() external view returns (Session);

    /// @notice Session for one asset, which may be Halted while the market is Open.
    function sessionOf(address asset) external view returns (Session);

    /// @notice Seconds since `feed` last posted a price.
    function priceAge(address feed) external view returns (uint256);

    /// @notice Price plus the context needed to use it responsibly.
    /// @param feed Chainlink aggregator proxy for the asset.
    /// @return price Latest answer, at the feed's own decimals.
    /// @return ageSeconds How old that answer is.
    /// @return confidenceBps 10000 = fully fresh, 0 = untrustworthy. Decays
    ///         across the closed session rather than cliff-edging at a heartbeat.
    /// @return sess Session the price was last updated in.
    function priceWithConfidence(address feed)
        external
        view
        returns (int256 price, uint256 ageSeconds, uint16 confidenceBps, Session sess);
}
