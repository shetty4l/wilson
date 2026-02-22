import { describe, expect, test } from "bun:test";
import { type Channel, ChannelRegistry } from "../src/channels/index";

/** Create a minimal test channel that records lifecycle calls. */
function makeChannel(name: string, calls: string[]): Channel {
  return {
    name,
    canReceive: true,
    canDeliver: false,
    mode: "buffered" as const,
    priority: 2,
    async start() {
      calls.push(`start:${name}`);
    },
    async stop() {
      calls.push(`stop:${name}`);
    },
    async sync() {
      calls.push(`sync:${name}`);
    },
  };
}

describe("ChannelRegistry", () => {
  test("register, get, and getAll", () => {
    const reg = new ChannelRegistry();
    const calls: string[] = [];
    const ch = makeChannel("test", calls);

    reg.register(ch);

    expect(reg.get("test")).toBe(ch);
    expect(reg.get("nonexistent")).toBeUndefined();
    expect(reg.getAll()).toEqual([ch]);
  });

  test("startAll starts in registration order", async () => {
    const reg = new ChannelRegistry();
    const calls: string[] = [];
    reg.register(makeChannel("alpha", calls));
    reg.register(makeChannel("beta", calls));
    reg.register(makeChannel("gamma", calls));

    await reg.startAll();

    expect(calls).toEqual(["start:alpha", "start:beta", "start:gamma"]);
  });

  test("stopAll stops in reverse order", async () => {
    const reg = new ChannelRegistry();
    const calls: string[] = [];
    reg.register(makeChannel("alpha", calls));
    reg.register(makeChannel("beta", calls));
    reg.register(makeChannel("gamma", calls));

    await reg.stopAll();

    expect(calls).toEqual(["stop:gamma", "stop:beta", "stop:alpha"]);
  });

  test("duplicate name throws", () => {
    const reg = new ChannelRegistry();
    const calls: string[] = [];
    reg.register(makeChannel("dup", calls));

    expect(() => reg.register(makeChannel("dup", calls))).toThrow(
      'channel "dup" is already registered',
    );
  });
});
