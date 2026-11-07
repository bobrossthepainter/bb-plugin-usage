import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useComposer, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import { cn } from "../lib/utils";
import { attachFooterHost } from "../lib/composer-footer-anchor";
import {
  contextLevel,
  formatIndicatorTokens,
  formatSessionIndicator,
  sessionIndicatorParts,
  type SessionIndicatorData,
  type UsageBucket,
} from "../lib/session-indicator";

const RUNNING_REFRESH_MS = 10_000;

// Ultimate's status line: JetBrains Mono when installed, bb's mono otherwise.
// Colors use bb's tokens with literal fallbacks so a renamed token degrades to
// a readable footer instead of an invisible one.
const FONT = "'JetBrains Mono', 'JetBrainsMono Nerd Font', 'JetBrainsMono NF', var(--font-mono, ui-monospace), ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const COLOR = {
  muted: "var(--muted-foreground, #777)",
  strong: "color-mix(in oklch, var(--foreground, currentColor) 80%, transparent)",
  warning: "var(--warning-text, var(--warning, #b45309))",
  error: "var(--destructive, #dc2626)",
  track: "var(--muted, rgba(127,127,127,.25))",
};

/** A status-line item with an optional tooltip, as in Ultimate's `Item`. */
function Item({ children, tip, className, style, label }: {
  children: ReactNode;
  tip?: ReactNode;
  className?: string;
  style?: React.CSSProperties;
  label?: string;
}) {
  const content = (
    <span
      className={cn("flex min-w-0 items-center gap-1.5", className)}
      style={style}
      aria-label={label}
      // Keyboard users reach the tooltip like the neighbouring gauge.
      tabIndex={tip ? 0 : undefined}
    >
      {children}
    </span>
  );
  if (!tip) return content;
  return (
    <Tooltip delayDuration={150}>
      <TooltipTrigger asChild>{content}</TooltipTrigger>
      <TooltipContent side="top" className="max-w-md text-[11px] leading-5" style={{ fontFamily: FONT }}>
        {tip}
      </TooltipContent>
    </Tooltip>
  );
}

const dollars = (cost: number) => `$${cost.toFixed(cost < 1 ? 4 : 2)}`;

function BucketRow({ bucket }: { bucket: UsageBucket }) {
  const cache = bucket.cacheReadTokens + bucket.cacheWriteTokens;
  return (
    <>
      <span className="truncate">{bucket.kind === "tool" ? `tool ${bucket.label}` : bucket.label}</span>
      <span className="whitespace-nowrap text-right tabular-nums">
        ↑{formatIndicatorTokens(bucket.inputTokens)} ↓{formatIndicatorTokens(bucket.outputTokens)}
        {cache > 0 ? ` R${formatIndicatorTokens(bucket.cacheReadTokens)}` : ""}
        {bucket.cacheWriteTokens > 0 ? ` W${formatIndicatorTokens(bucket.cacheWriteTokens)}` : ""}
        {" "}{bucket.costUsd === null ? "$?" : dollars(bucket.costUsd)}
      </span>
    </>
  );
}

function TokensTip({ data }: { data: SessionIndicatorData }) {
  return (
    <div className="space-y-1">
      {data.breakdown.length > 0 && (
        <div className="grid grid-cols-[minmax(0,auto)_auto] gap-x-3">
          {data.breakdown.map((bucket) => <BucketRow bucket={bucket} key={`${bucket.kind}:${bucket.label}`} />)}
        </div>
      )}
      {data.costEstimated && (
        <div className="max-w-72 opacity-80">
          Cost estimated at {data.pricedModel ?? "the current model"}'s models.dev API rates; not billed spend.
        </div>
      )}
      {data.costUsd === null && <div className="max-w-72 opacity-80">No recorded cost or known rate for this model.</div>}
      {data.subscription && <div className="max-w-72 opacity-80">Running on a subscription: cost is the API-rate equivalent.</div>}
      {data.source === "bb-events" && data.cacheWriteTokens === 0 && data.cacheReadTokens > 0 && (
        <div className="max-w-72 opacity-80">This provider reports cached input without a read/write split.</div>
      )}
      <div className="max-w-72 opacity-80">
        Session totals; CH is the cache hit rate of the latest response.
      </div>
    </div>
  );
}

function contextTip(data: SessionIndicatorData) {
  const used = data.contextUsedTokens;
  const window = data.contextWindowTokens ?? 0;
  const head = used === null
    ? "Context size is known after the next response"
    : `${data.contextEstimated ? "About " : ""}${used.toLocaleString()} of ${window.toLocaleString()} tokens in context${data.contextEstimated ? ", estimated until the next response" : ""}`;
  const compaction = data.autoCompactAtTokens !== null
    ? `Auto-compacts at ${data.autoCompactAtTokens.toLocaleString()} tokens`
    : data.autoCompaction === true ? "Automatic compaction on" : data.autoCompaction === false ? "Automatic compaction off" : null;
  return <>{head}{compaction && <div>{compaction}</div>}</>;
}

export function SessionFooter({ data }: { data: SessionIndicatorData }) {
  const parts = sessionIndicatorParts(data);
  if (!parts) return null;
  const level = contextLevel(parts.contextPercent);
  const contextColor = level === "error" ? COLOR.error : level === "warning" ? COLOR.warning : undefined;
  return (
    <TooltipProvider>
      <span
        className="flex min-w-0 items-center gap-3 overflow-hidden whitespace-nowrap text-[11px] tabular-nums leading-none"
        style={{ fontFamily: FONT, color: COLOR.muted }}
      >
        {(parts.tokens.length > 0 || parts.cost) && (
          <Item
            // On a phone bb's own gauge already shows the share; keep the line short.
            className="max-md:hidden"
            label="Session token usage and cost"
            tip={<TokensTip data={data} />}
          >
            {parts.tokens.map((part) => <span key={part}>{part}</span>)}
            {parts.cost && (
              <span style={{ color: COLOR.strong }}>
                {parts.cost}
                {parts.subscription && <span style={{ color: COLOR.muted }}> (sub)</span>}
              </span>
            )}
          </Item>
        )}
        {parts.context && (
          <Item label="Context window usage" style={contextColor ? { color: contextColor } : undefined} tip={contextTip(data)}>
            <span
              className="relative h-1.5 w-8 shrink-0 overflow-hidden rounded-full"
              style={{ background: COLOR.track }}
              aria-hidden="true"
            >
              <span
                className="absolute inset-y-0 left-0 rounded-full"
                style={{ width: `${Math.min(100, Math.max(0, parts.contextPercent ?? 0))}%`, background: "currentColor", opacity: 0.7 }}
              />
            </span>
            <span>{parts.context}</span>
          </Item>
        )}
      </span>
    </TooltipProvider>
  );
}

function useSessionIndicator(threadId: string | null, isRunning: boolean) {
  const rpc = useRpc<typeof rpcContract>();
  const generation = useRef(0);
  const [data, setData] = useState<SessionIndicatorData | null>(null);

  const refresh = useCallback(async () => {
    if (!threadId) return;
    const current = ++generation.current;
    try {
      const result = await rpc.call("sessionIndicator", { threadId });
      if (generation.current === current) setData(result.available ? result : null);
    } catch {
      // Preserve the last good snapshot through transient host reconnects.
    }
  }, [rpc, threadId]);

  useEffect(() => {
    setData(null);
    void refresh();
  }, [refresh]);

  // While a turn runs, poll; when it stops, refresh at once and once more
  // shortly after, as the provider's final usage can land just after idle.
  const wasRunning = useRef(isRunning);
  useEffect(() => {
    const stopped = wasRunning.current && !isRunning;
    wasRunning.current = isRunning;
    if (isRunning) {
      const timer = window.setInterval(() => void refresh(), RUNNING_REFRESH_MS);
      return () => window.clearInterval(timer);
    }
    if (!stopped) return;
    void refresh();
    const retry = window.setTimeout(() => void refresh(), 1_500);
    return () => window.clearTimeout(retry);
  }, [isRunning, refresh]);

  useRealtime("session-indicator-updated", (payload) => {
    if (payload && typeof payload === "object" && "threadId" in payload && payload.threadId === threadId) {
      void refresh();
    }
  });

  return data;
}

/**
 * Composer action that renders nothing in place; it portals the footer into
 * bb's composer footer beside the context gauge. bb has no status-line slot,
 * so placement lives in `attachFooterHost`, which degrades to nothing when
 * the footer's shape changes.
 */
export function SessionUsageIndicator() {
  const composer = useComposer();
  const threadId = composer.scope.kind === "thread" ? composer.scope.threadId : null;
  const data = useSessionIndicator(threadId, composer.isRunning);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    return attachFooterHost(anchor, setHost);
  }, []);

  const label = data ? formatSessionIndicator(data) : "";
  return (
    <span ref={anchorRef} className="hidden" aria-hidden="true">
      {host && data && label ? createPortal(<SessionFooter data={data} />, host) : null}
    </span>
  );
}
