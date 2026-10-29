// Retrieval baseline: for each question of eval/questions.json, run ONLY the retrieval
// step (no LLM call, so it is free and repeatable) and check whether the passage that
// holds the answer is among the top-k chunks.
//
// "The right passage was retrieved" must survive chunk-size changes, so it is defined on
// the TEXT, not on chunk ids: a question has one or more evidence strings copied from the
// document; a retrieved chunk "hits" an evidence string if it contains it (whitespace and
// case normalised). If a chunk boundary cuts the evidence, containing at least one half of
// it counts as a "partial" hit, reported separately.
import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { z } from "zod";
import { embeddingModelName } from "./embeddings";
import { getSettings } from "./settings";
import { search, type Hit } from "./store";

const QuestionSchema = z.object({
  id: z.string(),
  question: z.string(),
  type: z.enum(["simple", "hard", "multi_hop", "unanswerable", "needle"]),
  docs: z.array(z.string()).min(1), // the corpus the question is asked against
  evidence: z.array(z.string()), // empty for unanswerable questions
  match: z.enum(["any", "all"]).default("any"), // multi_hop: all evidence strings needed
  expected_answer: z.string(),
});
export type EvalQuestion = z.infer<typeof QuestionSchema>;

export const QUESTIONS_FILE = path.join(process.cwd(), "eval", "questions.json");
export const RUNS_DIR = path.join(process.cwd(), "eval", "runs");
export const RUNS_LOG = path.join(process.cwd(), "eval", "runs.jsonl");

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

function evidenceRank(evidence: string, hits: Hit[]): { full: number | null; partial: number | null } {
  const e = norm(evidence);
  const half = Math.floor(e.length / 2);
  const halves = [e.slice(0, half), e.slice(half)].filter((h) => h.length >= 20);
  let full: number | null = null;
  let partial: number | null = null;
  for (const h of hits) {
    const t = norm(h.text);
    if (full === null && t.includes(e)) full = h.rank;
    if (partial === null && (t.includes(e) || halves.some((x) => t.includes(x)))) partial = h.rank;
  }
  return { full, partial };
}

export type EvalRow = {
  id: string;
  type: EvalQuestion["type"];
  question: string;
  hit: boolean | null; // null for unanswerable
  partial_hit: boolean | null;
  rank: number | null; // rank of the (first) evidence hit
  top_score: number;
  top_ids: string[];
};

export async function loadQuestions(): Promise<EvalQuestion[]> {
  return z.array(QuestionSchema).parse(JSON.parse(await fs.readFile(QUESTIONS_FILE, "utf8")));
}

export async function runEval() {
  const settings = await getSettings();
  const questions = await loadQuestions();
  const rows: EvalRow[] = [];
  const started = Date.now();
  for (const q of questions) {
    const hits = await search(q.question, q.docs, settings);
    let hit: boolean | null = null;
    let partial: boolean | null = null;
    let rank: number | null = null;
    if (q.evidence.length) {
      const ranks = q.evidence.map((e) => evidenceRank(e, hits));
      const full = ranks.map((r) => r.full);
      const part = ranks.map((r) => r.partial);
      hit = q.match === "all" ? full.every((r) => r !== null) : full.some((r) => r !== null);
      partial = q.match === "all" ? part.every((r) => r !== null) : part.some((r) => r !== null);
      const found = (hit ? full : part).filter((r): r is number => r !== null);
      rank = found.length ? Math.min(...found) : null;
    }
    rows.push({
      id: q.id,
      type: q.type,
      question: q.question,
      hit,
      partial_hit: partial,
      rank,
      top_score: Number((hits[0]?.score ?? 0).toFixed(4)),
      top_ids: hits.map((h) => h.id),
    });
  }
  const answerable = rows.filter((r) => r.hit !== null);
  const byType: Record<string, { n: number; hit: number; partial: number }> = {};
  for (const r of answerable) {
    byType[r.type] ??= { n: 0, hit: 0, partial: 0 };
    byType[r.type].n++;
    if (r.hit) byType[r.type].hit++;
    if (r.partial_hit) byType[r.type].partial++;
  }
  const unanswerable = rows.filter((r) => r.hit === null);
  const ts = new Date().toISOString();
  const summary = {
    ts,
    embedding_model: embeddingModelName(),
    settings,
    questions: rows.length,
    answerable: answerable.length,
    hit_at_k: answerable.length ? answerable.filter((r) => r.hit).length / answerable.length : 0,
    partial_hit_at_k: answerable.length ? answerable.filter((r) => r.partial_hit).length / answerable.length : 0,
    // Mean reciprocal rank: 1 if the evidence is ranked first, 1/2 if second, 0 if missed.
    mrr: answerable.length ? answerable.reduce((s, r) => s + (r.hit && r.rank ? 1 / r.rank : 0), 0) / answerable.length : 0,
    by_type: byType,
    // For questions the corpus cannot answer, a high top score means the system will
    // probably send misleading context: lower is better.
    unanswerable_avg_top_score: unanswerable.length ? unanswerable.reduce((s, r) => s + r.top_score, 0) / unanswerable.length : null,
    answerable_avg_top_score: answerable.length ? answerable.reduce((s, r) => s + r.top_score, 0) / answerable.length : null,
    duration_ms: Date.now() - started,
    file: "",
  };
  const file = `${ts.slice(0, 19).replace(/:/g, "-")}-${summary.embedding_model}-c${settings.chunkSize}-o${settings.overlapPercent}-k${settings.topK}.json`;
  summary.file = file;
  await fs.mkdir(RUNS_DIR, { recursive: true });
  await fs.writeFile(path.join(RUNS_DIR, file), JSON.stringify({ summary, rows }, null, 2), "utf8");
  await fs.appendFile(RUNS_LOG, JSON.stringify(summary) + "\n", "utf8");
  return { summary, rows };
}

export async function listRuns() {
  try {
    return (await fs.readFile(RUNS_LOG, "utf8"))
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
