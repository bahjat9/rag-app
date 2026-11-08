"use client";

import { useState } from "react";

export type Retrievers = { dense: boolean; bm25: boolean; graph: boolean };
export type Settings = { chunkSize: number; overlapPercent: number; topK: number; minParagraphLength: number; retrievers?: Retrievers };
export const RETRIEVERS = ["dense", "bm25", "graph"] as const;
export const retrieverTag = (r?: Retrievers) => (r ? RETRIEVERS.filter((x) => r[x]).join("+") : "dense");
export type Source = { retriever: "dense" | "bm25" | "graph"; rank: number; score: number; matched?: string[] };
/** "dense #3 · bm25 #1": which retriever(s) found a chunk, at which rank, before fusion. */
export const sourcesText = (src?: Source[]) =>
  src?.length ? src.map((x) => `${x.retriever} #${x.rank}${x.matched?.length ? ` (${x.matched.slice(0, 4).join(", ")})` : ""}`).join(" · ") : "";
export type Chunk = { id: string; doc: string; index: number; start: number; end: number; text: string };
export type Evidence = { source: string; quote: string };
export type Question = {
  id: string;
  question: string;
  type: string;
  answerable: boolean;
  evidence: Evidence[];
  expected_answer: string;
  notes?: string;
};
export type QuestionSet = { id: string; name: string; file: string; docs: string[]; questions: Question[] };

export async function call<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new Error("Network error: the server is not reachable.");
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${data?.error ?? `Request failed (HTTP ${res.status}).`} (HTTP ${res.status})`);
  return data as T;
}

export const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const pct = (x: number | null | undefined, digits = 1) => (x == null ? "–" : `${(x * 100).toFixed(digits)} %`);

/** Click a chunk id anywhere in the app: the modal shows the exact chunk text. */
export function useChunkModal() {
  const [open, setOpen] = useState<Chunk | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** cfg = "<chunkSize>_<overlap>_<minParagraph>" to open a chunk of another configuration. */
  async function openChunk(id: string, cfg?: string) {
    try {
      setError(null);
      setOpen(await call<Chunk>(`/api/chunks?id=${encodeURIComponent(id)}${cfg ? `&cfg=${cfg}` : ""}`));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const modal = (
    <>
      {error && <p role="alert">{error}</p>}
      {open && (
        <div className="modal" role="dialog" aria-label={`chunk ${open.id}`} onClick={() => setOpen(null)}>
          <div className="modalbox" onClick={(e) => e.stopPropagation()}>
            <div className="row">
              <strong>{open.id}</strong>
              <button className="link" onClick={() => setOpen(null)}>close</button>
            </div>
            <p className="small muted">
              Document {open.doc} · chunk #{open.index} · characters {open.start}–{open.end}
            </p>
            <pre className="chunk">{open.text}</pre>
          </div>
        </div>
      )}
    </>
  );
  return { openChunk, modal };
}

/** Checkboxes to switch the retrievers on and off (at least one stays on). */
export function RetrieverToggles({ value, onChange }: { value: Retrievers; onChange: (r: Retrievers) => void }) {
  return (
    <span className="retrievers">
      {RETRIEVERS.map((x) => (
        <label key={x} className="inline">
          <input
            type="checkbox"
            checked={value[x]}
            onChange={(e) => {
              const next = { ...value, [x]: e.target.checked };
              if (next.dense || next.bm25 || next.graph) onChange(next);
            }}
          />{" "}
          {x === "bm25" ? "BM25" : x}
        </label>
      ))}
    </span>
  );
}

export type GraphPath = {
  seeds: { key: string; name: string; type: string; matched: string }[];
  edges: { source: string; relation: string; target: string; hop: number; chunks: string[] }[];
};

/** The graph explanation: entities found in the question, edges followed, chunks they came from. */
export function GraphPathView({ graph, openChunk }: { graph: { available: boolean | null; path: GraphPath } | null; openChunk: (id: string) => void }) {
  if (!graph) return null;
  if (!graph.available) return <p className="small warn">Graph retriever on, but no graph is built for these documents (Graph tab → Build).</p>;
  const { seeds, edges } = graph.path;
  return (
    <details open className="graphpath">
      <summary>Graph path: {seeds.length} entit{seeds.length === 1 ? "y" : "ies"} found in the question, {edges.length} edge(s) followed</summary>
      {seeds.length ? (
        <p className="small">
          Entities in the question:{" "}
          {seeds.map((x) => (
            <span key={x.key} className="chip static">
              {x.name} <span className="muted">({x.type})</span>
            </span>
          ))}
        </p>
      ) : (
        <p className="small muted">No entity of the graph is named in the question: the graph returned nothing.</p>
      )}
      {edges.length > 0 && (
        <table className="small">
          <thead>
            <tr><th>hop</th><th>edge</th><th>from chunk(s)</th></tr>
          </thead>
          <tbody>
            {edges.slice(0, 25).map((e, i) => (
              <tr key={i}>
                <td>{e.hop}</td>
                <td>
                  {e.source} <span className="muted">—{e.relation}→</span> {e.target}
                </td>
                <td>
                  {e.chunks.map((c) => (
                    <button key={c} className="link" onClick={() => openChunk(c)}>{c}</button>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {edges.length > 25 && <p className="small muted">… {edges.length - 25} more edges.</p>}
    </details>
  );
}

export const cfgOf = (s: Settings) => `${s.chunkSize}_${s.overlapPercent}_${s.minParagraphLength}`;
