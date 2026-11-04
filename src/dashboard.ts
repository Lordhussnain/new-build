// src/dashboard.ts — a resize-aware terminal dashboard above the scrolling log.
//
// Rendering is deliberately independent of worker ownership and job state:
// the TUI only reads snapshots and never changes a job. Worker counts reflect
// the processes actually started, not live settings that need a restart. When
// the terminal is short, active workers get priority and an overflow indicator
// replaces the old all-or-nothing fallback. Non-TTY output stays plain logs.

import { db } from "./db";
import { activeDlSlots, autoscaler } from "./autoscale";
import { formatBytesPerSec } from "./util";
import {
  activeConvertJobs,
  activeDownloadJobs,
  activeMetadataJobs,
  getConfig,
  getPauseReason,
  isPaused,
  isTty,
  setTty,
  workerStatuses,
} from "./state";
import type { Config } from "./config";

const MIN_COLUMNS = 40;
const MIN_ROWS = 11;
const MIN_LOG_ROWS = 4;
const FIXED_ROWS = 5; // three header rows, worker heading, activity heading
const WORKER_PAGE_MS = 8_000;
const REDRAW_DELAY_MS = 100;
// A hostile or damaged title must not make every UI refresh scan megabytes.
const MAX_TERMINAL_TEXT_LENGTH = 4096;
const IDLE_DOWNLOAD = "— idle slot —";
const IDLE_WORKER = "💤 Idle";

export type WorkerKind = "DL" | "CV" | "MD";
export type DashboardTone = "normal" | "brand" | "success" | "warning" | "error" | "muted";

/** Rows per worker kind, as actually started. Download workers can grow live. */
interface Layout {
  download: number;
  convert: number;
  metadata: number;
}

export interface DashboardStats {
  downloading?: number | null;
  downloaded?: number | null;
  failed?: number | null;
  total?: number | null;
  /** Jobs pending a download, not including already active or paused jobs. */
  queued?: number | null;
  /** Individual download jobs currently held in the paused state. */
  pausedJobs?: number | null;
  resumable?: number | null;
}

export interface DashboardWorker {
  kind: WorkerKind;
  id: number;
  status: string;
  /** A worker that currently owns a job, not merely a non-empty status string. */
  active: boolean;
}

export interface DashboardSnapshot {
  stats: DashboardStats;
  speed: string;
  capSuffix: string;
  targetWorkers: number;
  paused: boolean;
  pauseReason?: string | null;
  offline: boolean;
  webUrl?: string;
  workers: readonly DashboardWorker[];
}

export interface DashboardFrameLine {
  text: string;
  tone: DashboardTone;
  workerKey?: string;
}

export interface DashboardFrame {
  lines: DashboardFrameLine[];
  hiddenWorkers: number;
  hiddenActiveWorkers: number;
}

/** Number of lines needed to display all workers, before viewport compaction. */
export function dashboardLineCount(config: Config): number {
  return FIXED_ROWS + config.maxDownloadWorkers + config.maxConcurrentConverts + config.maxMetadataWorkers;
}

/**
 * Remove terminal control sequences from untrusted job titles and tool output.
 * Drop complete OSC/DCS strings before stripping CSI and other controls, so an
 * embedded title/hyperlink cannot move the cursor or change the terminal title.
 */
export function sanitizeTerminalText(text: string): string {
  return String(text ?? "")
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g, "")
    .replace(/\x1b[P^_][\s\S]*?(?:\x1b\\|$)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}

/** Approximate terminal column width of a code point; combining marks are zero. */
function charWidth(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp === 0x200d || cp === 0x200b || (cp >= 0xfe00 && cp <= 0xfe0f) || /\p{Mark}/u.test(ch)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) return 2;
  return 1;
}

const graphemeSegmenter = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null;

function* graphemes(text: string): IterableIterator<string> {
  if (graphemeSegmenter) {
    for (const part of graphemeSegmenter.segment(text)) yield part.segment;
  } else {
    yield* text;
  }
}

function graphemeWidth(cluster: string): number {
  // A ZWJ emoji, a flag, a keycap, and an emoji-presentation selector occupy
  // one two-column glyph in a terminal that supports grapheme rendering.
  if (/\p{Emoji_Presentation}/u.test(cluster) ||
      /[\u{1f1e6}-\u{1f1ff}]{2}/u.test(cluster) ||
      cluster.includes("\u20e3") ||
      (cluster.includes("\ufe0f") && /\p{Emoji}/u.test(cluster)) ||
      (cluster.includes("\u200d") && /\p{Extended_Pictographic}/u.test(cluster))) return 2;
  return Array.from(cluster).reduce((sum, ch) => sum + charWidth(ch), 0);
}

/** Budget extra columns for terminals that render joined emoji as separate glyphs. */
function fitGraphemeWidth(cluster: string): number {
  const joinedEmoji = cluster.includes("\u200d") && /\p{Extended_Pictographic}/u.test(cluster);
  if (!joinedEmoji && !/\p{Emoji_Modifier}/u.test(cluster)) return graphemeWidth(cluster);
  let total = 0;
  let previousEmoji = false;
  let previousWidth = 0;
  for (const ch of cluster) {
    if (ch === "\ufe0f") {
      if (previousEmoji && previousWidth === 1) total++;
      continue;
    }
    const width = charWidth(ch);
    if (width > 0) {
      total += width;
      previousWidth = width;
      previousEmoji = /\p{Emoji}/u.test(ch);
    } else if (ch === "\u200d") {
      previousEmoji = false;
    }
  }
  return Math.max(graphemeWidth(cluster), total);
}

/** Display columns occupied by untrusted text after terminal sanitization. */
export function terminalTextWidth(text: string): number {
  let width = 0;
  for (const cluster of graphemes(sanitizeTerminalText(text))) width += graphemeWidth(cluster);
  return width;
}

/** Sanitize and fit within `maxWidth` columns without splitting a grapheme. */
export function fitToWidth(text: string, maxWidth: number): string {
  const limit = Number.isFinite(maxWidth) ? Math.max(0, Math.floor(maxWidth)) : 0;
  if (limit === 0) return "";
  const input = String(text ?? "");
  const clean = sanitizeTerminalText(input.slice(0, MAX_TERMINAL_TEXT_LENGTH));
  const cells: { ch: string; width: number }[] = [];
  let used = 0;
  let truncated = input.length > MAX_TERMINAL_TEXT_LENGTH;
  // Stop segmenting as soon as the row is full. A huge remote title therefore
  // cannot monopolize the event loop or delay the engine's lease heartbeat.
  for (const ch of graphemes(clean)) {
    const width = fitGraphemeWidth(ch);
    if (used + width > limit) { truncated = true; break; }
    cells.push({ ch, width });
    used += width;
  }
  if (!truncated) return clean;
  const suffix = ".".repeat(Math.min(3, limit));
  const budget = limit - suffix.length;
  let out = "";
  used = 0;
  for (const cell of cells) {
    if (used + cell.width > budget) break;
    out += cell.ch;
    used += cell.width;
  }
  return out + suffix;
}

function count(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function progressBar(percent: number): string {
  const value = Math.min(100, Math.max(0, Number.isFinite(percent) ? percent : 0));
  const filled = Math.floor(value * 8 / 100);
  return "█".repeat(filled) + "░".repeat(8 - filled);
}

function workerKey(worker: DashboardWorker): string {
  return `${worker.kind}${worker.id}`;
}

function workerTone(worker: DashboardWorker): DashboardTone {
  const clean = sanitizeTerminalText(worker.status.slice(0, MAX_TERMINAL_TEXT_LENGTH)).toLowerCase();
  const separator = clean.indexOf(" | ");
  const status = separator < 0 ? clean : clean.slice(0, separator);
  if (/failed|error|stalled|claim lost|disk full/.test(status)) return "error";
  if (/parked|offline/.test(status)) return "muted";
  if (/paused|retry|waiting/.test(status)) return "warning";
  if (/downloaded|complete|\bdone\b/.test(status)) return "success";
  return worker.active ? "normal" : "muted";
}

function workerLine(worker: DashboardWorker, width: number): string {
  const clean = sanitizeTerminalText(worker.status.slice(0, MAX_TERMINAL_TEXT_LENGTH));
  const separator = clean.indexOf(" | ");
  const headline = separator < 0 ? clean : clean.slice(0, separator);
  const title = separator < 0 ? "" : clean.slice(separator + 3);
  const prefix = ` ${worker.kind} ${String(worker.id).padStart(2, "0")} │ `;
  const progress = worker.kind === "DL"
    ? /(\d+(?:\.\d+)?)%\s*@\s*([^,]+?)(?:,\s*ETA\s+(\S+))?$/i.exec(headline)
    : null;
  let detail = headline === IDLE_DOWNLOAD || headline === IDLE_WORKER ? "Idle" : headline;
  if (progress && width >= 64) {
    const pct = Number(progress[1]);
    detail = `${progressBar(pct)} ${progress[1]}%  ${progress[2].trim()}${progress[3] ? `  ETA ${progress[3]}` : ""}`;
  }
  return prefix + detail + (title ? `  ·  ${title}` : "");
}

function sectionRule(label: string, width: number): string {
  const prefix = `── ${label} `;
  return prefix + "─".repeat(Math.max(0, width - terminalTextWidth(prefix)));
}

/** Prefer currently active work; rotate if even the active set does not fit. */
function selectWorkers(workers: readonly DashboardWorker[], slots: number, now: number): DashboardWorker[] {
  if (slots <= 0) return [];
  if (workers.length <= slots) return [...workers];
  const active = workers.filter((worker) => worker.active);
  let selected: DashboardWorker[];
  if (active.length > slots) {
    const pageCount = Math.ceil(active.length / slots);
    const page = Math.floor(Math.max(0, now) / WORKER_PAGE_MS) % pageCount;
    const start = page * slots;
    selected = Array.from({ length: slots }, (_, i) => active[(start + i) % active.length]);
  } else {
    const attention = workers.filter((worker) => !worker.active && workerTone(worker) === "error");
    const rest = workers.filter((worker) => !worker.active && workerTone(worker) !== "error");
    selected = [...active, ...attention, ...rest].slice(0, slots);
  }
  // Keep a stable DL/CV/MD order within each page, even when attention workers
  // were selected ahead of idle workers.
  const chosen = new Set(selected.map(workerKey));
  return workers.filter((worker) => chosen.has(workerKey(worker)));
}

/**
 * Build a complete dashboard without terminal I/O. It always reserves four log
 * rows and leaves the last terminal column unused to prevent autowrap.
 */
export function composeDashboardFrame(
  snapshot: DashboardSnapshot,
  cols: number,
  rows: number,
  now = Date.now(),
): DashboardFrame | null {
  if (cols < MIN_COLUMNS || rows < MIN_ROWS) return null;
  const width = cols - 1;
  const line = (text: string, tone: DashboardTone = "normal", key?: string): DashboardFrameLine => ({
    text: fitToWidth(text, width), tone, ...(key ? { workerKey: key } : {}),
  });
  const stats = snapshot.stats;
  const done = count(stats.downloaded), total = count(stats.total), failed = count(stats.failed);
  const downloading = count(stats.downloading), queued = count(stats.queued), resumable = count(stats.resumable);
  const pausedJobs = count(stats.pausedJobs);
  const target = count(snapshot.targetWorkers);
  const mode = snapshot.paused ? "PAUSED" : snapshot.offline ? "OFFLINE" : "RUNNING";
  const modeTone: DashboardTone = snapshot.paused || snapshot.offline ? "warning" : "brand";
  const title = ` YouTube Archive  ·  ${mode}`;
  const hint = "Ctrl+C to stop ";
  const gap = width - terminalTextWidth(title) - terminalTextWidth(hint);
  const titleRow = gap >= 3 ? title + " ".repeat(gap) + hint : title;
  const detailedMetrics = ` Downloaded ${done}/${total}   Active ${downloading}/${target}   Queued ${queued}${pausedJobs ? `   Paused ${pausedJobs}` : ""}   Failed ${failed}${snapshot.paused && resumable ? `   Resumable ${resumable}` : ""}`;
  const compactBase = snapshot.paused
    ? ` Done ${done}/${total}${pausedJobs ? `  Paused ${pausedJobs}` : ""}${resumable ? `  Res ${resumable}` : ""}  Fail ${failed}`
    : ` DL done ${done}/${total}  DL ${downloading}/${target}  Fail ${failed}`;
  const compactExtra = `  Q ${queued}${!snapshot.paused && pausedJobs ? `  P ${pausedJobs}` : ""}`;
  const compactMetrics = terminalTextWidth(compactBase + compactExtra) <= width ? compactBase + compactExtra : compactBase;
  const metrics = terminalTextWidth(detailedMetrics) <= width ? detailedMetrics : compactMetrics;
  const capDetail = snapshot.capSuffix ? ` / ${snapshot.capSuffix.replace(/^\//, "")}` : "";
  const detailedThroughput = ` Rate ${snapshot.speed}${capDetail}${resumable ? `  ·  Resumable ${resumable}` : ""}`;
  const compactThroughput = ` Rate ${snapshot.speed}${snapshot.capSuffix}${resumable ? `  Res ${resumable}` : ""}`;
  const throughput = terminalTextWidth(detailedThroughput) <= width ? detailedThroughput : compactThroughput;
  const webDetail = snapshot.webUrl ? `  ·  Web ${snapshot.webUrl}` : "";
  // A truncated URL looks actionable but cannot be opened. The full address is
  // also printed in the log, so omit it here when the entire value will not fit.
  const withWeb = webDetail && webDetail.length <= MAX_TERMINAL_TEXT_LENGTH &&
    terminalTextWidth(throughput + webDetail) <= width ? throughput + webDetail : throughput;
  const offlineDetail = ` Downloads are waiting · local processing only${resumable ? ` · Res ${resumable}` : ""}`;
  const compactOffline = ` Downloads are waiting${resumable ? ` · Res ${resumable}` : ""}`;
  const details = snapshot.paused
    ? ` Reason: ${snapshot.pauseReason || "Paused"}`
    : snapshot.offline
      ? (terminalTextWidth(offlineDetail) <= width ? offlineDetail : compactOffline)
      : withWeb;

  const rawSlots = Math.max(0, rows - MIN_LOG_ROWS - FIXED_ROWS);
  const overflow = snapshot.workers.length > rawSlots;
  const visibleSlots = Math.max(0, rawSlots - (overflow ? 1 : 0));
  const selected = selectWorkers(snapshot.workers, visibleSlots, now);
  const activeCount = snapshot.workers.filter((worker) => worker.active).length;
  const hiddenWorkers = snapshot.workers.length - selected.length;
  const hiddenActiveWorkers = activeCount - selected.filter((worker) => worker.active).length;
  const legend = width >= 70 ? "  |  DL download · CV convert · MD metadata" : "";
  const lines: DashboardFrameLine[] = [
    line(titleRow, modeTone),
    line(metrics),
    line(details, snapshot.paused ? "warning" : "muted"),
    line(sectionRule(`WORKERS · ${activeCount} active${legend}`, width), "muted"),
  ];
  for (const worker of selected) lines.push(line(workerLine(worker, width), workerTone(worker), workerKey(worker)));
  if (hiddenWorkers > 0) {
    const activeNote = hiddenActiveWorkers > 0 ? ` (${hiddenActiveWorkers} active · rotating)` : "";
    lines.push(line(` +${hiddenWorkers} more workers${activeNote}`, "muted"));
  }
  lines.push(line(sectionRule("ACTIVITY", width), "muted"));
  return { lines, hiddenWorkers, hiddenActiveWorkers };
}

/** Only our own trusted SGR styles are emitted; user text is always sanitized. */
export function useTerminalColor(env: Record<string, string | undefined> = process.env): boolean {
  return env.NO_COLOR === undefined && env.CLICOLOR !== "0" && env.TERM !== "dumb";
}

const TONE_CODES: Record<DashboardTone, string> = {
  normal: "",
  brand: "1;36",
  success: "32",
  warning: "33",
  error: "31",
  muted: "2",
};

export interface TerminalOutput {
  columns?: number;
  rows?: number;
  write(text: string): unknown;
}

/** Terminal I/O isolated from the view model, so resize/cursor behavior is testable. */
export class TerminalDashboardRenderer {
  private previous: DashboardFrameLine[] = [];
  private previousColumns = 0;
  private previousRows = 0;
  private visible = false;

  constructor(private readonly output: TerminalOutput, private readonly color: boolean) {}

  private dimensions(): { cols: number; rows: number } {
    return { cols: this.output.columns || 80, rows: this.output.rows || 50 };
  }

  private row(row: number, value: DashboardFrameLine): string {
    const code = this.color ? TONE_CODES[value.tone] : "";
    return `\x1b[${row};1H\x1b[2K${code ? `\x1b[${code}m` : ""}${value.text}${code ? "\x1b[0m" : ""}`;
  }

  /** Draw or update the block. False means the terminal is too small. */
  render(snapshot: DashboardSnapshot, now = Date.now()): boolean {
    const { cols, rows } = this.dimensions();
    const frame = composeDashboardFrame(snapshot, cols, rows, now);
    if (!frame) {
      this.clear();
      return false;
    }
    const changedGeometry = !this.visible || this.previous.length !== frame.lines.length ||
      this.previousColumns !== cols || this.previousRows !== rows;
    let out = "";
    if (changedGeometry) {
      // DECSTBM homes the cursor. Reset the old region first, clear the old and
      // new header rows, then reserve the new log region. On initial draw start
      // logs just below the block; on resize put the cursor at the bottom so a
      // restored cursor can never be stranded inside the enlarged dashboard.
      out += `\x1b[1;${rows}r`;
      for (let row = 1; row <= Math.min(rows - 1, Math.max(this.previous.length, frame.lines.length)); row++) {
        out += `\x1b[${row};1H\x1b[2K`;
      }
      out += `\x1b[${frame.lines.length + 1};${rows}r`;
      for (let i = 0; i < frame.lines.length; i++) out += this.row(i + 1, frame.lines[i]);
      out += `\x1b[${this.visible ? rows : frame.lines.length + 1};1H`;
    } else {
      // A worker update redraws only changed rows and leaves the log cursor in
      // place. Saving/restoring around the whole update avoids visible flicker.
      out = "\x1b7";
      for (let i = 0; i < frame.lines.length; i++) {
        const before = this.previous[i], after = frame.lines[i];
        if (!before || before.text !== after.text || before.tone !== after.tone) out += this.row(i + 1, after);
      }
      out += "\x1b8";
      if (out === "\x1b7\x1b8") out = "";
    }
    if (out) this.output.write(out);
    this.previous = frame.lines;
    this.previousColumns = cols;
    this.previousRows = rows;
    this.visible = true;
    return true;
  }

  /** Return a too-small terminal to plain logging; a later render can restore it. */
  clear(): void {
    if (!this.visible) return;
    const { rows } = this.dimensions();
    let out = `\x1b[1;${rows}r`;
    for (let row = 1; row <= Math.min(this.previous.length, rows - 1); row++) out += `\x1b[${row};1H\x1b[2K`;
    out += `\x1b[${rows};1H`;
    this.output.write(out);
    this.previous = [];
    this.visible = false;
  }

  /** Restore the normal scrolling region on shutdown, without clearing logs. */
  stop(): void {
    if (this.visible) {
      const { rows } = this.dimensions();
      this.output.write(`${this.color ? "\x1b[0m" : ""}\x1b[1;${rows}r\x1b[${rows};1H`);
    }
    this.previous = [];
    this.visible = false;
  }
}

let layout: Layout = { download: 0, convert: 0, metadata: 0 };
let lastStats: DashboardStats = {};
let dashboardUrl = "";
let renderer: TerminalDashboardRenderer | null = null;
let tuiEnabled = false;
let resizeWatched = false;
let redrawTimer: ReturnType<typeof setTimeout> | undefined;

function workersForLayout(): DashboardWorker[] {
  const workers: DashboardWorker[] = [];
  const offline = getConfig().offlineMode;
  const append = (kind: WorkerKind, total: number, active: Map<number, string>, fallback: string) => {
    for (let id = 1; id <= total; id++) {
      const busy = active.has(id);
      let status = workerStatuses.get(`${kind}${id}`) ?? fallback;
      // Offline and parked are loop states rather than results for a job. They
      // can linger in the shared status map after a live toggle/scale-up until
      // the next job arrives; do not present them as current in that case.
      if ((!offline && status.startsWith("📴 Offline mode")) ||
          (kind === "DL" && activeDlSlots.has(id) && status.startsWith("⏸️ Parked"))) {
        status = busy ? "Preparing" : fallback;
      }
      workers.push({ kind, id, status, active: busy });
    }
  };
  append("DL", layout.download, activeDownloadJobs, IDLE_DOWNLOAD);
  append("CV", layout.convert, activeConvertJobs, IDLE_WORKER);
  append("MD", layout.metadata, activeMetadataJobs, IDLE_WORKER);
  return workers;
}

function snapshot(): DashboardSnapshot {
  const cap = autoscaler.maxBandwidthKBps > 0 ? `/${formatBytesPerSec(autoscaler.maxBandwidthKBps * 1024)}` : "";
  return {
    stats: lastStats,
    speed: formatBytesPerSec(autoscaler.getAggregateSpeed()),
    capSuffix: cap,
    targetWorkers: autoscaler.targetWorkers,
    paused: isPaused(),
    pauseReason: getPauseReason(),
    offline: getConfig().offlineMode,
    webUrl: dashboardUrl,
    workers: workersForLayout(),
  };
}

function syncDashboard(): void {
  if (!tuiEnabled || !renderer) return;
  const visible = renderer.render(snapshot());
  if (visible && !isTty()) {
    setTty(true);
    console.log("Terminal dashboard restored.");
  } else if (!visible && isTty()) {
    setTty(false);
    console.log("Terminal too small for the dashboard; using standard logs until it is resized.");
  }
}

function requestRedraw(): void {
  if (!tuiEnabled || !isTty() || redrawTimer) return;
  redrawTimer = setTimeout(() => {
    redrawTimer = undefined;
    syncDashboard();
  }, REDRAW_DELAY_MS);
  (redrawTimer as unknown as { unref?: () => void }).unref?.();
}

function watchResize(): void {
  if (resizeWatched) return;
  resizeWatched = true;
  try {
    process.stdout.on("resize", () => {
      if (tuiEnabled) syncDashboard();
    });
  } catch {
    // Some stdout implementations do not expose resize events.
  }
}

export function initDashboard(config: Config, options: { webUrl?: string } = {}): void {
  if (!isTty()) return;
  // TERM=dumb is a genuine terminal without cursor-control support. NO_COLOR,
  // in contrast, disables color but still permits a cursor-based dashboard.
  if (process.env.TERM === "dumb") {
    setTty(false);
    return;
  }
  layout = {
    download: config.maxDownloadWorkers,
    convert: config.maxConcurrentConverts,
    metadata: config.maxMetadataWorkers,
  };
  dashboardUrl = options.webUrl ?? "";
  renderer = new TerminalDashboardRenderer(process.stdout, useTerminalColor());
  tuiEnabled = true;
  // Watch even when the initial dimensions are too small, so enlarging the
  // window recovers the dashboard without restarting the engine.
  watchResize();
  renderDashboard();
}

/** A raised download-worker ceiling starts real workers and expands the view. */
export function setDownloadRows(count: number): void {
  if (count <= layout.download) return;
  layout = { ...layout, download: count };
  requestRedraw();
}

/** Low-level compatibility helper; workers should use their named update below. */
export function updateAbsoluteLine(row: number, text: string): void {
  if (!isTty() || !tuiEnabled || row < 1) return;
  const cols = process.stdout.columns || 80;
  process.stdout.write(`\x1b7\x1b[${row};1H\x1b[2K${fitToWidth(text, cols - 1)}\x1b8`);
}

export function updateWorkerLine(id: number, text: string, _config: Config): void {
  workerStatuses.set(`DL${id}`, text);
  requestRedraw();
}

export function updateConvertWorkerLine(id: number, text: string, _config: Config): void {
  workerStatuses.set(`CV${id}`, text);
  requestRedraw();
}

export function updateMetadataWorkerLine(id: number, text: string, _config: Config): void {
  workerStatuses.set(`MD${id}`, text);
  requestRedraw();
}

/** Refresh lightweight aggregate counters and redraw the visible frame. */
export function renderDashboard(): void {
  if (!isTty() || !tuiEnabled) return;
  try {
    lastStats = db.query(
      `SELECT
         SUM(CASE WHEN download_status = 'pending' THEN 1 ELSE 0 END) AS queued,
         SUM(CASE WHEN download_status = 'paused' THEN 1 ELSE 0 END) AS pausedJobs,
         SUM(CASE WHEN download_status = 'downloading' THEN 1 ELSE 0 END) AS downloading,
         SUM(CASE WHEN download_status = 'downloaded' THEN 1 ELSE 0 END) AS downloaded,
         SUM(CASE WHEN download_status = 'failed' OR conversion_status = 'failed' OR metadata_status = 'failed'
                  THEN 1 ELSE 0 END) AS failed,
         COUNT(*) AS total,
         SUM(CASE WHEN partial_file_path IS NOT NULL
                   AND download_status IN ('pending', 'paused', 'downloading')
                  THEN 1 ELSE 0 END) AS resumable
       FROM jobs`,
    ).get() as DashboardStats;
  } catch {
    // The dashboard is observational. A closing or temporarily unavailable DB
    // must not crash the engine or change the worker state it is displaying.
  }
  syncDashboard();
}

/** Backward-compatible one-line aggregate summary for callers and tests. */
export function formatHeaderLine(stats: DashboardStats, speed: string, capSuffix: string): string {
  const reason = isPaused() ? ` | ⏸️ PAUSED${getPauseReason() ? ` (${getPauseReason()})` : ""}` : "";
  const resumable = count(stats.resumable);
  const resumeNote = resumable > 0 ? ` Res:${resumable}` : "";
  return (
    `🚀 DL:${count(stats.downloading)}/${autoscaler.targetWorkers} | ${speed}${capSuffix}` +
    ` | Done:${count(stats.downloaded)} Fail:${count(stats.failed)} Tot:${count(stats.total)}` +
    `${resumeNote}${reason}`
  );
}

export function resetTerminal(): void {
  if (redrawTimer) clearTimeout(redrawTimer);
  redrawTimer = undefined;
  tuiEnabled = false;
  renderer?.stop();
  renderer = null;
  setTty(false);
}
