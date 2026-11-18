import { DescribeVolumesCommand, type DescribeVolumesCommandOutput, type Volume } from "@aws-sdk/client-ec2";
import type { Check } from "../types.js";
import { collect, isoDate } from "../util.js";

const id = "unattached-volumes";

export const unattachedVolumes: Check = {
  id,
  title: "EBS volumes not attached to anything",
  why: "A volume is billed for its full size every month until it's deleted, even when no server uses it.",
  scope: "region",
  async run({ region, clients }) {
    const volumes = await collect<Volume>(async (NextToken) => {
      const res: DescribeVolumesCommandOutput = await clients.ec2.send(
        new DescribeVolumesCommand({ Filters: [{ Name: "status", Values: ["available"] }], MaxResults: 500, NextToken }),
      );
      return { items: res.Volumes, next: res.NextToken };
    });

    return volumes.map((volume) => ({
      check: id,
      region,
      resource: volume.VolumeId ?? "unknown volume",
      detail: `${volume.Size ?? "?"} GiB ${volume.VolumeType ?? ""} volume, created ${isoDate(volume.CreateTime)}`.replace("  ", " "),
    }));
  },
};
