// Opt in with YTA_COMPAT_TEST=1 when a real yt-dlp is on PATH. The fixture is
// served locally; neither YouTube nor external network access is required.
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import { buildDownloadPlan } from "../src/download-args";
import { parseSpeedToBytesPerSec } from "../src/util";

describe.skipIf(!process.env.YTA_COMPAT_TEST)("real yt-dlp progress compatibility", () => {
  test("the engine's template distinguishes real video/audio progress and numeric speed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yta-progress-compat-"));
    const video = new Uint8Array(3 * 1024 * 1024).fill(42);
    const audio = new Uint8Array(256 * 1024).fill(41);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const payload = new URL(request.url).pathname === "/audio.m4a" ? audio : video;
        return new Response(request.method === "HEAD" ? null : payload, {
          headers: { "content-type": "application/octet-stream", "content-length": String(payload.length) },
        });
      },
    });
    try {
      const root = `http://127.0.0.1:${server.port}`;
      const url = `${root}/video.mp4`;
      const plan = buildDownloadPlan({
        job: { id: "fixture", url, title: "Fixture", index: 1, output_directory: dir, duration: 10 },
        config: { ...DEFAULT_CONFIG, useAria2c: false },
        activeSlots: 1,
        aria2cAvailable: false,
      });
      const template = plan.args[plan.args.indexOf("--progress-template") + 1];
      // A local info JSON lets the real downloader select two independent
      // formats without invoking YouTube or requiring ffmpeg to merge them.
      const infoFile = join(dir, "info.json");
      await writeFile(infoFile, JSON.stringify({
        id: "fixture", title: "Fixture", ext: "mkv", extractor: "generic", extractor_key: "Generic",
        webpage_url: url,
        formats: [
          { url, ext: "mp4", format_id: "137", protocol: "http", vcodec: "avc1", acodec: "none" },
          { url: `${root}/audio.m4a`, ext: "m4a", format_id: "140", protocol: "http", vcodec: "none", acodec: "aac" },
        ],
      }));
      const proc = Bun.spawn([
        "yt-dlp", "--ignore-config", "--no-colors", "--progress", "--newline", "--allow-unplayable-formats",
        "--format", "137+140", "--progress-template", template,
        "--load-info-json", infoFile, "-o", join(dir, "output.%(ext)s"),
      ], { stdout: "pipe", stderr: "pipe" });
      const timeout = setTimeout(() => proc.kill(), 30_000);
      let out: string, err: string, code: number;
      try {
        [out, err, code] = await Promise.all([
          new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
        ]);
      } finally {
        clearTimeout(timeout);
      }
      if (code !== 0) throw new Error(`yt-dlp failed (${code}): ${err}`);
      const records = out.split(/[\r\n]+/).filter((line) => line.startsWith("PROGRESS:"));
      expect(records.length).toBeGreaterThan(0);
      const fields = records.map((line) => line.slice("PROGRESS:".length).split("|"));
      expect(fields.some((f) => Number.isFinite(parseFloat(f[0])))).toBe(true);
      expect(fields.some((f) => parseSpeedToBytesPerSec(f[1]) > 0)).toBe(true);
      expect(fields.some((f) => Number(f[3]) === video.length && Number(f[4]) > 0)).toBe(true);
      expect(fields.some((f) => Number(f[3]) === audio.length && Number(f[4]) > 0)).toBe(true);
      const formatIds = fields.map((f) => {
        try { return JSON.parse(f.slice(5).join("|")); } catch { return null; }
      }).filter((id): id is string => typeof id === "string");
      expect(new Set(formatIds).size).toBe(2);
      expect(formatIds).toContain("137");
      expect(formatIds).toContain("140");
    } finally {
      server.stop(true);
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    }
  }, 45_000);
});
