import Anthropic from "@anthropic-ai/sdk";
import {zodOutputFormat} from "@anthropic-ai/sdk/helpers/zod";
import {z} from "zod";
import type {FeedObservation} from "./chain.js";
import {Session, SESSION_NAMES} from "./session.js";

const MODEL = "claude-opus-5";

export const RiskAssessment = z.object({
  haircut_bps: z
    .number()
    .int()
    .min(0)
    .max(10_000)
    .describe("Confidence haircut in basis points. 0 = last close is still a fair estimate. 10000 = unusable."),
  severity: z.enum(["none", "minor", "elevated", "severe"]),
  headline: z.string().describe("One line a risk officer could read at a glance."),
  reasoning: z.string().describe("Why this haircut, citing the specific events that move the estimate."),
  affected_tickers: z.array(z.string()).describe("Tickers most exposed. Empty if the risk is broad-market."),
});

export type RiskAssessment = z.infer<typeof RiskAssessment>;

/// Step 1: find out whether anything happened since the last print.
/// This is the part a clock cannot do. Friday's close is a fine estimate of
/// Monday's open right up until it isn't, and the difference is news.
async function researchOvernightEvents(
  client: Anthropic,
  feeds: FeedObservation[],
  session: Session,
): Promise<{summary: string; searchOk: boolean; resultCount: number; searchError?: string}> {
  const lastPrint = new Date(Math.max(...feeds.map((f) => f.updatedAt)) * 1000).toISOString();

  // Streamed: a web search plus adaptive thinking routinely runs past the
  // non-streaming socket timeout, which surfaces as UND_ERR_SOCKET rather
  // than anything resembling an API error.
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 32000,
    thinking: {type: "adaptive"},
    system:
      "You assess whether stale equity prices remain usable as collateral marks. " +
      "You are terse and specific. You care only about events that would move a price, " +
      "not general commentary.",
    messages: [
      {
        role: "user",
        content:
          `The US equity market session is currently: ${SESSION_NAMES[session]}.\n` +
          `The most recent onchain price print was at ${lastPrint} (UTC).\n` +
          `Current time is ${new Date().toISOString()} (UTC).\n\n` +
          `Tracked instruments: ${feeds.map((f) => `${f.ticker} @ $${f.priceUsd.toFixed(2)}`).join(", ")}\n\n` +
          `Search for market-moving events since that last print: earnings surprises, ` +
          `guidance changes, macro data, geopolitical shocks, index-level futures moves, ` +
          `or anything specific to the tracked names. ` +
          `Report what you find in under 200 words. If nothing material happened, say so plainly.`,
      },
    ],
    tools: [{type: "web_search_20260209", name: "web_search", max_uses: 5}],
  });

  const response = await stream.finalMessage();

  // Server-tool failures arrive as a 200 with an error object in place of the
  // results list. Nothing throws. Left unchecked, the model quietly writes an
  // assessment from no evidence and the haircut becomes a guess wearing a
  // number, so surface it rather than swallow it.
  let resultCount = 0;
  let searchError: string | undefined;
  for (const block of response.content) {
    if (block.type !== "web_search_tool_result") continue;
    const content = (block as {content: unknown}).content;
    if (Array.isArray(content)) resultCount += content.length;
    else searchError = JSON.stringify(content);
  }
  // A search that ran and returned nothing is not the same as a search that
  // errored, but for risk purposes both mean the same thing: no evidence.
  const searchOk = resultCount > 0;

  const summary = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  return {summary, searchOk, resultCount, searchError};
}

/// Step 2: turn that research into a number the contract can act on.
/// Kept as a separate call because structured outputs and citation-bearing
/// server-tool results do not compose.
export async function assessRisk(
  feeds: FeedObservation[],
  session: Session,
): Promise<RiskAssessment & {searchOk: boolean}> {
  const client = new Anthropic();

  const research = await researchOvernightEvents(client, feeds, session);
  if (!research.searchOk) {
    console.warn(
      `  warning: web search returned no usable results${research.searchError ? ` (${research.searchError})` : ""}.` +
        `\n  the haircut below is reasoned from staleness alone, not from events.`,
    );
  }
  const maxAgeHours = (Math.max(...feeds.map((f) => f.ageSeconds)) / 3600).toFixed(1);

  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    thinking: {type: "adaptive"},
    system:
      "You convert market research into a confidence haircut for a lending protocol.\n" +
      "The haircut answers one question: how much less should we trust the last printed " +
      "price as a mark for collateral?\n\n" +
      "Calibration:\n" +
      "  0-500      quiet period, last close still fair\n" +
      "  500-2000   ordinary drift, some macro noise\n" +
      "  2000-5000  a real event with directional impact on the tracked names\n" +
      "  5000-10000 the last print is materially wrong; a gap open is likely\n\n" +
      "Be conservative in both directions. Over-haircutting freezes borrowers out " +
      "unnecessarily; under-haircutting leaves the protocol lending against a price " +
      "that no longer exists.",
    messages: [
      {
        role: "user",
        content:
          `Session: ${SESSION_NAMES[session]}\n` +
          `Oldest price on chain: ${maxAgeHours}h old\n` +
          `Feeds past their 24h heartbeat: ${feeds.filter((f) => f.pastHeartbeat).length}/${feeds.length}\n\n` +
          `Event search: ${research.searchOk ? `${research.resultCount} results reviewed` : "UNAVAILABLE - no event evidence"}\n\n` +
          `Research findings:\n${research.summary || "(none)"}`,
      },
    ],
    output_config: {format: zodOutputFormat(RiskAssessment)},
  });

  const parsed = response.parsed_output;
  if (!parsed) throw new Error("risk assessment did not parse");
  return {...parsed, searchOk: research.searchOk};
}
