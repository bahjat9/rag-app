// Question sets, one JSONL file per corpus, in the Kestrel format:
//   {"id", "question", "type", "answerable", "evidence": [{"source", "quote"}], "expected_answer", "notes"}
// eval/sets.json says which documents each set is asked against.
import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { z } from "zod";
import { AppError } from "./errors";

export const EVAL_DIR = path.join(process.cwd(), "eval");

export const QuestionSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  type: z.string().min(1), // exact_identifier, split_answer, vocabulary, versions, two_hop, not_in_corpus, ...
  answerable: z.boolean(),
  evidence: z.array(z.object({ source: z.string(), quote: z.string().min(1) })),
  expected_answer: z.string(),
  notes: z.string().optional(),
  // Optional, our own sets only: "any" when the quotes are alternatives (the same fact written in
  // two places), "all" (default) when each quote is a different part of the answer.
  evidence_match: z.enum(["all", "any"]).optional(),
});
export type Question = z.infer<typeof QuestionSchema>;

export const QuestionSetSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string(),
  file: z.string(), // relative to eval/
  docs: z.array(z.string()).min(1), // the corpus the questions are asked against
});
export type QuestionSet = z.infer<typeof QuestionSetSchema>;

export async function listSets(): Promise<QuestionSet[]> {
  const raw = JSON.parse(await fs.readFile(path.join(EVAL_DIR, "sets.json"), "utf8"));
  return z.array(QuestionSetSchema).parse(raw);
}

export async function getSet(id: string): Promise<QuestionSet> {
  const set = (await listSets()).find((s) => s.id === id);
  if (!set) throw new AppError("not_found", `Unknown question set "${id}".`);
  return set;
}

/** Parse a JSONL question file; a bad line is reported with its line number. */
export async function loadQuestions(set: QuestionSet): Promise<Question[]> {
  const text = await fs.readFile(path.join(EVAL_DIR, set.file), "utf8");
  const out: Question[] = [];
  text.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    let parsed;
    try {
      parsed = QuestionSchema.safeParse(JSON.parse(line));
    } catch {
      throw new AppError("invalid_request", `${set.file} line ${i + 1}: not valid JSON.`);
    }
    if (!parsed.success) throw new AppError("invalid_request", `${set.file} line ${i + 1}: ${parsed.error.issues[0]?.message}`);
    out.push(parsed.data);
  });
  const ids = new Set<string>();
  for (const q of out) {
    if (ids.has(q.id)) throw new AppError("invalid_request", `${set.file}: duplicate id ${q.id}.`);
    ids.add(q.id);
  }
  return out;
}
