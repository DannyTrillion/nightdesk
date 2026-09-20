# NightDesk

**An onchain market-session and price-confidence oracle for Robinhood Chain.**

Stock Tokens trade 24/7. Their price feeds don't.

### → [Live app](https://dannytrillion.github.io/nightdesk/)

Reads Robinhood Chain mainnet from your browser. Nothing is cached or staged -
if the feeds are stale when you open it, you are watching the problem happen.

- **Overview** - the argument, with the week of trading drawn as an hours-by-days matrix
- **Markets** - live feeds, confidence per instrument, and the coverage gaps
- **Position** - a time machine that walks real wall-clock forward from the chain's most
  recent print, so the session changes underneath you as it would in life. Naive
  integrator and NightDesk priced side by side on the same collateral.
- **Agent** - the attestation cycle against live chain state, plus wallet connect to
  price your own Stock Token balances

Connect is read-only: `eth_requestAccounts`, a 4902-aware chain add/switch, then
`balanceOf` against the five Stock Token contracts. Nothing is ever signed.

---

## The gap

Robinhood Chain is an Arbitrum Orbit L2 where tokenized equities live as plain
ERC-20s with Chainlink feeds. The tokens are transferable every second of every
day. The feeds, per Robinhood's own documentation, "update 24/5, following
market hours."

US equity market hours are 32.5 hours out of every 168-hour week.

**A Stock Token has a live price roughly 19% of the time.**

Chainlink publishes an 86400s heartbeat on these feeds, and Robinhood's
integration guide tells builders to compare `updatedAt` against it and "reject
stale prices." Follow that advice and your protocol is offline all weekend.
Ignore it and you are pricing collateral on Friday's close.

This is not theoretical. `test/ForkStaleness.t.sol` forks mainnet and measures
it. Sunday 2026-09-20, 14:53 UTC:

```
heartbeat (s): 86400
---
GOOGL   $350.47    age 42h    past heartbeat: true
QQQ     $720.37    age 43h    past heartbeat: true
TSM     $434.26    age 42h    past heartbeat: true
SGOV    $101.11    age 38h    past heartbeat: true
EWY     $180.93    age 43h    past heartbeat: true
---
stale feeds: 5 of 5
```

Every feed on the chain, simultaneously unusable, by the chain's own standard.

Two more holes found while building:

- **There is no onchain market-status primitive.** Session state is only
  available off-chain, via `GET https://api.robinhood.com/rhj/assets`. No
  contract on Robinhood Chain can currently tell whether the market is open.
- **That API returns `null` anyway.** All 194 live assets report
  `tradingCapabilities: null` while the market is closed — exactly when a
  protocol most needs to know.

## The primitive

Today a consumer contract picks between two bad options: trust a 43-hour-old
price, or halt. NightDesk adds a third.

```solidity
(int256 price, uint256 age, uint16 confidenceBps, Session s)
    = marketState.priceWithConfidence(feed);
```

`confidenceBps` runs 10000 (fully fresh) to 0 (do not use), decaying smoothly
rather than cliff-edging at a heartbeat — and decaying *at a rate that depends
on the session*. An hour-old price during `Open` is suspect, because price
discovery is happening without it. The same hour-old price at 2am Sunday is
the best information in existence.

A lending market reads confidence and widens LTV instead of freezing. An AMM
widens spreads instead of getting picked off. Nobody has to choose between
solvency and being open.

### The agent

An offchain agent attests session state and a **risk haircut** — the part a
clock alone cannot do. Friday's close is a fine estimate of Monday's open
until something happens over the weekend. The agent watches for that, and
haircuts confidence when the last print stops being a good guess.

Session state is derived from observed feed behaviour rather than the assets
API, because the API returns `null` in precisely the conditions that matter.

## Status

| Component | State |
|---|---|
| `MarketStateOracle.sol` | Built, 11 unit tests + fuzz passing |
| `ForkStaleness.t.sol` | Built, passing against live mainnet |
| Attestor agent - chain observation | Built, verified against mainnet |
| Attestor agent - AI risk assessment | Built, verified end to end |
| `NightDeskLending.sol` | Built, 12 tests passing |
| Live demo dashboard | Deployed - [dannytrillion.github.io/nightdesk](https://dannytrillion.github.io/nightdesk/) |
| Testnet deployment | Not started |

## What it buys you

`NightDeskLending` is the flagship consumer: a lending market that reads
confidence and scales risk parameters instead of choosing between mispricing
and halting. Measured in `test_borrowCapacityTapersThroughTheWeekend`, on
$35,000 of collateral at a 70% base LTV:

| Price age | NightDesk capacity | Naive heartbeat integrator |
|---|---|---|
| fresh | $24,500 | $24,500 |
| 18h | $18,375 | $24,500 (trusting a stale price) |
| 36h | $12,250 | $0 (halted) |
| 80h | $0 | $0 |

The naive column is the choice available today: full trust until the heartbeat
expires, then nothing. NightDesk's borrower keeps a shrinking, honestly-priced
line through the weekend.

### The asymmetry

Borrowing needs 20% confidence. Liquidation needs 50%. That gap is deliberate
and it is the part a binary fresh/stale check cannot express: a borrower whose
collateral is merely hard to value should not lose it because the oracle went
quiet. `test_liquidationBlockedWhenPriceIsUnverifiable` pins the behaviour -
the price collapses, the market is closed, and the keeper is turned away until
Monday's real print arrives, at which point
`test_liquidationProceedsOnceMarketReopens` lets the liquidation through.

## Running it

```bash
cd contracts
forge test                                    # unit + fuzz
forge test --match-contract ForkStaleness -vv # live mainnet measurement

cd ../agent
pnpm install
pnpm observe                 # read live feeds, derive session - no API key needed
pnpm attest --dry-run        # + AI risk assessment, nothing written onchain
pnpm attest                  # push session + haircut to the oracle
pnpm watch                   # continuous
```

The agent derives session state by cross-checking a New York clock against
observed feed behaviour, so market holidays are handled without a hardcoded
calendar: if it should be a trading session and every feed has gone quiet for
two hours, the market is closed whatever the calendar says.

## Chain reference

| | Mainnet | Testnet |
|---|---|---|
| Chain ID | 4663 | 46630 |
| RPC | `https://rpc.mainnet.chain.robinhood.com` | `https://rpc.testnet.chain.robinhood.com` |
| Explorer | robinhoodchain.blockscout.com | explorer.testnet.chain.robinhood.com |

Gas is paid in ETH. Contract size limit is 96KB. Stock Tokens are 18-decimal
ERC-20s using ERC-8056 scaled UI amounts (`uiMultiplier()`) for splits and
dividends; Chainlink prices already include the multiplier, so never apply it
twice. Feeds are 8 decimals.

Built for the Arbitrum Open House Singapore Buildathon, submissions due
2026-10-04.
