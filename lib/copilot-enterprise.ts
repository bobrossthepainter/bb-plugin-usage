import { z } from "zod";
import type { ProviderLimitWindow } from "./provider-limits";
import { normalizeCopilotEnterpriseSource } from "./host-scripts.generated";

export const copilotEnterpriseSnapshotSchema = z.object({
  accountIdentity: z.string().regex(/^[a-f0-9]{64}$/),
  planLabel: z.string().max(100).nullable(),
  windows: z.array(z.object({
    label: z.string().max(100),
    usedPercent: z.number().min(0).max(100),
    resetsAt: z.string().nullable(),
    unlimited: z.literal(true).optional(),
  })).max(10),
});

// Compiled by generate:collectors and executed on the enrolled host. Keep this
// function self-contained and return quota metadata only; account details from
// /copilot_internal/user must not cross the host boundary.
export function normalizeCopilotEnterprise(payload: unknown): {
  planLabel: string | null;
  windows: ProviderLimitWindow[];
  accountReference: string;
} {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Copilot Enterprise response had an unexpected shape.");
  }
  const data = payload as Record<string, any>;
  const snapshots = data.quota_snapshots;
  if (!snapshots || typeof snapshots !== "object" || Array.isArray(snapshots)) {
    throw new Error("Copilot Enterprise response contained no quota snapshots.");
  }
  const commonReset = typeof data.quota_reset_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(data.quota_reset_date)
    ? `${data.quota_reset_date}T00:00:00.000Z`
    : null;
  const labels: Record<string, string> = {
    chat: "Chat",
    completions: "Completions",
    premium_interactions: "Premium requests",
  };
  const windows: ProviderLimitWindow[] = [];
  for (const [key, raw] of Object.entries(snapshots)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const quota = raw as Record<string, any>;
    if (quota.has_quota === false) continue;
    const unlimited = quota.unlimited === true;
    const remaining = quota.percent_remaining;
    if (!unlimited && (typeof remaining !== "number" || !Number.isFinite(remaining))) continue;
    let resetsAt = commonReset;
    if (typeof quota.quota_reset_at === "number" && Number.isFinite(quota.quota_reset_at) && quota.quota_reset_at > 0) {
      const milliseconds = quota.quota_reset_at < 10_000_000_000 ? quota.quota_reset_at * 1000 : quota.quota_reset_at;
      const parsed = new Date(milliseconds);
      if (!Number.isNaN(parsed.getTime())) resetsAt = parsed.toISOString();
    }
    const quotaId = typeof quota.quota_id === "string" && quota.quota_id ? quota.quota_id : key;
    const label = labels[quotaId] ?? quotaId.split("_").filter(Boolean)
      .map((part: string) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
    windows.push({
      label,
      usedPercent: unlimited ? 0 : Number(Math.min(100, Math.max(0, 100 - remaining)).toFixed(6)),
      resetsAt: unlimited ? null : resetsAt,
      ...(unlimited ? { unlimited: true as const } : {}),
    });
  }
  if (!windows.length) throw new Error("Copilot Enterprise response contained no usable quota windows.");
  const plan = typeof data.copilot_plan === "string" && data.copilot_plan.trim() ? data.copilot_plan.trim() : null;
  const planLabel = plan ? `${plan.charAt(0).toUpperCase()}${plan.slice(1)}` : "Enterprise";
  const accountReference = JSON.stringify([
    typeof data.id === "number" || typeof data.id === "string" ? data.id : null,
    typeof data.login === "string" ? data.login : null,
  ]);
  return { planLabel, windows, accountReference };
}

export function normalizeCopilotEnterpriseHost(value: string) {
  const hostname = value.trim().toLowerCase().replace(/\.$/, "");
  if (!hostname) return null;
  if (hostname.length > 253 || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(hostname)
    || hostname.split(".").some((label) => !label || label.length > 63 || label.startsWith("-") || label.endsWith("-"))) {
    throw new Error("Copilot Enterprise hostname must be a DNS hostname without a scheme, port, or path.");
  }
  return hostname;
}

export function copilotEnterpriseLimitsCommand(configuredHost: string) {
  const hostname = normalizeCopilotEnterpriseHost(configuredHost);
  if (!hostname) throw new Error("Copilot Enterprise hostname is not configured.");
  const apiUrl = `https://api.${hostname}/copilot_internal/user`;
  const script = `
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const normalize = ${normalizeCopilotEnterpriseSource};
(async () => {
  const hostname = ${JSON.stringify(hostname)};
  let token;
  try { token = execFileSync('gh', ['auth', 'token', '--hostname', hostname], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 }).trim(); }
  catch (error) { if (error && (error.code === 'ENOENT' || error.status !== 0)) { console.log('__BB_USAGE_ERROR__:no-copilot-enterprise-credential'); return; } throw error; }
  if (!token || /[\\r\\n]/.test(token)) throw new Error('GitHub Enterprise credential was invalid.');
  let response;
  try { response = await fetch(${JSON.stringify(apiUrl)}, {
    headers: {
      Authorization: 'token ' + token,
      Accept: 'application/json',
      'User-Agent': 'GitHubCopilotChat/0.35.0',
      'Editor-Version': 'vscode/1.107.0',
      'Editor-Plugin-Version': 'copilot-chat/0.35.0',
      'Copilot-Integration-Id': 'vscode-chat',
      'Content-Type': 'application/json',
    },
    redirect: 'error', signal: AbortSignal.timeout(20000),
  }); } catch { throw new Error('Copilot Enterprise quota request failed.'); }
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403
    ? 'GitHub Enterprise login expired or Copilot access was denied. Run gh auth login again.'
    : 'Copilot Enterprise quota request returned HTTP ' + response.status + '.');
  let body = ''; const reader = response.body.getReader();
  while (true) { const part = await reader.read(); if (part.done) break; body += Buffer.from(part.value).toString('utf8'); if (body.length > 262144) { await reader.cancel(); throw new Error('Copilot Enterprise quota response was too large.'); } }
  let payload; try { payload = JSON.parse(body); } catch { throw new Error('Copilot Enterprise quota response was not valid JSON.'); }
  const result = normalize(payload);
  const identityMaterial = result.accountReference === '[null,null]' ? token : result.accountReference;
  const accountIdentity = crypto.createHash('sha256').update(JSON.stringify([hostname, identityMaterial])).digest('hex');
  console.log('__BB_USAGE_BEGIN__');
  console.log(JSON.stringify({ accountIdentity, planLabel: result.planLabel, windows: result.windows }));
  console.log('__BB_USAGE_END__:0');
})().catch(error => { console.log('__BB_USAGE_ERROR__:' + String(error?.message ?? error).replace(/[\\r\\n]+/g, ' ').slice(0, 300)); process.exitCode = 1; });`;
  return `set +x; if ! command -v node >/dev/null 2>&1; then printf '%s\\n' '__BB_USAGE_ERROR__:Node.js is required to collect Copilot Enterprise limits.'; exit 127; fi; node -e '${script.replace(/'/g, `'\\''`)}'`;
}
