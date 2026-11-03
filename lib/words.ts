// Words analytics: which words the corpus contains, how often, and in which chunks.
// Computed on the CHUNKS of the current index (the units retrieval works on), not on the raw files.
// Because chunks overlap, a word inside an overlap is counted in both chunks: "occurrences" are
// occurrences in chunks. Results are cached per (documents, chunk settings).
//
// Tokenisation (deliberately simple, so the numbers are easy to check by hand):
//   lower-case, then sequences of letters/digits, keeping inner "-", "'", "." and "_" joins:
//   "KST-2044" -> "kst-2044", "203.0.113.10" -> "203.0.113.10", "don't" -> "don't", "e-mail" -> "e-mail".
//   Markdown symbols (#, |, *, `) are separators.
import "server-only";
import type { Settings } from "./settings";
import { allChunks, search } from "./store";

const TOKEN_RE = /[\p{L}\p{N}]+(?:[-'’._][\p{L}\p{N}]+)*/gu;

export const STOPWORDS = new Set(
  (
    "a an the and or but if then else of to in on at by for with from into onto about as is are was were be been being am do does did doing have has had having " +
    "i me my we our you your he him his she her it its they them their this that these those there here what which who whom whose when where why how " +
    "not no nor so than too very can could should would will shall may might must also just only own same other such each few more most some any all both " +
    "up down out over under again further once off s t"
  ).split(" "),
);

export function tokenize(text: string): string[] {
  return (text.toLowerCase().replace(/’/g, "'").match(TOKEN_RE) ?? []).map((t) => t.replace(/[.'_-]+$/, ""));
}

type ChunkRef = { id: string; doc: string; text: string };
type WordStats = { word: string; count: number; chunks: Map<string, number> };
type Vocab = { words: Map<string, WordStats>; chunks: Map<string, ChunkRef>; totalTokens: number };

const cache = new Map<string, Vocab>();

async function vocabulary(docs: string[], s: Settings): Promise<Vocab> {
  const key = `${[...docs].sort().join(",")}|${s.chunkSize}_${s.overlapPercent}_${s.minParagraphLength}`;
  const chunks = await allChunks(docs, s); // throws index_missing if a document is not indexed
  const signature = `${key}|${chunks.length}|${chunks[0]?.text.length ?? 0}`;
  const hit = cache.get(signature);
  if (hit) return hit;
  const words = new Map<string, WordStats>();
  const refs = new Map<string, ChunkRef>();
  let totalTokens = 0;
  for (const c of chunks) {
    refs.set(c.id, { id: c.id, doc: c.doc, text: c.text });
    for (const w of tokenize(c.text)) {
      totalTokens++;
      let ws = words.get(w);
      if (!ws) words.set(w, (ws = { word: w, count: 0, chunks: new Map() }));
      ws.count++;
      ws.chunks.set(c.id, (ws.chunks.get(c.id) ?? 0) + 1);
    }
  }
  const v = { words, chunks: refs, totalTokens };
  cache.set(signature, v);
  return v;
}

/** Corpus mode, vocabulary: words sorted by occurrences (or alphabetically), optionally filtered. */
export async function vocabularyList(
  docs: string[],
  s: Settings,
  opts: { filter?: string; hideStopwords?: boolean; sort?: "count" | "chunks" | "alpha"; limit?: number },
) {
  const v = await vocabulary(docs, s);
  const f = opts.filter?.toLowerCase().trim();
  let list = [...v.words.values()].filter((w) => (!f || w.word.includes(f)) && (!opts.hideStopwords || !STOPWORDS.has(w.word)));
  const sort = opts.sort ?? "count";
  list.sort((a, b) =>
    sort === "alpha" ? a.word.localeCompare(b.word) : sort === "chunks" ? b.chunks.size - a.chunks.size || b.count - a.count : b.count - a.count || b.chunks.size - a.chunks.size,
  );
  const total = list.length;
  list = list.slice(0, opts.limit ?? 300);
  return {
    distinct_words: v.words.size,
    total_tokens: v.totalTokens,
    chunks: v.chunks.size,
    matching: total,
    words: list.map((w) => ({ word: w.word, count: w.count, chunks: w.chunks.size, stopword: STOPWORDS.has(w.word) })),
  };
}

function snippet(text: string, word: string): string {
  const i = text.toLowerCase().indexOf(word);
  if (i < 0) return text.slice(0, 160);
  const from = Math.max(0, i - 70);
  return (from > 0 ? "…" : "") + text.slice(from, i + word.length + 90).replace(/\s+/g, " ") + "…";
}

/** Corpus mode, word -> chunks: every chunk containing the word, and how many times. */
export async function wordChunks(docs: string[], s: Settings, word: string) {
  const v = await vocabulary(docs, s);
  const w = tokenize(word)[0] ?? word.toLowerCase().trim();
  const ws = v.words.get(w);
  return {
    word: w,
    count: ws?.count ?? 0,
    chunks: ws
      ? [...ws.chunks.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id, n]) => ({ id, doc: v.chunks.get(id)!.doc, count: n, snippet: snippet(v.chunks.get(id)!.text, w) }))
      : [],
  };
}

/**
 * Question mode: for each word of the question, does it exist in the corpus, in how many chunks,
 * and is it in the chunks that hold the answer (evidence) and in the chunks retrieval returned?
 */
export async function questionWords(docs: string[], s: Settings, question: string, evidence: string[] = []) {
  const v = await vocabulary(docs, s);
  const norm = (x: string) => x.toLowerCase().replace(/\s+/g, " ").trim();
  const evidenceChunks = [...v.chunks.values()].filter((c) => evidence.some((e) => norm(c.text).includes(norm(e)))).map((c) => c.id);
  const retrieved = (await search(question, docs, s)).map((h) => ({ id: h.id, score: Number(h.score.toFixed(4)) }));
  const seen = new Set<string>();
  const words = tokenize(question)
    .filter((w) => !seen.has(w) && seen.add(w))
    .map((w) => {
      const ws = v.words.get(w);
      const inChunks = ws ? [...ws.chunks.keys()] : [];
      return {
        word: w,
        stopword: STOPWORDS.has(w),
        in_corpus: !!ws,
        count: ws?.count ?? 0,
        chunks: inChunks.length,
        share_of_chunks: v.chunks.size ? inChunks.length / v.chunks.size : 0,
        in_evidence_chunks: evidenceChunks.filter((id) => ws?.chunks.has(id)),
        in_retrieved: retrieved.filter((r) => ws?.chunks.has(r.id)).map((r) => r.id),
        top_chunks: inChunks.sort((a, b) => (ws!.chunks.get(b) ?? 0) - (ws!.chunks.get(a) ?? 0)).slice(0, 8),
      };
    });
  return {
    question,
    chunks_in_corpus: v.chunks.size,
    evidence_chunks: evidenceChunks,
    retrieved,
    retrieved_contains_evidence: retrieved.some((r) => evidenceChunks.includes(r.id)),
    words,
    absent: words.filter((w) => !w.in_corpus && !w.stopword).map((w) => w.word), // stop words are reported in the table only
  };
}
