"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { AskResponse } from "@/lib/schema";
import { ActivityTab } from "./ui/ActivityTab";
import { call, GraphPathView, json, RetrieverToggles, sourcesText, traceIdOf, useChunkModal, type QuestionSet, type Settings } from "./ui/common";
import { EvalTab } from "./ui/EvalTab";
import { StudyTab } from "./ui/StudyTab";
import { TraceModal } from "./ui/TraceView";
import { GraphTab } from "./ui/GraphTab";
import { WordsTab } from "./ui/WordsTab";

type Doc = { id: string; bytes: number; modified: string; index: "ready" | "missing" | "stale"; chunks: number | null };
const kb = (b: number) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1000)} kB`);

export default function Home() {
  const [tab, setTab] = useState<"ask" | "study" | "activity" | "eval" | "words" | "graph">("ask");
  const [dev, setDev] = useState(false); // developer tools: evaluation, words, graph, retrieval settings
  const [sets, setSets] = useState<QuestionSet[]>([]);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string; traceId?: string } | null>(null);
  const [trace, setTrace] = useState<string | null>(null);

  useEffect(() => {
    try {
      setDev(localStorage.getItem("devtools") === "1");
    } catch {
      /* storage unavailable: default view */
    }
  }, []);
  function toggleDev(on: boolean) {
    setDev(on);
    if (!on && ["eval", "words", "graph"].includes(tab)) setTab("ask");
    try {
      localStorage.setItem("devtools", on ? "1" : "0");
    } catch {
      /* ignore */
    }
  }

  const refresh = useCallback(async () => {
    try {
      const data = await call<{ docs: Doc[]; settings: Settings }>("/api/documents");
      setDocs(data.docs);
      setSettings(data.settings);
      setDraft((d) => d ?? data.settings);
      setSelected((sel) => (sel.length ? sel.filter((s) => data.docs.some((d) => d.id === s)) : data.docs.filter((d) => d.index === "ready").map((d) => d.id)));
    } catch (e) {
      setNotice({ kind: "error", text: (e as Error).message });
    }
  }, []);

  useEffect(() => {
    refresh();
    call<{ sets: QuestionSet[] }>("/api/sets")
      .then((r) => setSets(r.sets))
      .catch(() => setSets([]));
  }, [refresh]);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    const form = new FormData();
    Array.from(files).forEach((f) => form.append("file", f));
    setBusy("Adding the file…");
    try {
      const r = await call<{ added: { id: string }[] }>("/api/documents", { method: "POST", body: form });
      setNotice({ kind: "ok", text: `Added ${r.added.map((a) => a.id).join(", ")}. Click "Prepare" before asking questions about it.` });
      setSelected((s) => [...new Set([...s, ...r.added.map((a) => a.id)])]);
      await refresh();
    } catch (e) {
      setNotice({ kind: "error", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function remove(id: string) {
    if (!confirm(`Remove ${id} from the app? The file and its index are deleted.`)) return;
    try {
      await call(`/api/documents?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      setNotice({ kind: "ok", text: `Removed ${id}.` });
      setSelected((s) => s.filter((x) => x !== id));
      await refresh();
    } catch (e) {
      setNotice({ kind: "error", text: (e as Error).message });
    }
  }

  async function prepare(all = false) {
    const todo = all ? selected : selected.filter((id) => docs.find((d) => d.id === id)?.index !== "ready");
    if (!todo.length) return;
    const big = docs.filter((d) => todo.includes(d.id)).reduce((a, d) => a + d.bytes, 0) > 300_000;
    setBusy(`Preparing ${todo.length} document(s)…${big ? " A long book takes about a minute." : ""} The first time, the app also downloads its language model (~25 MB).`);
    try {
      const r = await call<{ indexed: { doc: string; chunks: number; ms: number }[]; traceId: string }>("/api/index", json("POST", { docs: todo }));
      setNotice({ kind: "ok", text: `Ready: ${r.indexed.map((x) => `${x.doc} (${x.chunks} passages, ${(x.ms / 1000).toFixed(1)} s)`).join(" · ")}`, traceId: r.traceId });
      await refresh();
    } catch (e) {
      setNotice({ kind: "error", text: (e as Error).message, traceId: traceIdOf(e) });
    } finally {
      setBusy(null);
    }
  }

  async function saveSettings(next: Settings, message?: string) {
    try {
      const s = await call<Settings>("/api/settings", json("PUT", next));
      const reindex = settings && (s.chunkSize !== settings.chunkSize || s.overlapPercent !== settings.overlapPercent || s.minParagraphLength !== settings.minParagraphLength);
      setNotice({ kind: "ok", text: message ?? (reindex ? "Settings saved. The passages changed: prepare the documents again (and rebuild the graph)." : "Settings saved.") });
      setDraft(s);
      await refresh();
    } catch (e) {
      setNotice({ kind: "error", text: (e as Error).message });
    }
  }

  const notReady = docs.filter((d) => selected.includes(d.id) && d.index !== "ready").map((d) => d.id);
  const tabs: [typeof tab, string][] = [
    ["ask", "Ask"],
    ["study", "Study"],
    ["activity", "Activity"],
    ...(dev ? ([["eval", "Evaluation"], ["words", "Words"], ["graph", "Graph"]] as [typeof tab, string][]) : []),
  ];

  return (
    <main className="app">
      <header className="topbar">
        <div>
          <h1>Ask the docs</h1>
          <p className="muted">Ask questions about your documents. Every answer shows the passages it comes from.</p>
        </div>
        <nav className="tabs">
          {tabs.map(([k, label]) => (
            <button key={k} className={tab === k ? "tab active" : "tab"} onClick={() => setTab(k)}>
              {label}
            </button>
          ))}
          <label className="inline small devtoggle" title="Evaluation, words analytics, concept graph and retrieval settings">
            <input type="checkbox" checked={dev} onChange={(e) => toggleDev(e.target.checked)} /> Developer tools
          </label>
        </nav>
      </header>

      {notice && (
        <p className={notice.kind === "error" ? "notice error" : "notice"} role={notice.kind === "error" ? "alert" : "status"}>
          {notice.text} {notice.traceId && <button className="link" onClick={() => setTrace(notice.traceId!)}>{notice.kind === "error" ? "What happened?" : "Details"}</button>}{" "}
          <button className="link" onClick={() => setNotice(null)} aria-label="close">×</button>
        </p>
      )}
      {busy && <p className="notice busy">{busy}</p>}

      <div className="layout">
        <aside>
          <section className="panel">
            <h2>Your documents</h2>
            {sets.length > 0 && (
              <p className="small">
                Quick select:{" "}
                {sets.map((st) => (
                  <button key={st.id} className="chip" onClick={() => setSelected(st.docs.filter((d) => docs.some((x) => x.id === d)))}>
                    {st.name}
                  </button>
                ))}
              </p>
            )}
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
                    {kb(d.bytes)} · <span className={`status ${d.index}`}>{d.index === "ready" ? "ready" : d.index === "stale" ? "changed: prepare again" : "not prepared"}</span>
                  </span>
                  <button className="link danger" onClick={() => remove(d.id)} aria-label={`remove ${d.id}`} title="remove this document">
                    ×
                  </button>
                </li>
              ))}
              {!docs.length && <li className="muted">No document yet: add a .md or .txt file.</li>}
            </ul>
            {notReady.length > 0 ? (
              <button onClick={() => prepare()} disabled={!!busy}>
                Prepare {notReady.length} document(s)
              </button>
            ) : (
              <p className="small muted">{selected.length ? `${selected.length} document(s) selected, ready to use.` : "Select the documents to ask about."}</p>
            )}
            {dev && selected.length > 0 && (
              <button className="link small" onClick={() => prepare(true)} disabled={!!busy}>
                re-index all selected
              </button>
            )}
            <label className="upload">
              + Add .md / .txt files
              <input type="file" accept=".md,.txt,text/plain,text/markdown" multiple onChange={(e) => upload(e.target.files)} />
            </label>
          </section>

          {settings && (
            <section className="panel">
              <h2>Privacy</h2>
              <label className="inline small">
                <input
                  type="checkbox"
                  checked={settings.redactPII !== false}
                  onChange={(e) =>
                    saveSettings(
                      { ...settings, redactPII: e.target.checked },
                      e.target.checked ? "Personal data is hidden from the AI provider again." : "Personal data hiding is off: e-mails, phone numbers and names are sent to the AI provider as they are.",
                    )
                  }
                />{" "}
                Hide personal data from the AI provider (recommended)
              </label>
              <p className="small muted">
                E-mail addresses, phone numbers, card and bank numbers and known names are replaced by placeholders before your question and the passages are sent to the AI model, then put back in the answer on your computer.
              </p>
            </section>
          )}

          {dev && (
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
                  <div className="field">
                    Retrievers (fused with RRF)
                    <RetrieverToggles value={draft.retrievers ?? { dense: true, bm25: true, graph: false }} onChange={(r) => setDraft({ ...draft, retrievers: r })} />
                  </div>
                  <button onClick={() => saveSettings({ ...draft, redactPII: settings?.redactPII ?? true })}>Save settings</button>
                  <p className="small muted">
                    Chunk size, overlap and min paragraph change the passages → prepare again. Top-k and retrievers only change the search. all-MiniLM-L6-v2 reads at most 256 tokens (~1,000 characters).
                  </p>
                </div>
              )}
            </section>
          )}
        </aside>

        <div>
          {tab === "ask" && <AskPanel selected={selected} notReady={notReady} dev={dev} hasDocs={docs.length > 0} />}
          {tab === "study" && <StudyTab selected={selected} notReady={notReady} />}
          {tab === "activity" && <ActivityTab />}
          {tab === "eval" && dev && <EvalTab settings={settings} sets={sets} />}
          {tab === "words" && dev && <WordsTab sets={sets} selected={selected} />}
          {tab === "graph" && dev && <GraphTab sets={sets} settings={settings} />}
        </div>
      </div>
      {trace && <TraceModal id={trace} onClose={() => setTrace(null)} />}
    </main>
  );
}

const STEPS = ["Searching your documents…", "Reading the best passages…", "Writing the answer…"];

function AskPanel({ selected, notReady, dev, hasDocs }: { selected: string[]; notReady: string[]; dev: boolean; hasDocs: boolean }) {
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(0);
  const [error, setError] = useState<{ text: string; traceId?: string } | null>(null);
  const [result, setResult] = useState<(AskResponse & { asked: string }) | null>(null);
  const [trace, setTrace] = useState<string | null>(null);
  const { openChunk, modal } = useChunkModal();

  useEffect(() => {
    if (!busy) return;
    setStep(0);
    const t = setInterval(() => setStep((x) => Math.min(STEPS.length - 1, x + 1)), 1500);
    return () => clearInterval(t);
  }, [busy]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!question.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      setResult({ ...(await call<AskResponse>("/api/ask", json("POST", { question, docs: selected }))), asked: question.trim() });
    } catch (err) {
      setResult(null);
      setError({ text: (err as Error).message, traceId: traceIdOf(err) });
    } finally {
      setBusy(false);
    }
  }

  const blocked = !hasDocs
    ? "Add a document first (left panel)."
    : !selected.length
      ? "Select the documents to ask about (left panel)."
      : notReady.length
        ? `Prepare the selected documents first: ${notReady.join(", ")}.`
        : null;
  const redacted = result ? Object.values(result.redactions).reduce((a, b) => a + b, 0) : 0;

  return (
    <section className="panel">
      <h2>Ask a question</h2>
      {blocked && (
        <ol className="small onboarding">
          <li className={hasDocs ? "done" : ""}>Add your documents (.md or .txt) on the left, or tick the ones already there.</li>
          <li className={hasDocs && selected.length && !notReady.length ? "done" : ""}>Click <strong>Prepare</strong> once per document (it is cut into passages and indexed on your computer).</li>
          <li>Ask your question below. The answer links to the passages it uses.</li>
        </ol>
      )}
      <form onSubmit={submit}>
        <textarea
          rows={3}
          value={question}
          maxLength={500}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              (e.currentTarget.form as HTMLFormElement).requestSubmit();
            }
          }}
          placeholder="e.g. What does error KST-2044 mean and how do I fix it?"
        />
        <div className="row">
          <span className="small muted">{selected.length ? `Asked against ${selected.length} document(s)` : "No document selected"} · Enter to send</span>
          <button type="submit" disabled={busy || !question.trim() || !!blocked}>
            {busy ? "Working…" : "Ask"}
          </button>
        </div>
      </form>
      {blocked && <p className="small warn">{blocked}</p>}
      {busy && <p className="notice busy small">{STEPS[step]}</p>}
      {error && (
        <p role="alert" className="notice error">
          {error.text} {error.traceId && <button className="link" onClick={() => setTrace(error.traceId!)}>What happened?</button>}
        </p>
      )}

      {result && !busy && (
        <div className="result">
          <p className="small muted">Q: {result.asked}</p>
          <div className={result.found ? "answer" : "answer notfound"}>
            {!result.found && <strong>Not found in your documents. </strong>}
            <p>{result.answer}</p>
          </div>
          {result.warnings.map((w) => (
            <p key={w} className="small warn">⚠ {w}</p>
          ))}
          <div className="row">
            <span className="small muted">
              {(result.latency.total_ms / 1000).toFixed(1)} s{redacted > 0 && ` · ${redacted} piece(s) of personal data hidden from the AI provider`}
            </span>
            <button className="secondary" onClick={() => setTrace(result.traceId)}>What happened? (details)</button>
          </div>
          {result.citations.length > 0 && (
            <>
              <h3>Where this comes from</h3>
              <ul className="refs">
                {result.citations.map((c, i) => (
                  <li key={c.id}>
                    <button className="ref" onClick={() => openChunk(c.id)}>
                      [{i + 1}] {c.doc}, passage {c.index + 1}
                    </button>
                    {dev && <span className="small muted"> {c.id} · found by {sourcesText(c.sources) || "dense"} · RRF {c.score.toFixed(4)}</span>}
                    <p className="preview">{c.text.replace(/[*#`|]+/g, " ").replace(/\s+/g, " ").slice(0, 220).trim()}…</p>
                  </li>
                ))}
              </ul>
            </>
          )}
          {result.graph && <GraphPathView graph={result.graph} openChunk={openChunk} />}
          {dev && (
            <>
              <details>
                <summary>All {result.retrieved.length} retrieved passages (sent to the model)</summary>
                <ol className="retrieved">
                  {result.retrieved.map((h) => (
                    <li key={h.id}>
                      <button className="link" onClick={() => openChunk(h.id)}>{h.id}</button>{" "}
                      <span className="small muted">RRF {h.score.toFixed(4)} · {sourcesText(h.sources)}{result.citations.some((c) => c.id === h.id) ? " · cited" : ""}</span>
                    </li>
                  ))}
                </ol>
              </details>
              <p className="meta small">
                {Object.entries(result.settings.retrievers).filter(([, on]) => on).map(([x]) => x).join(" + ")} · {result.model} + {result.embeddingModel} · {result.promptVersion} · chunk {result.settings.chunkSize}/{result.settings.overlapPercent}% · top-{result.settings.topK} ·
                retrieval {result.latency.retrieval_ms} ms · generation {result.latency.generation_ms} ms
                {result.usage && ` · tokens in ${result.usage.input_tokens} / out ${result.usage.output_tokens}`}
              </p>
            </>
          )}
        </div>
      )}
      {trace && <TraceModal id={trace} onClose={() => setTrace(null)} openChunk={openChunk} />}
      {modal}
    </section>
  );
}
