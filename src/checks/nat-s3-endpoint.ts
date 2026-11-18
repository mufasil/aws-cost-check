import { GetMetricStatisticsCommand, type GetMetricStatisticsCommandOutput } from "@aws-sdk/client-cloudwatch";
import {
  DescribeNatGatewaysCommand,
  type DescribeNatGatewaysCommandOutput,
  DescribeVpcEndpointsCommand,
  type DescribeVpcEndpointsCommandOutput,
  type NatGateway,
  type VpcEndpoint,
} from "@aws-sdk/client-ec2";
import type { Check, SendClient } from "../types.js";
import { collect, DAY_MS, formatBytes } from "../util.js";

const id = "nat-without-s3-endpoint";
const LOOKBACK_DAYS = 7;

export const natWithoutS3Endpoint: Check = {
  id,
  title: "VPCs with a NAT gateway but no S3 gateway endpoint",
  why: "S3 traffic from private subnets then goes through the NAT and is charged per GB, while an S3 gateway endpoint is free.",
  scope: "region",
  async run({ region, clients, now }) {
    const natGateways = await collect<NatGateway>(async (NextToken) => {
      const res: DescribeNatGatewaysCommandOutput = await clients.ec2.send(
        new DescribeNatGatewaysCommand({ Filter: [{ Name: "state", Values: ["available"] }], MaxResults: 1000, NextToken }),
      );
      return { items: res.NatGateways, next: res.NextToken };
    });
    if (natGateways.length === 0) return [];

    const endpoints = await collect<VpcEndpoint>(async (NextToken) => {
      const res: DescribeVpcEndpointsCommandOutput = await clients.ec2.send(
        new DescribeVpcEndpointsCommand({
          Filters: [
            { Name: "vpc-endpoint-type", Values: ["Gateway"] },
            { Name: "service-name", Values: [`com.amazonaws.${region}.s3`] },
          ],
          MaxResults: 1000,
          NextToken,
        }),
      );
      return { items: res.VpcEndpoints, next: res.NextToken };
    });
    const vpcsWithEndpoint = new Set(
      endpoints.filter((endpoint) => endpoint.State?.toLowerCase() === "available").map((endpoint) => endpoint.VpcId),
    );

    const byVpc = new Map<string, string[]>();
    for (const nat of natGateways) {
      if (!nat.VpcId || !nat.NatGatewayId || vpcsWithEndpoint.has(nat.VpcId)) continue;
      byVpc.set(nat.VpcId, [...(byVpc.get(nat.VpcId) ?? []), nat.NatGatewayId]);
    }

    const findings = [];
    for (const [vpcId, natIds] of byVpc) {
      const bytes = await bytesOut(clients.cloudwatch, natIds, now);
      const traffic =
        bytes === undefined ? "" : `. ${formatBytes(bytes)} went out through NAT in the last ${LOOKBACK_DAYS} days`;
      findings.push({
        check: id,
        region,
        resource: vpcId,
        detail: `NAT ${natIds.length === 1 ? "gateway" : "gateways"} ${natIds.join(", ")} and no S3 gateway endpoint${traffic}`,
      });
    }
    return findings;
  },
};

/** Total BytesOutToDestination for the gateways, or undefined if the metrics can't be read. */
async function bytesOut(cloudwatch: SendClient, natIds: string[], now: Date): Promise<number | undefined> {
  try {
    let total = 0;
    for (const natId of natIds) {
      const res: GetMetricStatisticsCommandOutput = await cloudwatch.send(
        new GetMetricStatisticsCommand({
          Namespace: "AWS/NATGateway",
          MetricName: "BytesOutToDestination",
          Dimensions: [{ Name: "NatGatewayId", Value: natId }],
          StartTime: new Date(now.getTime() - LOOKBACK_DAYS * DAY_MS),
          EndTime: now,
          Period: LOOKBACK_DAYS * 86400,
          Statistics: ["Sum"],
        }),
      );
      total += (res.Datapoints ?? []).reduce((sum, point) => sum + (point.Sum ?? 0), 0);
    }
    return total;
  } catch {
    return undefined;
  }
}
