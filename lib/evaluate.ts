// Retrieval evaluation (V2): run every question of a question set against the app's retrieval,
// for one configuration (chunk size, overlap, min paragraph, top-k, embedding model), and save the
// results to eval/runs/<file>.json (+ one summary line in eval/runs.jsonl).
//
// "The right passage was retrieved" is defined on the TEXT, not on chunk ids, so that runs with
// different chunk sizes stay comparable: each answerable question lists evidence quotes copied
// from the documents ({source, quote}); a quote is found at rank r if the r-th retrieved chunk comes
// from that source and contains the quote (case and whitespace normalised). A chunk holding only one half of a quote (cut by a chunk
// boundary) is a "partial" find, reported separately.
//
// Measured for k = 1, 3, 5, 10, overall and per question type:
//   hit@k    = the question has at least one evidence quote in the top k     (HitRate@k)
//   recall@k = share of the question's evidence quotes found in the top k     (Recall@k)
//              (questions whose quotes are alternatives - evidence_match "any" - count 1 if any is found)
//   MRR      = mean of 1 / rank of the first quote found (0 if not in the top 10)
// Unanswerable questions have no relevant chunk: they are left out of these numbers; their best
// similarity score is kept to compare with answerable questions.
//
// Optionally (answers = true) the run also generates the grounded answer with the configured top-k
// and saves it next to its retrieved chunks, with an empty grade to fill in by hand.
import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { z } from "zod";
import { embeddingModelName } from "./embeddings";
import { AppError } from "./errors";
import { llmModel } from "./llm";
import { withPacing } from "./pace";
import { EVAL_DIR, getSet, loadQuestions, type Question } from "./questions";
import { answerFromHits } from "./rag";
import { getSettings, SettingsSchema, type Settings } from "./settings";
import { ensureIndexes, search, type Hit } from "./store";

export const KS = [1, 3, 5, 10] as const;
const MAX_K = 10;
export const RUNS_DIR = path.join(EVAL_DIR, "runs");
export const RUNS_LOG = path.join(EVAL_DIR, "runs.jsonl");
const FILE_RE = /^[A-Za-z0-9._-]+\.json$/;

export const GRADES = ["correct", "partial", "wrong", "unsupported"] as const;
export type Grade = (typeof GRADES)[number];

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Rank of the first chunk containing the whole quote, and of the first containing at least one half. */
function quoteRanks(source: string, quote: string, hits: Hit[]): { full: number | null; partial: number | null } {
  const q = norm(quote);
  const half = Math.floor(q.length / 2);
  const halves = [q.slice(0, half), q.slice(half)].filter((h) => h.length >= 15);
  let full: number | null = null;
  let partial: number | null = null;
  for (const h of hits) {
    if (h.doc !== source) continue; // relevant = comes from the evidence's source AND contains the quote
    const t = norm(h.text);
    if (full === null && t.includes(q)) full = h.rank;
    if (partial === null && (t.includes(q) || halves.some((x) => t.includes(x)))) partial = h.rank;
  }
  return { full, partial };
}

export type RowAnswer = {
  found: boolean;
  answer: string;
  citations: string[];
  warnings: string[];
  chunks: { id: string; score: number; text: string }[]; // the top-k chunks the answer was generated from
  error?: string;
};

export type EvalRow = {
  id: string;
  type: string;
  question: string;
  answerable: boolean;
  quote_ranks: (number | null)[]; // per evidence quote: rank of the first chunk containing it (top 10)
  quote_partial_ranks: (number | null)[];
  first_rank: number | null;
  hit: Record<string, boolean> | null; // "1", "3", "5", "10"
  recall: Record<string, number> | null;
  partial: Record<string, boolean> | null;
  top_score: number;
  retrieved: { id: string; score: number }[]; // top 10
  answer?: RowAnswer;
  grade?: Grade | null; // filled in by hand
  grade_note?: string;
};

type KStats = { hit: number; recall: number; partial: number };
export type EvalSummary = {
  ts: string;
  file: string;
  set: string;
  set_name: string;
  label: string;
  embedding_model: string;
  settings: Settings;
  docs: string[];
  questions: number;
  answerable: number;
  at: Record<string, KStats>; // k -> rates over answerable questions
  mrr: number;
  by_type: Record<string, { n: number; at: Record<string, { hit: number; recall: number }> }>;
  unanswerable: number;
  answerable_avg_top_score: number | null;
  unanswerable_avg_top_score: number | null;
  answers: boolean;
  llm_model: string | null;
  duration_ms: number;
};

export const EvalOptionsSchema = z
  .object({
    set: z.string(),
    // Optional overrides: the run uses the saved settings, changed by these values only.
    chunkSize: SettingsSchema.shape.chunkSize.optional(),
    overlapPercent: SettingsSchema.shape.overlapPercent.optional(),
    minParagraphLength: SettingsSchema.shape.minParagraphLength.optional(),
    topK: SettingsSchema.shape.topK.optional(),
    answers: z.boolean().default(false),
    label: z.string().max(60).default(""),
  })
  .strict();
export type EvalOptions = z.input<typeof EvalOptionsSchema>;

function rate(rows: EvalRow[], f: (r: EvalRow) => number): number {
  return rows.length ? rows.reduce((s, r) => s + f(r), 0) / rows.length : 0;
}

function scoreRow(q: Question, hits: Hit[]): Omit<EvalRow, "id" | "type" | "question" | "answerable" | "top_score" | "retrieved"> {
  if (!q.answerable || !q.evidence.length) {
    return { quote_ranks: [], quote_partial_ranks: [], first_rank: null, hit: null, recall: null, partial: null };
  }
  const ranks = q.evidence.map((e) => quoteRanks(e.source, e.quote, hits));
  const full = ranks.map((r) => r.full);
  const part = ranks.map((r) => r.partial);
  const found = full.filter((r): r is number => r !== null);
  const hit: Record<string, boolean> = {};
  const recall: Record<string, number> = {};
  const partial: Record<string, boolean> = {};
  for (const k of KS) {
    const inK = full.map((r) => r !== null && r <= k);
    hit[k] = inK.some(Boolean);
    recall[k] = q.evidence_match === "any" ? (hit[k] ? 1 : 0) : inK.filter(Boolean).length / inK.length;
    partial[k] = part.some((r) => r !== null && r <= k);
  }
  return { quote_ranks: full, quote_partial_ranks: part, first_rank: found.length ? Math.min(...found) : null, hit, recall, partial };
}

export async function runEval(input: EvalOptions, onProgress?: (done: number, total: number) => void) {
  const opts = EvalOptionsSchema.parse(input);
  const set = await getSet(opts.set);
  const questions = await loadQuestions(set);
  const saved = await getSettings();
  const settings: Settings = SettingsSchema.parse({
    chunkSize: opts.chunkSize ?? saved.chunkSize,
    overlapPercent: opts.overlapPercent ?? saved.overlapPercent,
    minParagraphLength: opts.minParagraphLength ?? saved.minParagraphLength,
    topK: opts.topK ?? saved.topK,
  });
  const started = Date.now();
  await ensureIndexes(set.docs, settings); // builds the indexes this configuration needs

  const rows: EvalRow[] = [];
  for (const [i, q] of questions.entries()) {
    // Retrieve once with k = 10 (or more), then read the results for k = 1, 3, 5, 10.
    const hits = await search(q.question, set.docs, { ...settings, topK: Math.max(MAX_K, settings.topK) });
    const row: EvalRow = {
      id: q.id,
      type: q.type,
      question: q.question,
      answerable: q.answerable,
      ...scoreRow(q, hits.slice(0, MAX_K)),
      top_score: Number((hits[0]?.score ?? 0).toFixed(4)),
      retrieved: hits.slice(0, MAX_K).map((h) => ({ id: h.id, score: Number(h.score.toFixed(4)) })),
    };
    if (opts.answers) {
      const used = hits.slice(0, settings.topK);
      const chunks = used.map((h) => ({ id: h.id, score: Number(h.score.toFixed(4)), text: h.text }));
      try {
        const a = await withPacing(() => answerFromHits(q.question, used));
        row.answer = { found: a.found, answer: a.answer, citations: a.citations.map((c) => c.id), warnings: a.warnings, chunks };
      } catch (error) {
        // One failed generation (quota, timeout...) must not lose the whole run.
        const e = error instanceof AppError ? error : null;
        row.answer = { found: false, answer: "", citations: [], warnings: [], chunks, error: e?.publicMessage ?? String(error) };
      }
      row.grade = null;
      row.grade_note = "";
    }
    rows.push(row);
    onProgress?.(i + 1, questions.length);
  }

  const answerable = rows.filter((r) => r.hit !== null);
  const unanswerable = rows.filter((r) => r.hit === null);
  const at: Record<string, KStats> = {};
  for (const k of KS) {
    at[k] = {
      hit: rate(answerable, (r) => (r.hit![k] ? 1 : 0)),
      recall: rate(answerable, (r) => r.recall![k]),
      partial: rate(answerable, (r) => (r.partial![k] ? 1 : 0)),
    };
  }
  const by_type: EvalSummary["by_type"] = {};
  for (const t of [...new Set(answerable.map((r) => r.type))]) {
    const rs = answerable.filter((r) => r.type === t);
    by_type[t] = { n: rs.length, at: {} };
    for (const k of KS) by_type[t].at[k] = { hit: rate(rs, (r) => (r.hit![k] ? 1 : 0)), recall: rate(rs, (r) => r.recall![k]) };
  }
  const ts = new Date().toISOString();
  const tag = `${set.id}-c${settings.chunkSize}-o${settings.overlapPercent}-k${settings.topK}${opts.answers ? "-answers" : ""}`;
  const summary: EvalSummary = {
    ts,
    file: `${ts.slice(0, 19).replace(/:/g, "-")}-${tag}.json`,
    set: set.id,
    set_name: set.name,
    label: opts.label,
    embedding_model: embeddingModelName(),
    settings,
    docs: set.docs,
    questions: rows.length,
    answerable: answerable.length,
    at,
    mrr: rate(answerable, (r) => (r.first_rank ? 1 / r.first_rank : 0)),
    by_type,
    unanswerable: unanswerable.length,
    answerable_avg_top_score: answerable.length ? rate(answerable, (r) => r.top_score) : null,
    unanswerable_avg_top_score: unanswerable.length ? rate(unanswerable, (r) => r.top_score) : null,
    answers: opts.answers,
    llm_model: opts.answers ? llmModel() : null,
    duration_ms: Date.now() - started,
  };
  await fs.mkdir(RUNS_DIR, { recursive: true });
  await fs.writeFile(path.join(RUNS_DIR, summary.file), JSON.stringify({ summary, rows }, null, 2) + "\n", "utf8");
  await fs.appendFile(RUNS_LOG, JSON.stringify(summary) + "\n", "utf8");
  return { summary, rows };
}

/** Summaries of every V2 run (V1 lines of runs.jsonl, which have no question set, are skipped). */
export async function listRuns(): Promise<EvalSummary[]> {
  try {
    return (await fs.readFile(RUNS_LOG, "utf8"))
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l))
      .filter((s) => s.set && s.at);
  } catch {
    return [];
  }
}

export async function readRun(file: string): Promise<{ summary: EvalSummary; rows: EvalRow[] }> {
  if (!FILE_RE.test(file)) throw new AppError("invalid_request", "Invalid run file name.");
  try {
    return JSON.parse(await fs.readFile(path.join(RUNS_DIR, file), "utf8"));
  } catch {
    throw new AppError("not_found", `Run ${file} not found.`);
  }
}

/** Save a hand grade in the run file, next to the answer it grades. */
export async function setGrade(file: string, id: string, grade: Grade | null, note: string) {
  const run = await readRun(file);
  const row = run.rows.find((r) => r.id === id);
  if (!row) throw new AppError("not_found", `Question ${id} is not in ${file}.`);
  if (!row.answer) throw new AppError("invalid_request", "This run has no generated answers to grade (run it with answers on).");
  row.grade = grade;
  row.grade_note = note;
  await fs.writeFile(path.join(RUNS_DIR, file), JSON.stringify(run, null, 2) + "\n", "utf8");
  return gradeSummary(run.rows);
}

export function gradeSummary(rows: EvalRow[]) {
  const counts: Record<string, number> = { correct: 0, partial: 0, wrong: 0, unsupported: 0, ungraded: 0 };
  for (const r of rows) if (r.answer) counts[r.grade ?? "ungraded"]++;
  return counts;
}

/** Markdown results table: one line per run, both corpora x configurations, per type. */
export function resultsMarkdown(runs: EvalSummary[]): string {
  const pct = (x: number) => `${(x * 100).toFixed(0)} %`;
  const lines: string[] = [];
  for (const set of [...new Set(runs.map((r) => r.set))]) {
    const rs = runs.filter((r) => r.set === set);
    const types = [...new Set(rs.flatMap((r) => Object.keys(r.by_type)))].sort();
    lines.push(`### ${rs[0].set_name}`, "");
    lines.push(`Hit rate (at least one evidence quote in the top k) and recall (share of the evidence quotes in the top k), ${rs[0].answerable} answerable questions.`, "");
    lines.push("| Configuration | hit@1 | hit@3 | hit@5 | hit@10 | recall@5 | recall@10 | MRR | avg top score answerable / unanswerable |");
    lines.push("|---|---|---|---|---|---|---|---|---|");
    for (const r of rs) {
      const s = r.settings;
      lines.push(
        `| ${r.label ? `**${r.label}** ` : ""}${s.chunkSize} / ${s.overlapPercent} % / min ${s.minParagraphLength} | ${KS.map((k) => pct(r.at[k].hit)).join(" | ")} | ${pct(r.at[5].recall)} | ${pct(r.at[10].recall)} | ${r.mrr.toFixed(3)} | ${r.answerable_avg_top_score?.toFixed(2) ?? "–"} / ${r.unanswerable_avg_top_score?.toFixed(2) ?? "–"} |`,
      );
    }
    lines.push("", "Per question type, hit@1 / hit@3 / hit@5 / hit@10 (n = questions of that type):", "");
    lines.push(`| Configuration | ${types.map((t) => `${t} (n=${rs[0].by_type[t]?.n ?? "?"})`).join(" | ")} |`);
    lines.push(`|---|${types.map(() => "---").join("|")}|`);
    for (const r of rs) {
      const s = r.settings;
      lines.push(
        `| ${r.label ? `**${r.label}** ` : ""}${s.chunkSize} / ${s.overlapPercent} % | ${types
          .map((t) => (r.by_type[t] ? KS.map((k) => Math.round(r.by_type[t].at[k].hit * r.by_type[t].n)).join(" / ") : "–"))
          .join(" | ")} |`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}
