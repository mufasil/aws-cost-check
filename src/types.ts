/** Anything with an SDK v3 style `send`. Real clients in the CLI, small fakes in the tests. */
export interface SendClient {
  // SDK clients type `send` per command, so each call site states the output type it expects.
  send(command: unknown): Promise<any>;
}

export interface Clients {
  ec2: SendClient;
  logs: SendClient;
  cloudwatch: SendClient;
  rds: SendClient;
  budgets: SendClient;
}

export interface Options {
  /** Snapshots at least this many days old are reported. */
  snapshotAgeDays: number;
  /** How far back to look at RDS metrics. */
  idleDays: number;
  /** An RDS instance whose CPU never went above this percentage is reported. */
  idleCpuPercent: number;
}

export interface CheckContext {
  /** Region for regional checks, "global" for account checks. */
  region: string;
  account: string;
  clients: Clients;
  now: Date;
  options: Options;
}

export interface Finding {
  check: string;
  region: string;
  resource: string;
  detail: string;
}

export interface Check {
  id: string;
  title: string;
  /** One plain sentence on why this costs money. */
  why: string;
  /** "region" checks run once per region. "account" checks run once in total. */
  scope: "region" | "account";
  run(ctx: CheckContext): Promise<Finding[]>;
}
