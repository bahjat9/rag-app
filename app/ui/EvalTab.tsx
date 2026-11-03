"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { call, cfgOf, json, pct, useChunkModal, type QuestionSet, type Settings } from "./common";

const KS = ["1", "3", "5", "10"] as const;
const GRADES = ["correct", "partial", "wrong", "unsupported"] as const;

type KStats = { hit: number; recall: number; partial: number };
type Summary = {
  ts: string;
  file: string;
  set: string;
  set_name: string;
  label: string;
  embedding_model: string;
  settings: Settings;
  questions: number;
  answerable: number;
  at: Record<string, KStats>;
  mrr: number;
  by_type: Record<string, { n: number; at: Record<string, { hit: number; recall: number }> }>;
  answerable_avg_top_score: number | null;
  unanswerable_avg_top_score: number | null;
  answers: boolean;
  llm_model: string | null;
  duration_ms: number;
};
type Row = {
  id: string;
  type: string;
  question: string;
  answerable: boolean;
  quote_ranks: (number | null)[];
  first_rank: number | null;
  hit: Record<string, boolean> | null;
  recall: Record<string, number> | null;
  partial: Record<string, boolean> | null;
  top_score: number;
  retrieved: { id: string; score: number }[];
  answer?: { found: boolean; answer: string; citations: string[]; warnings: string[]; chunks: { id: string; score: number; text: string }[]; error?: string };
  grade?: (typeof GRADES)[number] | null;
  grade_note?: string;
};
type Run = { summary: Summary; rows: Row[]; grades?: Record<string, number> };
type NcRow = { id: string; type: string; question: string; answerable: boolean; expected_answer: string; answer: string; knows: boolean; verdict: string | null; reason: string; flag: boolean | null; error?: string };
type NcRun = { summary: { ts: string; set: string; set_name: string; llm_model: string; file: string; verdicts: Record<string, number>; answered_correctly_without_retrieval: string[]; errors: number; flags_checked_by_hand?: boolean }; rows: NcRow[] };

export function EvalTab({ settings, sets }: { settings: Settings | null; sets: QuestionSet[] }) {
  const [runs, setRuns] = useState<Summary[]>([]);
  const [markdown, setMarkdown] = useState("");
  const [open, setOpen] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState({ set: "kestrel", chunkSize: 800, overlapPercent: 10, minParagraphLength: 20, topK: 5, answers: false, label: "" });
  const { openChunk, modal } = useChunkModal();

  useEffect(() => {
    if (settings) setForm((f) => ({ ...f, ...settings }));
  }, [settings]);
  useEffect(() => {
    if (sets.length && !sets.some((s) => s.id === form.set)) setForm((f) => ({ ...f, set: sets[0].id }));
  }, [sets, form.set]);

  const load = useCallback(async () => {
    try {
      const r = await call<{ runs: Summary[]; markdown: string }>("/api/eval");
      setRuns([...r.runs].reverse());
      setMarkdown(r.markdown);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function run() {
    setBusy(form.answers ? "Running retrieval + generating answers (one LLM call per question)…" : "Running the retrieval evaluation (indexes are built if needed)…");
    setError(null);
    try {
      const r = await call<Run>("/api/eval", json("POST", form));
      setOpen(r);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function openRun(file: string) {
    try {
      setOpen(await call<Run>(`/api/eval/run?file=${encodeURIComponent(file)}`));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <section className="panel">
        <h2>Retrieval evaluation</h2>
        <p className="small muted">
          Runs every question of a set through retrieval (top 10) and checks, for k = 1, 3, 5, 10, whether the chunks contain the evidence quotes of the question. Unanswerable questions are left out of
          the rates. The configuration below only applies to this run (the saved settings are not changed); missing indexes are built. Same as{" "}
          <code>npm run cli -- eval --set {form.set} --chunk {form.chunkSize} --overlap {form.overlapPercent} --k {form.topK}{form.answers ? " --answers" : ""}</code>.
        </p>
        <div className="formgrid">
          <label>
            Question set
            <select value={form.set} onChange={(e) => setForm({ ...form, set: e.target.value })}>
              {sets.map((s) => (
                <option key={s.id} value={s.id}>{s.name} ({s.questions.length})</option>
              ))}
            </select>
          </label>
          <label>Chunk size<input type="number" min={100} max={4000} value={form.chunkSize} onChange={(e) => setForm({ ...form, chunkSize: Number(e.target.value) })} /></label>
          <label>Overlap %<input type="number" min={0} max={50} value={form.overlapPercent} onChange={(e) => setForm({ ...form, overlapPercent: Number(e.target.value) })} /></label>
          <label>Min paragraph<input type="number" min={0} max={200} value={form.minParagraphLength} onChange={(e) => setForm({ ...form, minParagraphLength: Number(e.target.value) })} /></label>
          <label>Top-k (answers)<input type="number" min={1} max={20} value={form.topK} onChange={(e) => setForm({ ...form, topK: Number(e.target.value) })} /></label>
          <label>Label<input type="text" maxLength={60} value={form.label} placeholder="e.g. A (baseline)" onChange={(e) => setForm({ ...form, label: e.target.value })} /></label>
          <label className="check">
            <input type="checkbox" checked={form.answers} onChange={(e) => setForm({ ...form, answers: e.target.checked })} /> also generate the answers (LLM, for hand grading)
          </label>
        </div>
        <button onClick={run} disabled={!!busy}>{busy ? "Running…" : "Run the evaluation"}</button>
        {busy && <p className="notice busy small">{busy}</p>}
        {error && <p role="alert">{error}</p>}
      </section>

      {open && <RunView run={open} sets={sets} onOpenChunk={openChunk} onGraded={(g) => setOpen({ ...open, grades: g })} onClose={() => setOpen(null)} />}

      <section className="panel">
        <h2>All runs</h2>
        <table>
          <thead>
            <tr><th>Date</th><th>Set</th><th>Label</th><th>Chunk / overlap / min</th><th>hit@1</th><th>hit@3</th><th>hit@5</th><th>hit@10</th><th>recall@5</th><th>MRR</th><th>Answers</th><th></th></tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.file}>
                <td className="small">{r.ts.replace("T", " ").slice(0, 16)}</td>
                <td>{r.set}</td>
                <td>{r.label}</td>
                <td>{r.settings.chunkSize} / {r.settings.overlapPercent} % / {r.settings.minParagraphLength}</td>
                {KS.map((k) => <td key={k}>{pct(r.at[k].hit, 0)}</td>)}
                <td>{pct(r.at["5"].recall, 0)}</td>
                <td>{r.mrr.toFixed(3)}</td>
                <td>{r.answers ? `yes (k=${r.settings.topK})` : "–"}</td>
                <td><button className="link" onClick={() => openRun(r.file)}>open</button></td>
              </tr>
            ))}
            {!runs.length && <tr><td colSpan={12} className="muted">No run yet.</td></tr>}
          </tbody>
        </table>
        {markdown && (
          <details>
            <summary>Results table in Markdown (for REPORT.md) – also written by <code>npm run cli -- results</code></summary>
            <pre className="chunk small">{markdown}</pre>
          </details>
        )}
      </section>

      <NoContextPanel sets={sets} />
      {modal}
    </>
  );
}

function RunView({ run, sets, onOpenChunk, onGraded, onClose }: { run: Run; sets: QuestionSet[]; onOpenChunk: (id: string, cfg?: string) => void; onGraded: (g: Record<string, number>) => void; onClose: () => void }) {
  const s = run.summary;
  const cfg = cfgOf(s.settings);
  const questions = useMemo(() => new Map((sets.find((x) => x.id === s.set)?.questions ?? []).map((q) => [q.id, q])), [sets, s.set]);
  const [rows, setRows] = useState(run.rows);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => setRows(run.rows), [run.rows]);
  const graded = rows.some((r) => r.answer);
  const counts = useMemo(() => {
    const c: Record<string, number> = { correct: 0, partial: 0, wrong: 0, unsupported: 0, ungraded: 0 };
    rows.forEach((r) => r.answer && c[r.grade ?? "ungraded"]++);
    return c;
  }, [rows]);

  async function grade(id: string, grade: Row["grade"], note: string) {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, grade, grade_note: note } : r)));
    try {
      const r = await call<{ grades: Record<string, number> }>("/api/eval/grade", json("POST", { file: s.file, id, grade: grade ?? null, note }));
      onGraded(r.grades);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <section className="panel">
      <div className="row">
        <h2>
          Run {s.label && <>“{s.label}” </>}· {s.set_name}
        </h2>
        <button className="link" onClick={onClose}>close</button>
      </div>
      <p className="small muted">
        {s.embedding_model} · chunk {s.settings.chunkSize} · overlap {s.settings.overlapPercent} % · min paragraph {s.settings.minParagraphLength} · {s.answerable} answerable / {s.questions} questions ·{" "}
        {(s.duration_ms / 1000).toFixed(1)} s · file <code>eval/runs/{s.file}</code>
      </p>
      <table>
        <thead>
          <tr><th></th>{KS.map((k) => <th key={k}>k = {k}</th>)}</tr>
        </thead>
        <tbody>
          <tr><td>hit rate</td>{KS.map((k) => <td key={k}><strong>{pct(s.at[k].hit)}</strong></td>)}</tr>
          <tr><td>recall</td>{KS.map((k) => <td key={k}>{pct(s.at[k].recall)}</td>)}</tr>
          <tr><td>partial (half a quote)</td>{KS.map((k) => <td key={k}>{pct(s.at[k].partial)}</td>)}</tr>
        </tbody>
      </table>
      <p className="small">
        MRR {s.mrr.toFixed(3)} · average best similarity: answerable {s.answerable_avg_top_score?.toFixed(3) ?? "–"} / unanswerable {s.unanswerable_avg_top_score?.toFixed(3) ?? "–"}
      </p>
      <h3>Per question type (hit rate)</h3>
      <table>
        <thead>
          <tr><th>Type</th><th>n</th>{KS.map((k) => <th key={k}>hit@{k}</th>)}<th>recall@5</th></tr>
        </thead>
        <tbody>
          {Object.entries(s.by_type).map(([t, v]) => (
            <tr key={t}>
              <td>{t}</td>
              <td>{v.n}</td>
              {KS.map((k) => <td key={k}>{Math.round(v.at[k].hit * v.n)}/{v.n}</td>)}
              <td>{pct(v.at["5"].recall, 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Questions</h3>
      <table>
        <thead>
          <tr><th>Id</th><th>Type</th><th>Question</th><th>Rank of each quote</th><th>@1</th><th>@3</th><th>@5</th><th>@10</th><th>Top score</th><th>Top 3 retrieved</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.id}</td>
              <td className="small">{r.type}</td>
              <td>{r.question}</td>
              <td>{r.answerable ? r.quote_ranks.map((x) => x ?? "–").join(", ") : <span className="muted">unanswerable</span>}</td>
              {KS.map((k) => (
                <td key={k} className={r.hit === null ? "muted" : r.hit[k] ? "good" : r.partial?.[k] ? "warn" : "bad"}>
                  {r.hit === null ? "n/a" : r.hit[k] ? (r.recall![k] < 1 ? `${Math.round(r.recall![k] * 100)}%` : "✓") : r.partial?.[k] ? "½" : "✗"}
                </td>
              ))}
              <td>{r.top_score.toFixed(3)}</td>
              <td className="small">
                {r.retrieved.slice(0, 3).map((h) => (
                  <div key={h.id}><button className="link small" onClick={() => onOpenChunk(h.id, cfg)}>{h.id}</button> {h.score.toFixed(2)}</div>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="small muted">✓ all quotes in the top k · NN% some quotes · ½ only half of a quote (cut by a chunk boundary) · ✗ missed.</p>

      {graded && (
        <>
          <h3>Answers – grade by hand</h3>
          <p className="small muted">
            Scale: <strong>correct</strong>, <strong>partial</strong>, <strong>wrong</strong>, <strong>unsupported</strong> (says things the referenced chunks do not say). Unanswerable: correct = the app says
            &quot;not in the documents&quot;. Write the grading rules (eval/GRADING.md) before grading. Grades are saved in the run file.
          </p>
          <p className="small">
            {GRADES.map((g) => `${g} ${counts[g]}`).join(" · ")} · ungraded {counts.ungraded}
          </p>
          {err && <p role="alert">{err}</p>}
          {rows.filter((r) => r.answer).map((r) => (
            <GradeCard key={r.id} row={r} expected={questions.get(r.id)?.expected_answer ?? ""} cfg={cfg} onOpenChunk={onOpenChunk} onGrade={grade} />
          ))}
        </>
      )}
    </section>
  );
}

function GradeCard({ row, expected, cfg, onOpenChunk, onGrade }: { row: Row; expected: string; cfg: string; onOpenChunk: (id: string, cfg?: string) => void; onGrade: (id: string, g: Row["grade"], note: string) => void }) {
  const [note, setNote] = useState(row.grade_note ?? "");
  const a = row.answer!;
  const evidenceRetrieved = row.hit ? row.quote_ranks.some((r) => r !== null && r <= a.chunks.length) : null;
  return (
    <div className="gradecard">
      <div className="row">
        <strong>{row.id} · {row.type}</strong>
        <span className="small muted">
          {evidenceRetrieved === null ? "unanswerable" : evidenceRetrieved ? "evidence WAS in the chunks sent to the model" : "evidence NOT in the chunks sent to the model (retrieval failure)"}
        </span>
      </div>
      <p><strong>Q:</strong> {row.question}</p>
      <p className="small"><strong>Expected:</strong> {expected}</p>
      <div className={a.found ? "answer" : "answer notfound"}>
        {a.error ? <p role="alert">Generation failed: {a.error}</p> : <p>{!a.found && <strong>[not found] </strong>}{a.answer}</p>}
      </div>
      <p className="small">
        Cited:{" "}
        {a.citations.length ? a.citations.map((c) => <button key={c} className="link small" onClick={() => onOpenChunk(c, cfg)}>{c}</button>) : "none"}
        {a.warnings.map((w) => <span key={w} className="warn"> · ⚠ {w}</span>)}
      </p>
      <details>
        <summary className="small">The {a.chunks.length} chunks sent to the model</summary>
        {a.chunks.map((c) => (
          <div key={c.id} className="small">
            <strong>{c.id}</strong> ({c.score.toFixed(3)})<pre className="chunk">{c.text}</pre>
          </div>
        ))}
      </details>
      <div className="row">
        <span>
          {GRADES.map((g) => (
            <label key={g} className="gradeopt">
              <input type="radio" name={`g-${row.id}`} checked={row.grade === g} onChange={() => onGrade(row.id, g, note)} /> {g}
            </label>
          ))}
        </span>
        <input type="text" className="note" placeholder="note (why)" value={note} onChange={(e) => setNote(e.target.value)} onBlur={() => row.grade && note !== (row.grade_note ?? "") && onGrade(row.id, row.grade, note)} />
      </div>
    </div>
  );
}

function NoContextPanel({ sets }: { sets: QuestionSet[] }) {
  const [runs, setRuns] = useState<NcRun[]>([]);
  const [set, setSet] = useState("kestrel");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await call<{ runs: NcRun[] }>("/api/nocontext");
      setRuns(r.runs);
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
      const r = await call<NcRun>("/api/nocontext", json("POST", { set }));
      setShown(r.summary.file);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function flag(file: string, id: string, value: boolean) {
    try {
      await call("/api/nocontext", json("PATCH", { file, id, flag: value }));
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const current = runs.find((r) => r.summary.file === shown);
  return (
    <section className="panel">
      <h2>No-context test</h2>
      <p className="small muted">
        Asks every question to the LLM <strong>without retrieval</strong> (2 calls per question: the answer, then a judge comparing it with the expected answer). A question the model answers correctly
        anyway does not test the RAG. The judge&apos;s flag is a suggestion: check it by hand. Same as <code>npm run cli -- nocontext --set {set}</code>.
      </p>
      <div className="row">
        <select value={set} onChange={(e) => setSet(e.target.value)}>
          {sets.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <button onClick={run} disabled={busy}>{busy ? "Asking the LLM…" : "Run the no-context test"}</button>
      </div>
      {error && <p role="alert">{error}</p>}
      <table>
        <thead><tr><th>Date</th><th>Set</th><th>Model</th><th>Verdicts</th><th>Answered without RAG</th><th></th></tr></thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.summary.file}>
              <td className="small">{r.summary.ts.replace("T", " ").slice(0, 16)}</td>
              <td>{r.summary.set}</td>
              <td className="small">{r.summary.llm_model}</td>
              <td className="small">{Object.entries(r.summary.verdicts).map(([k, v]) => `${k} ${v}`).join(" · ")}{r.summary.errors ? ` · errors ${r.summary.errors}` : ""}</td>
              <td>{r.summary.answered_correctly_without_retrieval.join(", ") || "none"}{r.summary.flags_checked_by_hand ? " (checked)" : ""}</td>
              <td><button className="link" onClick={() => setShown(shown === r.summary.file ? null : r.summary.file)}>{shown === r.summary.file ? "hide" : "open"}</button></td>
            </tr>
          ))}
          {!runs.length && <tr><td colSpan={6} className="muted">No run yet.</td></tr>}
        </tbody>
      </table>
      {current && (
        <table>
          <thead><tr><th>Id</th><th>Question</th><th>Expected</th><th>LLM without retrieval</th><th>Judge</th><th>Answered correctly?</th></tr></thead>
          <tbody>
            {current.rows.map((r) => (
              <tr key={r.id}>
                <td>{r.id}<div className="small muted">{r.type}</div></td>
                <td>{r.question}</td>
                <td className="small">{r.expected_answer}</td>
                <td className="small">{r.error ? <span role="alert">{r.error}</span> : <>{!r.knows && <em>[does not know] </em>}{r.answer}</>}</td>
                <td className="small">{r.verdict ?? "–"}<div className="muted">{r.reason}</div></td>
                <td>
                  <label className="check"><input type="checkbox" checked={!!r.flag} onChange={(e) => flag(current.summary.file, r.id, e.target.checked)} /> yes</label>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
