import type { CheckContext, Clients, SendClient } from "../src/types.js";

// Fakes return loosely shaped SDK output.
type Handler = (input: any) => unknown;

export interface FakeClient extends SendClient {
  calls: { name: string; input: unknown }[];
}

/**
 * A stand-in for an SDK client. Handlers are keyed by command class name.
 * An array of handlers answers successive calls in order, which is how pagination is tested.
 */
export function fakeClient(handlers: Record<string, Handler | Handler[]> = {}): FakeClient {
  const calls: FakeClient["calls"] = [];
  const queues = new Map<string, Handler[]>();
  return {
    calls,
    async send(command: unknown) {
      const { name } = (command as object).constructor;
      const input = (command as { input: unknown }).input;
      calls.push({ name, input });
      const handler = handlers[name];
      if (!handler) throw new Error(`fake client has no handler for ${name}`);
      if (Array.isArray(handler)) {
        const queue = queues.get(name) ?? [...handler];
        queues.set(name, queue);
        const next = queue.shift();
        if (!next) throw new Error(`fake client ran out of responses for ${name}`);
        return next(input);
      }
      return handler(input);
    },
  };
}

export function fakeClients(overrides: Partial<Clients> = {}): Clients {
  return {
    ec2: fakeClient(),
    logs: fakeClient(),
    cloudwatch: fakeClient(),
    rds: fakeClient(),
    budgets: fakeClient(),
    ...overrides,
  };
}

export const NOW = new Date("2026-11-18T00:00:00Z");

export function context(clients: Clients, overrides: Partial<CheckContext> = {}): CheckContext {
  return {
    region: "eu-west-1",
    account: "123456789012",
    clients,
    now: NOW,
    options: { snapshotAgeDays: 90, idleDays: 14, idleCpuPercent: 10 },
    ...overrides,
  };
}

export const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);

export function awsError(name: string, message = name): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}
