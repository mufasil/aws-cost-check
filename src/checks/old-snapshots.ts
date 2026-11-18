import {
  DescribeImagesCommand,
  type DescribeImagesCommandOutput,
  DescribeSnapshotsCommand,
  type DescribeSnapshotsCommandOutput,
  DescribeVolumesCommand,
  type DescribeVolumesCommandOutput,
  type Image,
  type Snapshot,
  type Volume,
} from "@aws-sdk/client-ec2";
import type { Check } from "../types.js";
import { collect, daysBetween } from "../util.js";

const id = "old-snapshots";

// AWS uses this placeholder when a snapshot wasn't taken from a volume in this account, e.g. a copy.
const NO_SOURCE_VOLUME = "vol-ffffffff";

export const oldSnapshots: Check = {
  id,
  title: "Old EBS snapshots",
  why: "Snapshots are kept and billed until someone deletes them, and \"just in case\" copies tend to pile up.",
  scope: "region",
  async run({ region, clients, now, options }) {
    const snapshots = await collect<Snapshot>(async (NextToken) => {
      const res: DescribeSnapshotsCommandOutput = await clients.ec2.send(
        new DescribeSnapshotsCommand({ OwnerIds: ["self"], MaxResults: 1000, NextToken }),
      );
      return { items: res.Snapshots, next: res.NextToken };
    });

    const old = snapshots.filter(
      (snap) => snap.StartTime && daysBetween(snap.StartTime, now) >= options.snapshotAgeDays,
    );
    if (old.length === 0) return [];

    // A snapshot behind a registered AMI is in use, so leave it out.
    const images = await collect<Image>(async (NextToken) => {
      const res: DescribeImagesCommandOutput = await clients.ec2.send(
        new DescribeImagesCommand({ Owners: ["self"], MaxResults: 1000, NextToken }),
      );
      return { items: res.Images, next: res.NextToken };
    });
    const usedByImages = new Set(
      images.flatMap((image) => (image.BlockDeviceMappings ?? []).map((mapping) => mapping.Ebs?.SnapshotId)),
    );

    const volumes = await collect<Volume>(async (NextToken) => {
      const res: DescribeVolumesCommandOutput = await clients.ec2.send(
        new DescribeVolumesCommand({ MaxResults: 500, NextToken }),
      );
      return { items: res.Volumes, next: res.NextToken };
    });
    const existingVolumes = new Set(volumes.map((volume) => volume.VolumeId));

    return old
      .filter((snap) => !usedByImages.has(snap.SnapshotId))
      .map((snap) => {
        const age = daysBetween(snap.StartTime as Date, now);
        const sourceGone =
          snap.VolumeId && snap.VolumeId !== NO_SOURCE_VOLUME && !existingVolumes.has(snap.VolumeId);
        return {
          check: id,
          region,
          resource: snap.SnapshotId ?? "unknown snapshot",
          detail:
            `${age} days old, taken from a ${snap.VolumeSize ?? "?"} GiB volume` +
            (sourceGone ? `. The source volume ${snap.VolumeId} no longer exists` : ""),
        };
      });
  },
};
