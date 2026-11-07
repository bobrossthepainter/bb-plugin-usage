// Shared model of the live session footer beside the composer's context gauge.
// Pure: used by the server (to reduce provider events) and the browser (to
// format), and covered by unit tests without bb.

export type UsageBucket = {
  label: string;
  kind: "model" | "tool" | "other";
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Null when no rate is known for this bucket. */
  costUsd: number | null;
};

export type SessionIndicatorData = {
  available: boolean;
  /** `pi-session`: exact totals from Pi's session file; `bb-events`: totals the provider bridge reported to bb. */
  source: "pi-session" | "bb-events";
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  latestCacheHitRate: number | null;
  /** Null when the cost is unknown (no recorded cost and no catalog rate). */
  costUsd: number | null;
  /** True when the cost is a models.dev estimate rather than recorded by the agent. */
  costEstimated: boolean;
  /** Model whose rates priced an estimated cost. */
  pricedModel: string | null;
  subscription: boolean;
  /** Null when the provider does not say. */
  autoCompaction: boolean | null;
  autoCompactAtTokens: number | null;
  contextUsedTokens: number | null;
  contextWindowTokens: number | null;
  contextEstimated: boolean;
  breakdown: UsageBucket[];
};

export const CONTEXT_WARNING_PERCENT = 70;
export const CONTEXT_ERROR_PERCENT = 90;

export function unavailableSessionIndicator(): SessionIndicatorData {
  return {
    available: false,
    source: "bb-events",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    latestCacheHitRate: null,
    costUsd: null,
    costEstimated: false,
    pricedModel: null,
    subscription: false,
    autoCompaction: null,
    autoCompactAtTokens: null,
    contextUsedTokens: null,
    contextWindowTokens: null,
    contextEstimated: true,
    breakdown: [],
  };
}

/** Ultimate's (and Pi's) compact token notation. */
export function formatIndicatorTokens(count: number) {
  if (count < 1_000) return count.toString();
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

export function sessionIndicatorContextPercent(data: Pick<SessionIndicatorData, "contextUsedTokens" | "contextWindowTokens">) {
  if (data.contextUsedTokens === null || data.contextWindowTokens === null || data.contextWindowTokens <= 0) {
    return null;
  }
  return (data.contextUsedTokens / data.contextWindowTokens) * 100;
}

export type ContextLevel = "normal" | "warning" | "error";

export function contextLevel(percent: number | null): ContextLevel {
  if (percent === null) return "normal";
  if (percent > CONTEXT_ERROR_PERCENT) return "error";
  if (percent > CONTEXT_WARNING_PERCENT) return "warning";
  return "normal";
}

export type SessionIndicatorParts = {
  /** `↑80k`, `↓6.9k`, `R767k`, `W1.2k`, `CH97.7%` — empty fragments omitted. */
  tokens: string[];
  /** `$0.766` / `~$0.766`, or null when hidden. */
  cost: string | null;
  subscription: boolean;
  /** `28.8%/272k`, or null without a known window. */
  context: string | null;
  contextPercent: number | null;
};

export function sessionIndicatorParts(data: SessionIndicatorData): SessionIndicatorParts | null {
  if (!data.available) return null;
  const tokens: string[] = [];
  if (data.inputTokens > 0) tokens.push(`↑${formatIndicatorTokens(data.inputTokens)}`);
  if (data.outputTokens > 0) tokens.push(`↓${formatIndicatorTokens(data.outputTokens)}`);
  if (data.cacheReadTokens > 0) tokens.push(`R${formatIndicatorTokens(data.cacheReadTokens)}`);
  if (data.cacheWriteTokens > 0) tokens.push(`W${formatIndicatorTokens(data.cacheWriteTokens)}`);
  if ((data.cacheReadTokens > 0 || data.cacheWriteTokens > 0) && data.latestCacheHitRate !== null) {
    tokens.push(`CH${data.latestCacheHitRate.toFixed(1)}%`);
  }
  // A subscription's $0.000 says something once there is usage, and looks broken before.
  const showCost = data.costUsd !== null && (data.costUsd > 0 || (data.subscription && tokens.length > 0));
  const cost = showCost ? `${data.costEstimated ? "~" : ""}$${data.costUsd!.toFixed(3)}` : null;
  const contextPercent = sessionIndicatorContextPercent(data);
  const context = data.contextWindowTokens !== null && data.contextWindowTokens > 0
    ? `${contextPercent === null ? "?" : `${contextPercent.toFixed(1)}%`}/${formatIndicatorTokens(data.contextWindowTokens)}`
    : null;
  if (!tokens.length && !cost && !context) return null;
  return { tokens, cost, subscription: showCost && data.subscription, context, contextPercent };
}

/** One-line text form, used for accessible labels and tests. */
export function formatSessionIndicator(data: SessionIndicatorData) {
  const parts = sessionIndicatorParts(data);
  if (!parts) return "";
  const out = [...parts.tokens];
  if (parts.cost) out.push(`${parts.cost}${parts.subscription ? " (sub)" : ""}`);
  if (parts.context) out.push(`${parts.context}${data.autoCompaction ? " (auto)" : ""}`);
  return out.join(" ");
}

// ---------------------------------------------------------------------------
// Provider-neutral reduction of bb's `thread/tokenUsage/updated` events.

export type TokenUsageBreakdown = {
  inputTokens: number;
  cachedInputTokens: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens: number;
};

export type Price = { input: number; cached: number; cacheWrite: number; output: number };

/**
 * Providers whose bridge reports `inputTokens` inclusive of cached input
 * (OpenAI semantics). Anthropic-style bridges (Pi, Claude Code) report the
 * uncached remainder and list cache reads/writes separately.
 */
const INCLUSIVE_INPUT_PROVIDERS = new Set(["codex"]);

export type NormalizedTokens = { input: number; output: number; cacheRead: number; cacheWrite: number };

const nonNegative = (value: number | undefined) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

export function normalizeTokenUsage(providerId: string, usage: TokenUsageBreakdown): NormalizedTokens {
  const cached = nonNegative(usage.cachedInputTokens);
  const cacheRead = usage.cacheReadInputTokens === undefined ? cached : nonNegative(usage.cacheReadInputTokens);
  const cacheWrite = usage.cacheWriteInputTokens === undefined
    ? Math.max(0, cached - cacheRead)
    : nonNegative(usage.cacheWriteInputTokens);
  const rawInput = nonNegative(usage.inputTokens);
  const input = INCLUSIVE_INPUT_PROVIDERS.has(providerId) ? Math.max(0, rawInput - cacheRead - cacheWrite) : rawInput;
  return { input, output: nonNegative(usage.outputTokens), cacheRead, cacheWrite };
}

export function cacheHitRate(tokens: NormalizedTokens) {
  const prompt = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  return prompt > 0 ? (tokens.cacheRead / prompt) * 100 : null;
}

export function estimateCostUsd(tokens: NormalizedTokens, price: Price) {
  return (tokens.input * price.input + tokens.cacheRead * price.cached
    + tokens.cacheWrite * price.cacheWrite + tokens.output * price.output) / 1_000_000;
}

/** The models.dev provider that bills a bb provider's models, when one is implied. */
export function pricingProviderFor(providerId: string) {
  switch (providerId) {
    case "codex": return "openai";
    case "claude-code": return "anthropic";
    default: return "unknown";
  }
}

export function eventSessionIndicator(input: {
  providerId: string;
  total: TokenUsageBreakdown;
  last: TokenUsageBreakdown | null;
  model: string | null;
  price: Price | null;
  subscription: boolean;
}): Pick<SessionIndicatorData,
  "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "latestCacheHitRate"
  | "costUsd" | "costEstimated" | "pricedModel" | "breakdown"> {
  const total = normalizeTokenUsage(input.providerId, input.total);
  const last = input.last ? normalizeTokenUsage(input.providerId, input.last) : null;
  const costUsd = input.price ? estimateCostUsd(total, input.price) : null;
  return {
    inputTokens: total.input,
    outputTokens: total.output,
    cacheReadTokens: total.cacheRead,
    cacheWriteTokens: total.cacheWrite,
    latestCacheHitRate: last ? cacheHitRate(last) : null,
    costUsd,
    costEstimated: costUsd !== null,
    pricedModel: costUsd !== null ? input.model : null,
    breakdown: input.model
      ? [{
          label: input.model,
          kind: "model",
          inputTokens: total.input,
          outputTokens: total.output,
          cacheReadTokens: total.cacheRead,
          cacheWriteTokens: total.cacheWrite,
          costUsd,
        }]
      : [],
  };
}
