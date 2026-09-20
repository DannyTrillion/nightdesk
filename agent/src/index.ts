import "dotenv/config";
import {observeFeeds, attestorClient, marketStateAbi, HEARTBEAT_SECONDS, type FeedObservation} from "./chain.js";
import {deriveSession, Session, SESSION_NAMES} from "./session.js";
import {assessRisk} from "./risk.js";
import type {Address} from "viem";

function hours(seconds: number): string {
  return `${(seconds / 3600).toFixed(1)}h`;
}

function printObservation(feeds: FeedObservation[], derived: ReturnType<typeof deriveSession>) {
  console.log(`\n  session    ${SESSION_NAMES[derived.session]}` +
    (derived.overridden ? `  (calendar said ${SESSION_NAMES[derived.scheduled]}; feeds are quiet)` : ""));
  console.log(`  heartbeat  ${HEARTBEAT_SECONDS}s`);
  console.log(`  median age ${hours(derived.medianAgeSeconds)}\n`);

  console.log(`  ${"TICKER".padEnd(8)}${"PRICE".padEnd(12)}${"AGE".padEnd(9)}STATUS`);
  for (const f of feeds) {
    const status = f.pastHeartbeat ? "STALE" : "ok";
    console.log(
      `  ${f.ticker.padEnd(8)}${("$" + f.priceUsd.toFixed(2)).padEnd(12)}${hours(f.ageSeconds).padEnd(9)}${status}`,
    );
  }

  const stale = feeds.filter((f) => f.pastHeartbeat).length;
  console.log(`\n  ${stale}/${feeds.length} feeds past heartbeat\n`);
}

async function observe() {
  const feeds = await observeFeeds();
  printObservation(feeds, deriveSession(feeds));
}

async function attest({dryRun}: {dryRun: boolean}) {
  const feeds = await observeFeeds();
  const derived = deriveSession(feeds);
  printObservation(feeds, derived);

  console.log("  assessing event risk...\n");
  const risk = await assessRisk(feeds, derived.session);

  console.log(`  severity   ${risk.severity}`);
  console.log(`  haircut    ${risk.haircut_bps} bps`);
  console.log(`  headline   ${risk.headline}`);
  if (risk.affected_tickers.length) console.log(`  exposed    ${risk.affected_tickers.join(", ")}`);
  console.log(`\n  ${risk.reasoning}\n`);

  if (dryRun) {
    console.log("  dry run, nothing written onchain\n");
    return;
  }

  const key = process.env.PRIVATE_KEY as `0x${string}` | undefined;
  const oracle = process.env.MARKET_STATE_ADDRESS as Address | undefined;
  if (!key || !oracle) {
    console.log("  set PRIVATE_KEY and MARKET_STATE_ADDRESS to attest onchain\n");
    return;
  }

  const wallet = attestorClient(key);
  const hash = await wallet.writeContract({
    address: oracle,
    abi: marketStateAbi,
    functionName: "attest",
    args: [derived.session, risk.haircut_bps],
  });
  console.log(`  attested: ${hash}\n`);
}

async function watch(intervalMinutes: number) {
  console.log(`  watching, every ${intervalMinutes}m. ctrl-c to stop.`);
  for (;;) {
    try {
      await attest({dryRun: false});
    } catch (err) {
      // A failed cycle must not kill the watcher; the contract fails closed
      // to Unknown on its own if we stay down past the attestation TTL.
      console.error(`  cycle failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await new Promise((r) => setTimeout(r, intervalMinutes * 60_000));
  }
}

const command = process.argv[2] ?? "observe";
const dryRun = process.argv.includes("--dry-run");

switch (command) {
  case "observe":
    await observe();
    break;
  case "attest":
    await attest({dryRun});
    break;
  case "watch":
    await watch(Number(process.env.WATCH_INTERVAL_MINUTES ?? 15));
    break;
  default:
    console.error(`unknown command: ${command}\nusage: observe | attest [--dry-run] | watch`);
    process.exit(1);
}

export {Session};
