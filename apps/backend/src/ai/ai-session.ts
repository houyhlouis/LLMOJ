/*
 * A job's evidence and cost (review Part III, §8.1/§8.4): what each run of its programs did and took, what its model
 * requests were for and used, and what each repair changed in its program. All of it is bounded and kept with the job:
 * an author sees what a retry or a repair actually cost and changed, measured, never estimated.
 */
import type { AiUsageRecord } from "./ai-runtime";

export const AI_SESSION_LIMITS = Object.freeze({
  // Runs kept with the job, latest last
  runs: 20,
  // Bytes of a repair's change kept (its start, whole lines)
  diffBytes: 64 * 1024,
  // Lines compared line by line in a change: past this many (both programs' changed parts multiplied), the changed part
  // is shown as replaced as a whole
  diffCells: 4000000
});

/** What a model request was for, from the job's step when it was made. */
export const AI_PURPOSES = [
  "import",
  "source",
  "translate",
  "tags",
  "difficulty",
  "tutorial",
  "plan",
  "programs",
  "repairs",
  "other"
] as const;
export type AiPurpose = (typeof AI_PURPOSES)[number];

export function purposeOfStep(step: string): AiPurpose {
  const action = (step || "").split(".")[0];
  if (["import", "source", "translate", "tags", "difficulty", "tutorial"].includes(action)) return action as AiPurpose;
  if (action !== "testdata") return "other";
  if (step === "testdata.plan" || step === "testdata.quality-plan") return "plan";
  if (step === "testdata.repair") return "repairs";
  return "programs";
}

/**
 * A purpose's requests, as the job counted them (review Part IV, IV-08): `generations` are the paid model generations
 * it started; `requests` every model request sent, polls that recover a background response included (transport,
 * not work). Tokens are those providers reported. `unreported` are generations whose usage no response reported
 * (yet: a background generation's usage arrives with the poll that completes it).
 */
export interface AiSpending {
  generations?: number;
  requests: number;
  failed: number;
  searches: number;
  inputTokens: number;
  outputTokens: number;
  unreported: number;
  // Generations started without usage, waiting for the poll that reports it (bounded)
  pending?: string[];
}

export function asPurpose(value: string | undefined): AiPurpose | undefined {
  return (AI_PURPOSES as readonly string[]).includes(value as string) ? (value as AiPurpose) : undefined;
}

/** Counts a provider request of the job by what it was for: as sent, else (older callers) the job's step. */
export function tallyUsage(state: Record<string, unknown>, step: string, record: AiUsageRecord) {
  const spending = (state.spending || {}) as Partial<Record<AiPurpose, AiSpending>>;
  const purpose = asPurpose(record.purpose) ?? purposeOfStep(step);
  const item = spending[purpose] || {
    generations: 0,
    requests: 0,
    failed: 0,
    searches: 0,
    inputTokens: 0,
    outputTokens: 0,
    unreported: 0
  };
  item.generations ??= 0;
  if (record.target === "search") item.searches++;
  else item.requests++;
  if (!record.success) item.failed++;
  item.inputTokens += record.inputTokens || 0;
  item.outputTokens += record.outputTokens || 0;
  if (record.target !== "search") {
    const generation = record.operation === "generate";
    if (generation) item.generations++;
    const id = record.generationId;
    if (generation && !record.usageReported) {
      item.unreported++;
      if (id && record.pendingResponseId) item.pending = [...(item.pending || []), id].slice(-50);
    } else if (!generation && record.usageReported && id && item.pending?.includes(id)) {
      // The poll that completed a background generation reported its usage
      item.unreported = Math.max(0, item.unreported - 1);
      item.pending = item.pending.filter(pending => pending !== id);
    }
    if (item.pending && !item.pending.length) delete item.pending;
  }
  spending[purpose] = item;
  state.spending = spending;
}

/** A run of the job's programs, as the job saw it: from its request to its result. */
export interface AiRunRecord {
  at: string;
  operation: "generate" | "replay";
  seconds: number;
  // "passed", or the kind of its failure (a replay: its outcome)
  result: string;
  origin?: "local" | "judge";
  reuse?: { builds: number; inputs: number };
  // The repair whose program it ran first (a replay: the repair it tested)
  repair?: number;
}

export function recordRun(state: Record<string, unknown>, run: AiRunRecord) {
  state.runs = [...((state.runs as AiRunRecord[]) || []), run].slice(-AI_SESSION_LIMITS.runs);
}

/** A program's change as a unified diff, its start kept (whole lines), and how many lines it adds and removes. */
export interface AiProgramChange {
  text: string;
  added: number;
  removed: number;
  truncated: boolean;
}

/**
 * The unified diff of two sources (3 lines of context). The common start and end are found first; the part between
 * is compared line by line, or shown as replaced as a whole when it's too large to compare (see AI_SESSION_LIMITS).
 */
export function unifiedDiff(before: string, after: string, context = 3): AiProgramChange {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const middleA = a.slice(start, a.length - end);
  const middleB = b.slice(start, b.length - end);
  // The edit script: " " kept, "-" removed, "+" added, with each line's number in the old and new source
  type Op = { op: " " | "-" | "+"; line: string };
  let middle: Op[] = [];
  if (middleA.length * middleB.length <= AI_SESSION_LIMITS.diffCells) {
    // Longest common subsequence of the changed part
    const n = middleA.length;
    const m = middleB.length;
    const lengths = new Int32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        lengths[i * (m + 1) + j] =
          middleA[i] === middleB[j]
            ? lengths[(i + 1) * (m + 1) + j + 1] + 1
            : Math.max(lengths[(i + 1) * (m + 1) + j], lengths[i * (m + 1) + j + 1]);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && middleA[i] === middleB[j]) {
        middle.push({ op: " ", line: middleA[i] });
        i++;
        j++;
      } else if (i < n && (j === m || lengths[(i + 1) * (m + 1) + j] >= lengths[i * (m + 1) + j + 1])) {
        // Removed lines first, as diffs show them
        middle.push({ op: "-", line: middleA[i] });
        i++;
      } else {
        middle.push({ op: "+", line: middleB[j] });
        j++;
      }
    }
  } else
    middle = [
      ...middleA.map(line => ({ op: "-" as const, line })),
      ...middleB.map(line => ({ op: "+" as const, line }))
    ];
  const ops: Op[] = [
    ...a.slice(0, start).map(line => ({ op: " " as const, line })),
    ...middle,
    ...a.slice(a.length - end).map(line => ({ op: " " as const, line }))
  ];
  const added = ops.filter(item => item.op === "+").length;
  const removed = ops.filter(item => item.op === "-").length;
  // Hunks: the changed lines with `context` lines around them
  const lines: string[] = [];
  const changed = ops.map(item => item.op !== " ");
  let index = 0;
  let oldLine = 1;
  let newLine = 1;
  const positions = ops.map(item => {
    const position = { oldLine, newLine };
    if (item.op !== "+") oldLine++;
    if (item.op !== "-") newLine++;
    return position;
  });
  while (index < ops.length) {
    if (!changed[index]) {
      index++;
      continue;
    }
    const from = Math.max(0, index - context);
    let to = index;
    // Extend while the next change is within 2 * context kept lines
    for (let next = index; next < ops.length && next - to <= 2 * context; next++) {
      if (changed[next]) to = next;
    }
    const until = Math.min(ops.length, to + context + 1);
    const hunk = ops.slice(from, until);
    const oldCount = hunk.filter(item => item.op !== "+").length;
    const newCount = hunk.filter(item => item.op !== "-").length;
    lines.push(`@@ -${positions[from].oldLine},${oldCount} +${positions[from].newLine},${newCount} @@`);
    for (const item of hunk) lines.push(`${item.op}${item.line}`);
    index = until;
  }
  let text = "";
  let truncated = false;
  for (const line of lines) {
    if (Buffer.byteLength(text) + Buffer.byteLength(line) + 1 > AI_SESSION_LIMITS.diffBytes) {
      truncated = true;
      break;
    }
    text += `${line}\n`;
  }
  return { text, added, removed, truncated };
}
