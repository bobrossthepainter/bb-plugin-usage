import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionFooter } from "./session-footer";
import type { SessionIndicatorData } from "../lib/session-indicator";

const data = (overrides: Partial<SessionIndicatorData> = {}): SessionIndicatorData => ({
  available: true, source: "pi-session",
  inputTokens: 6, outputTokens: 3_329, cacheReadTokens: 100_381, cacheWriteTokens: 6_487,
  latestCacheHitRate: 98.5, costUsd: 0.412, costEstimated: false, pricedModel: null,
  subscription: true, autoCompaction: true, autoCompactAtTokens: null,
  contextUsedTokens: 58_442, contextWindowTokens: 1_000_000, contextEstimated: true,
  breakdown: [], ...overrides,
});

describe("SessionFooter", () => {
  it("renders Ultimate's tokens, cost and context items in mono 11px", () => {
    const html = renderToStaticMarkup(<SessionFooter data={data()} />);
    expect(html).toContain("text-[11px]");
    expect(html).toContain("JetBrains Mono");
    for (const part of ["↑6", "↓3.3k", "R100k", "W6.5k", "CH98.5%", "$0.412", " (sub)", "5.8%/1.0M"]) {
      expect(html).toContain(part);
    }
    expect(html).toContain("width:5.8442%");
    expect(html).not.toContain("var(--destructive");
  });

  it("colours only the context item above the thresholds", () => {
    const warning = renderToStaticMarkup(<SessionFooter data={data({ contextUsedTokens: 750_000 })} />);
    expect(warning).toContain('style="color:var(--warning-text, var(--warning, #b45309))" aria-label="Context window usage"');
    expect(warning.match(/--warning-text/g)).toHaveLength(1);
    const error = renderToStaticMarkup(<SessionFooter data={data({ contextUsedTokens: 950_000 })} />);
    expect(error).toContain("color:var(--destructive");
  });

  it("renders nothing without data to show", () => {
    expect(renderToStaticMarkup(<SessionFooter data={data({ available: false })} />)).toBe("");
  });
});
