// Tests for check-ranking: a list that passes goes on byte for byte; each
// kind of problem is refused in words the runner reads as a refusal; links
// are asked HEAD first, with slow ones and robot refusals marked and not held
// against the list; sponsors are found by name and by site. fetch is stubbed.
//
// The ranked fixture is story-ranker's output on its own fixture, which came
// from 31 real items from four feeds read once on 2026-09-25.
//
// Written by the harness (the owner's building-block exception, 2026-09-23).
//   needs: node >= 22
//   node --test test/check-ranking.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyReply } from "../../../process-runner/scripts/match-reply.mjs";
import { stoppedReply } from "../scripts/stop-notice.mjs";
import { canonicalUrl, publisherOf, readCovered, sponsorsOf } from "../scripts/common.mjs";
import { checkRanking, listProblems, refusalFor } from "../scripts/check-ranking.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SCRIPT = join(HERE, "..", "scripts", "check-ranking.mjs");
const FIXTURE = join(HERE, "fixtures", "ai-agents.ranked.json");
const fixture = (name) => JSON.parse(readFileSync(join(HERE, "fixtures", name), "utf8"));
const RANKED = fixture("ai-agents.ranked.json");
const CHANNEL = fixture("ai-agents.channel.json");
const COVERED = fixture("ai-agents.covered.json");
const YAHOO = "https://www.yahoo.com/tech/articles/meta-made-tamagotchi-wearable-muse-004617.html";
const CUTE = "https://www.theverge.com/column/999999/optimizer-meta-muse-ai-cute";
const ELEVEN = "https://techcrunch.com/2026/09/24/twenty-minutes-with-the-ceo-of-elevenlabs-now-reportedly-valued-at-22-billion/";

/** A stub fetch: a status for every link (200 unless named), per method when given, or "timeout" or "down". */
function fakeFetch(routes = {}, seen = []) {
  return async (url, opts = {}) => {
    seen.push({ url: String(url), method: opts.method, ua: opts.headers?.["user-agent"], signal: !!opts.signal });
    const r = routes[String(url)] ?? routes["*"] ?? 200;
    const got = typeof r === "object" ? r[opts.method] ?? 200 : r;
    if (got === "timeout") throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    if (got === "down") throw new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } });
    return new Response(opts.method === "HEAD" ? null : "<html></html>", { status: got });
  };
}

function setup({ ranked = null, channel = CHANNEL, covered = COVERED } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rank-checker-"));
  const job = join(dir, "job1");
  const argv = ["--job", job, "--records", join(dir, "records")];
  const put = (name, data) => { const p = join(dir, name); writeFileSync(p, typeof data === "string" ? data : JSON.stringify(data)); argv.push("--file", `${p}::application/json`); };
  put("stories.json", ranked ?? readFileSync(FIXTURE, "utf8"));
  if (channel) put("channel.json", channel);
  if (covered) put("covered.json", covered);
  return { dir, job, argv };
}

const checked = (job) => JSON.parse(readFileSync(join(job, "..", "records", "job1", "check.json"), "utf8"));

test("a list that passes goes on byte for byte; links are asked HEAD first, and slow ones and robot refusals are marked, not held against it", async () => {
  const { job, argv } = setup();
  const seen = [];
  const res = await checkRanking({ argv, fetchImpl: fakeFetch({ [YAHOO]: { HEAD: 405, GET: 200 }, [CUTE]: 403, [ELEVEN]: "timeout" }, seen) });
  assert.equal(res.reply, "Passed the ranked list of 10 for AI agents this week: 12 of 14 links answered, 1 ran past 8 seconds and 1 would not serve a robot, marked in the records; every source, rank and number checks out, nothing repeats a covered story.");
  assert.ok(readFileSync(join(job, "out", "stories.json")).equals(readFileSync(FIXTURE)), "the piece is passed on unchanged");
  const pieces = JSON.parse(readFileSync(join(job, "pieces.json"), "utf8"));
  assert.deepEqual(pieces.map((p) => [p.name, p.path, p.media_type]), [["stories", "out/stories.json", "application/json"]]);
  assert.equal(new Set(seen.map((s) => s.url)).size, 14, "every link once: the stories' own and their sources'");
  assert.ok(seen.every((s) => s.ua.startsWith("Mozilla/5.0") && s.signal), "a browser user agent and a time limit on every call");
  assert.deepEqual(seen.filter((s) => s.url === YAHOO).map((s) => s.method), ["HEAD", "GET"], "GET only when HEAD is turned away");
  assert.deepEqual(seen.filter((s) => s.url === CUTE).map((s) => s.method), ["HEAD", "GET"]);
  assert.deepEqual(checked(job).marked.map((m) => [m.state, m.status, m.stories]), [["turned-away", 403, [7]], ["timeout", null, [8]]]);
  assert.equal(checked(job).passed, true);
  assert.notEqual(classifyReply({ text: res.reply, files: [] }), "refused");
});

test("every problem is refused and named: no source, a dead link, a number not in the material, a covered story, a gap in the ranks, a sponsor", async () => {
  const doc = structuredClone(RANKED);
  doc.items[1].sources = [];
  doc.items[3].why = "Live Avatar speaks 97 languages in 12 countries.";
  doc.items[4].url = "https://www.arstechnica.com/security/2026/09/microsoft-disrupts-ai-assisted-platform-that-compromised-12000/?utm_source=rss";
  doc.items[9].rank = 11;
  const dead = doc.items[2].url;
  const { job, argv } = setup({ ranked: doc, channel: { ...CHANNEL, sponsor: { name: "Lovable", logo: "https://lovable.dev/logo.png", line: "Build apps by chatting", link: "https://lovable.dev" } } });
  const res = await checkRanking({ argv, fetchImpl: fakeFetch({ [dead]: 404 }) });
  const problems = checked(job).problems;
  assert.deepEqual(problems, [
    "The ranks must run 1 to 10 in order with no gaps, and they run 1, 2, 3, 4, 5, 6, 7, 8, 9, 11.",
    "Story 2 has no source.",
    "Story 4's why says 12, which is not in its material.",
    "Story 5 repeats a story covered on 2026-09-23: \"Microsoft disrupts AI-assisted platform that compromised...\".",
    "Story 9 names the sponsor Lovable; the ranker never sees the sponsor, so this is for the owner to settle.",
    `Story 3's link ${dead} answers 404.`,
  ]);
  assert.equal(res.reply, `I cannot pass the ranked list: 6 problems. ${problems.join(" ")}`);
  assert.ok(res.reply.length < 600, `${res.reply.length} characters`);
  assert.equal(classifyReply({ text: res.reply, files: [] }), "refused");
  // More problems than 600 characters hold: as many as fit, then how many more.
  const many = refusalFor(Array.from({ length: 12 }, (_, i) => `Story ${i + 1}'s link https://example.test/${"x".repeat(40)} answers 404.`));
  assert.ok(many.length < 600, `${many.length} characters`);
  assert.match(many, /^I cannot pass the ranked list: 12 problems\. Story 1's link .* And \d+ more, all in the records\.$/);
  assert.equal(classifyReply({ text: many, files: [] }), "refused");
  assert.equal(existsSync(join(job, "out")), false, "nothing is passed on");
  assert.equal(existsSync(join(job, "pieces.json")), false);
});

test("when no link answers the list is refused once for that; a site that cannot be reached or answers a server error is a problem", async () => {
  const silent = setup();
  const r1 = await checkRanking({ argv: silent.argv, fetchImpl: fakeFetch({ "*": "timeout" }) });
  assert.equal(r1.reply, "I cannot pass the ranked list: 1 problem. No link answered: all 14 ran past 8 seconds or could not be reached, so none could be checked.");
  const some = setup();
  const r2 = await checkRanking({ argv: some.argv, fetchImpl: fakeFetch({ [YAHOO]: "down", [ELEVEN]: 503 }) });
  assert.deepEqual(checked(some.job).problems, [
    `Story 1's link ${YAHOO} cannot be reached (ENOTFOUND).`,
    `Story 8's link ${ELEVEN} answers 503.`,
  ]);
  assert.equal(r2.reply, `I cannot pass the ranked list: 2 problems. Story 1's link ${YAHOO} cannot be reached (ENOTFOUND). Story 8's link ${ELEVEN} answers 503.`);
  for (const r of [r1, r2]) assert.equal(classifyReply({ text: r.reply, files: [] }), "refused");
});

test("sponsors are read from the channel in every shape and found as words or by their site; the dropped list is not the list", () => {
  assert.deepEqual(sponsorsOf({ sponsor: "Acme" }), [{ name: "Acme", site: null }]);
  assert.deepEqual(sponsorsOf({ sponsors: ["Acme", { name: "Beta Labs", link: "https://www.betalabs.example.com/offer" }] }), [{ name: "Acme", site: null }, { name: "Beta Labs", site: "example.com" }]);
  assert.deepEqual(sponsorsOf({ sponsor: { format: "sponsor-v1", name: "Arc", link: "https://arc.example.org" } }), [{ name: "Arc", site: "example.org" }]);
  assert.deepEqual(sponsorsOf({ slug: "x" }), []);
  const doc = structuredClone(RANKED);
  doc.dropped.push({ title: "Arc ships a new browser agent", url: "https://arc.example.org/news", reason: "off topic: a browser" });
  // "Arc" is not in "search" or "Arcade", and a sponsor only in the dropped list is not in the list.
  doc.items[0].text = `${doc.items[0].text} People search the Arcade for it.`;
  assert.deepEqual(listProblems(doc, { sponsors: [{ name: "Arc", site: null }] }), []);
  doc.items[5].why = "Muse looks like OpenClaw, the ARC agent.";
  assert.deepEqual(listProblems(doc, { sponsors: [{ name: "Arc", site: null }] }), ["Story 6 names the sponsor Arc; the ranker never sees the sponsor, so this is for the owner to settle."]);
  assert.deepEqual(listProblems(RANKED, { sponsors: [{ name: "Acme Robotics", site: "theverge.com" }] }).map((p) => p.slice(0, 50)), [
    "Story 2 links to the sponsor's site theverge.com; ",
    "Story 4 links to the sponsor's site theverge.com; ",
    "Story 5 links to the sponsor's site theverge.com; ",
    "Story 6 links to the sponsor's site theverge.com; ",
    "Story 7 links to the sponsor's site theverge.com; ",
  ]);
  assert.deepEqual(listProblems(RANKED, { covered: readCovered(COVERED) }), [], "the fixture repeats nothing covered");
});

test("links, publishers and the shared files: tracking words and www. do not make a new link, two pages of one site are one publisher, and every copy is the same", () => {
  assert.equal(canonicalUrl("https://www.Example.com/a/b/?utm_source=x&id=2&fbclid=y#top"), "example.com/a/b?id=2");
  assert.equal(canonicalUrl("http://example.com/a/b/amp/"), "example.com/a/b");
  assert.equal(canonicalUrl("mailto:someone@example.com"), null);
  assert.equal(publisherOf("https://blog.techcrunch.com/x"), "techcrunch.com");
  assert.equal(publisherOf("https://www.bbc.co.uk/news/x"), "bbc.co.uk");
  assert.equal(publisherOf("https://alice.substack.com/p/x"), "alice.substack.com");
  assert.equal(publisherOf("https://github.com/acme/agent/releases"), "github.com/acme");
  const blocks = join(HERE, "..", "..");
  const master = readFileSync(join(blocks, "story-editor", "scripts", "common.mjs"));
  for (const b of ["story-ranker", "rank-checker"]) assert.ok(readFileSync(join(blocks, b, "scripts", "common.mjs")).equals(master), `${b}'s common.mjs is the master copy`);
  const stop = readFileSync(join(blocks, "..", "explainer-blocks", "shared", "stop-notice.mjs"));
  for (const b of ["story-editor", "story-ranker", "rank-checker"]) assert.ok(readFileSync(join(blocks, b, "scripts", "stop-notice.mjs")).equals(stop), `${b}'s stop-notice.mjs is the master copy`);
  const caller = readFileSync(join(blocks, "..", "explainer-blocks", "shared", "caller.mjs"));
  for (const b of ["story-editor", "story-ranker"]) assert.ok(readFileSync(join(blocks, b, "scripts", "caller.mjs")).equals(caller), `${b}'s caller.mjs is the master copy`);
});

test("refuses in words the process runner reads as a refusal, and a stop notice does no work", async () => {
  const replies = [
    (await checkRanking({ argv: setup({ ranked: { format: "stories-v1", stories: [] } }).argv, fetchImpl: fakeFetch() })).reply,
    (await checkRanking({ argv: setup({ channel: null }).argv, fetchImpl: fakeFetch() })).reply,
    (await checkRanking({ argv: setup({ ranked: { ...RANKED, items: [] } }).argv, fetchImpl: fakeFetch() })).reply,
  ];
  assert.deepEqual(replies, [
    "I cannot check the ranked list: none was handed over. Send the ranked list (ranked-stories-v1) the story ranker delivers.",
    "I cannot check the ranked list: no channel was handed over. Send the channel's definition (channel-v1); its sponsor setting is checked against the list.",
    "I cannot pass the ranked list: it has no stories in its items list.",
  ]);
  for (const said of replies) assert.equal(classifyReply({ text: said, files: [] }), "refused", said);
  const dir = mkdtempSync(join(tmpdir(), "rank-checker-stop-"));
  mkdirSync(join(dir, "job"));
  writeFileSync(join(dir, "job", "message.txt"), "run r-20260925-ab12 phase rank-checker: stop that\nThe owner cancelled this run.\n");
  const cli = spawnSync(process.execPath, [SCRIPT, "--job", join(dir, "job"), "--records", join(dir, "records"), "--text-file", join(dir, "job", "message.txt")], { encoding: "utf8" });
  assert.equal(JSON.parse(cli.stdout).reply, stoppedReply({ run: "r-20260925-ab12", phase: "rank-checker" }));
  assert.deepEqual(readdirSync(join(dir, "job")), ["message.txt"]);
  assert.equal(existsSync(join(dir, "records")), false);
});
