"use client";

import { useState } from "react";

export type Settings = { chunkSize: number; overlapPercent: number; topK: number; minParagraphLength: number };
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

export const cfgOf = (s: Settings) => `${s.chunkSize}_${s.overlapPercent}_${s.minParagraphLength}`;
