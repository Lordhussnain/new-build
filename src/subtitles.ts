// src/subtitles.ts — subtitle language selection, sidecar naming, and the
// ISO-639 language tags ffmpeg writes onto a muxed subtitle track.
//
// Pure module: both the metadata worker (which fetches the sidecar files) and
// the converter (which embeds them into the media) use it, and `download-args`
// may use it without importing a worker.

/**
 * The yt-dlp `--sub-langs` value for the operator's setting.
 *
 * `all` (or blank) keeps the legacy "every language" behaviour, including
 * auto-generated captions. YouTube exposes live chat as another language entry;
 * it is not a subtitle track, its "file" can be larger than the video, and
 * converting it to srt is a common way for a metadata pass to blow its
 * timeout — so it is excluded unless the operator asked for it by name.
 */
export function subtitleSelector(languages: string): string {
  const langs = (languages || "").trim();
  const base = (!langs || langs.toLowerCase() === "all" ? "all.*" : langs).replace(/,+$/, "");
  return /live[_-]?chat/i.test(base) ? base : `${base},-live_chat`;
}

/** The yt-dlp flags that write subtitle sidecar files (pure, unit-tested). */
export function subtitleArgs(config: {
  subtitleLanguages: string;
  subtitleFormat: string;
}): string[] {
  return [
    "--write-subs",
    "--write-auto-subs",
    "--sub-langs",
    subtitleSelector(config.subtitleLanguages),
    "--convert-subs",
    config.subtitleFormat || "srt",
  ];
}

/** Subtitle file extensions ffmpeg can read as an input track. */
export const EMBEDDABLE_SUBTITLE_EXTENSIONS = [".srt", ".vtt", ".ass", ".ssa"] as const;

export function isEmbeddableSubtitleFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  return EMBEDDABLE_SUBTITLE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * The language tag in a yt-dlp subtitle sidecar name.
 *
 * `001 - Video.en.srt` → "en"; `...zh-Hans.vtt` → "zh-hans";
 * `...en-orig.srt` → "en-orig"; a bare `... .srt` → null. Anything that is not
 * a plausible tag returns null, so a stray file is embedded as "und" rather
 * than tagged with a whole title.
 */
export function parseSubtitleLanguage(filename: string, mediaBase: string): string | null {
  const prefix = `${mediaBase}.`.toLowerCase();
  const lower = filename.toLowerCase();
  if (!lower.startsWith(prefix)) return null;
  const rest = lower.slice(prefix.length);
  if (!isEmbeddableSubtitleFile(rest)) return null;
  const tag = rest.replace(/\.[^.]+$/, "");
  if (!tag) return null;
  return /^[a-z]{2,3}(?:[-_][a-z0-9]{2,8})*$/.test(tag) ? tag : null;
}

/**
 * ISO 639-1 → ISO 639-2/B, the codes Matroska and MP4 store (and players
 * display). A three-letter input is assumed to already be 639-2; anything
 * unknown becomes "und" so a track is never mistagged.
 */
const ISO639_1_TO_2: Record<string, string> = {
  aa: "aar", ab: "abk", af: "afr", ak: "aka", am: "amh", ar: "ara", as: "asm",
  ay: "aym", az: "aze", ba: "bak", be: "bel", bg: "bul", bm: "bam", bn: "ben",
  bo: "bod", br: "bre", bs: "bos", ca: "cat", co: "cos", cs: "ces", cy: "cym",
  da: "dan", de: "deu", dv: "div", dz: "dzo", el: "ell", en: "eng", eo: "epo",
  es: "spa", et: "est", eu: "eus", fa: "fas", ff: "ful", fi: "fin", fil: "fil",
  fo: "fao", fr: "fra", fy: "fry", ga: "gle", gd: "gla", gl: "glg", gn: "grn",
  gu: "guj", ha: "hau", he: "heb", hi: "hin", hr: "hrv", ht: "hat", hu: "hun",
  hy: "hye", id: "ind", ig: "ibo", is: "isl", it: "ita", iu: "iku", ja: "jpn",
  jv: "jav", ka: "kat", kk: "kaz", kl: "kal", km: "khm", kn: "kan", ko: "kor",
  ks: "kas", ku: "kur", ky: "kir", la: "lat", lb: "ltz", lg: "lug", ln: "lin",
  lo: "lao", lt: "lit", lu: "lub", lv: "lav", mg: "mlg", mi: "mri", mk: "mkd",
  ml: "mal", mn: "mon", mr: "mar", ms: "msa", mt: "mlt", my: "mya", nb: "nob",
  ne: "nep", nl: "nld", nn: "nno", no: "nor", or: "ori", pa: "pan", pl: "pol",
  ps: "pus", pt: "por", qu: "que", ro: "ron", ru: "rus", rw: "kin", sa: "san",
  sd: "snd", si: "sin", sk: "slk", sl: "slv", sn: "sna", so: "som", sq: "sqi",
  sr: "srp", st: "sot", su: "sun", sv: "swe", sw: "swa", ta: "tam", te: "tel",
  tg: "tgk", th: "tha", ti: "tir", tk: "tuk", tl: "tgl", tn: "tsn", to: "ton",
  tr: "tur", tt: "tat", ug: "uig", uk: "ukr", ur: "urd", uz: "uzb", vi: "vie",
  wo: "wol", xh: "xho", yi: "yid", yo: "yor", zh: "zho", zu: "zul",
  // Legacy codes YouTube still emits for some tracks.
  iw: "heb", in: "ind", ji: "yid", jw: "jav", mo: "ron",
};

export function iso639_2(language: string | null | undefined): string {
  if (!language) return "und";
  const base = language.toLowerCase().split(/[-_]/)[0]?.trim() ?? "";
  if (!base) return "und";
  if (base.length === 3) return base;
  return ISO639_1_TO_2[base] ?? "und";
}
