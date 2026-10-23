// tests/lifecycle.test.ts — the part of shutdown that touches the web server.
//
// handleShutdown itself ends in process.exit(), so it cannot be driven from a
// test. The behaviour that caused the "Bun.serve() timed out a request"
// warning at Ctrl+C lives in the helper it calls first, and that is testable:
// the listener must be closed before the long shutdown work starts, in-flight
// responses must be allowed to finish (stop(false), never stop(true)), and a
// server that refuses to close must not abort the shutdown.

import { describe, expect, test } from "bun:test";
import { stopAcceptingRequests } from "../src/lifecycle";

describe("stopAcceptingRequests", () => {
  test("closes the listener without cutting in-flight responses", () => {
    const calls: (boolean | undefined)[] = [];
    stopAcceptingRequests({ stop: (closeActive?: boolean) => void calls.push(closeActive) });
    expect(calls).toEqual([false]);
  });

  test("no handle (UI never started, or already gone) is a no-op", () => {
    expect(() => stopAcceptingRequests(null)).not.toThrow();
  });

  test("a server that refuses to stop never aborts the shutdown", () => {
    // The final stop(true) in the shutdown path still runs, so this must be
    // swallowed rather than turning a clean Ctrl+C into exit code 1.
    expect(() =>
      stopAcceptingRequests({
        stop() {
          throw new Error("listener already closed");
        },
      }),
    ).not.toThrow();
  });
});
