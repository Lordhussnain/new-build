// tests/sleep-interval.test.ts — yt-dlp --sleep-interval / --max-sleep-interval.

import { describe, expect, test } from "bun:test";
import { parseConfig } from "../src/config";
import { buildDownloadPlan } from "../src/download-args";

const job: any = {
  id: "job-1",
  url: "https://www.youtube.com/watch?v=cEhIs1oPy5M",
  title: "Sleep test",
  index: 1,
  output_directory: "/tmp/sleep-test-out",
  duration: 600,
  video_quality: null,
  target_format: null,
  audio_tracks: null,
};

function argsFor(overrides: Record<string, unknown>): string[] {
  const config = parseConfig(overrides);
  return buildDownloadPlan({ job, config, activeSlots: 1, aria2cAvailable: false }).args;
}

describe("sleep-interval download options", () => {
  test("defaults to off: no sleep flags are emitted", () => {
    const args = argsFor({});
    expect(args).not.toContain("--sleep-interval");
    expect(args).not.toContain("--max-sleep-interval");
  });

  test("sleepInterval emits --sleep-interval", () => {
    const args = argsFor({ sleepInterval: 5 });
    expect(args[args.indexOf("--sleep-interval") + 1]).toBe("5");
    expect(args).not.toContain("--max-sleep-interval");
  });

  test("maxSleepInterval is passed only when it is larger than sleepInterval", () => {
    const random = argsFor({ sleepInterval: 3, maxSleepInterval: 10 });
    expect(random[random.indexOf("--max-sleep-interval") + 1]).toBe("10");

    const same = argsFor({ sleepInterval: 5, maxSleepInterval: 5 });
    expect(same).not.toContain("--max-sleep-interval");

    const lower = argsFor({ sleepInterval: 8, maxSleepInterval: 2 });
    expect(lower).not.toContain("--max-sleep-interval");
  });

  test("values above 60 seconds are rejected by the config schema", () => {
    expect(() => parseConfig({ sleepInterval: 61 })).toThrow();
    expect(() => parseConfig({ maxSleepInterval: 120 })).toThrow();
    expect(() => parseConfig({ sleepInterval: -1 })).toThrow();
  });
});
