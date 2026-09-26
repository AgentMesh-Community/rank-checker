// What the three channel editing blocks share: links, publishers, headlines,
// numbers, the covered list, and finding the pieces a job was handed.
//
// The same file in story-editor, story-ranker and rank-checker, because a
// package carries its own files. The master copy is
// channel-blocks/story-editor/scripts/common.mjs, and rank-checker's test
// holds the three copies the same.
//
// The harness wrote this file under the owner's building-block exception of
// 2026-09-23.
//
//   needs: node >= 22
import { readFileSync } from "node:fs";
import { basename } from "node:path";

export const isRec = (v) => !!v && typeof v === "object" && !Array.isArray(v);
export const str = (v) => (typeof v === "string" ? v.trim() : "");

// ── links ──────────────────────────────────────────────────────────────────

/** Query words that only say where a reader came from, never which page it is. */
const TRACKING = /^(utm_[a-z_]+|itm_[a-z_]+|at_[a-z_]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|_hsenc|_hsmi|mkt_tok|ref|ref_src|ref_url|cmpid|ocid|smid|sr_share|guccounter|guce_referrer|guce_referrer_sig|xtor|amp)$/i;

/**
 * A link as a key: http and https alike, the host in lower case without www.,
 * m. or amp., no fragment, no tracking words in the query, no /amp or
 * /index.html on the end and no trailing slash. Null when it is not a web
 * address.
 */
export function canonicalUrl(url) {
  let u;
  try { u = new URL(str(url)); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase().replace(/^(www\d?|m|amp|mobile)\./, "");
  const path = u.pathname.replace(/\/amp\/?$/i, "/").replace(/\/index\.html?$/i, "/").replace(/\/+$/, "");
  const query = [...u.searchParams].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `${host}${path}${query.length ? `?${new URLSearchParams(query)}` : ""}`;
}

/** The host a reader sees, without www. Null when it is not a web address. */
export function hostOf(url) {
  try { return new URL(str(url)).hostname.toLowerCase().replace(/^www\./, ""); } catch { return null; }
}

/** Hosts where each subdomain is a different publisher (someone.substack.com). */
const BY_SUBDOMAIN = ["substack.com", "medium.com", "github.io", "blogspot.com", "wordpress.com", "tumblr.com", "ghost.io", "beehiiv.com", "hashnode.dev", "bearblog.dev", "pages.dev", "netlify.app", "vercel.app"];
/** Hosts where the first part of the path is the publisher (github.com/owner). */
const BY_PATH = ["medium.com", "github.com", "gitlab.com", "dev.to", "huggingface.co", "youtube.com", "x.com", "twitter.com", "linkedin.com", "reddit.com", "substack.com"];
const TWO_PART_SUFFIX = /\.(co|com|net|org|gov|ac|edu|ne|or)\.[a-z]{2}$/;

/**
 * Who published a link: the site's own name under its public suffix
 * (news.example.co.uk and example.co.uk are one publisher), except on shared
 * hosts, where each writer's subdomain or first path part is its own
 * publisher. Two pages of one site are one publisher; that is what makes a
 * count of publishers a count of independent sources.
 */
export function publisherOf(url) {
  let u;
  try { u = new URL(str(url)); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^(www\d?|m|amp|mobile)\./, "");
  const labels = host.split(".");
  const site = labels.slice(TWO_PART_SUFFIX.test(host) ? -3 : -2).join(".");
  if (BY_SUBDOMAIN.includes(site) && host !== site) return host;
  if (BY_PATH.includes(host)) {
    const first = u.pathname.split("/").filter(Boolean)[0];
    if (first) return `${host}/${first.toLowerCase()}`;
  }
  return site;
}

// ── headlines ──────────────────────────────────────────────────────────────

/** Case folded, curly quotes and long dashes made plain, accents taken off. */
export function fold(text) {
  return String(text ?? "")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[‘’‚‛′`´]/g, "'")
    .replace(/[“”„‟″«»]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const STOP = new Set(("a an and are as at be been but by can could did do does dont for from get gets got had has have he her his how i if in into is isnt it its just let lets like may me might more most much my new no not now of off on one or our out over says say said she so than that the their them there these they this those to too up us was we were what when where which while who why will with would yet you your youre after about via amid").split(" "));

/** One word as the headline matcher compares it: a plain plural made singular. */
function stem(w) {
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us")) return w.slice(0, -1);
  return w;
}

/**
 * The words of a headline that say what it is about: folded, a publisher's
 * name on the end (" | The Verge", " - TechCrunch") taken off when `publisher`
 * names it, apostrophes dropped, small words left out, plurals made singular.
 * Digits and version numbers are kept ("3.8", "gpt-6" gives "gpt" and "6").
 */
export function words(text, publisher = "") {
  let t = fold(text).replace(/'/g, "");
  const tail = /\s+[|\-:]\s+([^|\-:]{2,40})$/.exec(t);
  const pub = fold(publisher).replace(/'/g, "");
  if (tail && pub && (pub.includes(tail[1].trim()) || tail[1].trim().includes(pub.split(".")[0]))) t = t.slice(0, tail.index);
  return t.split(/[^a-z0-9.]+/)
    .map((w) => w.replace(/^\.+|\.+$/g, ""))
    .filter((w) => w && !STOP.has(w))
    .map(stem);
}

/** How alike two lists of words are: shared words over all words (0 to 1). */
export function likeness(a, b) {
  const A = new Set(a), B = new Set(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / (A.size + B.size - shared);
}

/** Headlines at least this alike, with three words or more each, report the same news. */
export const SAME_HEADLINE = 0.75;

/** Whether two headlines' words say the same thing: near-identical, or the very same when either is short. */
export function sameWords(wa, wb) {
  if (Math.min(new Set(wa).size, new Set(wb).size) < 3) return wa.length > 0 && wa.join(" ") === wb.join(" ");
  return likeness(wa, wb) >= SAME_HEADLINE;
}

/** Whether two headlines say the same thing. */
export function sameHeadline(a, b, pubA = "", pubB = "") {
  return sameWords(words(a, pubA), words(b, pubB));
}

// ── numbers ────────────────────────────────────────────────────────────────

/**
 * Every number written in digits in a text, as a plain number: "12,000" is
 * 12000, "09" is 9, "3.8." is 3.8, "$1.1M" is 1.1. Numbers written in words
 * are not read.
 */
export function numbersIn(text) {
  return (String(text ?? "").match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => {
    const v = Number(n.replace(/,/g, ""));
    return Number.isFinite(v) ? String(v) : n.replace(/,/g, "");
  });
}

/** The numbers in `said` that `material` does not hold, each once. */
export function strayNumbers(said, material) {
  const known = new Set(numbersIn(material));
  return [...new Set(numbersIn(said))].filter((n) => !known.has(n));
}

// ── what a channel has covered (covered-v1) ────────────────────────────────

/**
 * The covered list, however it arrived: covered-v1's stories (or items), or a
 * bare list, each entry { title, url, date }. Entries with neither a title nor
 * a link are passed over.
 */
export function readCovered(v) {
  const list = Array.isArray(v) ? v : isRec(v) ? (Array.isArray(v.stories) ? v.stories : Array.isArray(v.items) ? v.items : []) : [];
  return list.filter(isRec).map((e) => ({
    title: str(e.title ?? e.headline),
    url: str(e.url ?? e.link),
    date: str(e.date ?? e.published ?? e.covered_on ?? e.covered_at),
  })).filter((e) => e.title || e.url);
}

/** The covered entry a story repeats, by any of its links or its headline; null when it repeats none. */
export function coveredMatch(covered, { urls = [], titles = [] }) {
  const keys = new Set(urls.map(canonicalUrl).filter(Boolean));
  for (const e of covered) {
    const k = canonicalUrl(e.url);
    if (k && keys.has(k)) return { entry: e, by: "link" };
  }
  for (const e of covered) {
    if (e.title && titles.some((t) => sameHeadline(t, e.title))) return { entry: e, by: "headline" };
  }
  return null;
}

/** "covered on 2026-09-20", the reason a covered story is dropped. */
export const coveredReason = (entry) => (/^\d{4}-\d{2}-\d{2}/.test(entry.date) ? `covered on ${entry.date.slice(0, 10)}` : "covered before");

// ── a channel's sponsor setting ────────────────────────────────────────────

/**
 * The sponsors a channel names, as { name, site }: `sponsor` or `sponsors`,
 * each a name, or a sponsor-v1 piece ({ name, logo, line, link }). Empty when
 * the channel has none.
 */
export function sponsorsOf(channel) {
  if (!isRec(channel)) return [];
  const raw = [channel.sponsor, ...(Array.isArray(channel.sponsors) ? channel.sponsors : [channel.sponsors])].filter((s) => s != null && s !== "");
  const flat = raw.flatMap((s) => (Array.isArray(s) ? s : [s]));
  return flat.map((s) => {
    if (typeof s === "string") return { name: s.trim(), site: null };
    if (!isRec(s)) return null;
    const link = str(s.link ?? s.url);
    return { name: str(s.name), site: link ? publisherOf(link) : null };
  }).filter((s) => s && (s.name.length >= 2 || s.site));
}

/** Whether `text` says `name` as words of their own, ignoring case. */
export function names(text, name) {
  const n = fold(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return n.length >= 2 && new RegExp(`(^|[^a-z0-9])${n}($|[^a-z0-9])`).test(fold(text));
}

// ── the pieces a job was handed ────────────────────────────────────────────

/** Every handed file that is JSON, with its lower-case file name. */
export function loadPieces(paths) {
  const out = [];
  for (const path of paths) {
    try { out.push({ path, name: basename(path).toLowerCase(), data: JSON.parse(readFileSync(path, "utf8")) }); } catch { /* not JSON, not ours */ }
  }
  return out;
}

/** The first piece of `format`, else the first whose file name says `word` and whose shape fits, else the first whose shape fits. */
export function pick(pieces, { format, word, shape }) {
  return pieces.find((p) => isRec(p.data) && p.data.format === format)
    ?? pieces.find((p) => p.name.includes(word) && shape(p.data) && !(isRec(p.data) && p.data.format && p.data.format !== format))
    ?? pieces.find((p) => shape(p.data) && !(isRec(p.data) && p.data.format && p.data.format !== format))
    ?? null;
}

/** A channel definition (channel-v1): an object with a topic or a slug, and a rubric. */
export const isChannel = (v) => isRec(v) && (str(v.topic) !== "" || str(v.slug) !== "") && (isRec(v.rubric) || typeof v.rubric === "string");

/** The rubric in words, one line per part, whatever its keys. */
export function rubricLines(rubric) {
  if (typeof rubric === "string") return [`- ${rubric.trim()}`];
  if (!isRec(rubric)) return [];
  return Object.entries(rubric).filter(([, v]) => v != null && v !== "").map(([k, v]) => `- ${k.replace(/_/g, " ")}: ${Array.isArray(v) ? v.join("; ") : typeof v === "object" ? JSON.stringify(v) : String(v).trim()}`);
}

/** The window a list covers, { from, to } as dates: `days` back from `to`. */
export function windowOf(to, days) {
  const end = new Date(to);
  const d = Number.isInteger(days) && days > 0 ? days : 7;
  const start = new Date(end.getTime() - d * 86400000);
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

/**
 * The reply of a job that cannot be done. It opens "I cannot", the words the
 * process runner reads as a refusal (classifyReply in
 * process-runner/scripts/match-reply.mjs), and is cut short of 600
 * characters, past which the runner reads none.
 */
export function refusal(text, lead = "I cannot do this") {
  const said = /^I cannot\b/.test(text) ? text : `${lead}: ${text}`;
  return said.length < 600 ? said : `${said.slice(0, 596)}...`;
}

export function parseArgs(argv) {
  const out = { job: "", records: "", textFile: "", files: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (v === undefined) continue;
    if (k === "--job") out.job = argv[++i];
    else if (k === "--records") out.records = argv[++i];
    else if (k === "--text-file") out.textFile = argv[++i];
    else if (k === "--file") { const at = v.lastIndexOf("::"); out.files.push(at > 0 ? v.slice(0, at) : v); i++; }
    else if (k.startsWith("--")) i++;
  }
  return out;
}
