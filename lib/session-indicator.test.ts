import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PI_SESSION_INDICATOR_BEGIN,
  PI_SESSION_INDICATOR_END,
  piSessionIndicatorScript,
} from "./pi-session-indicator-command";
import {
  cacheHitRate,
  contextLevel,
  eventSessionIndicator,
  formatIndicatorTokens,
  formatSessionIndicator,
  normalizeTokenUsage,
  sessionIndicatorParts,
  type SessionIndicatorData,
} from "./session-indicator";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixtureData(overrides: Partial<SessionIndicatorData> = {}): SessionIndicatorData {
  return {
    available: true,
    source: "pi-session",
    inputTokens: 80_000,
    outputTokens: 6_900,
    cacheReadTokens: 767_000,
    cacheWriteTokens: 0,
    latestCacheHitRate: 97.7,
    costUsd: 0.766,
    subscription: true,
    autoCompaction: true,
    autoCompactAtTokens: null,
    costEstimated: false,
    pricedModel: null,
    contextUsedTokens: 78_336,
    contextWindowTokens: 272_000,
    contextEstimated: true,
    breakdown: [],
    ...overrides,
  };
}

describe("session indicator formatting", () => {
  it("matches Pi's compact footer notation", () => {
    expect(formatSessionIndicator(fixtureData())).toBe(
      "↑80k ↓6.9k R767k CH97.7% $0.766 (sub) 28.8%/272k (auto)",
    );
  });

  it("uses Pi's token thresholds and omits unavailable counters", () => {
    expect([999, 1_000, 9_999, 10_000, 999_999, 1_000_000, 10_000_000].map(formatIndicatorTokens))
      .toEqual(["999", "1.0k", "10.0k", "10k", "1000k", "1.0M", "10M"]);
    expect(formatSessionIndicator(fixtureData({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      latestCacheHitRate: null,
      costUsd: 0,
      subscription: false,
      autoCompaction: false,
      contextUsedTokens: null,
    }))).toBe("?/272k");
  });
});

describe("Pi session indicator host script", () => {
  it("matches Pi's subscription-backed provider semantics", () => {
    const root = mkdtempSync(join(tmpdir(), "bb-usage-indicator-auth-"));
    temporaryDirectories.push(root);
    const agentDir = join(root, ".pi", "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "auth.json"), JSON.stringify({
      anthropic: { type: "api_key", key: "not-a-subscription" },
      openrouter: { type: "oauth", access: "oauth-is-not-always-a-subscription" },
    }));
    const sessionFile = join(root, "session.jsonl");
    const subscriptionFor = (provider: string) => {
      writeFileSync(sessionFile, `${JSON.stringify({ type: "model_change", provider, modelId: "test" })}\n`);
      const output = execFileSync(process.execPath, ["-e", piSessionIndicatorScript], {
        encoding: "utf8",
        env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: agentDir, BB_PI_SESSION_FILE: sessionFile },
      });
      const match = output.match(new RegExp(`${PI_SESSION_INDICATOR_BEGIN}\\n([^\\n]+)\\n${PI_SESSION_INDICATOR_END}`));
      return JSON.parse(match![1]!).subscription as boolean;
    };

    expect(subscriptionFor("anthropic")).toBe(false);
    expect(subscriptionFor("openrouter")).toBe(false);
    // Pi itself labels Kimi Coding as subscription-backed even when the
    // active credential is represented as an API key.
    expect(subscriptionFor("kimi-coding")).toBe(true);
  });

  it("totals every usage-bearing entry and uses only the latest assistant for cache hit rate", () => {
    const root = mkdtempSync(join(tmpdir(), "bb-usage-indicator-"));
    temporaryDirectories.push(root);
    const cwd = join(root, "project");
    const agentDir = join(root, ".pi", "agent");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "auth.json"), JSON.stringify({
      "openai-codex": { type: "oauth", access: "must-not-appear-in-output" },
    }));
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: true } }));
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ compaction: { enabled: false } }));

    const usage = (input: number, output: number, cacheRead: number, cacheWrite: number, total: number) => ({
      input, output, cacheRead, cacheWrite,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
    });
    const lines = [
      { type: "session", cwd },
      { type: "model_change", provider: "openai-codex", modelId: "gpt-test" },
      { type: "message", message: { role: "assistant", provider: "openai-codex", usage: usage(100, 10, 900, 0, 0.1) } },
      { type: "message", message: { role: "toolResult", usage: usage(3, 4, 5, 6, 0.2) } },
      { type: "usage", usage: usage(7, 8, 9, 10, 0.3) },
      { type: "compaction", usage: usage(11, 12, 13, 14, 0.4) },
      { type: "branch_summary", usage: usage(15, 16, 17, 18, 0.5) },
      { type: "message", message: { role: "assistant", provider: "openai-codex", usage: usage(20, 21, 180, 0, 0.6) } },
      "partially-written-json",
    ];
    const sessionFile = join(root, "session.jsonl");
    writeFileSync(sessionFile, `${lines.map((line) => typeof line === "string" ? line : JSON.stringify(line)).join("\n")}\n`);

    const output = execFileSync(process.execPath, ["-e", piSessionIndicatorScript], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: root,
        PI_CODING_AGENT_DIR: agentDir,
        BB_PI_SESSION_FILE: sessionFile,
      },
    });
    const match = output.match(new RegExp(`${PI_SESSION_INDICATOR_BEGIN}\\n([^\\n]+)\\n${PI_SESSION_INDICATOR_END}`));
    expect(match).not.toBeNull();
    expect(output).not.toContain("must-not-appear-in-output");
    expect(JSON.parse(match![1]!)).toEqual({
      available: true,
      inputTokens: 156,
      outputTokens: 71,
      cacheReadTokens: 1_124,
      cacheWriteTokens: 48,
      latestCacheHitRate: 90,
      costUsd: 2.1,
      subscription: true,
      autoCompaction: false,
      breakdown: [
        { label: "openai-codex/gpt-test", kind: "model", inputTokens: 120, outputTokens: 31, cacheReadTokens: 1_080, cacheWriteTokens: 0, costUsd: 0.7 },
        { label: "tool", kind: "tool", inputTokens: 3, outputTokens: 4, cacheReadTokens: 5, cacheWriteTokens: 6, costUsd: 0.2 },
        { label: "other", kind: "other", inputTokens: 7, outputTokens: 8, cacheReadTokens: 9, cacheWriteTokens: 10, costUsd: 0.3 },
        { label: "compaction", kind: "other", inputTokens: 11, outputTokens: 12, cacheReadTokens: 13, cacheWriteTokens: 14, costUsd: 0.4 },
        { label: "branch summary", kind: "other", inputTokens: 15, outputTokens: 16, cacheReadTokens: 17, cacheWriteTokens: 18, costUsd: 0.5 },
      ],
    });
  });
});

describe("session footer parts", () => {
  it("splits Ultimate's tokens, cost and context items", () => {
    expect(sessionIndicatorParts(fixtureData())).toEqual({
      tokens: ["↑80k", "↓6.9k", "R767k", "CH97.7%"],
      cost: "$0.766",
      subscription: true,
      context: "28.8%/272k",
      contextPercent: expect.closeTo(28.8, 1),
    });
  });

  it("marks estimated cost and hides unknown cost", () => {
    expect(sessionIndicatorParts(fixtureData({ costEstimated: true, subscription: false }))?.cost).toBe("~$0.766");
    const unknown = sessionIndicatorParts(fixtureData({ costUsd: null }));
    expect(unknown?.cost).toBeNull();
    expect(unknown?.subscription).toBe(false);
  });

  it("hides a subscription's $0.000 until there is usage", () => {
    expect(sessionIndicatorParts(fixtureData({
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, latestCacheHitRate: null,
    }))).toMatchObject({ tokens: [], cost: null });
  });

  it("returns nothing when there is nothing to show", () => {
    expect(sessionIndicatorParts(fixtureData({ available: false }))).toBeNull();
    expect(sessionIndicatorParts(fixtureData({
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, subscription: false,
      latestCacheHitRate: null, contextWindowTokens: null,
    }))).toBeNull();
  });

  it("uses Ultimate's warning (>70%) and error (>90%) thresholds", () => {
    expect([null, 70, 70.1, 90, 90.1].map(contextLevel)).toEqual(["normal", "normal", "warning", "warning", "error"]);
  });
});

describe("provider-neutral token usage", () => {
  it("removes cached input from Codex's inclusive input count", () => {
    expect(normalizeTokenUsage("codex", {
      inputTokens: 62_926_795, cachedInputTokens: 62_408_832, cacheReadInputTokens: 62_408_832, outputTokens: 108_217,
    })).toEqual({ input: 517_963, output: 108_217, cacheRead: 62_408_832, cacheWrite: 0 });
  });

  it("keeps Anthropic-style exclusive input and the read/write split", () => {
    const tokens = normalizeTokenUsage("claude-code", {
      inputTokens: 6, cachedInputTokens: 106_868, cacheReadInputTokens: 100_381, cacheWriteInputTokens: 6_487, outputTokens: 3_329,
    });
    expect(tokens).toEqual({ input: 6, output: 3_329, cacheRead: 100_381, cacheWrite: 6_487 });
    expect(cacheHitRate(tokens)).toBeCloseTo(93.9, 1);
  });

  it("treats cached input without a split as cache reads", () => {
    expect(normalizeTokenUsage("acp", { inputTokens: 10, cachedInputTokens: 90, outputTokens: 1 }))
      .toEqual({ input: 10, output: 1, cacheRead: 90, cacheWrite: 0 });
  });

  it("estimates cost from catalog rates and reports one model bucket", () => {
    const result = eventSessionIndicator({
      providerId: "codex",
      total: { inputTokens: 1_100_000, cachedInputTokens: 1_000_000, outputTokens: 10_000 },
      last: { inputTokens: 1_000, cachedInputTokens: 900, outputTokens: 5 },
      model: "gpt-test",
      price: { input: 1, cached: 0.1, cacheWrite: 1, output: 10 },
      subscription: true,
    });
    expect(result).toMatchObject({
      inputTokens: 100_000,
      cacheReadTokens: 1_000_000,
      latestCacheHitRate: 90,
      costEstimated: true,
      pricedModel: "gpt-test",
      breakdown: [{ label: "gpt-test", kind: "model" }],
    });
    expect(result.costUsd).toBeCloseTo(0.1 + 0.1 + 0.1, 6);
  });

  it("leaves cost unknown without a rate", () => {
    expect(eventSessionIndicator({
      providerId: "acp", total: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }, last: null,
      model: null, price: null, subscription: false,
    })).toMatchObject({ costUsd: null, costEstimated: false, breakdown: [] });
  });
});
