import { describe, expect, it } from "vitest";
import {
  copilotEnterpriseLimitsCommand,
  normalizeCopilotEnterprise,
  normalizeCopilotEnterpriseHost,
} from "./copilot-enterprise";

const payload = {
  id: 12345,
  login: "user",
  copilot_plan: "business",
  quota_reset_date: "2030-01-01",
  quota_snapshots: {
    chat: {
      percent_remaining: 100,
      quota_id: "chat",
      unlimited: true,
      has_quota: true,
      quota_reset_at: 0,
    },
    completions: {
      percent_remaining: 100,
      quota_id: "completions",
      unlimited: true,
      has_quota: true,
      quota_reset_at: 0,
    },
    premium_interactions: {
      percent_remaining: 75,
      quota_id: "premium_interactions",
      unlimited: false,
      has_quota: true,
      quota_reset_at: 0,
      remaining: 750,
      entitlement: 1000,
    },
  },
};

describe("Copilot Enterprise quota normalization", () => {
  it("maps unlimited and finite quota snapshots without returning account details", () => {
    expect(normalizeCopilotEnterprise(payload)).toEqual({
      planLabel: "Business",
      accountReference: JSON.stringify([12345, "user"]),
      windows: [
        { label: "Chat", usedPercent: 0, resetsAt: null, unlimited: true },
        { label: "Completions", usedPercent: 0, resetsAt: null, unlimited: true },
        { label: "Premium requests", usedPercent: 25, resetsAt: "2030-01-01T00:00:00.000Z" },
      ],
    });
  });

  it("supports epoch reset timestamps and unknown quota names", () => {
    const result = normalizeCopilotEnterprise({
      quota_snapshots: {
        code_review: {
          quota_id: "code_review", has_quota: true, unlimited: false,
          percent_remaining: 25, quota_reset_at: 1_799_000_000,
        },
      },
    });
    expect(result.windows).toEqual([{
      label: "Code Review", usedPercent: 75,
      resetsAt: new Date(1_799_000_000_000).toISOString(),
    }]);
  });

  it("rejects responses without usable quota snapshots", () => {
    expect(() => normalizeCopilotEnterprise({})).toThrow("no quota snapshots");
    expect(() => normalizeCopilotEnterprise({ quota_snapshots: { chat: { has_quota: false } } }))
      .toThrow("no usable quota windows");
  });
});

describe("Copilot Enterprise host command", () => {
  it("accepts a bare enterprise hostname and derives only its API subdomain", () => {
    expect(normalizeCopilotEnterpriseHost(" GHE.EXAMPLE.COM. ")).toBe("ghe.example.com");
    const command = copilotEnterpriseLimitsCommand("ghe.example.com");
    expect(command).toContain("https://api.ghe.example.com/copilot_internal/user");
    expect(command).toContain("execFileSync");
    expect(command).toContain("--hostname");
    expect(command).toContain("redirect:");
    expect(command).toContain("error");
    expect(command).toContain("set +x");
  });

  it.each([
    "https://ghe.example.com", "ghe.example.com/path", "ghe.example.com:443", "-bad.example", "bad..example",
  ])("rejects unsafe hostname input: %s", (hostname) => {
    expect(() => normalizeCopilotEnterpriseHost(hostname)).toThrow("DNS hostname");
  });
});
