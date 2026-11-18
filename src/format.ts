import type { Report } from "./run.js";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function formatText(report: Report): string {
  const lines: string[] = [
    `aws-cost-check, account ${report.account}, ${plural(report.regions.length, "region")}: ${report.regions.join(", ")}`,
    "",
  ];
  const quiet: string[] = [];

  for (const check of report.checks) {
    const found = report.findings.filter((finding) => finding.check === check.id);
    if (found.length === 0) {
      if (!report.skipped.some((skip) => skip.check === check.id)) quiet.push(check.title);
      continue;
    }
    lines.push(`${check.title} (${found.length})`, `  ${check.why}`);
    const regionWidth = Math.max(...found.map((finding) => finding.region.length));
    // Long log group names would push everything right, so alignment stops at 40 characters.
    const resourceWidth = Math.min(40, Math.max(...found.map((finding) => finding.resource.length)));
    for (const finding of found) {
      lines.push(`  ${finding.region.padEnd(regionWidth)}  ${finding.resource.padEnd(resourceWidth)}  ${finding.detail}`);
    }
    lines.push("");
  }

  if (quiet.length > 0) {
    lines.push("Nothing found", ...quiet.map((title) => `  ${title}`), "");
  }
  if (report.skipped.length > 0) {
    lines.push("Could not run", ...report.skipped.map((skip) => `  ${skip.check} in ${skip.region}: ${skip.reason}`), "");
  }

  const count = report.findings.length;
  lines.push(`${count === 0 ? "No findings" : plural(count, "finding")}. Nothing in the account was changed.`);
  return lines.join("\n");
}

export function formatJson(report: Report): string {
  return JSON.stringify(
    {
      account: report.account,
      regions: report.regions,
      checks: report.checks.map(({ id, title, why, scope }) => ({ id, title, why, scope })),
      findings: report.findings,
      skipped: report.skipped,
    },
    null,
    2,
  );
}
