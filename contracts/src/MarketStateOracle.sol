// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IMarketState, Session} from "./interfaces/IMarketState.sol";
import {IAggregatorV3} from "./interfaces/IAggregatorV3.sol";

/// @title MarketStateOracle
/// @notice Onchain market-session and price-confidence oracle for Robinhood Chain.
///
/// Why this exists: Stock Tokens trade 24/7, but their Chainlink feeds update
/// 24/5 with an 86400s heartbeat. Measured on mainnet on a Sunday, every feed
/// was 38-44h stale. A consumer contract today has two bad options - trust a
/// price from Friday's close, or refuse to operate all weekend.
///
/// This contract adds the missing third option: keep operating, but know
/// exactly how much the price is worth. An offchain attestor (the NightDesk
/// agent) pushes session state and a risk haircut; the contract derives a
/// confidence score that decays smoothly across the closure.
contract MarketStateOracle is IMarketState {
    // -------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------
    error NotAuthorized();
    error InvalidFeed();
    error InvalidHaircut();
    error StaleAttestation();

    // -------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------
    event SessionAttested(Session indexed session, uint16 riskHaircutBps, uint64 observedAt, address attestor);
    event AssetSessionSet(address indexed asset, Session indexed session);
    event AttestorSet(address indexed attestor, bool allowed);
    event AttestationTtlSet(uint32 ttl);

    // -------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------
    uint16 internal constant BPS = 10_000;

    /// @dev How long a price stays useful, per session. During `Open` a price
    /// an hour old is already suspect; over a weekend closure a Friday price
    /// is the best information that exists, so it decays over ~72h instead.
    uint32 internal constant DECAY_OPEN = 1 hours;
    uint32 internal constant DECAY_EXTENDED = 6 hours;
    uint32 internal constant DECAY_CLOSED = 72 hours;

    // -------------------------------------------------------------------
    // Storage
    // -------------------------------------------------------------------
    address public owner;
    mapping(address => bool) public isAttestor;

    /// @notice Most recent attested market session.
    Session internal _session;

    /// @notice Agent-assessed haircut for overnight event risk, in bps.
    /// Raised when something happened since the close that makes the last
    /// print a poor estimate - an earnings miss, a geopolitical shock.
    uint16 public riskHaircutBps;

    /// @notice When the attestor last observed the market.
    uint64 public attestedAt;

    /// @notice How long an attestation remains valid before the contract
    /// falls back to `Unknown`. Fail closed, never silently trust a dead agent.
    uint32 public attestationTtl = 30 minutes;

    /// @notice Per-asset overrides, for halts while the market is otherwise open.
    mapping(address => Session) internal _assetSession;

    // -------------------------------------------------------------------
    // Modifiers
    // -------------------------------------------------------------------
    modifier onlyOwner() {
        if (msg.sender != owner) revert NotAuthorized();
        _;
    }

    modifier onlyAttestor() {
        if (!isAttestor[msg.sender]) revert NotAuthorized();
        _;
    }

    constructor(address initialAttestor) {
        owner = msg.sender;
        isAttestor[initialAttestor] = true;
        _session = Session.Unknown;
        emit AttestorSet(initialAttestor, true);
    }

    // -------------------------------------------------------------------
    // Attestation (agent-facing)
    // -------------------------------------------------------------------

    /// @notice Push the current market session and event-risk haircut.
    /// @param newSession Session observed by the agent.
    /// @param haircutBps Confidence haircut for overnight event risk, 0-10000.
    function attest(Session newSession, uint16 haircutBps) external onlyAttestor {
        if (haircutBps > BPS) revert InvalidHaircut();
        _session = newSession;
        riskHaircutBps = haircutBps;
        attestedAt = uint64(block.timestamp);
        emit SessionAttested(newSession, haircutBps, uint64(block.timestamp), msg.sender);
    }

    /// @notice Flag or clear an asset-specific halt.
    function setAssetSession(address asset, Session s) external onlyAttestor {
        _assetSession[asset] = s;
        emit AssetSessionSet(asset, s);
    }

    // -------------------------------------------------------------------
    // Reads
    // -------------------------------------------------------------------

    /// @inheritdoc IMarketState
    function session() public view returns (Session) {
        // A stale attestation is worse than no attestation: it looks live.
        if (block.timestamp - attestedAt > attestationTtl) return Session.Unknown;
        return _session;
    }

    /// @inheritdoc IMarketState
    function sessionOf(address asset) public view returns (Session) {
        Session s = _assetSession[asset];
        if (s == Session.Halted) return s;
        return session();
    }

    /// @inheritdoc IMarketState
    function priceAge(address feed) public view returns (uint256) {
        (,,, uint256 updatedAt,) = IAggregatorV3(feed).latestRoundData();
        if (updatedAt == 0) revert InvalidFeed();
        return block.timestamp > updatedAt ? block.timestamp - updatedAt : 0;
    }

    /// @inheritdoc IMarketState
    function priceWithConfidence(address feed)
        public
        view
        returns (int256 price, uint256 ageSeconds, uint16 confidenceBps, Session sess)
    {
        (, int256 answer,, uint256 updatedAt,) = IAggregatorV3(feed).latestRoundData();
        if (updatedAt == 0 || answer <= 0) revert InvalidFeed();

        ageSeconds = block.timestamp > updatedAt ? block.timestamp - updatedAt : 0;
        sess = session();
        confidenceBps = _confidence(ageSeconds, sess);
        price = answer;
    }

    /// @notice Confidence as a function of age and session.
    /// @dev Unknown always scores 0 - if the agent is down we say so rather
    /// than guessing. Otherwise confidence falls linearly across the window
    /// for the session, then the agent's event-risk haircut is applied.
    function _confidence(uint256 ageSeconds, Session sess) internal view returns (uint16) {
        if (sess == Session.Unknown) return 0;

        uint32 window = _decayWindow(sess);
        if (ageSeconds >= window) return 0;

        uint256 base = BPS - ((ageSeconds * BPS) / window);
        uint256 haircut = sess == Session.Open ? 0 : riskHaircutBps;
        return uint16((base * (BPS - haircut)) / BPS);
    }

    function _decayWindow(Session sess) internal pure returns (uint32) {
        if (sess == Session.Open) return DECAY_OPEN;
        if (sess == Session.PreMarket || sess == Session.PostMarket) return DECAY_EXTENDED;
        return DECAY_CLOSED;
    }

    // -------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------
    function setAttestor(address attestor, bool allowed) external onlyOwner {
        isAttestor[attestor] = allowed;
        emit AttestorSet(attestor, allowed);
    }

    function setAttestationTtl(uint32 ttl) external onlyOwner {
        attestationTtl = ttl;
        emit AttestationTtlSet(ttl);
    }
}
