import { describe, expect, it } from "vitest";
import { noBudget } from "../src/checks/budgets.js";
import { idleRds } from "../src/checks/idle-rds.js";
import { logRetention } from "../src/checks/log-retention.js";
import { natWithoutS3Endpoint } from "../src/checks/nat-s3-endpoint.js";
import { oldSnapshots } from "../src/checks/old-snapshots.js";
import { unattachedVolumes } from "../src/checks/unattached-volumes.js";
import { unusedElasticIps } from "../src/checks/unused-elastic-ips.js";
import { awsError, context, daysAgo, fakeClient, fakeClients } from "./fake.js";

describe("unattached-volumes", () => {
  it("reports every available volume across pages and asks only for available ones", async () => {
    const ec2 = fakeClient({
      DescribeVolumesCommand: [
        () => ({ Volumes: [{ VolumeId: "vol-a", Size: 100, VolumeType: "gp3", CreateTime: daysAgo(30) }], NextToken: "t1" }),
        () => ({ Volumes: [{ VolumeId: "vol-b", Size: 8, VolumeType: "gp2", CreateTime: daysAgo(400) }] }),
      ],
    });
    const findings = await unattachedVolumes.run(context(fakeClients({ ec2 })));

    expect(findings.map((f) => f.resource)).toEqual(["vol-a", "vol-b"]);
    expect(findings[0]?.detail).toBe("100 GiB gp3 volume, created 2026-10-19");
    expect(ec2.calls[0]?.input).toMatchObject({ Filters: [{ Name: "status", Values: ["available"] }] });
    expect(ec2.calls[1]?.input).toMatchObject({ NextToken: "t1" });
  });

  it("returns nothing when every volume is attached", async () => {
    const ec2 = fakeClient({ DescribeVolumesCommand: () => ({ Volumes: [] }) });
    expect(await unattachedVolumes.run(context(fakeClients({ ec2 })))).toEqual([]);
  });
});

describe("old-snapshots", () => {
  const ec2 = () =>
    fakeClient({
      DescribeSnapshotsCommand: () => ({
        Snapshots: [
          { SnapshotId: "snap-old-orphan", StartTime: daysAgo(200), VolumeId: "vol-gone", VolumeSize: 50 },
          { SnapshotId: "snap-old-live", StartTime: daysAgo(120), VolumeId: "vol-live", VolumeSize: 20 },
          { SnapshotId: "snap-old-copy", StartTime: daysAgo(95), VolumeId: "vol-ffffffff", VolumeSize: 10 },
          { SnapshotId: "snap-ami", StartTime: daysAgo(300), VolumeId: "vol-gone", VolumeSize: 8 },
          { SnapshotId: "snap-new", StartTime: daysAgo(10), VolumeId: "vol-live", VolumeSize: 20 },
        ],
      }),
      DescribeImagesCommand: () => ({
        Images: [{ ImageId: "ami-1", BlockDeviceMappings: [{ Ebs: { SnapshotId: "snap-ami" } }] }],
      }),
      DescribeVolumesCommand: () => ({ Volumes: [{ VolumeId: "vol-live" }] }),
    });

  it("reports old snapshots, skips ones behind an AMI and notes a deleted source volume", async () => {
    const findings = await oldSnapshots.run(context(fakeClients({ ec2: ec2() })));

    expect(findings.map((f) => f.resource)).toEqual(["snap-old-orphan", "snap-old-live", "snap-old-copy"]);
    expect(findings[0]?.detail).toBe("200 days old, taken from a 50 GiB volume. The source volume vol-gone no longer exists");
    expect(findings[1]?.detail).toBe("120 days old, taken from a 20 GiB volume");
    expect(findings[2]?.detail).toBe("95 days old, taken from a 10 GiB volume");
  });

  it("respects --snapshot-age", async () => {
    const ctx = context(fakeClients({ ec2: ec2() }));
    ctx.options.snapshotAgeDays = 150;
    const findings = await oldSnapshots.run(ctx);
    expect(findings.map((f) => f.resource)).toEqual(["snap-old-orphan"]);
  });

  it("makes no extra calls when nothing is old enough", async () => {
    const client = fakeClient({ DescribeSnapshotsCommand: () => ({ Snapshots: [{ SnapshotId: "s", StartTime: daysAgo(1) }] }) });
    expect(await oldSnapshots.run(context(fakeClients({ ec2: client })))).toEqual([]);
    expect(client.calls).toHaveLength(1);
  });
});

describe("log-retention", () => {
  it("reports groups without retention, biggest first", async () => {
    const logs = fakeClient({
      DescribeLogGroupsCommand: [
        () => ({
          logGroups: [
            { logGroupName: "/small", storedBytes: 2048 },
            { logGroupName: "/kept", retentionInDays: 30, storedBytes: 10 ** 12 },
          ],
          nextToken: "n1",
        }),
        () => ({ logGroups: [{ logGroupName: "/aws/lambda/big", storedBytes: 5 * 1024 ** 3 }] }),
      ],
    });
    const findings = await logRetention.run(context(fakeClients({ logs })));

    expect(findings.map((f) => f.resource)).toEqual(["/aws/lambda/big", "/small"]);
    expect(findings[0]?.detail).toBe("no retention set, 5.0 GiB stored");
    expect(findings[1]?.detail).toBe("no retention set, 2.0 KiB stored");
    expect(logs.calls[1]?.input).toMatchObject({ nextToken: "n1" });
  });
});

describe("nat-without-s3-endpoint", () => {
  const ec2 = () =>
    fakeClient({
      DescribeNatGatewaysCommand: () => ({
        NatGateways: [
          { NatGatewayId: "nat-1", VpcId: "vpc-no-endpoint" },
          { NatGatewayId: "nat-2", VpcId: "vpc-no-endpoint" },
          { NatGatewayId: "nat-3", VpcId: "vpc-with-endpoint" },
        ],
      }),
      DescribeVpcEndpointsCommand: () => ({ VpcEndpoints: [{ VpcId: "vpc-with-endpoint", State: "Available" }] }),
    });

  it("flags a VPC that has NAT gateways but no S3 gateway endpoint, with last week's traffic", async () => {
    const cloudwatch = fakeClient({
      GetMetricStatisticsCommand: [
        () => ({ Datapoints: [{ Sum: 300 * 1024 ** 3 }] }),
        () => ({ Datapoints: [{ Sum: 100 * 1024 ** 3 }] }),
      ],
    });
    const client = ec2();
    const findings = await natWithoutS3Endpoint.run(context(fakeClients({ ec2: client, cloudwatch })));

    expect(findings).toEqual([
      {
        check: "nat-without-s3-endpoint",
        region: "eu-west-1",
        resource: "vpc-no-endpoint",
        detail: "NAT gateways nat-1, nat-2 and no S3 gateway endpoint. 400 GiB went out through NAT in the last 7 days",
      },
    ]);
    expect(client.calls[1]?.input).toMatchObject({
      Filters: [
        { Name: "vpc-endpoint-type", Values: ["Gateway"] },
        { Name: "service-name", Values: ["com.amazonaws.eu-west-1.s3"] },
      ],
    });
  });

  it("still reports the VPC when CloudWatch can't be read", async () => {
    const cloudwatch = fakeClient({
      GetMetricStatisticsCommand: () => {
        throw awsError("AccessDenied");
      },
    });
    const findings = await natWithoutS3Endpoint.run(context(fakeClients({ ec2: ec2(), cloudwatch })));
    expect(findings[0]?.detail).toBe("NAT gateways nat-1, nat-2 and no S3 gateway endpoint");
  });

  it("does nothing when there are no NAT gateways", async () => {
    const client = fakeClient({ DescribeNatGatewaysCommand: () => ({ NatGateways: [] }) });
    expect(await natWithoutS3Endpoint.run(context(fakeClients({ ec2: client })))).toEqual([]);
    expect(client.calls).toHaveLength(1);
  });
});

describe("unused-elastic-ips", () => {
  it("reports addresses with no association", async () => {
    const ec2 = fakeClient({
      DescribeAddressesCommand: () => ({
        Addresses: [
          { PublicIp: "203.0.113.10", AllocationId: "eipalloc-1" },
          { PublicIp: "203.0.113.11", AllocationId: "eipalloc-2", AssociationId: "eipassoc-2" },
        ],
      }),
    });
    const findings = await unusedElasticIps.run(context(fakeClients({ ec2 })));
    expect(findings).toEqual([
      {
        check: "unused-elastic-ips",
        region: "eu-west-1",
        resource: "203.0.113.10",
        detail: "allocated as eipalloc-1 but not associated with any instance or network interface",
      },
    ]);
  });
});

describe("idle-rds", () => {
  const rds = () =>
    fakeClient({
      DescribeDBInstancesCommand: () => ({
        DBInstances: [
          { DBInstanceIdentifier: "unused-db", DBInstanceStatus: "available", DBInstanceClass: "db.m6g.large", Engine: "postgres" },
          { DBInstanceIdentifier: "quiet-db", DBInstanceStatus: "available", DBInstanceClass: "db.r6g.xlarge", Engine: "mysql" },
          { DBInstanceIdentifier: "busy-db", DBInstanceStatus: "available", DBInstanceClass: "db.t4g.medium", Engine: "postgres" },
          { DBInstanceIdentifier: "new-db", DBInstanceStatus: "available", DBInstanceClass: "db.t4g.micro", Engine: "postgres" },
          { DBInstanceIdentifier: "stopped-db", DBInstanceStatus: "stopped", DBInstanceClass: "db.t4g.micro", Engine: "postgres" },
        ],
      }),
    });

  const metrics: Record<string, Record<string, number[]>> = {
    "unused-db": { DatabaseConnections: [0, 0], CPUUtilization: [3, 4] },
    "quiet-db": { DatabaseConnections: [2, 5], CPUUtilization: [4.2, 6.37] },
    "busy-db": { DatabaseConnections: [40], CPUUtilization: [12, 85] },
    "new-db": { DatabaseConnections: [], CPUUtilization: [] },
  };
  const cloudwatch = () =>
    fakeClient({
      GetMetricStatisticsCommand: (input: { MetricName: string; Dimensions: { Value: string }[] }) => ({
        Datapoints: (metrics[input.Dimensions[0]?.Value ?? ""]?.[input.MetricName] ?? []).map((Maximum) => ({ Maximum })),
      }),
    });

  it("reports instances with no connections or a CPU that never got busy", async () => {
    const findings = await idleRds.run(context(fakeClients({ rds: rds(), cloudwatch: cloudwatch() })));
    expect(findings).toEqual([
      {
        check: "idle-rds",
        region: "eu-west-1",
        resource: "unused-db",
        detail: "db.m6g.large postgres, no connections in the last 14 days",
      },
      {
        check: "idle-rds",
        region: "eu-west-1",
        resource: "quiet-db",
        detail: "db.r6g.xlarge mysql, CPU never went above 6.4% in the last 14 days",
      },
    ]);
  });

  it("widens the metric period so long windows stay under 1,440 datapoints", async () => {
    const watch = cloudwatch();
    const ctx = context(fakeClients({ rds: rds(), cloudwatch: watch }));
    ctx.options.idleDays = 90;
    await idleRds.run(ctx);
    const periods = watch.calls.map((call) => (call.input as { Period: number }).Period);
    expect(new Set(periods)).toEqual(new Set([7200]));
    expect((90 * 86400) / 7200).toBeLessThanOrEqual(1440);
  });
});

describe("no-budget", () => {
  it("reports an account with no budgets", async () => {
    const budgets = fakeClient({ DescribeBudgetsCommand: () => ({ Budgets: [] }) });
    const findings = await noBudget.run(context(fakeClients({ budgets }), { region: "global" }));
    expect(findings).toEqual([
      { check: "no-budget", region: "global", resource: "123456789012", detail: "no budgets are set up in AWS Budgets" },
    ]);
    expect(budgets.calls[0]?.input).toMatchObject({ AccountId: "123456789012" });
  });

  it("treats NotFoundException as no budgets", async () => {
    const budgets = fakeClient({
      DescribeBudgetsCommand: () => {
        throw awsError("NotFoundException", "No budgets found");
      },
    });
    expect(await noBudget.run(context(fakeClients({ budgets })))).toHaveLength(1);
  });

  it("passes other errors up so the run marks the check as skipped", async () => {
    const budgets = fakeClient({
      DescribeBudgetsCommand: () => {
        throw awsError("AccessDeniedException");
      },
    });
    await expect(noBudget.run(context(fakeClients({ budgets })))).rejects.toThrow("AccessDeniedException");
  });

  it("is quiet when a budget exists", async () => {
    const budgets = fakeClient({ DescribeBudgetsCommand: () => ({ Budgets: [{ BudgetName: "monthly" }] }) });
    expect(await noBudget.run(context(fakeClients({ budgets })))).toEqual([]);
  });
});
