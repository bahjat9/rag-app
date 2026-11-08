// Retriever 2 (V3): BM25 keyword search.
//
// Index: one JSON file per (document, chunk settings) in data/index/, next to the dense index:
//   data/index/<doc>__bm25__<chunkSize>_<overlap>_<minParagraph>.json
// It holds, for every chunk, its length in tokens and its term frequencies. It is built at the same
// time as the dense index (same chunks, same ids), from the same chunk texts, so both retrievers
// always speak about the same chunks. Updates: when a document or a chunk setting changes, the dense
// index is rebuilt and so is this file (same docHash check). Document frequencies (IDF) are computed
// at query time over the documents the question is asked against, so adding or removing a document
// never leaves stale statistics.
//
// Tokenisation: the Words tab tokenizer (lower-case, letters/digits, KST-2044 and 203.0.113.10 kept
// whole), stop words removed, and for a hyphenated token its parts are added too
// ("second-factor" -> "second-factor", "second", "factor"), so "KST-2044" matches "kst-2044" exactly
// and "two-factor" still matches "factor".
import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { hashText, readDoc } from "./docs";
import { indexKey, type Settings } from "./settings";
import { STOPWORDS, tokenize } from "./tokenize";

export const BM25_K1 = 1.2;
export const BM25_B = 0.75;
const INDEX_DIR = path.join(process.cwd(), "data", "index");
const VERSION = 1;

type Bm25Chunk = { id: string; len: number; tf: Record<string, number> };
type Bm25File = { version: number; doc: string; docHash: string; key: string; chunks: Bm25Chunk[] };

const cache = new Map<string, Bm25File>();

export function bm25Tokens(text: string): string[] {
  const out: string[] = [];
  for (const t of tokenize(text)) {
    if (STOPWORDS.has(t)) continue;
    out.push(t);
    if (t.includes("-")) for (const part of t.split("-")) if (part && !STOPWORDS.has(part)) out.push(part);
  }
  return out;
}

function fileFor(doc: string, s: Settings) {
  return path.join(INDEX_DIR, `${doc}__bm25__${indexKey(s)}.json`);
}

/** Build (and save) the BM25 index of a document from its chunks. */
export async function buildBm25(doc: string, s: Settings, chunks: { id: string; text: string }[]): Promise<void> {
  const data: Bm25File = {
    version: VERSION,
    doc,
    docHash: hashText(await readDoc(doc)),
    key: indexKey(s),
    chunks: chunks.map((c) => {
      const tf: Record<string, number> = {};
      const toks = bm25Tokens(c.text);
      for (const t of toks) tf[t] = (tf[t] ?? 0) + 1;
      return { id: c.id, len: toks.length, tf };
    }),
  };
  await fs.mkdir(INDEX_DIR, { recursive: true });
  await fs.writeFile(fileFor(doc, s), JSON.stringify(data), "utf8");
  cache.set(fileFor(doc, s), data);
}

async function loadBm25(doc: string, s: Settings, chunks: () => Promise<{ id: string; text: string }[]>): Promise<Bm25File> {
  const file = fileFor(doc, s);
  const current = hashText(await readDoc(doc));
  let data = cache.get(file);
  if (!data) {
    try {
      data = JSON.parse(await fs.readFile(file, "utf8")) as Bm25File;
    } catch {
      data = undefined;
    }
  }
  if (!data || data.docHash !== current || data.version !== VERSION) {
    await buildBm25(doc, s, await chunks()); // missing or stale: rebuilt from the dense index's chunks
    data = cache.get(file)!;
  }
  cache.set(file, data);
  return data;
}

export type Bm25Hit = { id: string; score: number; rank: number; matched: string[] };

/** BM25 over the chunks of the given documents. */
export async function bm25Search(
  question: string,
  docs: string[],
  s: Settings,
  k: number,
  chunksOf: (doc: string) => Promise<{ id: string; text: string }[]>,
): Promise<Bm25Hit[]> {
  const files = await Promise.all(docs.map((d) => loadBm25(d, s, () => chunksOf(d))));
  const all = files.flatMap((f) => f.chunks);
  const N = all.length;
  if (!N) return [];
  const avgdl = all.reduce((a, c) => a + c.len, 0) / N;
  const qTerms = [...new Set(bm25Tokens(question))];
  const df = new Map<string, number>();
  for (const t of qTerms) df.set(t, all.reduce((a, c) => a + (c.tf[t] ? 1 : 0), 0));
  const scored: Bm25Hit[] = [];
  for (const c of all) {
    let score = 0;
    const matched: string[] = [];
    for (const t of qTerms) {
      const f = c.tf[t];
      if (!f) continue;
      const n = df.get(t)!;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * ((f * (BM25_K1 + 1)) / (f + BM25_K1 * (1 - BM25_B + (BM25_B * c.len) / avgdl)));
      matched.push(t);
    }
    if (score > 0) scored.push({ id: c.id, score, rank: 0, matched });
  }
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return scored.slice(0, k).map((h, i) => ({ ...h, rank: i + 1 }));
}
