export const PI_SESSION_INDICATOR_BEGIN = "__BB_PI_SESSION_INDICATOR_BEGIN__";
export const PI_SESSION_INDICATOR_END = "__BB_PI_SESSION_INDICATOR_END__";

// Runs on the thread's host. Only the aggregate below crosses the host
// boundary: prompts, responses, and credentials never leave the machine.
export const piSessionIndicatorScript = String.raw`
const fs = require("node:fs");
const path = require("node:path");

const number = (value) => typeof value === "number" && Number.isFinite(value) ? value : 0;
const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return null; }
};
const buckets = new Map();
const add = (totals, usage, cost) => {
  totals.inputTokens += number(usage.input);
  totals.outputTokens += number(usage.output);
  totals.cacheReadTokens += number(usage.cacheRead);
  totals.cacheWriteTokens += number(usage.cacheWrite);
  totals.costUsd += cost;
};
// Model and tool names are identifiers, never transcript content.
const label = (value) => typeof value === "string" && value ? value.slice(0, 120) : null;
const addUsage = (totals, usage, kind, name) => {
  if (!usage || typeof usage !== "object") return;
  const rawCost = usage.cost;
  const cost = rawCost && typeof rawCost === "object"
    ? (typeof rawCost.total === "number" && Number.isFinite(rawCost.total)
      ? rawCost.total
      : number(rawCost.input) + number(rawCost.output) + number(rawCost.cacheRead) + number(rawCost.cacheWrite))
    : 0;
  add(totals, usage, cost);
  const key = kind + ":" + (name || kind);
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { label: name || kind, kind: kind === "model" || kind === "tool" ? kind : "other",
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
    buckets.set(key, bucket);
  }
  add(bucket, usage, cost);
};

const result = {
  available: false,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  latestCacheHitRate: null,
  costUsd: 0,
  subscription: false,
  autoCompaction: true,
  breakdown: [],
};

try {
  const sessionFile = process.env.BB_PI_SESSION_FILE;
  if (!sessionFile) throw new Error("missing session path");
  const text = fs.readFileSync(sessionFile, "utf8");
  let cwd = null;
  let activeProvider = null;
  let activeModel = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type === "session" && typeof entry.cwd === "string") cwd = entry.cwd;
    if (entry.type === "model_change" && typeof entry.provider === "string") activeProvider = entry.provider;
    if (entry.type === "model_change" && typeof entry.modelId === "string") activeModel = entry.modelId;

    if (entry.type === "usage") {
      addUsage(result, entry.usage, "other", label(entry.source) || "other");
      continue;
    }
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      addUsage(result, entry.usage, "other", entry.type === "compaction" ? "compaction" : "branch summary");
      continue;
    }
    if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
    const message = entry.message;
    if (message.role === "assistant") {
      const model = label(message.model) || label(activeModel);
      const provider = label(message.provider) || label(activeProvider);
      addUsage(result, message.usage, "model", model ? (provider ? provider + "/" + model : model) : null);
      if (typeof message.provider === "string") activeProvider = message.provider;
      const usage = message.usage;
      const promptTokens = usage && typeof usage === "object"
        ? number(usage.input) + number(usage.cacheRead) + number(usage.cacheWrite)
        : 0;
      result.latestCacheHitRate = promptTokens > 0 ? number(usage.cacheRead) / promptTokens * 100 : null;
    } else if (message.role === "toolResult") {
      addUsage(result, message.usage, "tool", label(message.toolName));
    }
  }
  result.breakdown = [...buckets.values()]
    .filter((bucket) => bucket.inputTokens + bucket.outputTokens + bucket.cacheReadTokens + bucket.cacheWriteTokens > 0 || bucket.costUsd > 0)
    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "model" ? -1 : b.kind === "model" ? 1 : a.kind === "tool" ? -1 : 1))
    .slice(0, 24);

  const home = process.env.HOME || "";
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(home, ".pi", "agent");
  const globalSettings = readJson(path.join(agentDir, "settings.json"));
  const projectSettings = cwd ? readJson(path.join(cwd, ".pi", "settings.json")) : null;
  const projectCompaction = projectSettings && projectSettings.compaction;
  const globalCompaction = globalSettings && globalSettings.compaction;
  result.autoCompaction = typeof (projectCompaction && projectCompaction.enabled) === "boolean"
    ? projectCompaction.enabled
    : typeof (globalCompaction && globalCompaction.enabled) === "boolean"
      ? globalCompaction.enabled
      : true;

  const auth = readJson(path.join(agentDir, "auth.json"));
  const subscriptionProviders = new Set([
    "anthropic", "github-copilot", "meta", "openai", "openai-codex", "xai",
  ]);
  const credential = auth && activeProvider ? auth[activeProvider] : null;
  // Pi treats Kimi Coding as subscription-backed even when its credential is
  // presented as an API key; all other providers require subscription OAuth.
  result.subscription = activeProvider === "kimi-coding"
    || (subscriptionProviders.has(activeProvider) && credential && credential.type === "oauth");
  result.available = true;
} catch {
  // A not-yet-created or unreadable session is ordinary while a thread starts.
}

process.stdout.write("${PI_SESSION_INDICATOR_BEGIN}\n" + JSON.stringify(result) + "\n${PI_SESSION_INDICATOR_END}\n");
`;
