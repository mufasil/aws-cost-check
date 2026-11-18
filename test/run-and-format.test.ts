import { describe, expect, it } from "vitest";
import { formatJson, formatText } from "../src/format.js";
import { runChecks } from "../src/run.js";
import type { Check } from "../src/types.js";
import { collect, formatBytes, pool } from "../src/util.js";
import { awsError, fakeClients, NOW } from "./fake.js";

const options = { snapshotAgeDays: 90, idleDays: 14, idleCpuPercent: 10 };

const regional: Check = {
  id: "regional",
  title: "Regional thing",
  why: "It costs money.",
  scope: "region",
  async run({ region }) {
    if (region === "ap-south-1") throw awsError("UnauthorizedOperation", "You are not authorized to perform this operation.");
    return [{ check: "regional", region, resource: `res-${region}`, detail: "found one" }];
  },
};

const account: Check = {
  id: "account",
  title: "Account thing",
  why: "It also costs money.",
  scope: "account",
  async run() {
    return [];
  },
};

describe("runChecks", () => {
  it("runs regional checks per region, account checks once, and records failures as skipped", async () => {
    const seen: string[] = [];
    const report = await runChecks({
      account: "123456789012",
      regions: ["eu-west-1", "us-east-1", "ap-south-1"],
      checks: [regional, account],
      clientsFor: (region) => {
        seen.push(region);
        return fakeClients();
      },
      options,
      now: NOW,
    });

    expect(report.findings.map((f) => f.region)).toEqual(["eu-west-1", "us-east-1"]);
    expect(report.skipped).toEqual([
      {
        check: "regional",
        region: "ap-south-1",
        reason: "UnauthorizedOperation: You are not authorized to perform this operation.",
      },
    ]);
    // The account check gets us-east-1 clients once, on top of the three regional runs.
    expect(seen.filter((region) => region === "us-east-1")).toHaveLength(2);
    expect(seen).toHaveLength(4);
  });
});

describe("formatText", () => {
  it("groups findings by check and lists quiet and skipped checks", async () => {
    const report = await runChecks({
      account: "123456789012",
      regions: ["eu-west-1", "ap-south-1"],
      checks: [regional, account],
      clientsFor: () => fakeClients(),
      options,
      now: NOW,
    });
    const text = formatText(report);

    expect(text).toContain("aws-cost-check, account 123456789012, 2 regions: eu-west-1, ap-south-1");
    expect(text).toContain("Regional thing (1)\n  It costs money.\n  eu-west-1  res-eu-west-1  found one");
    expect(text).toContain("Nothing found\n  Account thing");
    expect(text).toContain("Could not run\n  regional in ap-south-1: UnauthorizedOperation");
    expect(text.endsWith("1 finding. Nothing in the account was changed.")).toBe(true);
  });

  it("says so when there is nothing to report", () => {
    const text = formatText({ account: "1", regions: ["eu-west-1"], checks: [account], findings: [], skipped: [] });
    expect(text.endsWith("No findings. Nothing in the account was changed.")).toBe(true);
  });
});

describe("formatJson", () => {
  it("prints findings, skipped checks and check metadata", () => {
    const json = JSON.parse(
      formatJson({
        account: "1",
        regions: ["eu-west-1"],
        checks: [account],
        findings: [{ check: "account", region: "global", resource: "1", detail: "x" }],
        skipped: [],
      }),
    );
    expect(json.checks).toEqual([{ id: "account", title: "Account thing", why: "It also costs money.", scope: "account" }]);
    expect(json.findings).toHaveLength(1);
  });
});

describe("util", () => {
  it("formats bytes in binary units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(42 * 1024 ** 3)).toBe("42 GiB");
  });

  it("collects every page", async () => {
    const pages: Record<string, { items: number[]; next?: string }> = {
      first: { items: [1, 2], next: "b" },
      b: { items: [3], next: undefined },
    };
    const all = await collect<number>(async (token) => {
      const page = pages[token ?? "first"] as { items: number[]; next?: string };
      return { items: page.items, next: page.next };
    });
    expect(all).toEqual([1, 2, 3]);
  });

  it("keeps order in pool and never runs more than the limit at once", async () => {
    let running = 0;
    let peak = 0;
    const out = await pool([5, 1, 3, 2, 4], 2, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, n));
      running--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 30, 20, 40]);
    expect(peak).toBe(2);
  });
});
