export type SessionIndicatorData = {
  available: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  latestCacheHitRate: number | null;
  costUsd: number;
  subscription: boolean;
  autoCompaction: boolean;
  contextUsedTokens: number | null;
  contextWindowTokens: number | null;
  contextEstimated: boolean;
};

export function formatIndicatorTokens(count: number) {
  if (count < 1_000) return count.toString();
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

export function sessionIndicatorContextPercent(data: SessionIndicatorData) {
  if (data.contextUsedTokens === null || data.contextWindowTokens === null || data.contextWindowTokens <= 0) {
    return null;
  }
  return (data.contextUsedTokens / data.contextWindowTokens) * 100;
}

export function formatSessionIndicator(data: SessionIndicatorData) {
  if (!data.available) return "";
  const parts: string[] = [];
  if (data.inputTokens > 0) parts.push(`↑${formatIndicatorTokens(data.inputTokens)}`);
  if (data.outputTokens > 0) parts.push(`↓${formatIndicatorTokens(data.outputTokens)}`);
  if (data.cacheReadTokens > 0) parts.push(`R${formatIndicatorTokens(data.cacheReadTokens)}`);
  if (data.cacheWriteTokens > 0) parts.push(`W${formatIndicatorTokens(data.cacheWriteTokens)}`);
  if ((data.cacheReadTokens > 0 || data.cacheWriteTokens > 0) && data.latestCacheHitRate !== null) {
    parts.push(`CH${data.latestCacheHitRate.toFixed(1)}%`);
  }
  if (data.costUsd > 0 || data.subscription) {
    parts.push(`$${data.costUsd.toFixed(3)}${data.subscription ? " (sub)" : ""}`);
  }
  if (data.contextWindowTokens !== null && data.contextWindowTokens > 0) {
    const percent = sessionIndicatorContextPercent(data);
    const context = percent === null ? "?" : `${percent.toFixed(1)}%`;
    parts.push(`${context}/${formatIndicatorTokens(data.contextWindowTokens)}${data.autoCompaction ? " (auto)" : ""}`);
  }
  return parts.join(" ");
}
