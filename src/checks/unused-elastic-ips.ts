import { DescribeAddressesCommand, type DescribeAddressesCommandOutput } from "@aws-sdk/client-ec2";
import type { Check } from "../types.js";

const id = "unused-elastic-ips";

export const unusedElasticIps: Check = {
  id,
  title: "Elastic IPs not attached to anything",
  why: "AWS bills every public IPv4 address by the hour, whether or not anything is using it.",
  scope: "region",
  async run({ region, clients }) {
    const res: DescribeAddressesCommandOutput = await clients.ec2.send(new DescribeAddressesCommand({}));
    return (res.Addresses ?? [])
      .filter((address) => !address.AssociationId)
      .map((address) => ({
        check: id,
        region,
        resource: address.PublicIp ?? address.AllocationId ?? "unknown address",
        detail: `allocated as ${address.AllocationId ?? "?"} but not associated with any instance or network interface`,
      }));
  },
};
