import type { Check } from "../types.js";
import { noBudget } from "./budgets.js";
import { idleRds } from "./idle-rds.js";
import { logRetention } from "./log-retention.js";
import { natWithoutS3Endpoint } from "./nat-s3-endpoint.js";
import { oldSnapshots } from "./old-snapshots.js";
import { unattachedVolumes } from "./unattached-volumes.js";
import { unusedElasticIps } from "./unused-elastic-ips.js";

/** Every check, in the order the report shows them. */
export const allChecks: Check[] = [
  noBudget,
  natWithoutS3Endpoint,
  unattachedVolumes,
  oldSnapshots,
  logRetention,
  idleRds,
  unusedElasticIps,
];
