// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IMarketState, Session} from "./interfaces/IMarketState.sol";

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title NightDeskLending
/// @notice A lending market that stays open when the price feed goes quiet.
///
/// The point of this contract is the contrast. A conventional market on
/// Robinhood Chain has two choices once the equity market closes and the feed
/// stops updating: keep lending against Friday's price, or halt. The first
/// risks lending into a gap. The second means the protocol is shut for ~81%
/// of the week.
///
/// NightDeskLending reads confidence from MarketStateOracle and scales its
/// risk parameters continuously instead. Borrowing power shrinks as the price
/// ages. Liquidation holds a higher bar than borrowing, because seizing
/// someone's collateral on a price nobody can verify is the one mistake that
/// cannot be undone.
contract NightDeskLending {
    error NotSupported();
    error InsufficientCollateral();
    error ConfidenceTooLow(uint16 confidenceBps, uint16 requiredBps);
    error PositionHealthy();
    error NothingToRepay();

    event Deposited(address indexed user, address indexed asset, uint256 amount);
    event Withdrawn(address indexed user, address indexed asset, uint256 amount);
    event Borrowed(address indexed user, uint256 amount, uint16 confidenceBps);
    event Repaid(address indexed user, uint256 amount);
    event MarketListed(address indexed asset, address indexed feed, uint8 assetDecimals);
    event Liquidated(address indexed user, address indexed keeper, uint256 debtRepaid, uint256 collateralSeized);

    uint16 internal constant BPS = 10_000;

    /// @notice Borrowing power at full confidence. Scaled down from here.
    uint16 public constant BASE_LTV_BPS = 7_000; // 70%

    /// @notice A position is liquidatable past this LTV.
    uint16 public constant LIQUIDATION_LTV_BPS = 8_500; // 85%

    /// @notice Bonus paid to whoever liquidates.
    uint16 public constant LIQUIDATION_BONUS_BPS = 500; // 5%

    /// @notice Minimum confidence to take on new debt. Below this the price is
    /// too uncertain to size a new position against.
    uint16 public constant MIN_CONFIDENCE_BORROW_BPS = 2_000; // 20%

    /// @notice Minimum confidence to liquidate. Deliberately stricter than
    /// borrowing: a borrower who is merely hard to value should not lose their
    /// collateral because the oracle went quiet. This is the asymmetry that a
    /// binary fresh/stale check cannot express.
    uint16 public constant MIN_CONFIDENCE_LIQUIDATE_BPS = 5_000; // 50%

    IMarketState public immutable marketState;
    IERC20 public immutable debtAsset; // USDG
    uint8 public immutable debtDecimals;

    struct Market {
        address feed;
        uint8 assetDecimals;
        bool supported;
    }

    mapping(address => Market) public markets;
    mapping(address => mapping(address => uint256)) public collateral; // user => asset => amount
    mapping(address => uint256) public debt;

    /// @dev Every listed asset, so collateral value can be summed without the
    /// caller having to enumerate positions.
    address[] internal _listed;

    constructor(IMarketState _marketState, IERC20 _debtAsset, uint8 _debtDecimals) {
        marketState = _marketState;
        debtAsset = _debtAsset;
        debtDecimals = _debtDecimals;
    }

    // -------------------------------------------------------------------
    // Market config
    // -------------------------------------------------------------------

    /// @dev Permissionless listing is fine for a demo; a production deploy
    /// would gate this. Kept open so judges can list any Stock Token.
    function listMarket(address asset, address feed, uint8 assetDecimals) external {
        if (!markets[asset].supported) _listed.push(asset);
        markets[asset] = Market({feed: feed, assetDecimals: assetDecimals, supported: true});
        emit MarketListed(asset, feed, assetDecimals);
    }

    // -------------------------------------------------------------------
    // User actions
    // -------------------------------------------------------------------

    function deposit(address asset, uint256 amount) external {
        if (!markets[asset].supported) revert NotSupported();
        collateral[msg.sender][asset] += amount;
        require(IERC20(asset).transferFrom(msg.sender, address(this), amount), "transfer failed");
        emit Deposited(msg.sender, asset, amount);
    }

    function withdraw(address asset, uint256 amount) external {
        collateral[msg.sender][asset] -= amount;
        if (debt[msg.sender] > 0 && !_withinBorrowLimit(msg.sender)) revert InsufficientCollateral();
        require(IERC20(asset).transfer(msg.sender, amount), "transfer failed");
        emit Withdrawn(msg.sender, asset, amount);
    }

    /// @notice Borrow against deposited Stock Tokens.
    /// @dev Borrowing power is the base LTV scaled by price confidence, so it
    /// tapers through the weekend rather than switching off.
    function borrow(uint256 amount) external {
        uint16 confidence = _portfolioConfidence(msg.sender);
        if (confidence < MIN_CONFIDENCE_BORROW_BPS) {
            revert ConfidenceTooLow(confidence, MIN_CONFIDENCE_BORROW_BPS);
        }

        debt[msg.sender] += amount;
        if (!_withinBorrowLimit(msg.sender)) revert InsufficientCollateral();

        require(debtAsset.transfer(msg.sender, amount), "transfer failed");
        emit Borrowed(msg.sender, amount, confidence);
    }

    function repay(uint256 amount) external {
        uint256 owed = debt[msg.sender];
        if (owed == 0) revert NothingToRepay();
        uint256 paid = amount > owed ? owed : amount;
        debt[msg.sender] = owed - paid;
        require(debtAsset.transferFrom(msg.sender, address(this), paid), "transfer failed");
        emit Repaid(msg.sender, paid);
    }

    /// @notice Seize collateral from an unhealthy position.
    /// @dev Requires materially higher confidence than borrowing does. If the
    /// market has been closed long enough that the price is guesswork, the
    /// position waits for Monday instead of being liquidated on a guess.
    function liquidate(address user, address asset, uint256 repayAmount) external {
        uint16 confidence = _portfolioConfidence(user);
        if (confidence < MIN_CONFIDENCE_LIQUIDATE_BPS) {
            revert ConfidenceTooLow(confidence, MIN_CONFIDENCE_LIQUIDATE_BPS);
        }
        if (_healthBps(user) < LIQUIDATION_LTV_BPS) revert PositionHealthy();

        uint256 owed = debt[user];
        uint256 paid = repayAmount > owed ? owed : repayAmount;
        debt[user] = owed - paid;

        uint256 seized = _debtToCollateral(asset, paid);
        seized = (seized * (BPS + LIQUIDATION_BONUS_BPS)) / BPS;

        uint256 available = collateral[user][asset];
        if (seized > available) seized = available;
        collateral[user][asset] = available - seized;

        require(debtAsset.transferFrom(msg.sender, address(this), paid), "repay failed");
        require(IERC20(asset).transfer(msg.sender, seized), "seize failed");
        emit Liquidated(user, msg.sender, paid, seized);
    }

    // -------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------

    /// @notice Effective borrowing power in debt-asset terms.
    function borrowCapacity(address user) public view returns (uint256) {
        uint256 value = confidenceAdjustedCollateralValue(user);
        return (value * BASE_LTV_BPS) / BPS;
    }

    /// @notice Collateral value with the confidence haircut applied.
    /// This single line is the difference between this market and a normal one.
    function confidenceAdjustedCollateralValue(address user) public view returns (uint256) {
        uint256 total;
        for (uint256 i = 0; i < _listed.length; i++) {
            address asset = _listed[i];
            uint256 bal = collateral[user][asset];
            if (bal == 0) continue;

            Market memory m = markets[asset];
            (int256 price,, uint16 confidence,) = marketState.priceWithConfidence(m.feed);

            uint256 raw = (bal * uint256(price)) / (10 ** m.assetDecimals); // price is 8dp
            uint256 scaled = (raw * (10 ** debtDecimals)) / 1e8;
            total += (scaled * confidence) / BPS;
        }
        return total;
    }

    /// @notice Current LTV in bps. 0 when there is no debt.
    function _healthBps(address user) internal view returns (uint16) {
        uint256 value = confidenceAdjustedCollateralValue(user);
        if (value == 0) return debt[user] == 0 ? 0 : type(uint16).max;
        uint256 ltv = (debt[user] * BPS) / value;
        return ltv > type(uint16).max ? type(uint16).max : uint16(ltv);
    }

    function healthBps(address user) external view returns (uint16) {
        return _healthBps(user);
    }

    function _withinBorrowLimit(address user) internal view returns (bool) {
        return debt[user] <= borrowCapacity(user);
    }

    /// @notice Lowest confidence across the user's collateral. A portfolio is
    /// only as knowable as its least knowable leg.
    function _portfolioConfidence(address user) internal view returns (uint16) {
        uint16 lowest = BPS;
        bool any;
        for (uint256 i = 0; i < _listed.length; i++) {
            address asset = _listed[i];
            if (collateral[user][asset] == 0) continue;
            (,, uint16 c,) = marketState.priceWithConfidence(markets[asset].feed);
            if (c < lowest) lowest = c;
            any = true;
        }
        return any ? lowest : BPS;
    }

    function _debtToCollateral(address asset, uint256 debtAmount) internal view returns (uint256) {
        Market memory m = markets[asset];
        (int256 price,,,) = marketState.priceWithConfidence(m.feed);
        uint256 numer = debtAmount * 1e8 * (10 ** m.assetDecimals);
        return numer / (uint256(price) * (10 ** debtDecimals));
    }

    function listedCount() external view returns (uint256) {
        return _listed.length;
    }
}
