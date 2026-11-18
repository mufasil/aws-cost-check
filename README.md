# aws-cost-check

A small command line tool that goes through an AWS account and points at the usual sources of a surprise bill: disks nobody attached, snapshots nobody needs, logs kept forever, NAT traffic that could use a free S3 endpoint, idle databases and spare Elastic IPs.

It only reads. Every call it makes is a `Describe` or `Get` call, so nothing in your account gets changed, tagged or deleted.

## Run it

You need Node.js 22 or newer and AWS credentials the usual way (environment variables, `~/.aws` profiles or SSO).

```bash
git clone https://github.com/mufasil/aws-cost-check.git
cd aws-cost-check
npm install
npm run build
node dist/cli.js --region eu-west-1
```

A few more ways to run it:

```bash
node dist/cli.js --profile staging --region eu-west-1,us-east-1
node dist/cli.js --all-regions
node dist/cli.js --only log-retention,unattached-volumes
node dist/cli.js --json > report.json
```

## What it looks for

| Check | What gets flagged | Why it costs money |
| --- | --- | --- |
| `no-budget` | The account has no budget in AWS Budgets | Nothing warns you before the invoice does |
| `nat-without-s3-endpoint` | A VPC with a NAT gateway and no S3 gateway endpoint, with how much went out through NAT in the last 7 days | S3 traffic from private subnets is charged per GB as NAT data processing, and an S3 gateway endpoint costs nothing |
| `unattached-volumes` | EBS volumes in the `available` state | A volume is billed for its full size until it's deleted |
| `old-snapshots` | Snapshots older than 90 days that no AMI uses, and whether their source volume still exists | Snapshots stay and get billed until someone deletes them |
| `log-retention` | Log groups with no retention period, biggest first | Log groups never expire by default |
| `idle-rds` | RDS instances with no connections, or with CPU that never passed 10%, over the last 14 days | You keep paying for capacity nobody uses |
| `unused-elastic-ips` | Elastic IPs not associated with anything | Every public IPv4 address is billed by the hour |

Treat each finding as something to look at, not something to delete straight away. A quiet database might be a standby that someone needs, and an old snapshot might be the only backup of something.

## Example output

This is from a made-up account.

```text
aws-cost-check, account 111122223333, 1 region: eu-west-1

VPCs with a NAT gateway but no S3 gateway endpoint (1)
  S3 traffic from private subnets then goes through the NAT and is charged per GB, while an S3 gateway endpoint is free.
  eu-west-1  vpc-0a1b2c3d4e5f60789  NAT gateway nat-0123456789abcdef0 and no S3 gateway endpoint. 412 GiB went out through NAT in the last 7 days

EBS volumes not attached to anything (1)
  A volume is billed for its full size every month until it's deleted, even when no server uses it.
  eu-west-1  vol-0f1e2d3c4b5a69788  200 GiB gp3 volume, created 2026-02-11

Log groups that keep data forever (2)
  CloudWatch log groups never expire by default, so stored logs are billed every month from then on.
  eu-west-1  /aws/lambda/orders-api  no retention set, 38 GiB stored
  eu-west-1  /ecs/staging-web        no retention set, 6.2 GiB stored

RDS instances with almost no load (1)
  An instance sized on launch day and never looked at again keeps billing for capacity nobody uses.
  eu-west-1  demo-staging-db  db.m6g.large postgres, no connections in the last 14 days

Nothing found
  No AWS Budgets alert
  Old EBS snapshots
  Elastic IPs not attached to anything

5 findings. Nothing in the account was changed.
```

## Options

```text
  -r, --region <list>     Regions to check, comma separated. Defaults to your configured region.
      --all-regions       Check every region enabled for the account.
  -p, --profile <name>    AWS profile to use. Same as setting AWS_PROFILE.
      --only <list>       Run only these checks, comma separated.
      --snapshot-age <n>  Report snapshots at least n days old (default 90).
      --idle-days <n>     Days of RDS metrics to look at (default 14).
      --idle-cpu <n>      Report RDS instances whose CPU stayed under n percent (default 10).
      --json              Print JSON instead of text.
      --fail-on-findings  Exit with code 1 when anything is found. Handy in CI.
```

## Permissions

The AWS managed `ReadOnlyAccess` policy is enough. If you'd rather give it only what it uses, this policy covers every check:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ec2:DescribeAddresses",
        "ec2:DescribeImages",
        "ec2:DescribeNatGateways",
        "ec2:DescribeRegions",
        "ec2:DescribeSnapshots",
        "ec2:DescribeVolumes",
        "ec2:DescribeVpcEndpoints",
        "logs:DescribeLogGroups",
        "rds:DescribeDBInstances",
        "cloudwatch:GetMetricStatistics",
        "budgets:ViewBudget"
      ],
      "Resource": "*"
    }
  ]
}
```

If a permission is missing, that one check is listed under "Could not run" with the error, and the other checks still run.

## In CI

`--fail-on-findings` makes the exit code 1 when anything is found, so a scheduled job can fail and notify you.

| Exit code | Meaning |
| --- | --- |
| 0 | Ran fine. With `--fail-on-findings`, also means nothing was found |
| 1 | Something was found and `--fail-on-findings` was set |
| 2 | It couldn't run, for example no credentials or a bad option |

## Development

```bash
npm install
npm test            # vitest, with fake AWS clients
npm run typecheck
npm run build
```

Each check lives in `src/checks/` and gets its AWS clients passed in, so the tests swap them for small fakes in `test/fake.ts` instead of calling AWS.

## License

MIT
