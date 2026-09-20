import type {FeedObservation} from "./chain.js";

/// Mirrors the Session enum in MarketStateOracle.sol. Order is load-bearing:
/// these are the uint8 values the contract expects.
export enum Session {
  Unknown = 0,
  Closed = 1,
  PreMarket = 2,
  Open = 3,
  PostMarket = 4,
  Overnight = 5,
  Halted = 6,
}

export const SESSION_NAMES = [
  "Unknown", "Closed", "PreMarket", "Open", "PostMarket", "Overnight", "Halted",
] as const;

/// Minutes past midnight in New York, DST-correct without a tz library.
function newYorkClock(at: Date): {minutes: number; weekday: number} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
    hour12: false,
  }).formatToParts(at);

  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  // Intl renders midnight as "24" in some ICU versions; normalise it.
  const hour = Number(get("hour")) % 24;
  return {
    minutes: hour * 60 + Number(get("minute")),
    weekday: weekdays.indexOf(get("weekday")),
  };
}

/// What the calendar says the session should be, ignoring holidays.
export function scheduledSession(at: Date = new Date()): Session {
  const {minutes, weekday} = newYorkClock(at);
  if (weekday === 0 || weekday === 6) return Session.Closed;

  if (minutes >= 4 * 60 && minutes < 9 * 60 + 30) return Session.PreMarket;
  if (minutes >= 9 * 60 + 30 && minutes < 16 * 60) return Session.Open;
  if (minutes >= 16 * 60 && minutes < 20 * 60) return Session.PostMarket;
  return Session.Overnight;
}

/// A clock alone cannot see market holidays, and hardcoding a holiday calendar
/// rots. Instead we cross-check the clock against what the feeds are actually
/// doing: if it should be a trading session but every feed has gone quiet,
/// the market is closed regardless of what the calendar says.
export function deriveSession(feeds: FeedObservation[], at: Date = new Date()): {
  session: Session;
  scheduled: Session;
  overridden: boolean;
  medianAgeSeconds: number;
} {
  const scheduled = scheduledSession(at);

  const ages = feeds.map((f) => f.ageSeconds).sort((a, b) => a - b);
  const medianAgeSeconds = ages.length === 0 ? Number.POSITIVE_INFINITY : ages[Math.floor(ages.length / 2)]!;

  const tradingHours =
    scheduled === Session.Open || scheduled === Session.PreMarket || scheduled === Session.PostMarket;

  // Two hours of silence during a session that should be live means the
  // underlying is not trading - a holiday, or a feed outage. Both warrant
  // treating the price as a closed-market price rather than a live one.
  const QUIET = 2 * 60 * 60;
  if (tradingHours && medianAgeSeconds > QUIET) {
    return {session: Session.Closed, scheduled, overridden: true, medianAgeSeconds};
  }

  return {session: scheduled, scheduled, overridden: false, medianAgeSeconds};
}
