// Check a ranked list against its own material before anything is made from
// it. The ranker does not check itself; this block does, in code, calling no
// model. The list passes on unchanged only when every story has a source,
// every link answers, every number in a why is in that story's own material,
// nothing repeats a story the channel has covered, the ranks run 1 to n with
// no gaps, and no sponsor the channel names appears anywhere in the list.
// Otherwise it refuses, opening "I cannot" and naming each problem, so the
// runner can send the list back to the ranker.
//
// Links are asked once each, HEAD first and GET when HEAD is turned away,
// with a normal browser user agent and an eight second limit. A link that
// runs out of time, or a site that turns a robot away (401, 403, 429, 451),
// is marked in the records and not held against the list, unless no link
// answered at all. A link that answers 404, 410 or a server error, or whose
// site cannot be reached, is a problem.
//
// Writes out/stories.json (the ranked list, byte for byte as it arrived) and
// pieces.json when the list passes, and records/<job>/check.json always.
//
// In a competitor watch (a channel-v1 with a watch part,
// docs/competitor-watch-plan.md), 1.1.0: an empty list is a quiet period and
// passes with no link to ask (a short list was never a problem); and a
// page-change story is not
// checked against the covered list, because the snapshot comparison is what
// made it new and its address repeats by nature (every change to one pricing
// page has the same link). A channel without a watch part is checked exactly
// as in 1.0.0.
//
// The harness wrote this script, its spec and its tests (the owner's
// building-block exception of 2026-09-23).
//
//   needs: node >= 22
//   node scripts/check-ranking.mjs --job <job folder> --records <records folder> --file <path>::<media type>
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { stopReplyFor } from "./stop-notice.mjs";
import {
  coveredMatch, coveredReason, isChannel, isRec, loadPieces, names, parseArgs, pick, publisherOf, readCovered,
  refusal as refuse, sponsorsOf, str, strayNumbers,
} from "./common.mjs";

export const LINK_SECONDS = 8;
const AT_ONCE = 8;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
/** Statuses that say the page is there and the site turns robots away: marked, not held against the list. */
const TURNED_AWAY = new Set([401, 403, 429, 451]);

const refusal = (text) => refuse(text, "I cannot pass the ranked list");
const isHttp = (u) => /^https?:\/\/\S+$/i.test(str(u));
const short = (t) => { const s = str(t); return s.length > 60 ? `${s.slice(0, 57).trimEnd()}...` : s; };

/**
 * What one link answered: ok, turned-away or timeout (marked, not held
 * against the list), or dead, broken or unreachable (a problem). HEAD first;
 * GET when HEAD answers 400 or above.
 */
export async function checkLink(url, fetchImpl = fetch, seconds = LINK_SECONDS) {
  const ask = async (method) => {
    const res = await fetchImpl(url, { method, redirect: "follow", headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,*/*;q=0.8" }, signal: AbortSignal.timeout(seconds * 1000) });
    try { await res.body?.cancel?.(); } catch { /* nothing to cancel */ }
    return res.status;
  };
  try {
    let status = await ask("HEAD");
    if (status >= 400) status = await ask("GET");
    if (status < 400) return { url, state: "ok", status };
    if (TURNED_AWAY.has(status)) return { url, state: "turned-away", status };
    if (status === 404 || status === 410) return { url, state: "dead", status };
    return { url, state: "broken", status };
  } catch (err) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") return { url, state: "timeout" };
    return { url, state: "unreachable", said: String(err?.cause?.code ?? err?.message ?? err).slice(0, 120) };
  }
}

async function eachLimited(list, limit, fn) {
  const out = new Array(list.length);
  let next = 0;
  const worker = async () => { while (next < list.length) { const i = next++; out[i] = await fn(list[i]); } };
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
  return out;
}

/** Everything a why may draw a number from: the story's headline, text, site, sources, source count and engagement. */
export const materialOf = (it) => [it.title, it.text, it.domain, ...(Array.isArray(it.sources) ? it.sources.map((s) => s?.name) : []), it.source_count, it.engagement?.points, it.engagement?.comments]
  .filter((v) => v !== null && v !== undefined).join(" ");

/** Everything in a story a viewer could see or follow: where a sponsor must not appear. */
const shownOf = (it) => [it.title, it.why, it.text, it.url, it.domain, ...(Array.isArray(it.sources) ? it.sources.flatMap((s) => [s?.name, s?.url]) : [])].filter(Boolean).join(" \n ");

/** Whether a channel definition is a competitor watch: it has a watch part. */
export const isWatch = (channel) => isRec(channel?.watch);

/**
 * The problems with a ranked list that need no network, each a sentence:
 * sources, ranks, numbers in the whys, covered stories, sponsors. In a watch
 * a page-change story is not matched against the covered list.
 */
export function listProblems(doc, { covered = [], sponsors = [], watch = false } = {}) {
  const problems = [];
  const items = doc.items;
  const ranks = items.map((it) => it?.rank);
  if (!ranks.every((r, i) => r === i + 1)) problems.push(`The ranks must run 1 to ${items.length} in order with no gaps, and they run ${ranks.map((r) => (r === undefined ? "none" : r)).join(", ")}.`);
  items.forEach((it, i) => {
    const n = `Story ${Number.isInteger(it?.rank) ? it.rank : i + 1}`;
    if (!isRec(it)) { problems.push(`${n} is not a story.`); return; }
    if (!str(it.title)) problems.push(`${n} has no headline.`);
    if (!isHttp(it.url)) problems.push(`${n} has no link.`);
    if (!str(it.why)) problems.push(`${n} has no why.`);
    const sources = (Array.isArray(it.sources) ? it.sources : []).filter((s) => isRec(s) && (str(s.name) || isHttp(s.url)));
    if (!sources.length) problems.push(`${n} has no source.`);
    const stray = strayNumbers(it.why, materialOf(it));
    if (stray.length) problems.push(`${n}'s why says ${stray.join(", ")}, which is not in its material.`);
    const pageChange = watch && str(it.kind) === "page-change";
    const hit = pageChange ? null : coveredMatch(covered, { urls: [it.url, ...sources.map((s) => s.url)].filter(isHttp), titles: [str(it.title)] });
    if (hit) problems.push(`${n} repeats a story ${coveredReason(hit.entry)}: "${short(hit.entry.title || hit.entry.url)}".`);
    const shown = shownOf(it);
    for (const sp of sponsors) {
      if (sp.name && names(shown, sp.name)) problems.push(`${n} names the sponsor ${sp.name}; the ranker never sees the sponsor, so this is for the owner to settle.`);
      else if (sp.site && [it.url, ...sources.map((s) => s.url)].some((u) => isHttp(u) && publisherOf(u) === sp.site)) problems.push(`${n} links to the sponsor's site ${sp.site}; the ranker never sees the sponsor, so this is for the owner to settle.`);
    }
  });
  return problems;
}

/** Every link in the list, once each, with the stories that carry it. */
export function linksOf(items) {
  const by = new Map();
  items.forEach((it, i) => {
    const n = Number.isInteger(it?.rank) ? it.rank : i + 1;
    const urls = [it?.url, ...(Array.isArray(it?.sources) ? it.sources.map((s) => s?.url) : [])].filter(isHttp);
    for (const u of urls) { if (!by.has(u)) by.set(u, new Set()); by.get(u).add(n); }
  });
  return by;
}

const said = (r) => (r.state === "unreachable" ? `cannot be reached (${r.said})` : r.state === "dead" || r.state === "broken" ? `answers ${r.status}` : r.state);

/** The problems the links make: each one that is dead, broken or unreachable, or one sentence when none answered. */
export function linkProblems(results, by) {
  if (!results.length) return [];
  const failed = results.filter((r) => ["dead", "broken", "unreachable"].includes(r.state));
  const silent = results.filter((r) => r.state === "timeout" || r.state === "unreachable");
  if (silent.length === results.length) return [`No link answered: all ${results.length} ran past ${LINK_SECONDS} seconds or could not be reached, so none could be checked.`];
  return failed.map((r) => `${[...by.get(r.url)].map((n) => `Story ${n}`).join(" and ")}'s link ${r.url} ${said(r)}.`);
}

function record(args, value) {
  if (!args.records) return;
  const dir = join(args.records, basename(args.job));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "check.json"), JSON.stringify(value, null, 2) + "\n");
}

/** The refusal: "I cannot pass the ranked list", each problem, cut short of 600 characters with the count of the rest. */
export function refusalFor(problems) {
  let text = `I cannot pass the ranked list: ${problems.length} ${problems.length === 1 ? "problem" : "problems"}.`;
  for (let i = 0; i < problems.length; i++) {
    const rest = problems.length - i - 1;
    const next = `${text} ${problems[i]}`;
    if ((rest ? `${next} And ${rest} more, all in the records.` : next).length >= 600) return `${text} And ${problems.length - i} more, all in the records.`;
    text = next;
  }
  return text;
}

export async function checkRanking({ argv = [], fetchImpl = fetch, seconds = LINK_SECONDS } = {}) {
  const args = parseArgs(argv);
  // The runner's stop notice is not a list to check (stop-notice.mjs).
  const stopped = stopReplyFor(args.textFile);
  if (stopped) return { reply: stopped };
  if (!args.job) return { reply: refusal("I cannot check the ranked list: no job folder was given (--job).") };
  const pieces = loadPieces(args.files.filter((f) => existsSync(f)));
  const listPiece = pick(pieces, { format: "ranked-stories-v1", word: "stories", shape: (d) => isRec(d) && Array.isArray(d.items) });
  const channel = pick(pieces, { format: "channel-v1", word: "channel", shape: isChannel })?.data;
  const covered = readCovered(pick(pieces, { format: "covered-v1", word: "covered", shape: () => false })?.data);
  const doc = listPiece?.data;
  if (!doc) return { reply: refusal("I cannot check the ranked list: none was handed over. Send the ranked list (ranked-stories-v1) the story ranker delivers.") };
  if (!channel) return { reply: refusal("I cannot check the ranked list: no channel was handed over. Send the channel's definition (channel-v1); its sponsor setting is checked against the list.") };
  const watch = isWatch(channel);
  // In a watch, an empty list is a quiet period, not a failure.
  if (!Array.isArray(doc.items) || (!doc.items.length && !watch)) return { reply: refusal("I cannot pass the ranked list: it has no stories in its items list.") };

  const sponsors = sponsorsOf(channel);
  const problems = listProblems(doc, { covered, sponsors, watch });
  const by = linksOf(doc.items);
  const results = await eachLimited([...by.keys()], AT_ONCE, (u) => checkLink(u, fetchImpl, seconds));
  problems.push(...linkProblems(results, by));
  const marked = results.filter((r) => r.state === "timeout" || r.state === "turned-away");
  const pageChanges = watch ? doc.items.filter((it) => str(it?.kind) === "page-change").length : 0;
  record(args, {
    stories: doc.items.length, covered: covered.length, sponsors: sponsors.map((s) => s.name || s.site),
    links: results, marked: marked.map((r) => ({ url: r.url, state: r.state, status: r.status ?? null, stories: [...by.get(r.url)] })),
    problems, passed: problems.length === 0,
    ...(watch ? { watch: true, quiet: doc.items.length === 0, page_changes_not_matched_to_covered: pageChanges } : {}),
  });
  if (problems.length) return { reply: refusalFor(problems), problems };

  // It passes: the list goes on exactly as it came.
  mkdirSync(join(args.job, "out"), { recursive: true });
  writeFileSync(join(args.job, "out", "stories.json"), readFileSync(listPiece.path));
  writeFileSync(join(args.job, "pieces.json"), JSON.stringify([{
    name: "stories", step: "check-the-ranking", path: "out/stories.json", media_type: "application/json",
    about: "The ranked list (ranked-stories-v1), unchanged, after its sources, links, numbers, covered stories, ranks and sponsors were checked.",
    produced_from: ["stories", "channel", ...(covered.length ? ["covered"] : [])],
  }], null, 2) + "\n");
  if (!doc.items.length) return { reply: `Passed the ranked list for ${str(channel.name) || str(channel.slug) || "the watch"}: it is empty, a quiet period with nothing new, which a watch may have; there was no story or link to check.` };
  const ok = results.filter((r) => r.state === "ok").length;
  const late = marked.filter((r) => r.state === "timeout").length;
  const away = marked.length - late;
  const notes = [late ? `${late} ran past ${seconds} seconds` : "", away ? `${away} would not serve a robot` : ""].filter(Boolean);
  return { reply: `Passed the ranked list of ${doc.items.length} for ${str(channel.name) || str(channel.slug) || "the channel"}: ${ok} of ${results.length} links answered${notes.length ? `, ${notes.join(" and ")}, marked in the records` : ""}; every source, rank and number checks out, nothing repeats a covered story${sponsors.length ? ", and no sponsor appears" : ""}.` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  checkRanking({ argv: process.argv.slice(2) }).then(
    ({ reply }) => console.log(JSON.stringify({ reply })),
    (err) => { console.log(JSON.stringify({ reply: refusal(String(err?.message ?? err)) })); process.exitCode = 1; },
  );
}
