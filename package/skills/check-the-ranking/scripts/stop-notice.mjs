// The process runner's stop notice, and the one sentence a block answers it with.
//
// When a run is stopped, the runner tells every holder with work in flight, in
// a message whose first line is `run <run id> phase <phase>: stop that` (the
// runner's stopMessage, process-runner/scripts/messages.mjs). A block runs its
// job on every message it is sent, so until 2026-09-23 a stop notice was read
// as work: site-reader answered "I need a web address to read", and the runner,
// which by then had a new run of the same phase waiting on site-reader, took
// that answer as the new run's. A stop notice does no work and writes nothing.
// The answer names the run and the phase, so the runner matches it to the run
// that was stopped by its words, even where it cannot match it by id.
//
// The same file in every block, like caller.mjs, because a package carries its
// own files. The master copy is explainer-blocks/shared/stop-notice.mjs.
//
//   needs: node >= 22
import { readFileSync } from "node:fs";

const STOP = /^\s*(?:>\s*)?run\s+(r-\d{8}-[a-z0-9]{4})\s+phase\s+([a-z0-9-]+)\s*:\s*stop that\b/i;

/** The run and phase a stop notice names, or null when the text is not one. */
export function stopNotice(text) {
  const first = String(text ?? "").split(/\r?\n/).find((l) => l.trim()) ?? "";
  const m = STOP.exec(first);
  return m ? { run: m[1], phase: m[2] } : null;
}

/** The one sentence a block answers a stop notice with. */
export function stoppedReply({ run, phase }) {
  return `Nothing was in progress here for run ${run} phase ${phase}, so nothing was done and nothing was written.`;
}

/** The answer to the message in `textFile` when it is a stop notice; null when
 *  it is not, or when there is no message file to read. */
export function stopReplyFor(textFile) {
  if (!textFile) return null;
  let text = "";
  try { text = readFileSync(textFile, "utf8"); } catch { return null; }
  const notice = stopNotice(text);
  return notice ? stoppedReply(notice) : null;
}
