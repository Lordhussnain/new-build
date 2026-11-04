import { describe, expect, test } from "bun:test";
import { activeDlSlots } from "../src/autoscale";
import { DEFAULT_CONFIG } from "../src/config";
import { db, initDatabase } from "../src/db";
import {
  composeDashboardFrame,
  dashboardLineCount,
  fitToWidth,
  initDashboard,
  resetTerminal,
  sanitizeTerminalText,
  TerminalDashboardRenderer,
  terminalTextWidth,
  useTerminalColor,
  type DashboardSnapshot,
  type DashboardWorker,
  type TerminalOutput,
} from "../src/dashboard";
import {
  activeDownloadJobs, activeMetadataJobs, getConfig, getPauseReason, isPaused, isTty,
  setConfig, setPaused, setTty, workerStatuses,
} from "../src/state";

function snapshot(overrides: Partial<DashboardSnapshot> = {}): DashboardSnapshot {
  return {
    stats: { downloaded: 28, total: 120, downloading: 2, queued: 70, failed: 1, resumable: 3 },
    speed: "4.3 MB/s",
    capSuffix: "/10 MB/s",
    targetWorkers: 4,
    paused: false,
    offline: false,
    webUrl: "http://127.0.0.1:3000",
    workers: [
      { kind: "DL", id: 1, active: true, status: "⬇️ 42.5% @ 3.5 MB/s, ETA 31s | A video with 🤖 robotics" },
      { kind: "DL", id: 2, active: false, status: "— idle slot —" },
      { kind: "CV", id: 1, active: true, status: "🎞️ Converting | Episode four" },
      { kind: "MD", id: 1, active: true, status: "📎 Metadata | हिंदी 日本語" },
    ],
    ...overrides,
  };
}

class FakeTerminal implements TerminalOutput {
  columns = 100;
  rows = 24;
  writes: string[] = [];
  write(text: string): void { this.writes.push(text); }
}

describe("terminal dashboard frame", () => {
  test("shows clear totals, throughput, resumable work and labeled progress", () => {
    const frame = composeDashboardFrame(snapshot(), 100, 24, 0)!;
    const text = frame.lines.map((line) => line.text).join("\n");
    expect(text).toContain("YouTube Archive  ·  RUNNING");
    expect(text).toContain("Ctrl+C to stop");
    expect(text).toContain("Downloaded 28/120");
    expect(text).toContain("Active 2/4");
    expect(text).toContain("Queued 70");
    expect(text).toContain("Failed 1");
    expect(text).toContain("Rate 4.3 MB/s / 10 MB/s");
    expect(text).toContain("Resumable 3");
    expect(text).toContain("Web http://127.0.0.1:3000");
    expect(text).toContain("DL 01 │ ███░░░░░ 42.5%");
    expect(text).toContain("ETA 31s");
    expect(text).toContain("CV 01 │ 🎞️ Converting");
    expect(text).toContain("MD 01 │ 📎 Metadata");
    expect(text).toContain("ACTIVITY");
    expect(frame.hiddenWorkers).toBe(0);
    expect(frame.lines).toHaveLength(dashboardLineCount({ ...DEFAULT_CONFIG, maxDownloadWorkers: 2, maxConcurrentConverts: 1, maxMetadataWorkers: 1 }));
  });

  test("a paused engine and its reason remain visible in a narrow terminal", () => {
    const frame = composeDashboardFrame(snapshot({
      paused: true, pauseReason: "ENGINE_LEASE_LOST",
      stats: { downloaded: 28, total: 120, downloading: 2, queued: 70, pausedJobs: 9, failed: 1, resumable: 3 },
    }), 40, 11, 0)!;
    expect(frame.lines[0].text).toContain("PAUSED");
    expect(frame.lines[1].text).toContain("Paused 9");
    expect(frame.lines[1].text).toContain("Res 3");
    expect(frame.lines[1].text).toContain("Fail 1");
    expect(frame.lines[2].text).toContain("Reason: ENGINE_LEASE_LOST");
    expect(frame.lines[0].tone).toBe("warning");
    expect(frame.lines[2].tone).toBe("warning");
    expect(frame.hiddenWorkers).toBe(3);
    expect(frame.hiddenActiveWorkers).toBe(2);
    expect(frame.lines.map((line) => line.text).join("\n")).toContain("more workers");
  });

  test("offline state is explicit and a global pause takes precedence", () => {
    const offline = composeDashboardFrame(snapshot({ offline: true }), 80, 24, 0)!;
    expect(offline.lines[0].text).toContain("OFFLINE");
    expect(offline.lines[2].text).toContain("Downloads are waiting");
    const paused = composeDashboardFrame(snapshot({ offline: true, paused: true, pauseReason: "LOW_DISK_SPACE" }), 80, 24, 0)!;
    expect(paused.lines[0].text).toContain("PAUSED");
    expect(paused.lines[2].text).toContain("LOW_DISK_SPACE");
  });

  test("keeps resumable counts on narrow and offline displays without truncating a URL", () => {
    const text = composeDashboardFrame(snapshot(), 60, 18, 0)!.lines[2].text;
    expect(text).toContain("Rate 4.3 MB/s");
    expect(text).toContain("Resumable 3");
    expect(text).not.toContain("http://");
    expect(composeDashboardFrame(snapshot(), 40, 11, 0)!.lines[2].text).toContain("Res 3");
    expect(composeDashboardFrame(snapshot({ offline: true }), 40, 11, 0)!.lines[2].text).toContain("Res 3");
  });

  test("active work takes priority over idle rows in a short window", () => {
    const workers: DashboardWorker[] = [
      ...Array.from({ length: 20 }, (_, i) => ({ kind: "DL" as const, id: i + 1, active: i === 19, status: i === 19 ? "Downloading" : "Idle" })),
      ...Array.from({ length: 10 }, (_, i) => ({ kind: "CV" as const, id: i + 1, active: i === 9, status: i === 9 ? "Converting" : "Idle" })),
      ...Array.from({ length: 10 }, (_, i) => ({ kind: "MD" as const, id: i + 1, active: i === 9, status: i === 9 ? "Metadata" : "Idle" })),
    ];
    const frame = composeDashboardFrame(snapshot({ workers }), 80, 16, 0)!;
    const keys = frame.lines.map((line) => line.workerKey);
    expect(keys).toContain("DL20");
    expect(keys).toContain("CV10");
    expect(keys).toContain("MD10");
    expect(frame.hiddenWorkers).toBe(34);
    expect(frame.hiddenActiveWorkers).toBe(0);
    expect(frame.lines.length).toBeLessThanOrEqual(12); // four rows remain for logs
  });

  test("a title containing failure words does not make a healthy worker look failed", () => {
    const workers: DashboardWorker[] = [{
      kind: "DL", id: 1, active: true, status: "⬇️ 20.0% @ 1 MB/s | When the network failed: a documentary",
    }];
    const frame = composeDashboardFrame(snapshot({ workers }), 80, 24, 0)!;
    expect(frame.lines.find((line) => line.workerKey === "DL1")?.tone).toBe("normal");
  });

  test("when active work exceeds the viewport it rotates, without duplicate rows", () => {
    const workers: DashboardWorker[] = Array.from({ length: 5 }, (_, i) => ({
      kind: "DL", id: i + 1, active: true, status: `Downloading ${i + 1}`,
    }));
    const first = composeDashboardFrame(snapshot({ workers }), 40, 11, 0)!;
    const next = composeDashboardFrame(snapshot({ workers }), 40, 11, 8_000)!;
    expect(first.lines.find((line) => line.workerKey)?.workerKey).toBe("DL1");
    expect(next.lines.find((line) => line.workerKey)?.workerKey).toBe("DL2");
    expect(first.hiddenWorkers).toBe(4);
    expect(first.hiddenActiveWorkers).toBe(4);
    expect(first.lines.map((line) => line.text).join("\n")).toContain("rotating");
  });

  test("all frame lines fit and leave room for logs across window sizes", () => {
    const workers: DashboardWorker[] = Array.from({ length: 40 }, (_, i) => ({
      kind: i < 20 ? "DL" : i < 30 ? "CV" : "MD", id: (i % 10) + 1,
      active: i % 2 === 0, status: "⬇️ 99.9% @ 1.3 MB/s, ETA 2s | 👩🏽‍💻 日本語 très long title".repeat(3),
    }));
    // Use unique worker keys, just as the running engine does.
    workers.forEach((worker, i) => { if (i < 20) worker.id = i + 1; });
    for (const cols of [40, 41, 60, 80, 120]) {
      for (const rows of [11, 12, 18, 24, 50]) {
        const frame = composeDashboardFrame(snapshot({ workers }), cols, rows, 0)!;
        expect(frame.lines.length).toBeLessThanOrEqual(rows - 4);
        for (const entry of frame.lines) expect(terminalTextWidth(entry.text)).toBeLessThanOrEqual(cols - 1);
      }
    }
    expect(composeDashboardFrame(snapshot(), 39, 24)).toBeNull();
    expect(composeDashboardFrame(snapshot(), 80, 10)).toBeNull();
  });
});

describe("terminal text and color safety", () => {
  test("handles wide graphemes, emoji sequences and very small widths", () => {
    expect(terminalTextWidth("👩🏽‍💻")).toBe(2);
    expect(terminalTextWidth("🇵🇰")).toBe(2);
    expect(terminalTextWidth("e\u0301")).toBe(1);
    expect(terminalTextWidth("⬇️")).toBe(2);
    // A few terminals render joined emoji as several glyphs. The fit budget is
    // conservative even though a modern terminal displays the grapheme as two.
    expect(fitToWidth("A👩🏽‍💻BC", 9)).toBe("A👩🏽‍💻BC");
    expect(fitToWidth("A👩🏽‍💻BC", 5)).toBe("A...");
    const family = "👨‍👩‍👧‍👦";
    expect(fitToWidth(family.repeat(10), 79)).toBe(family.repeat(9) + "...");
    expect(fitToWidth("abcd", 2)).toBe("..");
    expect(fitToWidth("abcd", 1)).toBe(".");
    expect(fitToWidth("abcd", 0)).toBe("");
    expect(fitToWidth("x".repeat(200_000), 12)).toBe("xxxxxxxxx...");
  });

  test("strips cursor escapes, terminal titles and hyperlinks from untrusted text", () => {
    const unsafe = "title\x1b]0;INJECTED\x07\x1b[2J\x1b]8;;https://example.test\x1b\\link\x1b]8;;\x1b\\\nnext";
    const clean = sanitizeTerminalText(unsafe);
    expect(clean).toBe("titlelink next");
    expect(clean).not.toContain("\x1b");
    const frame = composeDashboardFrame(snapshot({
      paused: true, pauseReason: unsafe,
      workers: [{ kind: "DL", id: 1, active: true, status: unsafe }],
    }), 100, 24, 0)!;
    expect(frame.lines.every((entry) => !entry.text.includes("\x1b") && !entry.text.includes("INJECTED"))).toBe(true);
  });

  test("respects NO_COLOR, CLICOLOR and dumb terminals", () => {
    expect(useTerminalColor({})).toBe(true);
    expect(useTerminalColor({ NO_COLOR: "" })).toBe(false);
    expect(useTerminalColor({ CLICOLOR: "0" })).toBe(false);
    expect(useTerminalColor({ TERM: "dumb" })).toBe(false);
  });
});

describe("terminal dashboard rendering", () => {
  test("preserves the log cursor, resizes, falls back and restores cleanly", () => {
    const terminal = new FakeTerminal();
    const renderer = new TerminalDashboardRenderer(terminal, false);
    const view = snapshot();
    const frame = composeDashboardFrame(view, terminal.columns, terminal.rows, 0)!;
    expect(renderer.render(view, 0)).toBe(true);
    expect(terminal.writes[0]).toContain(`\x1b[${frame.lines.length + 1};24r`);
    expect(terminal.writes[0].endsWith(`\x1b[${frame.lines.length + 1};1H`)).toBe(true);
    expect(terminal.writes[0]).not.toContain("\x1b8");
    renderer.render(view, 0);
    expect(terminal.writes).toHaveLength(1); // identical frames do not redraw

    const updated = snapshot({ workers: view.workers.map((worker) =>
      worker.kind === "DL" && worker.id === 1 ? { ...worker, status: "⬇️ 50.0% @ 4 MB/s, ETA 20s | New title" } : worker) });
    renderer.render(updated, 0);
    const incremental = terminal.writes.at(-1)!;
    expect(incremental.startsWith("\x1b7")).toBe(true);
    expect(incremental.endsWith("\x1b8")).toBe(true);
    expect(incremental).toContain("50.0%");
    expect(incremental).not.toContain(";24r");

    terminal.columns = 60;
    terminal.rows = 14;
    expect(renderer.render(updated, 0)).toBe(true);
    expect(terminal.writes.at(-1)).toContain("\x1b[1;14r");
    expect(terminal.writes.at(-1)!.endsWith("\x1b[14;1H")).toBe(true);

    terminal.columns = 30;
    terminal.rows = 8;
    expect(renderer.render(updated, 0)).toBe(false);
    expect(terminal.writes.at(-1)).toContain("\x1b[1;8r");
    expect(terminal.writes.at(-1)!.endsWith("\x1b[8;1H")).toBe(true);

    terminal.columns = 100;
    terminal.rows = 24;
    expect(renderer.render(updated, 0)).toBe(true);
    expect(terminal.writes.at(-1)).toContain("YouTube Archive");
    renderer.stop();
    expect(terminal.writes.at(-1)).toBe("\x1b[1;24r\x1b[24;1H");
    expect(terminal.writes.join("")).not.toMatch(/\x1b\[[\d;]*m/); // no SGR colors
  });

  test("uses trusted color codes while stripping malicious worker controls", () => {
    const terminal = new FakeTerminal();
    const renderer = new TerminalDashboardRenderer(terminal, true);
    renderer.render(snapshot({ workers: [{ kind: "DL", id: 1, active: true, status: "⚠️ Failed \x1b]0;BAD\x07 | video" }] }), 0);
    const output = terminal.writes.join("");
    expect(output).toContain("\x1b[1;36m");
    expect(output).toContain("\x1b[31m");
    expect(output).not.toContain("BAD");
    renderer.stop();
    expect(terminal.writes.at(-1)).toContain("\x1b[0m");
  });

  test("an initially tiny TTY restores with accurate DB counters on resize", () => {
    const stdout = process.stdout;
    const oldWrite = stdout.write;
    const oldColumns = Object.getOwnPropertyDescriptor(stdout, "columns");
    const oldRows = Object.getOwnPropertyDescriptor(stdout, "rows");
    const oldTty = Boolean(isTty());
    const oldPaused = isPaused(), oldReason = getPauseReason(), oldConfig = getConfig();
    const oldStatuses = new Map(workerStatuses), oldActiveSlots = new Set(activeDlSlots);
    const oldDownloads = new Map(activeDownloadJobs), oldMetadata = new Map(activeMetadataJobs);
    const oldTerm = process.env.TERM;
    const oldLog = console.log;
    const writes: string[] = [];
    try {
      initDatabase(":memory:");
      db.run(`INSERT INTO jobs (id, download_status, conversion_status, metadata_status, partial_file_path) VALUES
        ('q', 'pending', 'pending', 'not_needed', NULL),
        ('p', 'paused', 'pending', 'not_needed', 'paused.part'),
        ('d', 'downloading', 'pending', 'not_needed', 'active.part'),
        ('c', 'downloaded', 'failed', 'not_needed', NULL),
        ('m', 'downloaded', 'done', 'failed', NULL),
        ('f', 'failed', 'pending', 'not_needed', NULL),
        ('both', 'failed', 'failed', 'failed', NULL)`);
      setConfig({ ...DEFAULT_CONFIG });
      setPaused(false);
      workerStatuses.set("DL1", "⏸️ Parked — slot scaled down");
      workerStatuses.set("MD1", "📴 Offline mode — sidecars need network");
      activeDlSlots.add(1);
      activeDownloadJobs.delete(1);
      activeMetadataJobs.delete(1);
      process.env.TERM = "xterm";
      Object.defineProperty(stdout, "columns", { configurable: true, writable: true, value: 100 });
      Object.defineProperty(stdout, "rows", { configurable: true, writable: true, value: 8 });
      stdout.write = ((text: string) => { writes.push(String(text)); return true; }) as typeof stdout.write;
      console.log = () => {};
      setTty(true);
      initDashboard(DEFAULT_CONFIG);
      expect(isTty()).toBe(false);
      expect(writes).toHaveLength(0);
      Object.defineProperty(stdout, "rows", { configurable: true, writable: true, value: 24 });
      stdout.emit("resize");
      expect(isTty()).toBe(true);
      const output = writes.join("");
      expect(output).toContain("YouTube Archive");
      expect(output).toContain("Downloaded 2/7");
      expect(output).toContain("Queued 1");
      expect(output).toContain("Paused 1");
      expect(output).toContain("Failed 4"); // one per job, across all three stages
      expect(output).toContain("Resumable 2");
      expect(output).toContain("DL 01 │ Idle"); // no longer parked after scale-up
      expect(output).toContain("MD 01 │ Idle"); // offline was switched off
      resetTerminal();
      expect(isTty()).toBe(false);
    } finally {
      resetTerminal();
      setTty(oldTty);
      setConfig(oldConfig);
      setPaused(oldPaused, oldReason);
      workerStatuses.clear();
      for (const [key, value] of oldStatuses) workerStatuses.set(key, value);
      activeDlSlots.clear();
      for (const id of oldActiveSlots) activeDlSlots.add(id);
      activeDownloadJobs.clear();
      for (const [id, job] of oldDownloads) activeDownloadJobs.set(id, job);
      activeMetadataJobs.clear();
      for (const [id, job] of oldMetadata) activeMetadataJobs.set(id, job);
      stdout.write = oldWrite;
      if (oldColumns) Object.defineProperty(stdout, "columns", oldColumns); else delete (stdout as any).columns;
      if (oldRows) Object.defineProperty(stdout, "rows", oldRows); else delete (stdout as any).rows;
      if (oldTerm === undefined) delete process.env.TERM; else process.env.TERM = oldTerm;
      console.log = oldLog;
    }
  });
});
