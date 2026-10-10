// src/dashboard.ts — terminal UI (TUI) dashboard.
//
// A fixed block at the top of the terminal: row 1 is the global stats line,
// row 2 is a spacer, then one row per download slot, convert worker and
// metadata worker. Rows below the block are the scrolling log area.
//
// Layout rules that keep the block from corrupting when worker counts change:
//   • The row counts are a snapshot taken when the block is drawn. Every row
//     number is computed from that snapshot, never from the live config. The
//     settings panel can change the config at any time; reading it here used to
//     move the convert/metadata rows while the old block was still on screen.
//   • Growing the download pool redraws the whole block (setDownloadRows), from
//     the stored per-worker statuses, so no stale row survives a resize.
//   • Terminal resizes are handled: the block is redrawn, or the TUI falls back
//     to plain logs when the terminal is too small, and comes back when it fits.
//   • Text is sanitized (escape sequences and control characters removed) and
//     cut by display width, so a wide emoji or a long title cannot wrap onto
//     the next row.

import { db } from "./db";
import { autoscaler } from "./autoscale";
import { formatBytesPerSec } from "./util";
import { getPauseReason, isPaused, isTty, setTty, workerStatuses } from "./state";
import type { Config } from "./config";

const MIN_COLUMNS = 60;
const IDLE_DOWNLOAD = "— idle slot —";
const IDLE_WORKER = "💤 Idle";

/** Rows per worker kind, as drawn. Never read from live config (see header). */
interface Layout {
  download: number;
  convert: number;
  metadata: number;
}

let layout: Layout = { download: 0, convert: 0, metadata: 0 };
/** The block is (or was) shown on this terminal; a resize may bring it back. */
let tuiEnabled = false;
let drawnLines = 0;
let lastHeader = "";
let resizeWatched = false;

/** Terminal rows reserved for the dashboard: 2 header rows + one per worker. */
export function dashboardLineCount(config: Config): number {
  return 2 + config.maxDownloadWorkers + config.maxConcurrentConverts + config.maxMetadataWorkers;
}

function blockLines(l: Layout): number {
  return 2 + l.download + l.convert + l.metadata;
}

function terminalSize(): { cols: number; rows: number } {
  return { cols: process.stdout.columns || 80, rows: process.stdout.rows || 50 };
}

function fitsTerminal(lines: number): boolean {
  const { cols, rows } = terminalSize();
  return cols >= MIN_COLUMNS && rows > lines + 5;
}

function rowFor(kind: "DL" | "CV" | "MD", id: number): number {
  if (kind === "DL") return 2 + id;
  if (kind === "CV") return 2 + layout.download + id;
  return 2 + layout.download + layout.convert + id;
}

export function initDashboard(config: Config): void {
  if (!isTty()) return;
  layout = {
    download: config.maxDownloadWorkers,
    convert: config.maxConcurrentConverts,
    metadata: config.maxMetadataWorkers,
  };
  if (!fitsTerminal(blockLines(layout))) {
    setTty(false);
    console.log("⚠️ Terminal too small for TUI dashboard. Falling back to standard logs.");
    return;
  }
  tuiEnabled = true;
  process.stdout.write("\x1b[2J\x1b[1;1H");
  drawBlock();
  watchResize();
}

/**
 * Remove control characters and terminal escape sequences from text that came
 * from outside (job titles, yt-dlp output). Otherwise a title can move the
 * cursor or clear the screen.
 */
export function sanitizeTerminalText(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}

/** Approximate terminal column width of one code point (wide CJK/emoji = 2). */
function charWidth(cp: number): number {
  if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x0300 && cp <= 0x036f)) return 0;
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
  ) {
    return 2;
  }
  return 1;
}

/** Sanitize, then cut to at most `maxWidth` terminal columns (with "..."). */
export function fitToWidth(text: string, maxWidth: number): string {
  const clean = sanitizeTerminalText(text);
  // (character, columns) pairs. A symbol followed by U+FE0F (emoji presentation,
  // e.g. ⬇️) renders two columns wide in most terminals.
  const cells: { ch: string; w: number }[] = [];
  for (const ch of Array.from(clean)) {
    const cp = ch.codePointAt(0) ?? 0;
    const w = cp === 0xfe0f ? 0 : charWidth(cp);
    const prev = cells[cells.length - 1];
    if (cp === 0xfe0f && prev && prev.w === 1) prev.w = 2;
    cells.push({ ch, w });
  }
  let width = 0;
  for (const cell of cells) width += cell.w;
  if (width <= maxWidth) return clean;
  const budget = Math.max(0, maxWidth - 3);
  let out = "";
  let used = 0;
  for (const cell of cells) {
    if (used + cell.w > budget) break;
    out += cell.ch;
    used += cell.w;
  }
  return `${out}...`;
}

/** One complete row: move, clear, write. Cursor position is the caller's concern. */
function rowSequence(row: number, text: string): string {
  const { cols } = terminalSize();
  return `\x1b[${row};1H\x1b[2K${fitToWidth(text, cols - 1)}`;
}

function statusFor(key: string, fallback: string): string {
  return workerStatuses.get(key) ?? fallback;
}

/** Draw the whole block from the stored statuses. The caller checked the fit. */
function drawBlock(): void {
  if (!isTty()) return;
  const { rows } = terminalSize();
  const lines = blockLines(layout);
  let out = "\x1b7"; // save the cursor: the log area keeps its place
  // Clear every row the block occupied before and occupies now, so a shrinking
  // layout leaves no leftover text behind.
  for (let row = 1; row <= Math.max(lines, drawnLines); row++) out += `\x1b[${row};1H\x1b[2K`;
  out += `\x1b[${lines + 1};${rows}r`; // scroll region: the log area only
  out += rowSequence(1, lastHeader);
  for (let i = 1; i <= layout.download; i++) {
    out += rowSequence(rowFor("DL", i), `[DL${i}] ${statusFor(`DL${i}`, IDLE_DOWNLOAD)}`);
  }
  for (let i = 1; i <= layout.convert; i++) {
    out += rowSequence(rowFor("CV", i), `[CV${i}] ${statusFor(`CV${i}`, IDLE_WORKER)}`);
  }
  for (let i = 1; i <= layout.metadata; i++) {
    out += rowSequence(rowFor("MD", i), `[MD${i}] ${statusFor(`MD${i}`, IDLE_WORKER)}`);
  }
  out += `\x1b[${lines + 1};1H\x1b8`;
  process.stdout.write(out);
  drawnLines = lines;
}

/** Give the terminal back to the plain log output (the block is cleared). */
function fallBackToLogs(reason: string): void {
  if (isTty()) {
    const { rows } = terminalSize();
    let out = "\x1b7";
    for (let row = 1; row <= drawnLines; row++) out += `\x1b[${row};1H\x1b[2K`;
    out += `\x1b[1;${rows}r\x1b8`;
    process.stdout.write(out);
  }
  drawnLines = 0;
  setTty(false);
  console.log(`⚠️ ${reason}. Falling back to standard logs.`);
}

/**
 * The download pool grew to `count` workers: reserve their rows and redraw the
 * block. Called by the engine when it starts more download workers.
 */
export function setDownloadRows(count: number): void {
  if (count <= layout.download) return;
  layout = { ...layout, download: count };
  if (!tuiEnabled) return;
  if (!isTty()) return;
  if (!fitsTerminal(blockLines(layout))) {
    fallBackToLogs("Terminal too small for the worker rows");
    return;
  }
  drawBlock();
}

function watchResize(): void {
  if (resizeWatched) return;
  resizeWatched = true;
  try {
    process.stdout.on("resize", () => {
      if (!tuiEnabled) return;
      if (fitsTerminal(blockLines(layout))) {
        if (!isTty()) setTty(true);
        drawBlock();
      } else if (isTty()) {
        fallBackToLogs("Terminal was resized too small for the worker rows");
      }
    });
  } catch {
    // Some stdout implementations are not event emitters; the block then keeps
    // its startup geometry, which is still correct until the next restart.
  }
}

export function updateAbsoluteLine(row: number, text: string): void {
  if (!isTty()) return;
  process.stdout.write(`\x1b7${rowSequence(row, text)}\x1b8`);
}

export function updateWorkerLine(id: number, text: string, _config: Config): void {
  workerStatuses.set(`DL${id}`, text);
  if (!isTty() || id > layout.download) return;
  updateAbsoluteLine(rowFor("DL", id), `[DL${id}] ${text}`);
}

export function updateConvertWorkerLine(id: number, text: string, _config: Config): void {
  workerStatuses.set(`CV${id}`, text);
  if (!isTty() || id > layout.convert) return;
  updateAbsoluteLine(rowFor("CV", id), `[CV${id}] ${text}`);
}

export function updateMetadataWorkerLine(id: number, text: string, _config: Config): void {
  workerStatuses.set(`MD${id}`, text);
  if (!isTty() || id > layout.metadata) return;
  updateAbsoluteLine(rowFor("MD", id), `[MD${id}] ${text}`);
}

export function renderDashboard(): void {
  if (!isTty()) return;
  const agg = formatBytesPerSec(autoscaler.getAggregateSpeed());
  const cap = autoscaler.maxBandwidthKBps > 0 ? `/${formatBytesPerSec(autoscaler.maxBandwidthKBps * 1024)}` : "";
  const statsData = db
    .query(
      `SELECT
         SUM(CASE WHEN download_status IN ('pending', 'paused', 'downloading') THEN 1 ELSE 0 END) as queued,
         SUM(CASE WHEN download_status = 'downloading' THEN 1 ELSE 0 END) as downloading,
         SUM(CASE WHEN download_status = 'downloaded' THEN 1 ELSE 0 END) as downloaded,
         SUM(CASE WHEN download_status = 'failed' THEN 1 ELSE 0 END) as failed,
         COUNT(*) as total,
         SUM(CASE WHEN partial_file_path IS NOT NULL
                   AND download_status IN ('pending', 'paused', 'downloading')
                  THEN 1 ELSE 0 END) as resumable
       FROM jobs`,
    )
    .get() as any;
  lastHeader = formatHeaderLine(statsData, agg, cap);
  updateAbsoluteLine(1, lastHeader);
}

/** The aggregate row: global counters, bandwidth, and pause state. */
export function formatHeaderLine(
  stats: {
    downloading?: number;
    downloaded?: number;
    failed?: number;
    total?: number;
    resumable?: number;
  },
  speed: string,
  capSuffix: string,
): string {
  const reason = isPaused() ? ` | ⏸️ PAUSED${getPauseReason() ? ` (${getPauseReason()})` : ""}` : "";
  // Jobs still holding a .part they will resume from. Shown only when non-zero:
  // it is the terminal-side twin of the dashboard's "will resume" tile, and a
  // quiet engine has nothing to report here. Kept terse (`Res:n`, not
  // "n resumable") because the header already overflows an 80-column terminal
  // and the pause reason has to stay readable at the end of the line.
  const resumable = stats.resumable || 0;
  const resumeNote = resumable > 0 ? ` Res:${resumable}` : "";
  return (
    `🚀 DL:${stats.downloading || 0}/${autoscaler.targetWorkers} | ${speed}${capSuffix}` +
    ` | Done:${stats.downloaded || 0} Fail:${stats.failed || 0} Tot:${stats.total || 0}` +
    `${resumeNote}${reason}`
  );
}

export function resetTerminal(): void {
  if (!isTty()) return;
  const rows = process.stdout.rows || 50;
  process.stdout.write(`\x1b[1;${rows}r\x1b[${rows};1H`);
}
