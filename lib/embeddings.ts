// Embedding model: all-MiniLM-L6-v2 (384 dimensions, 22.7M parameters), running
// LOCALLY with transformers.js: downloaded once (~25 MB), then no API call, no quota,
// and no text leaves the machine. The SAME model embeds chunks (indexing) and
// questions (answering): vectors from different models are not comparable.
// EMBEDDINGS=mock gives deterministic hashing vectors for offline tests only.
import "server-only";
import path from "path";
import { AppError } from "./errors";

export const LOCAL_MODEL = "Xenova/all-MiniLM-L6-v2";
export const DIM = 384;

export function embeddingModelName(): string {
  return process.env.EMBEDDINGS === "mock" ? "mock-hash-384" : "all-MiniLM-L6-v2";
}

type Extractor = (texts: string[], opts: { pooling: "mean"; normalize: boolean }) => Promise<{ tolist(): number[][] }>;
let extractorPromise: Promise<Extractor> | null = null;

async function getExtractor(): Promise<Extractor> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const t = await import("@huggingface/transformers");
      t.env.cacheDir = path.join(process.cwd(), ".cache", "models");
      return (await t.pipeline("feature-extraction", LOCAL_MODEL, { dtype: "fp32" })) as unknown as Extractor;
    })().catch((error) => {
      extractorPromise = null; // allow a retry later
      throw new AppError("embedding_failed", undefined, String(error));
    });
  }
  return extractorPromise;
}

function mockEmbed(text: string): number[] {
  // Hashing trick on lower-cased words: lexical only, NOT semantic. Tests only.
  const v = new Array<number>(DIM).fill(0);
  for (const w of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 2166136261;
    for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w.charCodeAt(i), 16777619);
    v[Math.abs(h) % DIM] += 1;
  }
  return normalize(v);
}

export function normalize(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

/** Embed texts into unit-length vectors (so cosine similarity = dot product). */
export async function embed(texts: string[], onProgress?: (done: number, total: number) => void): Promise<number[][]> {
  if (process.env.EMBEDDINGS === "mock") return texts.map(mockEmbed);
  const extractor = await getExtractor();
  const out: number[][] = [];
  const BATCH = 32;
  try {
    for (let i = 0; i < texts.length; i += BATCH) {
      const res = await extractor(texts.slice(i, i + BATCH), { pooling: "mean", normalize: true });
      out.push(...res.tolist());
      onProgress?.(Math.min(i + BATCH, texts.length), texts.length);
    }
  } catch (error) {
    throw new AppError("embedding_failed", undefined, String(error));
  }
  return out;
}

export function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
