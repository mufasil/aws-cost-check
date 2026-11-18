import { BudgetsClient } from "@aws-sdk/client-budgets";
import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { DescribeRegionsCommand, EC2Client } from "@aws-sdk/client-ec2";
import { RDSClient } from "@aws-sdk/client-rds";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import type { Clients } from "./types.js";
import { describeError } from "./util.js";

// A few extra retries ride out throttling when many regions are checked at once.
const maxAttempts = 5;
const cache = new Map<string, Clients>();

export function clientsFor(region: string): Clients {
  let clients = cache.get(region);
  if (!clients) {
    clients = {
      ec2: new EC2Client({ region, maxAttempts }),
      logs: new CloudWatchLogsClient({ region, maxAttempts }),
      cloudwatch: new CloudWatchClient({ region, maxAttempts }),
      rds: new RDSClient({ region, maxAttempts }),
      // Budgets is a global service served from us-east-1.
      budgets: new BudgetsClient({ region: "us-east-1", maxAttempts }),
    };
    cache.set(region, clients);
  }
  return clients;
}

/** The region from AWS_REGION or the active profile, if one is set. */
export async function defaultRegion(): Promise<string | undefined> {
  try {
    return (await new EC2Client({}).config.region()) || undefined;
  } catch {
    return undefined;
  }
}

export async function enabledRegions(region: string): Promise<string[]> {
  const res = await new EC2Client({ region, maxAttempts }).send(new DescribeRegionsCommand({ AllRegions: false }));
  return (res.Regions ?? [])
    .map((r) => r.RegionName)
    .filter((name): name is string => Boolean(name))
    .sort();
}

/** Reads the account ID. This is also the first call, so a credentials problem shows up here with a clear message. */
export async function accountId(region: string): Promise<string> {
  try {
    const res = await new STSClient({ region, maxAttempts }).send(new GetCallerIdentityCommand({}));
    if (!res.Account) throw new Error("STS returned no account ID");
    return res.Account;
  } catch (err) {
    throw new Error(`could not read your AWS identity (${describeError(err)}). Check your credentials or --profile.`);
  }
}
