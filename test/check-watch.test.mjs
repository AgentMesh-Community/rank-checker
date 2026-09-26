// Tests for check-ranking in a competitor watch (1.1.0): an empty or short
// list is a quiet period and passes; a page-change story is not held against
// the covered list, so a second change to the same pricing page passes; and
// every other check holds as before. A plain channel is checked as in 1.0.0.
// fetch is stubbed.
//
// Fixtures: the plan's example watch (docs/competitor-watch-plan.md, section
// 4), Copilot at Microsoft and Gemini at Google for Acme; the ranked list is
// story-ranker's output on its own watch fixture (its test holds them the
// same); the covered list holds an earlier change to the same pricing page.
//
// Written by the harness (the owner's building-block exception, 2026-09-23).
//   needs: node >= 22
//   node --test test/check-watch.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyReply } from "../../../process-runner/scripts/match-reply.mjs";
import { readCovered } from "../scripts/common.mjs";
import { checkRanking, listProblems } from "../scripts/check-ranking.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE = join(HERE, "fixtures", "acme-watch.ranked.json");
const fixture = (name) => JSON.parse(readFileSync(join(HERE, "fixtures", name), "utf8"));
const RANKED = fixture("acme-watch.ranked.json");
const CHANNEL = fixture("acme-watch.channel.json");
const COVERED = fixture("acme-watch.covered.json");
const PLAIN = (() => { const c = structuredClone(CHANNEL); delete c.watch; return c; })();
const PRICING = "https://example.com/copilot/pricing";

/** A stub fetch: a status for every link (200 unless named), or "timeout". */
function fakeFetch(routes = {}, seen = []) {
  return async (url, opts = {}) => {
    seen.push({ url: String(url), method: opts.method });
    const got = routes[String(url)] ?? routes["*"] ?? 200;
    if (got === "timeout") throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    return new Response(opts.method === "HEAD" ? null : "<html></html>", { status: got });
  };
}

function setup({ ranked = null, channel = CHANNEL, covered = COVERED } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rank-checker-watch-"));
  const job = join(dir, "job1");
  const argv = ["--job", job, "--records", join(dir, "records")];
  const put = (name, data) => { const p = join(dir, name); writeFileSync(p, typeof data === "string" ? data : JSON.stringify(data, null, 2)); argv.push("--file", `${p}::application/json`); return p; };
  const listPath = put("stories.json", ranked ?? readFileSync(FIXTURE, "utf8"));
  if (channel) put("channel.json", channel);
  if (covered) put("covered.json", covered);
  return { dir, job, argv, listPath };
}
const checked = (job) => JSON.parse(readFileSync(join(job, "..", "records", "job1", "check.json"), "utf8"));

test("the plan's example passes byte for byte in a watch, though the same pricing page changed before and is on the covered list; any other covered repeat is still refused, and a plain channel refuses the repeat as before", async () => {
  const { job, argv } = setup();
  const seen = [];
  const res = await checkRanking({ argv, fetchImpl: fakeFetch({}, seen) });
  assert.equal(res.reply, "Passed the ranked list of 5 for Acme competitor brief: 7 of 7 links answered; every source, rank and number checks out, nothing repeats a covered story.");
  assert.ok(readFileSync(join(job, "out", "stories.json")).equals(readFileSync(FIXTURE)), "the piece is passed on unchanged");
  assert.ok(seen.some((s) => s.url === PRICING), "the pricing page's link is still asked");
  assert.deepEqual([checked(job).watch, checked(job).quiet, checked(job).page_changes_not_matched_to_covered, checked(job).passed], [true, false, 1, true]);
  assert.notEqual(classifyReply({ text: res.reply, files: [] }), "refused");

  const repeat = { ...COVERED, items: [...COVERED.items, { title: "Gemini now connects to a CRM for sales teams", url: "https://example.org/ai-news/gemini-crm-connector?utm_source=brief", date: "2026-09-22" }] };
  const again = setup({ covered: repeat });
  const refused = await checkRanking({ argv: again.argv, fetchImpl: fakeFetch() });
  assert.equal(refused.reply, 'I cannot pass the ranked list: 1 problem. Story 2 repeats a story covered on 2026-09-22: "Gemini now connects to a CRM for sales teams".');
  assert.equal(existsSync(join(again.job, "out")), false);

  const plain = setup({ channel: PLAIN });
  const asBefore = await checkRanking({ argv: plain.argv, fetchImpl: fakeFetch() });
  assert.equal(asBefore.reply, 'I cannot pass the ranked list: 1 problem. Story 1 repeats a story covered on 2026-09-21: "Microsoft 365 Copilot pricing changed".');
  assert.equal(checked(plain.job).watch, undefined, "a plain channel's record is as it was");
  assert.deepEqual(listProblems(RANKED, { covered: readCovered(COVERED) }), ['Story 1 repeats a story covered on 2026-09-21: "Microsoft 365 Copilot pricing changed".']);
  assert.deepEqual(listProblems(RANKED, { covered: readCovered(COVERED), watch: true }), []);
});

test("a quiet period passes in a watch: an empty list goes on byte for byte with no link asked, and a short list is no failure; a plain channel's empty list is refused as before", async () => {
  const empty = { ...RANKED, quiet: true, items: [] };
  const { job, argv, listPath } = setup({ ranked: empty });
  const seen = [];
  const res = await checkRanking({ argv, fetchImpl: fakeFetch({}, seen) });
  assert.equal(res.reply, "Passed the ranked list for Acme competitor brief: it is empty, a quiet period with nothing new, which a watch may have; there was no story or link to check.");
  assert.equal(seen.length, 0, "no link is asked");
  assert.ok(readFileSync(join(job, "out", "stories.json")).equals(readFileSync(listPath)));
  assert.deepEqual(JSON.parse(readFileSync(join(job, "pieces.json"), "utf8")).map((p) => [p.name, p.path]), [["stories", "out/stories.json"]]);
  assert.deepEqual([checked(job).quiet, checked(job).passed, checked(job).problems], [true, true, []]);
  assert.notEqual(classifyReply({ text: res.reply, files: [] }), "refused");

  const one = setup({ ranked: { ...RANKED, items: RANKED.items.slice(0, 1) } });
  const short = await checkRanking({ argv: one.argv, fetchImpl: fakeFetch() });
  assert.equal(short.reply, "Passed the ranked list of 1 for Acme competitor brief: 1 of 1 links answered; every source, rank and number checks out, nothing repeats a covered story.");

  const plain = setup({ ranked: empty, channel: PLAIN });
  const refused = await checkRanking({ argv: plain.argv, fetchImpl: fakeFetch() });
  assert.equal(refused.reply, "I cannot pass the ranked list: it has no stories in its items list.");
  assert.equal(existsSync(join(plain.job, "out")), false);
  assert.equal(classifyReply({ text: refused.reply, files: [] }), "refused");
});

test("every other check holds in a watch: a dead link, a number not in the material and a gap in the ranks are refused, and no link answering is still a problem when there were links", async () => {
  const doc = structuredClone(RANKED);
  doc.items[2].why = "It is the first Copilot feature that acts on its own, and 40 teams use it.";
  doc.items[4].rank = 6;
  const dead = doc.items[3].url;
  const { job, argv } = setup({ ranked: doc });
  const res = await checkRanking({ argv, fetchImpl: fakeFetch({ [dead]: 404 }) });
  assert.deepEqual(checked(job).problems, [
    "The ranks must run 1 to 5 in order with no gaps, and they run 1, 2, 3, 4, 6.",
    "Story 3's why says 40, which is not in its material.",
    `Story 4's link ${dead} answers 404.`,
  ]);
  assert.equal(res.reply, `I cannot pass the ranked list: 3 problems. ${checked(job).problems.join(" ")}`);
  assert.equal(classifyReply({ text: res.reply, files: [] }), "refused");

  const one = setup({ ranked: { ...RANKED, items: RANKED.items.slice(0, 1) } });
  const silent = await checkRanking({ argv: one.argv, fetchImpl: fakeFetch({ "*": "timeout" }) });
  assert.equal(silent.reply, "I cannot pass the ranked list: 1 problem. No link answered: all 1 ran past 8 seconds or could not be reached, so none could be checked.");
});
