// src/download-output.ts — bounded parsing of yt-dlp / aria2c output.
//
// Subprocess output is not a filesystem path. In particular, aria2c can emit
// thousands of CR-only progress updates even with yt-dlp's --newline. Passing
// the resulting huge "line" to existsSync can panic Bun's Windows path
// converter (1.3.14, toWPathMaybeDir) instead of throwing a catchable JS error.

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
