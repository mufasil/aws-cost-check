import { DescribeBudgetsCommand, type DescribeBudgetsCommandOutput } from "@aws-sdk/client-budgets";
import type { Check } from "../types.js";

const id = "no-budget";

export const noBudget: Check = {
  id,
  title: "No AWS Budgets alert",
  why: "Without a budget, nothing warns you before the invoice does.",
  scope: "account",
  async run({ account, clients }) {
    let count = 0;
    try {
      const res: DescribeBudgetsCommandOutput = await clients.budgets.send(
        new DescribeBudgetsCommand({ AccountId: account, MaxResults: 100 }),
      );
      count = res.Budgets?.length ?? 0;
    } catch (err) {
      // The Budgets API answers NotFoundException when an account has no budgets at all.
      if (!(err instanceof Error && err.name === "NotFoundException")) throw err;
    }
    if (count > 0) return [];
    return [
      {
        check: id,
        region: "global",
        resource: account,
        detail: "no budgets are set up in AWS Budgets",
      },
    ];
  },
};
