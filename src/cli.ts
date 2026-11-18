#!/usr/bin/env node
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { allChecks } from "./checks/index.js";
import { accountId, clientsFor, defaultRegion, enabledRegions } from "./clients.js";
import { formatJson, formatText } from "./format.js";
import { runChecks } from "./run.js";
import type { Check } from "./types.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const HELP = `aws-cost-check ${version}

Looks through an AWS account for the usual sources of a surprise bill.
It only reads. Nothing in the account is changed.

Usage
  aws-cost-check [options]

Options
  -r, --region <list>     Regions to check, comma separated. Defaults to your configured region.
      --all-regions       Check every region enabled for the account.
  -p, --profile <name>    AWS profile to use. Same as setting AWS_PROFILE.
      --only <list>       Run only these checks, comma separated.
      --snapshot-age <n>  Report snapshots at least n days old (default 90).
      --idle-days <n>     Days of RDS metrics to look at (default 14).
      --idle-cpu <n>      Report RDS instances whose CPU stayed under n percent (default 10).
      --json              Print JSON instead of text.
      --fail-on-findings  Exit with code 1 when anything is found. Handy in CI.
  -h, --help              Show this help.
  -v, --version           Show the version.

Checks
${allChecks.map((check) => `  ${check.id.padEnd(26)}${check.title}`).join("\n")}
`;

const list = (value: string) =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

function positiveNumber(value: string | undefined, fallback: number, flag: string): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${flag} needs a positive number, got "${value}"`);
  return n;
}

function pickChecks(only: string | undefined): Check[] {
  if (!only) return allChecks;
  const wanted = list(only);
  const unknown = wanted.filter((id) => !allChecks.some((check) => check.id === id));
  if (unknown.length > 0) {
    throw new Error(`unknown check ${unknown.join(", ")}. Known checks: ${allChecks.map((c) => c.id).join(", ")}`);
  }
  return allChecks.filter((check) => wanted.includes(check.id));
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      region: { type: "string", short: "r" },
      "all-regions": { type: "boolean" },
      profile: { type: "string", short: "p" },
      only: { type: "string" },
      "snapshot-age": { type: "string" },
      "idle-days": { type: "string" },
      "idle-cpu": { type: "string" },
      json: { type: "boolean" },
      "fail-on-findings": { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
    strict: true,
  });

  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.version) {
    console.log(version);
    return 0;
  }
  if (values.profile) process.env.AWS_PROFILE = values.profile;

  const checks = pickChecks(values.only);
  const options = {
    snapshotAgeDays: positiveNumber(values["snapshot-age"], 90, "snapshot-age"),
    idleDays: positiveNumber(values["idle-days"], 14, "idle-days"),
    idleCpuPercent: positiveNumber(values["idle-cpu"], 10, "idle-cpu"),
  };

  const requested = values.region ? list(values.region) : [];
  const home = requested[0] ?? (await defaultRegion());
  if (!home) throw new Error("no region set. Pass --region, or set AWS_REGION or a region in your AWS profile.");

  const account = await accountId(home);
  const regions = values["all-regions"] ? await enabledRegions(home) : requested.length > 0 ? requested : [home];

  const report = await runChecks({ account, regions, checks, clientsFor, options });
  process.stdout.write(`${values.json ? formatJson(report) : formatText(report)}\n`);
  return values["fail-on-findings"] && report.findings.length > 0 ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(`aws-cost-check: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
  },
);
