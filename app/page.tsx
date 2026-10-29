"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { AskResponse } from "@/lib/schema";

type Doc = { id: string; bytes: number; modified: string; index: "ready" | "missing" | "stale"; chunks: number | null };
type Settings = { chunkSize: number; overlapPercent: number; topK: number; minParagraphLength: number };
type Chunk = { id: string; doc: string; index: number; start: number; end: number; text: string };

async function call<T>(url: string, init?: RequestInit): Promise<T> {
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
const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const kb = (b: number) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1000)} kB`);
const pct = (x: number | null | undefined) => (x == null ? "–" : `${(x * 100).toFixed(1)} %`);

export default function Home() {
  const [tab, setTab] = useState<"ask" | "eval">("ask");
  const [docs, setDocs] = useState<Doc[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await call<{ docs: Doc[]; settings: Settings }>("/api/documents");
      setDocs(data.docs);
      setSettings(data.settings);
      setDraft((d) => d ?? data.settings);
      setSelected((sel) => (sel.length ? sel.filter((s) => data.docs.some((d) => d.id === s)) : data.docs.map((d) => d.id)));
    } catch (e) {
      setNotice({ kind: "error", text: (e as Error).message });
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    const form = new FormData();
    Array.from(files).forEach((f) => form.append("file", f));
    setBusy("Uploading…");
    try {
      const r = await call<{ added: { id: string }[] }>("/api/documents", { method: "POST", body: form });
      setNotice({ kind: "ok", text: `Added ${r.added.map((a) => a.id).join(", ")}. Index it before asking.` });
      setSelected((s) => [...new Set([...s, ...r.added.map((a) => a.id)])]);
      await refresh();
    } catch (e) {
      setNotice({ kind: "error", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function remove(id: string) {
    if (!confirm(`Delete ${id} and its index?`)) return;
    try {
      await call(`/api/documents?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      setNotice({ kind: "ok", text: `Deleted ${id}.` });
      await refresh();
    } catch (e) {
      setNotice({ kind: "error", text: (e as Error).message });
    }
  }

  async function indexSelected() {
    const todo = selected;
    if (!todo.length) return;
    setBusy(`Indexing ${todo.length} document(s)… (the first run downloads the embedding model)`);
    try {
      const r = await call<{ indexed: { doc: string; chunks: number; ms: number }[] }>("/api/index", json("POST", { docs: todo }));
      setNotice({ kind: "ok", text: r.indexed.map((x) => `${x.doc}: ${x.chunks} chunks in ${(x.ms / 1000).toFixed(1)} s`).join(" · ") });
      await refresh();
    } catch (e) {
      setNotice({ kind: "error", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function saveSettings() {
    if (!draft) return;
    try {
      const s = await call<Settings>("/api/settings", json("PUT", draft));
      const reindex = settings && (s.chunkSize !== settings.chunkSize || s.overlapPercent !== settings.overlapPercent || s.minParagraphLength !== settings.minParagraphLength);
      setNotice({ kind: "ok", text: reindex ? "Settings saved. The chunks changed: re-index the documents." : "Settings saved (top-k only: no re-indexing needed)." });
      await refresh();
    } catch (e) {
      setNotice({ kind: "error", text: (e as Error).message });
    }
  }

  const notReady = docs.filter((d) => selected.includes(d.id) && d.index !== "ready");

  return (
    <main className="app">
      <header className="topbar">
        <div>
          <h1>Ask the docs</h1>
          <p className="muted">RAG V1 – naive retrieval-augmented question answering with references</p>
        </div>
        <nav className="tabs">
          <button className={tab === "ask" ? "tab active" : "tab"} onClick={() => setTab("ask")}>
            Ask
          </button>
          <button className={tab === "eval" ? "tab active" : "tab"} onClick={() => setTab("eval")}>
            Evaluation
          </button>
        </nav>
      </header>

      {notice && (
        <p className={notice.kind === "error" ? "notice error" : "notice"} role={notice.kind === "error" ? "alert" : "status"}>
          {notice.text} <button className="link" onClick={() => setNotice(null)}>×</button>
        </p>
      )}
      {busy && <p className="notice busy">{busy}</p>}

      <div className="layout">
        <aside>
          <section className="panel">
            <h2>Documents</h2>
            <label className="upload">
              + Add .md / .txt files
              <input type="file" accept=".md,.txt,text/plain,text/markdown" multiple onChange={(e) => upload(e.target.files)} />
            </label>
            <ul className="doclist">
              {docs.map((d) => (
                <li key={d.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={selected.includes(d.id)}
                      onChange={(e) => setSelected((s) => (e.target.checked ? [...s, d.id] : s.filter((x) => x !== d.id)))}
                    />
                    <span className="docname" title={d.id}>{d.id}</span>
                  </label>
                  <span className="small muted">
                    {kb(d.bytes)} · <span className={`status ${d.index}`}>{d.index === "ready" ? `${d.chunks} chunks` : d.index === "stale" ? "changed, re-index" : "not indexed"}</span>
                  </span>
                  <button className="link danger" onClick={() => remove(d.id)} aria-label={`delete ${d.id}`}>
                    delete
                  </button>
                </li>
              ))}
              {!docs.length && <li className="muted">No document yet.</li>}
            </ul>
            <button onClick={indexSelected} disabled={!selected.length || !!busy}>
              Index selected documents
            </button>
            {notReady.length > 0 && <p className="small warn">{notReady.length} selected document(s) must be indexed with the current settings.</p>}
          </section>

          <section className="panel">
            <h2>Retrieval settings</h2>
            {draft && (
              <div className="settings">
                <label>
                  Chunk size (characters)
                  <input type="number" min={100} max={4000} value={draft.chunkSize} onChange={(e) => setDraft({ ...draft, chunkSize: Number(e.target.value) })} />
                </label>
                <label>
                  Overlap (%)
                  <input type="number" min={0} max={50} value={draft.overlapPercent} onChange={(e) => setDraft({ ...draft, overlapPercent: Number(e.target.value) })} />
                </label>
                <label>
                  Top-k
                  <input type="number" min={1} max={20} value={draft.topK} onChange={(e) => setDraft({ ...draft, topK: Number(e.target.value) })} />
                </label>
                <label>
                  Min paragraph length
                  <input type="number" min={0} max={200} value={draft.minParagraphLength} onChange={(e) => setDraft({ ...draft, minParagraphLength: Number(e.target.value) })} />
                </label>
                <button onClick={saveSettings}>Save settings</button>
                <p className="small muted">
                  Chunk size, overlap and min paragraph change the chunks → re-index. Top-k only changes the search. all-MiniLM-L6-v2 reads at most 256 tokens (~1,000 characters): longer chunks are truncated when embedded.
                </p>
              </div>
            )}
          </section>
        </aside>

        <div>{tab === "ask" ? <AskPanel selected={selected} /> : <EvalPanel settings={settings} />}</div>
      </div>
    </main>
  );
}

function AskPanel({ selected }: { selected: string[] }) {
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AskResponse | null>(null);
  const [open, setOpen] = useState<Chunk | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!question.trim() || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await call<AskResponse>("/api/ask", json("POST", { question, docs: selected })));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function openChunk(id: string) {
    try {
      setOpen(await call<Chunk>(`/api/chunks?id=${encodeURIComponent(id)}`));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <section className="panel">
      <h2>Ask a question</h2>
      <form onSubmit={submit}>
        <textarea rows={3} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="e.g. My machine shows E27, what should I do?" />
        <div className="row">
          <span className="small muted">Asked against: {selected.length ? selected.join(", ") : "no document selected"}</span>
          <button type="submit" disabled={busy || !question.trim()}>
            {busy ? "Searching…" : "Ask"}
          </button>
        </div>
      </form>
      {error && <p role="alert">{error}</p>}

      {result && (
        <div className="result">
          <div className={result.found ? "answer" : "answer notfound"}>
            {!result.found && <strong>Not found in the documents. </strong>}
            <p>{result.answer}</p>
          </div>
          {result.warnings.map((w) => (
            <p key={w} className="small warn">⚠ {w}</p>
          ))}
          <h3>References</h3>
          {result.citations.length ? (
            <ul className="refs">
              {result.citations.map((c) => (
                <li key={c.id}>
                  <button className="ref" onClick={() => openChunk(c.id)}>
                    [{c.rank}] {c.id}
                  </button>
                  <span className="small muted"> similarity {c.score.toFixed(3)} · characters {c.start}–{c.end}</span>
                  <p className="preview">{c.text.slice(0, 220)}…</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">No reference cited.</p>
          )}
          <details>
            <summary>All {result.retrieved.length} retrieved passages (sent to the model)</summary>
            <ol className="retrieved">
              {result.retrieved.map((h) => (
                <li key={h.id}>
                  <button className="link" onClick={() => openChunk(h.id)}>{h.id}</button>{" "}
                  <span className="small muted">score {h.score.toFixed(3)}{result.citations.some((c) => c.id === h.id) ? " · cited" : ""}</span>
                </li>
              ))}
            </ol>
          </details>
          <p className="meta small">
            {result.model} + {result.embeddingModel} · {result.promptVersion} · chunk {result.settings.chunkSize}/{result.settings.overlapPercent}% · top-{result.settings.topK} ·
            retrieval {result.latency.retrieval_ms} ms · generation {result.latency.generation_ms} ms
            {result.usage && ` · tokens in ${result.usage.input_tokens} / out ${result.usage.output_tokens}`}
          </p>
        </div>
      )}

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
    </section>
  );
}

type EvalSummary = {
  ts: string;
  file: string;
  embedding_model: string;
  settings: Settings;
  questions: number;
  answerable: number;
  hit_at_k: number;
  partial_hit_at_k: number;
  mrr: number;
  by_type: Record<string, { n: number; hit: number; partial: number }>;
  unanswerable_avg_top_score: number | null;
  answerable_avg_top_score: number | null;
  duration_ms: number;
};
type EvalRow = { id: string; type: string; question: string; hit: boolean | null; partial_hit: boolean | null; rank: number | null; top_score: number; top_ids: string[] };

function EvalPanel({ settings }: { settings: Settings | null }) {
  const [runs, setRuns] = useState<EvalSummary[]>([]);
  const [last, setLast] = useState<{ summary: EvalSummary; rows: EvalRow[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRuns((await call<{ runs: EvalSummary[] }>("/api/eval")).runs.reverse());
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      setLast(await call("/api/eval", { method: "POST" }));
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <h2>Retrieval baseline</h2>
      <p className="small muted">
        Runs the questions of <code>eval/questions.json</code> through the retrieval step only (no LLM call: free and repeatable) and checks whether the passage holding the answer is in the top-k.
        Current settings: chunk {settings?.chunkSize} · overlap {settings?.overlapPercent}% · top-{settings?.topK}.
      </p>
      <button onClick={run} disabled={busy}>
        {busy ? "Running…" : "Run the baseline"}
      </button>
      {error && <p role="alert">{error}</p>}

      {last && (
        <div className="result">
          <div className="stats">
            <div className="stat"><div className="small muted">hit@{last.summary.settings.topK}</div><div className="statvalue">{pct(last.summary.hit_at_k)}</div></div>
            <div className="stat"><div className="small muted">partial hit</div><div className="statvalue">{pct(last.summary.partial_hit_at_k)}</div></div>
            <div className="stat"><div className="small muted">MRR</div><div className="statvalue">{last.summary.mrr.toFixed(3)}</div></div>
            <div className="stat"><div className="small muted">avg top score (answerable / not)</div><div className="statvalue">{last.summary.answerable_avg_top_score?.toFixed(2)} / {last.summary.unanswerable_avg_top_score?.toFixed(2)}</div></div>
          </div>
          <table>
            <thead>
              <tr><th>Id</th><th>Type</th><th>Question</th><th>Hit</th><th>Rank</th><th>Top score</th></tr>
            </thead>
            <tbody>
              {last.rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.id}</td>
                  <td>{r.type}</td>
                  <td>{r.question}</td>
                  <td className={r.hit === null ? "muted" : r.hit ? "good" : r.partial_hit ? "warn" : "bad"}>{r.hit === null ? "n/a" : r.hit ? "yes" : r.partial_hit ? "partial" : "MISS"}</td>
                  <td>{r.rank ?? "–"}</td>
                  <td>{r.top_score.toFixed(3)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3>All runs</h3>
      <table>
        <thead>
          <tr><th>Date</th><th>Embedding</th><th>Chunk / overlap / k</th><th>hit@k</th><th>partial</th><th>MRR</th><th>By type</th></tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.file}>
              <td className="small">{r.ts.replace("T", " ").slice(0, 19)}</td>
              <td>{r.embedding_model}</td>
              <td>{r.settings.chunkSize} / {r.settings.overlapPercent}% / {r.settings.topK}</td>
              <td>{pct(r.hit_at_k)}</td>
              <td>{pct(r.partial_hit_at_k)}</td>
              <td>{r.mrr.toFixed(3)}</td>
              <td className="small">{Object.entries(r.by_type).map(([t, v]) => `${t} ${v.hit}/${v.n}`).join(" · ")}</td>
            </tr>
          ))}
          {!runs.length && (
            <tr><td colSpan={7} className="muted">No run yet.</td></tr>
          )}
        </tbody>
      </table>
    </section>
  );
}
