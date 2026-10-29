// A minimal local vector store: one JSON file per (document, embedding model, chunk settings)
// in data/index/. Each chunk stores its text, its vector and its metadata (doc, position).
// Query = brute-force nearest-neighbour search with cosine similarity (vectors are
// normalised, so cosine = dot product). Fine for a few thousand chunks; a real vector
// database (ChromaDB, pgvector...) is the V2+ option if the corpus grows.
import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { chunkText } from "./chunker";
import { readDoc, hashText, checkDocId } from "./docs";
import { dot, embed, embeddingModelName } from "./embeddings";
import { AppError } from "./errors";
import { indexKey, type Settings } from "./settings";

export const INDEX_DIR = path.join(process.cwd(), "data", "index");

export type StoredChunk = {
  id: string; // "<doc>#<index>"
  doc: string;
  index: number;
  start: number; // character offsets in the normalised document text
  end: number;
  text: string;
  vector: number[];
};

type IndexFile = {
  doc: string;
  docHash: string;
  model: string;
  settings: Pick<Settings, "chunkSize" | "overlapPercent" | "minParagraphLength">;
  createdAt: string;
  chunks: StoredChunk[];
};

export type Hit = Omit<StoredChunk, "vector"> & { score: number; rank: number };

const cache = new Map<string, IndexFile>();

function indexFile(doc: string, s: Settings): string {
  const model = embeddingModelName().replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(INDEX_DIR, `${doc}__${model}__${indexKey(s)}.json`);
}

async function loadIndex(doc: string, s: Settings): Promise<IndexFile | null> {
  const file = indexFile(doc, s);
  if (cache.has(file)) return cache.get(file)!;
  try {
    const data = JSON.parse(await fs.readFile(file, "utf8")) as IndexFile;
    cache.set(file, data);
    return data;
  } catch {
    return null;
  }
}

/** Is the document indexed with these settings, and is the index up to date with the file? */
export async function indexStatus(doc: string, s: Settings): Promise<"ready" | "missing" | "stale"> {
  const text = await readDoc(doc); // throws 404 if the document does not exist
  const idx = await loadIndex(doc, s);
  if (!idx) return "missing";
  return idx.docHash === hashText(text) ? "ready" : "stale";
}

/** Phase 1 - indexing: document -> chunks -> embeddings -> stored. */
export async function buildIndex(doc: string, s: Settings): Promise<{ chunks: number; ms: number }> {
  checkDocId(doc);
  const started = Date.now();
  const text = await readDoc(doc);
  const { chunks } = chunkText(text, s);
  const vectors = await embed(chunks.map((c) => c.text));
  const data: IndexFile = {
    doc,
    docHash: hashText(text),
    model: embeddingModelName(),
    settings: { chunkSize: s.chunkSize, overlapPercent: s.overlapPercent, minParagraphLength: s.minParagraphLength },
    createdAt: new Date().toISOString(),
    chunks: chunks.map((c, i) => ({
      id: `${doc}#${String(c.index).padStart(4, "0")}`,
      doc,
      index: c.index,
      start: c.start,
      end: c.end,
      text: c.text,
      vector: vectors[i].map((x) => Math.round(x * 1e6) / 1e6),
    })),
  };
  await fs.mkdir(INDEX_DIR, { recursive: true });
  const file = indexFile(doc, s);
  await fs.writeFile(file, JSON.stringify(data), "utf8");
  cache.set(file, data);
  return { chunks: data.chunks.length, ms: Date.now() - started };
}

/** Remove every index built for a document (all settings), e.g. when it is deleted. */
export async function dropIndexes(doc: string): Promise<void> {
  try {
    for (const f of await fs.readdir(INDEX_DIR)) {
      if (f.startsWith(`${doc}__`)) {
        await fs.unlink(path.join(INDEX_DIR, f));
        cache.delete(path.join(INDEX_DIR, f));
      }
    }
  } catch {
    /* no index dir yet */
  }
}

/** Phase 2 - retrieval: embed the question with the same model, return the top-k chunks. */
export async function search(question: string, docs: string[], s: Settings): Promise<Hit[]> {
  const indexes: IndexFile[] = [];
  const missing: string[] = [];
  for (const d of docs) {
    const status = await indexStatus(d, s);
    if (status !== "ready") missing.push(d);
    else indexes.push((await loadIndex(d, s))!);
  }
  if (missing.length) {
    throw new AppError("index_missing", `Not indexed with the current settings: ${missing.join(", ")}. Click "Index selected documents".`);
  }
  const [q] = await embed([question]);
  const scored: Hit[] = [];
  for (const idx of indexes) {
    for (const c of idx.chunks) {
      const { vector, ...rest } = c;
      scored.push({ ...rest, score: dot(q, vector), rank: 0 });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, s.topK).map((h, i) => ({ ...h, rank: i + 1 }));
}

export async function getChunk(id: string, s: Settings): Promise<Omit<StoredChunk, "vector"> | null> {
  const doc = id.split("#")[0];
  checkDocId(doc);
  const idx = await loadIndex(doc, s);
  const c = idx?.chunks.find((x) => x.id === id);
  if (!c) return null;
  const { vector, ...rest } = c; // eslint-disable-line @typescript-eslint/no-unused-vars
  return rest;
}

export async function chunkCount(doc: string, s: Settings): Promise<number | null> {
  const idx = await loadIndex(doc, s);
  return idx ? idx.chunks.length : null;
}
