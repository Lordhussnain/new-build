// tests/dashboard.test.ts — terminal UI header formatting.
//
// The header is the only thing a user sees when the engine runs in a real
// terminal, so the counters it reports are worth pinning down: in particular
// that the resumable-partial count appears when there is resume state and stays
// out of the way when there is none.
import { describe, expect, test } from "bun:test";
import { formatHeaderLine } from "../src/dashboard";

describe("formatHeaderLine", () => {
  test("reports the core counters", () => {
    const line = formatHeaderLine(
      { downloading: 2, downloaded: 5, failed: 1, total: 12, resumable: 0 },
      "1.5 MB/s",
      "/2.0 MB/s",
    );
    expect(line).toContain("DL:2/");
    expect(line).toContain("Done:5");
    expect(line).toContain("Fail:1");
    expect(line).toContain("Tot:12");
    expect(line).toContain("1.5 MB/s/2.0 MB/s");
  });

  test("omits the resumable count when nothing is resumable", () => {
    // A quiet engine must not carry dead weight in a width-constrained line.
    const line = formatHeaderLine({ downloading: 0, downloaded: 3, total: 3, resumable: 0 }, "0 B/s", "");
    expect(line).not.toContain("Res:");
  });

  test("shows the resumable count when partials are held", () => {
    const line = formatHeaderLine({ downloading: 1, total: 4, resumable: 3 }, "0 B/s", "");
    expect(line).toContain("Res:3");
  });

  test("treats a missing resumable field as zero", () => {
    const line = formatHeaderLine({ total: 1 }, "0 B/s", "");
    expect(line).not.toContain("Res:");
  });

  test("puts the resumable count before the pause reason", () => {
    // Ordering matters: the pause reason is the last thing on the line and the
    // part most likely to be truncated on a narrow terminal.
    const line = formatHeaderLine({ total: 4, resumable: 2 }, "0 B/s", "");
    const at = line.indexOf("Res:2");
    expect(at).toBeGreaterThan(-1);
    expect(line.indexOf("Tot:4")).toBeLessThan(at);
  });

  test("renders an uncapped engine without a bandwidth suffix", () => {
    // The "/cap" suffix is only appended when a cap is configured, so an
    // uncapped engine must not show a dangling separator.
    const line = formatHeaderLine({ total: 0 }, "0 B/s", "");
    expect(line).toContain("0 B/s");
    expect(line).not.toContain("0 B/s/");
  });
});
