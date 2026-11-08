// V3: hybrid retrieval. Each retriever that is switched on returns its own ranked list of chunks;
// the lists are fused with Reciprocal Rank Fusion (RRF):
//   score(chunk) = sum over the retrievers that found it of 1 / (RRF_K + rank)
// RRF only uses ranks, so the scores of the retrievers (cosine, BM25, graph weight) never have to be
// put on the same scale. RRF_K = 60 is the value of the original paper (Cormack et al., 2009).
// Every fused hit keeps where it came from: which retriever found it and at which rank.
import "server-only";
import { bm25Search } from "./bm25";
import { graphSearch, type GraphPath } from "./graph";
import { allChunks, search, type Hit } from "./store";
import type { Retrievers, Settings } from "./settings";

export const RRF_K = 60;
/** How deep each retriever's list goes before fusion. */
export const PER_RETRIEVER = 20;

export type RetrieverName = "dense" | "bm25" | "graph";
export type Source = { retriever: RetrieverName; rank: number; score: number; matched?: string[] };
export type FusedHit = Hit & { sources: Source[] };

export type Retrieval = {
  hits: FusedHit[]; // fused, top-k
  lists: Record<RetrieverName, { id: string; rank: number }[] | null>; // each retriever's own list (null = off)
  path: GraphPath | null; // graph explanation (null = graph off)
  graph_available: boolean | null;
  ms: Record<RetrieverName, number | null> & { total: number };
};

export function retrieverTag(r: Retrievers): string {
  return (["dense", "bm25", "graph"] as const).filter((x) => r[x]).join("+");
}

export function parseRetrievers(text: string): Retrievers {
  const parts = new Set(text.split(/[,+ ]+/).map((x) => x.trim().toLowerCase()).filter(Boolean));
  for (const p of parts) if (!["dense", "bm25", "graph"].includes(p)) throw new Error(`Unknown retriever "${p}" (use dense, bm25, graph).`);
  return { dense: parts.has("dense"), bm25: parts.has("bm25"), graph: parts.has("graph") };
}

export async function retrieve(question: string, docs: string[], s: Settings, topK = s.topK): Promise<Retrieval> {
  const r = s.retrievers;
  const t0 = Date.now();
  const chunks = await allChunks(docs, s); // throws if a document is not indexed
  const byId = new Map(chunks.map((c) => [c.id, c]));
  const ms: Retrieval["ms"] = { dense: null, bm25: null, graph: null, total: 0 };
  const lists: Retrieval["lists"] = { dense: null, bm25: null, graph: null };
  const found = new Map<string, Source[]>();
  const note = (id: string, src: Source) => {
    if (!byId.has(id)) return;
    found.set(id, [...(found.get(id) ?? []), src]);
  };

  if (r.dense) {
    const t = Date.now();
    const hits = await search(question, docs, { ...s, topK: PER_RETRIEVER });
    ms.dense = Date.now() - t;
    lists.dense = hits.map((h) => ({ id: h.id, rank: h.rank }));
    hits.forEach((h) => note(h.id, { retriever: "dense", rank: h.rank, score: h.score }));
  }
  if (r.bm25) {
    const t = Date.now();
    const chunksOf = async (d: string) => chunks.filter((c) => c.doc === d).map((c) => ({ id: c.id, text: c.text }));
    const hits = await bm25Search(question, docs, s, PER_RETRIEVER, chunksOf);
    ms.bm25 = Date.now() - t;
    lists.bm25 = hits.map((h) => ({ id: h.id, rank: h.rank }));
    hits.forEach((h) => note(h.id, { retriever: "bm25", rank: h.rank, score: h.score, matched: h.matched }));
  }
  let path: GraphPath | null = null;
  let graph_available: boolean | null = null;
  if (r.graph) {
    const t = Date.now();
    const g = await graphSearch(question, docs, s, PER_RETRIEVER);
    ms.graph = Date.now() - t;
    path = g.path;
    graph_available = g.available;
    lists.graph = g.hits.map((h) => ({ id: h.id, rank: h.rank }));
    g.hits.forEach((h) => note(h.id, { retriever: "graph", rank: h.rank, score: h.score }));
  }

  const fused = [...found.entries()]
    .map(([id, sources]) => ({ id, sources, rrf: sources.reduce((a, x) => a + 1 / (RRF_K + x.rank), 0) }))
    // ties: best single rank first, then id, so the order is deterministic
    .sort((a, b) => b.rrf - a.rrf || Math.min(...a.sources.map((x) => x.rank)) - Math.min(...b.sources.map((x) => x.rank)) || a.id.localeCompare(b.id))
    .slice(0, topK);
  const hits: FusedHit[] = fused.map((f, i) => ({ ...byId.get(f.id)!, score: Math.round(f.rrf * 1e5) / 1e5, rank: i + 1, sources: f.sources }));
  ms.total = Date.now() - t0;
  return { hits, lists, path, graph_available, ms };
}
