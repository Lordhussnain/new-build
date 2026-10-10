// tests/web-ui-contract.test.ts — the dashboard page against the API it calls.
//
// `web_ui.html` has no build step, no types and no imports, so nothing but
// convention keeps it in sync with `src/web.ts`. When that convention broke,
// the page read the `{ ok, jobs: [...] }` envelope as if it were the array
// itself: `renderJobs` threw on `jobs.filter`, the throw was swallowed by
// `fetchStatus`'s catch, and the queue went blank while the engine kept
// downloading in the terminal. A blank dashboard — or a 404 from a renamed
// route — is therefore a *contract* regression, and this file pins both:
//
//   1. every `/api/…` path the page fetches must still resolve (404 = renamed
//      or deleted route; 405 is fine, the page calls it with another method);
//   2. the page's real inline script, run against the real request handler with
//      a seeded queue, must render one row per job and put the API's numbers in
//      the header cards.
//
// The page executes in a `node:vm` context over a stub DOM whose `fetch` calls
// `handleRequest` directly: no server, no port, no network — the same code the
// browser runs against the same JSON the browser gets.

import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { DEFAULT_CONFIG, type Config } from "../src/config";
import { db, initDatabase } from "../src/db";
import { handleRequest } from "../src/web";

const UI_PATH = new URL("../web_ui.html", import.meta.url);

/** A job id the fixtures seed, so `${…}` templates in the page resolve. */
const SEEDED_ID = "uicontract1";

function insertJob(id: string, overrides: Record<string, unknown> = {}): void {
  const row: Record<string, unknown> = {
    id,
    url: `https://www.youtube.com/watch?v=${id}`,
    title: `Contract Video ${id}`,
    output_directory: "/tmp/out",
    target_format: "mp4",
    ...overrides,
  };
  const cols = Object.keys(row);
  db.run(
    `INSERT INTO jobs (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    Object.values(row) as any[],
  );
}

/** One row per interesting pipeline state: live, finished, permanently broken. */
function seedQueue(): void {
  insertJob(SEEDED_ID, {
    title: "Downloading Video",
    download_status: "downloading",
    progress: 42.5,
    speed: 27648,
    eta: 6,
  });
  insertJob("uicontract2", {
    title: "Finished Video",
    download_status: "downloaded",
    conversion_status: "not_needed",
    metadata_status: "not_needed",
    progress: 100,
    file_size: 2048,
  });
  insertJob("uicontract3", {
    title: "Broken Video",
    download_status: "failed",
    last_error: "HTTP Error 429: Too Many Requests",
    retry_count: 3,
  });
}

interface StubElement {
  textContent: unknown;
  innerHTML: string;
  value: string;
  title: string;
  disabled: boolean;
  style: Record<string, string>;
  dataset: Record<string, string>;
  children: unknown[];
  classList: { add: () => void; remove: () => void; toggle: () => void; contains: () => boolean };
}

interface UiHarness {
  /** Call a top-level page function (`function` declarations land on globalThis). */
  run: (fn: string, ...args: unknown[]) => unknown;
  /** Read anything else out of the page's scope. */
  evaluate: (expression: string) => any;
  el: (id: string) => StubElement;
  /** What the page logged to console.error — a swallowed contract break shows up here. */
  errors: string[];
}

async function loadDashboard(config: Config): Promise<UiHarness> {
  const html = readFileSync(UI_PATH, "utf8");
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  if (scripts.length === 0) throw new Error("web_ui.html has no inline <script> to execute");

  const elements = new Map<string, StubElement>();
  const make = (id: string): StubElement => {
    const el: any = {
      id,
      textContent: "",
      innerHTML: "",
      value: "",
      title: "",
      disabled: false,
      style: {},
      dataset: {},
      children: [],
      classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
      addEventListener: () => {},
      appendChild: (child: unknown) => el.children.push(child),
      remove: () => {},
      focus: () => {},
      querySelector: () => null,
      querySelectorAll: () => [],
      closest: () => null,
    };
    return el as StubElement;
  };
  const at = (id: string): StubElement => {
    if (!elements.has(id)) elements.set(id, make(id));
    return elements.get(id)!;
  };
  const documentStub: any = {
    hidden: false,
    getElementById: at,
    createElement: (tag: string) => make(`<${tag}>`),
    addEventListener: () => {},
    querySelectorAll: () => [],
    querySelector: () => null,
  };

  const errors: string[] = [];
  const fetchImpl = async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as Request).url);
    return handleRequest(new Request(new URL(url, "http://127.0.0.1:3000"), init), config);
  };
  const sandbox: any = {
    document: documentStub,
    // The page wraps window.fetch with its 401-bounce guard, so the real entry
    // point has to live on `window` before the script runs.
    window: { fetch: fetchImpl, document: documentStub, location: { search: "", href: "", pathname: "/" } },
    location: { search: "", href: "", pathname: "/" },
    console: {
      log: () => {},
      warn: () => {},
      error: (...args: unknown[]) => errors.push(args.map(String).join(" ")),
    },
    // No timers: the 5 s poll must not run inside a test, and notification
    // cleanup must not keep the process alive.
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    alert: () => {},
    confirm: () => true,
    fetch: fetchImpl,
  };

  const context = vm.createContext(sandbox) as any;
  for (const source of scripts) vm.runInContext(source, context, { filename: "web_ui.inline.js" });

  return {
    run: (fn, ...args) => {
      const target = context[fn];
      if (typeof target !== "function") throw new Error(`web_ui.html has no global ${fn}()`);
      return target(...args);
    },
    evaluate: (expression: string) => vm.runInContext(expression, context),
    el: at,
    errors,
  };
}

beforeEach(() => {
  initDatabase(":memory:");
  seedQueue();
});

describe("the dashboard's API calls", () => {
  test("every /api path web_ui.html fetches still resolves in the route table", async () => {
    const html = readFileSync(UI_PATH, "utf8");
    // String literals and template heads: '/api/status', `/api/jobs/${id}/retry`.
    const paths = [...html.matchAll(/["'`](\/api\/[^"'`\s]*)["'`]/g)]
      .map((m) => m[1].replace(/\$\{[^}]*\}/g, SEEDED_ID).split("?")[0]);
    expect(paths.length).toBeGreaterThan(10);

    const missing: string[] = [];
    for (const path of new Set(paths)) {
      // GET is safe for every route: a write-only path answers 405 (+Allow),
      // a renamed or deleted one answers 404. 404 is the failure this guards.
      const res = await handleRequest(new Request(`http://127.0.0.1:3000${path}`), DEFAULT_CONFIG);
      if (res.status === 404) missing.push(path);
    }
    expect(missing).toEqual([]);
  });

  test("GET /api/jobs keeps the { ok, jobs } envelope the page unwraps", async () => {
    const res = await handleRequest(new Request("http://127.0.0.1:3000/api/jobs"), DEFAULT_CONFIG);
    const payload = await res.json();
    expect(Array.isArray(payload.jobs)).toBe(true);
    expect(payload.jobs.length).toBe(3);

    // The columns the table, the tabs and the detail drawer read by name. A
    // key that is not selected is not an error — it is a silently blank cell.
    const row = payload.jobs.find((j: any) => j.id === SEEDED_ID);
    for (const key of [
      "id",
      "title",
      "url",
      "folder",
      "output_directory",
      "file_path",
      "target_format",
      "video_quality",
      "download_status",
      "conversion_status",
      "metadata_status",
      "pause_reason",
      "progress",
      "speed",
      "eta",
      "file_size",
      "last_error",
      "retry_count",
      "conversion_retry_count",
      "metadata_retry_count",
      "resume_count",
      "partial_file_path",
      "audio_tracks",
      "audio_selection",
      "metadata_files",
      "metadata_unavailable",
      "relocated_to",
      "want_subtitles",
      "want_thumbnail",
      "want_description",
      "created_at",
      "updated_at",
    ]) {
      expect(Object.keys(row)).toContain(key);
    }
  });
});

describe("the dashboard renders the queue", () => {
  let ui: UiHarness;

  beforeEach(async () => {
    ui = await loadDashboard(DEFAULT_CONFIG);
  });

  test("one row per job, with the titles the API returned", async () => {
    await ui.run("fetchStatus");
    const body = ui.el("jobsTableBody");
    expect((body.innerHTML.match(/<tr /g) || []).length).toBe(3);
    expect(body.innerHTML).toContain("Downloading Video");
    expect(body.innerHTML).toContain("Finished Video");
    expect(body.innerHTML).toContain("Broken Video");
    // The whole poll cycle must fail silently nowhere: a swallowed TypeError
    // is how the blank table reached a user.
    expect(ui.errors).toEqual([]);
  });

  test("the header cards read the fields /api/status actually answers with", async () => {
    await ui.run("fetchStatus");
    expect(ui.el("downloadingCount").textContent).toBe(1);
    expect(ui.el("completedCount").textContent).toBe(1);
    expect(String(ui.el("completedSub").textContent)).toContain("3 jobs");
    expect(ui.el("failedCount").textContent).toBe(1);
    expect(String(ui.el("queuePosition").textContent)).toContain("queued");

    // An unresolved key paints "undefined" or nothing at all on a card.
    for (const id of ["downloadingCount", "completedCount", "failedCount", "queuePosition", "globalETA", "activeWorkers"]) {
      const text = String(ui.el(id).textContent);
      expect(text).not.toBe("");
      expect(text).not.toContain("undefined");
      expect(text).not.toContain("NaN");
    }
    // The reliability panel is a separate endpoint, not a /api/status field.
    expect(ui.el("relEngine").innerHTML).toContain("running");
    expect(String(ui.el("relPartials").textContent)).toContain("file(s)");
    expect(String(ui.el("relPolicy").textContent)).toContain("backoff");
  });

  test("the manual metadata scan button calls the route and reports its result", async () => {
    await ui.run("scanMissingMetadata");
    expect(ui.el("metadataScanBtn").disabled).toBe(false);
    expect(ui.el("metadataScanBtn").textContent).toBe("📝 Scan Missing Metadata");
    const notifications = ui.el("notifications").children as StubElement[];
    expect(notifications.map((notification) => String(notification.textContent)).join("\n")).toContain(
      "Checked 1 downloaded video(s)",
    );
    expect(ui.errors).toEqual([]);
  });

  test("the failed and history tabs unwrap the same envelope", async () => {
    await ui.run("loadFailedItems");
    expect(ui.el("failedItems").innerHTML).toContain("Broken Video");
    expect(ui.el("failedItems").innerHTML).not.toContain("jobs.filter");
    await ui.run("loadHistory");
    expect(ui.el("historyItems").innerHTML).toContain("Finished Video");
    expect(ui.el("historyItems").innerHTML).not.toContain("jobs.filter");
  });

  test("jobStatus follows the engine's own stage values", () => {
    // 'downloaded' — not 'done' — is what the DB writes when media lands, and
    // a VOD wait is its own download_status rather than a pause reason.
    expect(ui.run("jobStatus", { download_status: "downloaded", conversion_status: "not_needed" })).toBe("done");
    expect(ui.run("jobStatus", { download_status: "downloaded", conversion_status: "pending" })).toBe("pending");
    expect(ui.run("jobStatus", { download_status: "waiting_live" })).toBe("waiting_live");
    expect(ui.run("jobStatus", { download_status: "paused", pause_reason: "user" })).toBe("paused");
    expect(ui.run("jobStatus", { download_status: "failed" })).toBe("failed");
    expect(ui.run("jobStatus", { download_status: "downloaded", metadata_status: "failed" })).toBe("failed");
  });

  test("the detail drawer explains sidecars confirmed unavailable at the source", async () => {
    db.run("UPDATE jobs SET metadata_unavailable = ? WHERE id = ?", [JSON.stringify(["thumbnail", "infoJson"]), "uicontract2"]);
    await ui.run("openJobDetailById", "uicontract2");
    const drawer = String(ui.el("drawerBody").innerHTML);
    expect(drawer).toContain("Not returned by the last source check");
    expect(drawer).toContain("thumbnail");
    expect(drawer).toContain("info.json");
    expect(ui.errors).toEqual([]);
  });

  test("the log tab prints the { ok, logs } lines instead of an empty panel", async () => {
    // loadLogs renders `logs.join('\n')`; a missing file still answers with the
    // "No logs available" line, so a blank viewer can only mean a shape break.
    ui.el("logType").value = "error";
    await ui.run("loadLogs");
    const viewer = String(ui.el("logViewer").textContent);
    expect(viewer.split("\n").length).toBeGreaterThan(0);
    expect(viewer.trim()).not.toBe("");
    expect(viewer).not.toContain("undefined");
  });

  test("the ignored-videos manager loads titles as escaped text", async () => {
    db.run(
      "INSERT INTO ignored_videos (video_id, url, title, source_urls) VALUES (?, ?, ?, ?)",
      ["ignored-ui", "https://www.youtube.com/watch?v=ignored-ui", "<script>bad()</script>", JSON.stringify(["https://www.youtube.com/playlist?list=UI_TEST"])],
    );
    await ui.run("openIgnoredVideos");
    const body = ui.el("ignoredVideosBody").innerHTML;
    expect(body).toContain("&lt;script&gt;bad()&lt;/script&gt;");
    expect(body).not.toContain("<script>bad()</script>");
    expect(body).toContain("Allow again");
    expect(body).toContain("UI_TEST");
  });

  test("a job selection keeps video ids as strings", async () => {
    await ui.run("fetchStatus");
    ui.run("toggleJobSelection", SEEDED_ID);
    expect(ui.evaluate("Array.from(selectedJobs)")).toEqual([SEEDED_ID]);
  });

  test("the detail drawer reads the row the API sent, not an alias of it", async () => {
    await ui.run("fetchStatus");
    await ui.run("openJobDetailById", SEEDED_ID);
    expect(String(ui.el("drawerTitle").textContent)).toBe("Downloading Video");
    const drawer = String(ui.el("drawerBody").innerHTML);
    expect(drawer).toContain(SEEDED_ID);
    // Stage values and timestamps the engine really writes — the container has
    // no `override_*` columns, so a drawer reading those renders blank cells.
    expect(drawer).toContain(">downloading<");
    expect(drawer).toContain("42.5%");
    expect(drawer).toMatch(/Created \(UTC\)/);
    expect(drawer).not.toContain("undefined");
    // The override picker must pre-select the job's own container.
    expect(drawer).toContain('<option value="mp4" selected>MP4</option>');
  });

  test("queued rows expose the per-job controls: gear, audio picker, and resume", async () => {
    insertJob("uicontract-paused", {
      title: "Paused Video",
      download_status: "paused",
      pause_reason: "user",
      progress: 12.5,
    });
    const ui2 = await loadDashboard(DEFAULT_CONFIG);
    await ui2.run("fetchStatus");
    const html = String(ui2.el("jobsTableBody").innerHTML);
    // Every non-done row (downloading, paused, failed) gets the gear
    // (format/quality override) and the audio-tracks icon; the done row gets
    // neither.
    expect((html.match(/openOverridePopover/g) || []).length).toBe(3);
    expect((html.match(/openAudioPopover/g) || []).length).toBe(3);
    // A paused row gets the single-video resume action.
    expect((html.match(/▶️ Resume</g) || []).length).toBe(1);
    expect(html).toContain("resumeJob");
    // The failed row's retry is now a wipe-and-restart.
    expect(html).toContain("Wipe partial files and restart this job from 0%");
    expect(ui2.errors).toEqual([]);
  });

  test("the row resume action unpauses the job through the API", async () => {
    insertJob("uicontract-resume", {
      download_status: "paused",
      pause_reason: "user",
      progress: 33,
    });
    const ui2 = await loadDashboard(DEFAULT_CONFIG);
    await ui2.run("resumeJob", "uicontract-resume");
    const res = await handleRequest(new Request("http://127.0.0.1:3000/api/jobs"), DEFAULT_CONFIG);
    const payload = await res.json();
    const row = payload.jobs.find((j: any) => j.id === "uicontract-resume");
    expect(row.download_status).toBe("pending");
    expect(row.pause_reason).toBeNull();
    // Smart pick-up: progress is kept, only the pause is lifted.
    expect(row.progress).toBe(33);
    expect(ui2.errors).toEqual([]);
  });

  test("the detail drawer offers Resume Processing for a paused job", async () => {
    insertJob("uicontract-drawer", {
      title: "Drawer Paused",
      download_status: "paused",
      pause_reason: "user",
    });
    const ui2 = await loadDashboard(DEFAULT_CONFIG);
    await ui2.run("fetchStatus");
    await ui2.run("openJobDetailById", "uicontract-drawer");
    const drawer = String(ui2.el("drawerBody").innerHTML);
    expect(drawer).toContain("▶️ Resume Processing");
    expect(drawer).not.toContain("undefined");
    expect(ui2.errors).toEqual([]);
  });

  test("the Scan Unconverted Videos action posts to its route and reports the result", async () => {
    const ui2 = await loadDashboard(DEFAULT_CONFIG);
    await ui2.run("runUnconvertedScan");
    const notifications = ui2.el("notifications").children as StubElement[];
    const text = notifications.map((n) => String(n.textContent)).join("\n");
    expect(text).toContain("Imported");
    expect(text).toContain("conversion to MP4");
    expect(ui2.errors).toEqual([]);
  });
});
