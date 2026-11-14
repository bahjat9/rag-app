"use client";

// V4 · Part A: the list of traces (every question, indexing run, graph build and quiz) and the
// optional metrics page. Every number here is computed from the traces (GET /api/metrics).
import { useCallback, useEffect, useState } from "react";
import { call, useChunkModal } from "./common";
import { TraceModal, usd } from "./TraceView";

type Row = {
  id: string;
  kind: string;
  started_at: string;
  duration_ms: number;
  outcome: string;
  summary: string;
  totals: { llm_calls: number; input_tokens: number; output_tokens: number; cost_usd: number };
};
type P = { p50: number | null; p95: number | null; n: number };
type Metrics = {
  traces: number;
  questions: number;
  outcomes: Record<string, number>;
  latency: { request: P; steps: Record<string, P> };
  tokens_per_question: number;
  cost_per_question_usd: number;
  per_document: Record<string, { index_runs: number; index_ms: number; graph_tokens: number; graph_cost_usd: number }>;
  per_day: Record<string, { requests: number; llm_calls: number; tokens: number; cost_usd: number }>;
  prices: { input_per_m: number; output_per_m: number };
  retention_days: number;
};
const KIND: Record<string, string> = { ask: "Question", index: "Prepare documents", graph_build: "Build graph", study: "Quiz / cards" };
const ms = (x: number | null) => (x == null ? "–" : x >= 1000 ? `${(x / 1000).toFixed(2)} s` : `${x} ms`);

export function ActivityTab() {
  const [rows, setRows] = useState<Row[]>([]);
  const [m, setM] = useState<Metrics | null>(null);
  const [kind, setKind] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { openChunk, modal } = useChunkModal();

  const load = useCallback(async () => {
    try {
      setRows((await call<{ traces: Row[] }>(`/api/traces?limit=100${kind ? `&kind=${kind}` : ""}`)).traces);
      setM(await call<Metrics>("/api/metrics"));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [kind]);
  useEffect(() => {
    load();
  }, [load]);

  return (
    <>
      {m && (
        <section className="panel">
          <div className="row">
            <h2>Metrics</h2>
            <button className="link" onClick={load}>refresh</button>
          </div>
          <p className="small muted">
            Computed from the {m.traces} trace(s) kept on this computer (last {m.retention_days} days). Cost at ${m.prices.input_per_m} / ${m.prices.output_per_m} per million input / output tokens (0 on the free tier).
          </p>
          <div className="stats">
            <div><strong>{m.questions}</strong><span>questions</span></div>
            <div><strong>{m.outcomes.answered ?? 0}</strong><span>answered</span></div>
            <div><strong>{m.outcomes.abstained ?? 0}</strong><span>not in the documents</span></div>
            <div><strong>{m.outcomes.invalid ?? 0}</strong><span>invalid AI output</span></div>
            <div><strong>{m.outcomes.error ?? 0}</strong><span>errors</span></div>
            <div><strong>{ms(m.latency.request.p50)}</strong><span>p50 per question</span></div>
            <div><strong>{ms(m.latency.request.p95)}</strong><span>p95 per question</span></div>
            <div><strong>{m.tokens_per_question.toLocaleString()}</strong><span>tokens / question</span></div>
            <div><strong>{usd(m.cost_per_question_usd)}</strong><span>cost / question</span></div>
          </div>
          <details>
            <summary>Latency per step (questions)</summary>
            <table className="small">
              <thead><tr><th>Step</th><th>p50</th><th>p95</th><th>n</th></tr></thead>
              <tbody>
                {Object.entries(m.latency.steps).map(([k, v]) => (
                  <tr key={k}><td>{k}</td><td>{ms(v.p50)}</td><td>{ms(v.p95)}</td><td>{v.n}</td></tr>
                ))}
              </tbody>
            </table>
          </details>
          <details>
            <summary>Per day</summary>
            <table className="small">
              <thead><tr><th>Day</th><th>Requests</th><th>AI calls</th><th>Tokens</th><th>Cost</th></tr></thead>
              <tbody>
                {Object.entries(m.per_day).map(([d, v]) => (
                  <tr key={d}><td>{d}</td><td>{v.requests}</td><td>{v.llm_calls}</td><td>{v.tokens.toLocaleString()}</td><td>{usd(v.cost_usd)}</td></tr>
                ))}
              </tbody>
            </table>
          </details>
          <details>
            <summary>Per indexed document</summary>
            <p className="small muted">Preparing (indexing) a document is local: 0 tokens. Documents only cost tokens when the concept graph is built from them.</p>
            <table className="small">
              <thead><tr><th>Document</th><th>Index runs</th><th>Index time</th><th>Graph tokens</th><th>Graph cost</th></tr></thead>
              <tbody>
                {Object.entries(m.per_document).map(([d, v]) => (
                  <tr key={d}><td>{d}</td><td>{v.index_runs}</td><td>{ms(v.index_ms)}</td><td>{v.graph_tokens.toLocaleString()}</td><td>{usd(v.graph_cost_usd)}</td></tr>
                ))}
              </tbody>
            </table>
          </details>
        </section>
      )}

      <section className="panel">
        <div className="row">
          <h2>Activity</h2>
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">Everything</option>
            <option value="ask">Questions</option>
            <option value="study">Quizzes / cards</option>
            <option value="index">Preparing documents</option>
            <option value="graph_build">Graph builds</option>
          </select>
        </div>
        {error && <p role="alert">{error}</p>}
        <table>
          <thead><tr><th>When (UTC)</th><th>What</th><th>Result</th><th>Time</th><th>Tokens</th><th>Cost</th><th></th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="small">{r.started_at.replace("T", " ").slice(5, 19)}</td>
                <td>
                  {KIND[r.kind] ?? r.kind}
                  <div className="small muted">{r.summary}</div>
                </td>
                <td><span className={`badge ${r.outcome}`}>{r.outcome}</span></td>
                <td className="small">{ms(r.duration_ms)}</td>
                <td className="small">{(r.totals.input_tokens + r.totals.output_tokens).toLocaleString()}</td>
                <td className="small">{usd(r.totals.cost_usd)}</td>
                <td><button className="link" onClick={() => setOpen(r.id)}>open</button></td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={7} className="muted">Nothing yet: ask a question.</td></tr>}
          </tbody>
        </table>
      </section>
      {open && <TraceModal id={open} onClose={() => setOpen(null)} openChunk={openChunk} />}
      {modal}
    </>
  );
}
