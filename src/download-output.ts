// src/download-output.ts — bounded parsing of yt-dlp / aria2c output.
//
// Subprocess output is not a filesystem path. In particular, aria2c can emit
// thousands of CR-only progress updates even with yt-dlp's --newline. Passing
// the resulting huge "line" to existsSync can panic Bun's Windows path
// converter (1.3.14, toWPathMaybeDir) instead of throwing a catchable JS error.

import { parseSpeedToBytesPerSec } from "./util";

export const DOWNLOAD_PATH_PREFIX = "FILEPATH:";
// Deliberately conservative capture limits, not the OS's maximum path length.
// Generated filenames already have a MAX_PATH budget; allow room for roots.
export const MAX_DOWNLOAD_PATH_LENGTH = 4096;
export const MAX_OUTPUT_LINE_LENGTH = 8 * 1024;
export const MAX_OUTPUT_TAIL_LENGTH = 8 * 1024;

/** Only accept our explicit after_move record, validated BEFORE any fs call. */
export function parseDownloadPath(line: string): string | null {
  if (!line.startsWith(DOWNLOAD_PATH_PREFIX)) return null;
  const path = line.slice(DOWNLOAD_PATH_PREFIX.length);
  if (!path.trim() || path.length > MAX_DOWNLOAD_PATH_LENGTH || /[\x00-\x1f\x7f]/.test(path)) return null;
  return path; // Preserve spaces and Unicode in the actual path.
}

/**
 * Drain a pipe while retaining only a bounded diagnostic tail. With onLine,
 * also emit complete LF, CRLF, or CR-delimited records (including one at EOF).
 * A single streaming decoder preserves UTF-8 split across pipe chunks.
 * Oversized records are discarded WHOLE, through the next delimiter: slicing
 * their tail into a new record could mistake log text for a FILEPATH marker.
 */
export async function readProcessOutput(
  stream: ReadableStream<Uint8Array>,
  onLine?: (line: string) => void,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let discarding = false;
  let tail = "";

  const append = (segment: string) => {
    if (discarding) return;
    if (pending.length + segment.length > MAX_OUTPUT_LINE_LENGTH) {
      pending = "";
      discarding = true;
    } else {
      pending += segment;
    }
  };

  const consume = (text: string) => {
    tail = text.length >= MAX_OUTPUT_TAIL_LENGTH
      ? text.slice(-MAX_OUTPUT_TAIL_LENGTH)
      : (tail + text).slice(-MAX_OUTPUT_TAIL_LENGTH);
    if (!onLine) return;
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      if (text[i] !== "\r" && text[i] !== "\n") continue;
      append(text.slice(start, i));
      if (!discarding && pending) onLine(pending);
      pending = "";
      discarding = false;
      start = i + 1;
    }
    append(text.slice(start));
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      consume(decoder.decode(value, { stream: true }));
    }
    consume(decoder.decode());
    if (onLine && !discarding && pending) onLine(pending);
    return tail;
  } finally {
    reader.releaseLock();
  }
}

/**
 * aria2c's console readout, as seen on yt-dlp's stdout.
 *
 * When yt-dlp hands a whole-file transfer to aria2c it spawns the child with
 * stdout inherited — `ExternalFD._call_process` pipes only stderr — and aria2c
 * prints a readout record at most once a second (aria2's
 * ConsoleStatCalc::calculateStat). On a non-TTY stdout, which is what an
 * inherited pipe is, the record is plain, unpadded and newline-terminated:
 *
 *   [#208c72 1.4MiB/3.0MiB(48%) CN:16 DL:1.2MiB ETA:2m30s]
 *
 * Sizes come from aria2's util::abbrevSize ("" / Ki / Mi / Gi, one decimal
 * below 10, thousands separator from 1000), DL is bytes per second, and ETA is
 * util::secfmt ("45s" / "2m30s" / "1h5m"). yt-dlp fires no progress hook while
 * an external downloader runs, so this readout is the ONLY live progress signal
 * on the aria2c path — without it the dashboard sits at 0% for the whole
 * transfer.
 *
 * Returns null for anything that is not a usable single-group readout: the
 * compact multi-group form ("[DL:…][#gid …][#gid …]"), aria2c's other
 * bracketed extras ([FileAlloc:#…], [Checksum:#…]), and readouts with neither
 * a percentage nor any byte/rate information. A transfer whose total is not
 * known can still give the stall detector a useful byte or rate sample.
 */
export interface Aria2cReadout {
  /** The six-character aria2c group id, used to separate stream counters. */
  groupId: string;
  /** Resolution of the displayed byte count, in bytes, or 0 when unavailable. */
  downloadedResolutionBytes: number;
  /** Percent complete; NaN only when it cannot be derived at all. */
  percent: number;
  /** Transfer speed in bytes/second, 0 when aria2c did not report one. */
  speedBps: number;
  /** Seconds remaining, 0 when not reported (e.g. already finished). */
  etaSeconds: number;
  /** Total transfer size in bytes, 0 when aria2c does not know it yet. */
  totalBytes: number;
  /** Bytes completed so far, 0 when unknown. */
  downloadedBytes: number;
}

// A record always begins with its 6-hex-character group id. Anchoring at the
// start rejects the compact multi-group readout, which begins with "[DL:".
const ARIA2C_READOUT = /^\[#([0-9a-f]{6})\s+([^\]]*)\]/i;
// aria2 writes sizes as e.g. "0B", "512B", "1,000B", "1.4MiB", "922MiB".
const ARIA2C_BYTES = "\\d+(?:,\\d{3})*(?:\\.\\d+)?(?:[KMGT]i?)?B";
const ARIA2C_SIZES = new RegExp(`(${ARIA2C_BYTES})/(${ARIA2C_BYTES})`, "i");
const ARIA2C_PERCENT = /\((\d+(?:\.\d+)?)%\)/;
const ARIA2C_SPEED = /(?:^|\s)DL:(\S+?)(?=\s|$)/;
const ARIA2C_ETA = /(?:^|\s)ETA:((?:\d+h)?(?:\d+m)?(?:\d+s)?)(?=\s|$)/;

/** Parse one aria2 size token ("1.4MiB", "1,000B") into bytes. */
function parseAria2cSize(size: string): number {
  return parseSpeedToBytesPerSec(size.replace(/,/g, ""));
}

/** Resolution of an abbreviated size: e.g. 1.4MiB represents 0.1MiB steps. */
function aria2cSizeResolution(size: string): number {
  const match = /^\d+(?:,\d{3})*(?:\.(\d+))?([KMGT]?i?)B$/i.exec(size);
  if (!match) return 0;
  const unit = match[2].toUpperCase().replace(/I$/, "");
  const power = { "": 0, K: 1, M: 2, G: 3, T: 4 }[unit];
  if (power === undefined) return 0;
  return 1024 ** power / 10 ** (match[1]?.length ?? 0);
}

/** aria2's util::secfmt output ("45s", "2m30s", "1h5m") into seconds. */
function parseAria2cEta(eta: string): number {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(eta);
  if (!m) return 0;
  return parseInt(m[1] || "0", 10) * 3600 + parseInt(m[2] || "0", 10) * 60 + parseInt(m[3] || "0", 10);
}

export function parseAria2cReadout(line: string): Aria2cReadout | null {
  // A Windows console pads the record to the terminal width and may terminate
  // it with CR instead of LF, so tolerate whitespace on both sides.
  const text = line.trim();
  if (!text.startsWith("[#")) return null;
  const group = ARIA2C_READOUT.exec(text);
  if (!group) return null;
  const body = group[2];

  const sizes = ARIA2C_SIZES.exec(body);
  const downloadedBytes = sizes ? parseAria2cSize(sizes[1]) : 0;
  const totalBytes = sizes ? parseAria2cSize(sizes[2]) : 0;

  const pctMatch = ARIA2C_PERCENT.exec(body);
  let percent = pctMatch ? parseFloat(pctMatch[1]) : NaN;
  if (Number.isNaN(percent) && totalBytes > 0) percent = (downloadedBytes / totalBytes) * 100;
  const speedMatch = ARIA2C_SPEED.exec(body);
  const speedBps = speedMatch ? parseAria2cSize(speedMatch[1]) : 0;
  // Unknown totals cannot drive the dashboard's percentage, but a real byte
  // counter or positive speed is still useful to the stall detector.
  if (!Number.isFinite(percent) && downloadedBytes <= 0 && speedBps <= 0) return null;

  const etaMatch = ARIA2C_ETA.exec(body);
  return {
    groupId: group[1].toLowerCase(),
    downloadedResolutionBytes: sizes ? aria2cSizeResolution(sizes[1]) : 0,
    percent,
    speedBps,
    etaSeconds: etaMatch ? parseAria2cEta(etaMatch[1]) : 0,
    totalBytes,
    downloadedBytes,
  };
}
