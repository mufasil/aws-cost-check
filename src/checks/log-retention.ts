import { DescribeLogGroupsCommand, type DescribeLogGroupsCommandOutput, type LogGroup } from "@aws-sdk/client-cloudwatch-logs";
import type { Check } from "../types.js";
import { collect, formatBytes } from "../util.js";

const id = "log-retention";

export const logRetention: Check = {
  id,
  title: "Log groups that keep data forever",
  why: "CloudWatch log groups never expire by default, so stored logs are billed every month from then on.",
  scope: "region",
  async run({ region, clients }) {
    const groups = await collect<LogGroup>(async (nextToken) => {
      const res: DescribeLogGroupsCommandOutput = await clients.logs.send(
        new DescribeLogGroupsCommand({ limit: 50, nextToken }),
      );
      return { items: res.logGroups, next: res.nextToken };
    });

    return groups
      .filter((group) => group.retentionInDays === undefined)
      .sort((a, b) => (b.storedBytes ?? 0) - (a.storedBytes ?? 0))
      .map((group) => ({
        check: id,
        region,
        resource: group.logGroupName ?? "unknown log group",
        detail: `no retention set, ${formatBytes(group.storedBytes ?? 0)} stored`,
      }));
  },
};
