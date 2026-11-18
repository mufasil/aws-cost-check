import type { Check, Clients, Finding, Options } from "./types.js";
import { describeError, pool } from "./util.js";

export interface Skipped {
  check: string;
  region: string;
  reason: string;
}

export interface Report {
  account: string;
  regions: string[];
  checks: Check[];
  findings: Finding[];
  skipped: Skipped[];
}

export interface RunInput {
  account: string;
  regions: string[];
  checks: Check[];
  clientsFor: (region: string) => Clients;
  options: Options;
  now?: Date;
  concurrency?: number;
}

/**
 * Runs each regional check once per region and each account check once.
 * A check that fails, for example on a missing permission, is reported as skipped instead of stopping the run.
 */
export async function runChecks(input: RunInput): Promise<Report> {
  const now = input.now ?? new Date();
  const tasks: { check: Check; region: string }[] = [];
  for (const check of input.checks) {
    if (check.scope === "account") tasks.push({ check, region: "global" });
    else for (const region of input.regions) tasks.push({ check, region });
  }

  const results = await pool(tasks, input.concurrency ?? 6, async ({ check, region }) => {
    const clients = input.clientsFor(region === "global" ? "us-east-1" : region);
    try {
      const findings = await check.run({ region, account: input.account, clients, now, options: input.options });
      return { findings, skipped: [] as Skipped[] };
    } catch (err) {
      return { findings: [] as Finding[], skipped: [{ check: check.id, region, reason: describeError(err) }] };
    }
  });

  return {
    account: input.account,
    regions: input.regions,
    checks: input.checks,
    findings: results.flatMap((result) => result.findings),
    skipped: results.flatMap((result) => result.skipped),
  };
}
