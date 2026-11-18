import { type Datapoint, GetMetricStatisticsCommand, type GetMetricStatisticsCommandOutput } from "@aws-sdk/client-cloudwatch";
import { type DBInstance, DescribeDBInstancesCommand, type DescribeDBInstancesCommandOutput } from "@aws-sdk/client-rds";
import type { Check, SendClient } from "../types.js";
import { collect, DAY_MS } from "../util.js";

const id = "idle-rds";

export const idleRds: Check = {
  id,
  title: "RDS instances with almost no load",
  why: "An instance sized on launch day and never looked at again keeps billing for capacity nobody uses.",
  scope: "region",
  async run({ region, clients, now, options }) {
    const instances = await collect<DBInstance>(async (Marker) => {
      const res: DescribeDBInstancesCommandOutput = await clients.rds.send(
        new DescribeDBInstancesCommand({ MaxRecords: 100, Marker }),
      );
      return { items: res.DBInstances, next: res.Marker };
    });

    const findings = [];
    for (const db of instances) {
      if (db.DBInstanceStatus !== "available" || !db.DBInstanceIdentifier) continue;
      const days = options.idleDays;

      const connections = await maxOf(clients.cloudwatch, db.DBInstanceIdentifier, "DatabaseConnections", now, days);
      const cpu = await maxOf(clients.cloudwatch, db.DBInstanceIdentifier, "CPUUtilization", now, days);
      if (connections === undefined || cpu === undefined) continue; // no data yet, nothing to say

      let detail: string | undefined;
      if (connections === 0) {
        detail = `no connections in the last ${days} days`;
      } else if (cpu < options.idleCpuPercent) {
        detail = `CPU never went above ${cpu.toFixed(1)}% in the last ${days} days`;
      }
      if (detail) {
        findings.push({
          check: id,
          region,
          resource: db.DBInstanceIdentifier,
          detail: `${db.DBInstanceClass ?? "?"} ${db.Engine ?? ""}, ${detail}`.replace(" ,", ","),
        });
      }
    }
    return findings;
  },
};

/** Highest hourly Maximum for an RDS metric over the window, or undefined when there are no datapoints. */
async function maxOf(
  cloudwatch: SendClient,
  instanceId: string,
  metric: string,
  now: Date,
  days: number,
): Promise<number | undefined> {
  // GetMetricStatistics returns at most 1,440 datapoints, so widen the period for long windows.
  const period = Math.max(1, Math.ceil((days * 24) / 1440)) * 3600;
  const res: GetMetricStatisticsCommandOutput = await cloudwatch.send(
    new GetMetricStatisticsCommand({
      Namespace: "AWS/RDS",
      MetricName: metric,
      Dimensions: [{ Name: "DBInstanceIdentifier", Value: instanceId }],
      StartTime: new Date(now.getTime() - days * DAY_MS),
      EndTime: now,
      Period: period,
      Statistics: ["Maximum"],
    }),
  );
  const points: Datapoint[] = res.Datapoints ?? [];
  if (points.length === 0) return undefined;
  return Math.max(...points.map((point) => point.Maximum ?? 0));
}
