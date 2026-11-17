"use client";

// V4 · Part A: "What happened?" — the trace of one request, opened from the answer (or from the
// Activity page). A timeline of the steps, then what each step did: the passages found by each
// retriever, the personal data hidden from the AI provider, the LLM call with its tokens and cost.
import { useEffect, useState } from "react";
import { call } from "./common";

type Span = {
  name: string;
  start_ms: number;
  duration_ms: number;
  status: "ok" | "error";
  attrs: Record<string, unknown>;
  llm?: { model: string; input_tokens: number; output_tokens: number; cost_usd: number; attempts: number };
  error?: string;
};
export type Trace = {
  id: string;
  kind: string;
  started_at: string;
  duration_ms: number;
  outcome: string;
  error?: { code: string; message: string };
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  spans: Span[];
  totals: { llm_calls: number; input_tokens: number; output_tokens: number; cost_usd: number };
};

// plain-language names of the steps, for a non-programmer
const LABEL: Record<string, string> = {
  retrieve: "Search the documents (all methods, combined)",
  "retrieve.dense": "Search by meaning (embeddings)",
  "retrieve.bm25": "Search by exact words (BM25)",
  "retrieve.graph": "Search the concept graph",
  "redact.prompt": "Hide personal data before sending",
  "llm.generate": "Ask the AI model",
  "answer.check": "Check the answer and its references",
  "redact.restore": "Put the personal data back in the answer",
  "index.document": "Prepare one document",
  "index.read": "Read the file",
  "index.chunk": "Cut it into passages",
  "index.embed": "Compute the embeddings (local model)",
  "index.save": "Save the index",
  "index.bm25": "Build the word index (BM25)",
  "graph.extract": "AI extracts concepts from a passage",
  "graph.assemble": "Merge the concepts into the graph",
  "study.pick_chunks": "Pick the passages to study",
  "study.check": "Check every question against its passage",
  "llm.grade": "AI grades the answer against its passage",
};
const PII: Record<string, string> = { EMAIL: "e-mail address(es)", PHONE: "phone number(s)", CARD: "card number(s)", IBAN: "bank account(s)", PERSON: "name(s)" };
const OUTCOME: Record<string, string> = {
  answered: "Answered",
  abstained: "Not found in the documents",
  invalid: "The AI returned an invalid answer",
  error: "Error",
  ok: "Done",
};

export const usd = (x: number) => (x === 0 ? "$0" : x < 0.01 ? `$${x.toFixed(5)}` : `$${x.toFixed(3)}`);
const show = (v: unknown): string => (Array.isArray(v) ? v.map(show).join(", ") : v && typeof v === "object" ? JSON.stringify(v) : String(v));

export function TraceModal({ id, onClose, openChunk }: { id: string; onClose: () => void; openChunk?: (id: string) => void }) {
  const [trace, setTrace] = useState<Trace | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    call<Trace>(`/api/traces?id=${encodeURIComponent(id)}`)
      .then(setTrace)
      .catch((e) => setError((e as Error).message));
  }, [id]);
  return (
    <div className="modal" role="dialog" aria-label="What happened" onClick={onClose}>
      <div className="modalbox wide" onClick={(e) => e.stopPropagation()}>
        <div className="row">
          <strong>What happened</strong>
          <button className="link" onClick={onClose}>close</button>
        </div>
        {error && <p role="alert">{error}</p>}
        {!trace && !error && <p className="muted">Loading…</p>}
        {trace && <TraceBody trace={trace} openChunk={openChunk} />}
      </div>
    </div>
  );
}

export function TraceBody({ trace, openChunk }: { trace: Trace; openChunk?: (id: string) => void }) {
  const total = Math.max(1, trace.duration_ms);
  const t = trace.totals;
  const redacted = trace.spans.find((s) => s.name === "redact.prompt")?.attrs;
  return (
    <div className="trace">
      <p className="small">
        <span className={`badge ${trace.outcome}`}>{OUTCOME[trace.outcome] ?? trace.outcome}</span> · {(trace.duration_ms / 1000).toFixed(2)} s · {t.llm_calls} AI call(s) ·{" "}
        {(t.input_tokens + t.output_tokens).toLocaleString()} tokens ({t.input_tokens.toLocaleString()} in / {t.output_tokens.toLocaleString()} out) · cost {usd(t.cost_usd)}
        <span className="muted"> · {trace.started_at.replace("T", " ").slice(0, 19)} UTC · trace {trace.id.slice(0, 8)}</span>
      </p>
      {trace.error && <p className="small warn">⚠ {trace.error.message}</p>}
      {typeof trace.input.question === "string" && (
        <p className="small">
          <strong>Question (as stored):</strong> {trace.input.question as string}
        </p>
      )}
      {redacted && (
        <p className="small">
          <strong>Privacy:</strong>{" "}
          {redacted.enabled === false
            ? "personal data hiding is switched off."
            : Number(redacted.replaced) > 0
              ? `${redacted.replaced} piece(s) of personal data were replaced before anything was sent to the AI provider (${Object.entries((redacted.kinds ?? {}) as Record<string, number>).map(([k, n]) => `${n} ${PII[k] ?? k}`).join(", ")}).`
              : "no personal data detected in what was sent to the AI provider."}
        </p>
      )}

      <h3>Steps</h3>
      <div className="waterfall">
        {trace.spans.map((s, i) => (
          <details key={i} className={s.status === "error" ? "span error" : "span"}>
            <summary>
              <span className="spanname">{LABEL[s.name] ?? s.name}</span>
              <span className="bar">
                <span style={{ left: `${(s.start_ms / total) * 100}%`, width: `${Math.max(0.6, (s.duration_ms / total) * 100)}%` }} />
              </span>
              <span className="small muted">
                {s.duration_ms} ms{s.llm ? ` · ${s.llm.input_tokens + s.llm.output_tokens} tokens · ${usd(s.llm.cost_usd)}` : ""}
              </span>
            </summary>
            <div className="small spanattrs">
              <div className="muted">{s.name}</div>
              {s.llm && (
                <div>
                  model <code>{s.llm.model}</code> · {s.llm.input_tokens} tokens in, {s.llm.output_tokens} out · {s.llm.attempts} call(s) · {usd(s.llm.cost_usd)}
                </div>
              )}
              {s.error && <div className="warn">{s.error}</div>}
              {Object.entries(s.attrs).map(([k, v]) => (
                <div key={k}>
                  <span className="muted">{k}:</span>{" "}
                  {Array.isArray(v) && openChunk && v.every((x) => typeof x === "string" && /#\d{4}/.test(x)) ? (
                    v.map((x: string) => {
                      const cid = x.match(/^[^\s]+#\d{4}/)?.[0] ?? x;
                      return (
                        <button key={x} className="link" onClick={() => openChunk(cid)} title={x}>
                          {x}
                        </button>
                      );
                    })
                  ) : (
                    show(v)
                  )}
                </div>
              ))}
            </div>
          </details>
        ))}
      </div>
      <p className="small muted">
        A trace stores the steps, chunk ids, sizes, tokens and the question/answer with personal data replaced. It never stores your API key, the documents themselves or the hidden personal data.
      </p>
    </div>
  );
}
