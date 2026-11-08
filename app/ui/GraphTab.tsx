"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { call, GraphPathView, json, sourcesText, useChunkModal, type GraphPath, type QuestionSet, type Settings, type Source } from "./common";

type Node = { key: string; name: string; type: string; names: string[]; chunks: string[] };
type Edge = { source: string; relation: string; target: string; chunks: string[] };
type Stats = {
  key: string;
  docs: string[];
  model: string;
  built_at: string;
  entities: number;
  relations: number;
  merges: number;
  entity_types: Record<string, number>;
  relation_types: Record<string, number>;
  cost: { chunks: number; failed: number; llm_calls: number; input_tokens: number; output_tokens: number; seconds: number };
  type_conflicts: number;
};
type Graph = { stats: Stats; nodes: Node[]; edges: Edge[]; merges: { key: string; names: string[] }[]; type_conflicts: { key: string; types: string[] }[]; failed: { id: string; error: string }[] };
type Triple = { n: number; source: string; relation: string; target: string; chunk: string; chunk_text: string; grade: "correct" | "wrong" | "unsupported" | null; note: string };
type Triples = { graph: string; sampled_at: string; triples: Triple[] } | null;
type SearchResult = { hits: { id: string; text: string; score: number; rank: number; sources: Source[] }[]; graph: { available: boolean | null; path: GraphPath } | null };

const TRIPLE_GRADES = ["correct", "wrong", "unsupported"] as const;

export function GraphTab({ sets, settings }: { sets: QuestionSet[]; settings: Settings | null }) {
  const [set, setSet] = useState("kestrel");
  const [graph, setGraph] = useState<Graph | null>(null);
  const [triples, setTriples] = useState<Triples>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [q, setQ] = useState("");
  const [search, setSearch] = useState<SearchResult | null>(null);
  const { openChunk, modal } = useChunkModal();

  const load = useCallback(async () => {
    try {
      setGraph((await call<{ graph: Graph | null }>(`/api/graph?set=${encodeURIComponent(set)}`)).graph);
      setTriples((await call<{ triples: Triples }>("/api/graph/triples")).triples);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [set]);
  useEffect(() => {
    load();
  }, [load]);

  async function build(opts: { rebuild?: boolean; retryFailed?: boolean }) {
    if (opts.rebuild && !confirm("Rebuild from scratch? Every chunk is sent to the LLM again.")) return;
    setBusy("Extracting triples: one LLM call per chunk (paced). Several minutes on a free tier; if it stops on a quota error, click Build again: it resumes.");
    setError(null);
    try {
      await call("/api/graph", json("POST", { set, ...opts }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
      await load();
    }
  }

  async function sample() {
    const graded = triples?.triples.some((t) => t.grade);
    if (graded && !confirm("Draw 10 new triples? The current grades are erased.")) return;
    try {
      setTriples((await call<{ triples: Triples }>("/api/graph/triples", json("POST", { set, force: graded }))).triples);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function grade(n: number, g: Triple["grade"], note: string) {
    setTriples((t) => t && { ...t, triples: t.triples.map((x) => (x.n === n ? { ...x, grade: g, note } : x)) });
    try {
      await call("/api/graph/triples", json("PATCH", { n, grade: g, note }));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function tryQuestion() {
    const docs = sets.find((s) => s.id === set)?.docs ?? [];
    try {
      setSearch(await call<SearchResult>("/api/search", json("POST", { question: q, docs })));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const nodes = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const ns = graph?.nodes ?? [];
    return (f ? ns.filter((n) => n.key.includes(f) || n.type.includes(f) || n.names.some((x) => x.toLowerCase().includes(f))) : ns).slice(0, 80);
  }, [graph, filter]);
  const degree = useMemo(() => {
    const d = new Map<string, number>();
    graph?.edges.forEach((e) => [e.source, e.target].forEach((k) => d.set(k, (d.get(k) ?? 0) + 1)));
    return d;
  }, [graph]);
  const counts = useMemo(() => {
    const c: Record<string, number> = { correct: 0, wrong: 0, unsupported: 0, ungraded: 0 };
    triples?.triples.forEach((t) => c[t.grade ?? "ungraded"]++);
    return c;
  }, [triples]);
  const s = graph?.stats;

  return (
    <>
      <section className="panel">
        <h2>Concept graph</h2>
        <p className="small muted">
          At indexing time an LLM reads every chunk and extracts (entity, relation, entity) triples with a fixed schema; the output is validated with Zod (an invalid output is retried once, then the
          chunk is skipped and listed below). Every entity and edge keeps the chunks it came from. Entities with the same normalised name are merged (entity resolution). Same as{" "}
          <code>npm run cli -- graph build --set {set}</code>.
        </p>
        <div className="row">
          <select value={set} onChange={(e) => setSet(e.target.value)}>
            {sets.map((x) => (
              <option key={x.id} value={x.id}>{x.name}</option>
            ))}
          </select>
          <span>
            <button onClick={() => build({})} disabled={!!busy}>{graph ? "Build (resume)" : "Build the graph"}</button>{" "}
            {graph && graph.failed.length > 0 && <button onClick={() => build({ retryFailed: true })} disabled={!!busy}>Retry failed chunks</button>}{" "}
            {graph && <button className="link danger" onClick={() => build({ rebuild: true })} disabled={!!busy}>rebuild from scratch</button>}
          </span>
        </div>
        {settings && <p className="small muted">Chunk settings {settings.chunkSize} / {settings.overlapPercent} % / {settings.minParagraphLength}: the graph uses the same chunks as the other retrievers.</p>}
        {busy && <p className="notice busy small">{busy}</p>}
        {error && <p role="alert">{error}</p>}
        {!graph && !busy && <p className="muted">No graph built for this set with the current chunk settings.</p>}
        {s && (
          <>
            <h3>The graph in numbers</h3>
            <table>
              <tbody>
                <tr><td>Entities / relations</td><td><strong>{s.entities}</strong> / <strong>{s.relations}</strong></td></tr>
                <tr><td>Entity types</td><td className="small">{Object.entries(s.entity_types).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" · ")}</td></tr>
                <tr><td>Relation types</td><td className="small">{Object.entries(s.relation_types).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" · ")}</td></tr>
                <tr><td>Merged entities (entity resolution)</td><td>{s.merges}</td></tr>
                <tr><td>Type conflicts (same entity, several types)</td><td>{s.type_conflicts}</td></tr>
                <tr><td>Chunks read / failed validation</td><td>{s.cost.chunks} / {s.cost.failed}</td></tr>
                <tr><td>Build cost</td><td>{s.cost.llm_calls} LLM calls · {s.cost.input_tokens.toLocaleString()} input + {s.cost.output_tokens.toLocaleString()} output tokens · {s.cost.seconds} s of LLM time ({s.model})</td></tr>
                <tr><td>Built</td><td className="small">{s.built_at.replace("T", " ").slice(0, 19)}</td></tr>
              </tbody>
            </table>
          </>
        )}
      </section>

      {graph && (
        <section className="panel">
          <h2>Try the graph retriever</h2>
          <div className="row">
            <input type="text" className="note" value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. Error KST-5031 on scheduled reports: which team?" />
            <button onClick={tryQuestion} disabled={!q.trim()}>Search</button>
          </div>
          <p className="small muted">Uses the retrievers switched on in the settings, fused with RRF (switch the graph on there).</p>
          {search && (
            <>
              <GraphPathView graph={search.graph} openChunk={(id) => openChunk(id)} />
              <ol className="retrieved">
                {search.hits.map((h) => (
                  <li key={h.id}>
                    <button className="link" onClick={() => openChunk(h.id)}>{h.id}</button> <span className="small muted">RRF {h.score.toFixed(4)} · {sourcesText(h.sources)}</span>
                  </li>
                ))}
              </ol>
            </>
          )}
        </section>
      )}

      {graph && (
        <section className="panel">
          <h2>Entity resolution</h2>
          <p className="small muted">Each line = one entity that several surface names were merged into. Check them: find one correct merge and one wrong (or missed) merge for the report.</p>
          <ul className="small">
            {graph.merges.map((m) => (
              <li key={m.key}><strong>{m.key}</strong> ← {m.names.join(" | ")}</li>
            ))}
            {!graph.merges.length && <li className="muted">No merge.</li>}
          </ul>
          {graph.type_conflicts.length > 0 && (
            <p className="small">Type conflicts (the majority type is kept): {graph.type_conflicts.map((t) => `${t.key} (${t.types.join(" / ")})`).join(", ")}</p>
          )}
          {graph.failed.length > 0 && (
            <>
              <h3>Chunks whose extraction failed validation</h3>
              <ul className="small">
                {graph.failed.map((f) => (
                  <li key={f.id}><button className="link" onClick={() => openChunk(f.id)}>{f.id}</button> {f.error.slice(0, 160)}</li>
                ))}
              </ul>
            </>
          )}
          <h3>Entities</h3>
          <input type="text" className="note" placeholder="filter (name, type)…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <table className="small">
            <thead><tr><th>Entity</th><th>Type</th><th>Names</th><th>Edges</th><th>Chunks (provenance)</th></tr></thead>
            <tbody>
              {nodes.map((n) => (
                <tr key={n.key}>
                  <td>{n.name}</td>
                  <td>{n.type}</td>
                  <td>{n.names.join(" | ")}</td>
                  <td>{degree.get(n.key) ?? 0}</td>
                  <td>{n.chunks.slice(0, 4).map((c) => <button key={c} className="link" onClick={() => openChunk(c)}>{c.replace(/\.md#0*(\d)/, "#$1")}</button>)}{n.chunks.length > 4 && ` +${n.chunks.length - 4}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {graph.nodes.length > nodes.length && <p className="small muted">{nodes.length} of {graph.nodes.length} shown: use the filter.</p>}
        </section>
      )}

      {graph && (
        <section className="panel">
          <h2>Extraction quality: 10 random triples</h2>
          <p className="small muted">
            Grade each triple against the chunk it came from: <strong>correct</strong> (the chunk states it), <strong>wrong</strong> (the chunk says something else), <strong>unsupported</strong> (not in the
            chunk: inferred or invented). Saved in <code>eval/graph-triples.json</code>. Same as <code>npm run cli -- graph sample --set {set}</code>.
          </p>
          <button onClick={sample}>{triples ? "Draw 10 new triples" : "Draw 10 random triples"}</button>
          {triples && (
            <>
              <p className="small">
                {TRIPLE_GRADES.map((g) => `${g} ${counts[g]}`).join(" · ")} · ungraded {counts.ungraded} <span className="muted">(graph {triples.graph}, drawn {triples.sampled_at.slice(0, 16).replace("T", " ")})</span>
              </p>
              {triples.triples.map((t) => (
                <TripleCard key={t.n} t={t} onGrade={grade} />
              ))}
            </>
          )}
        </section>
      )}
      {modal}
    </>
  );
}

function TripleCard({ t, onGrade }: { t: Triple; onGrade: (n: number, g: Triple["grade"], note: string) => void }) {
  const [note, setNote] = useState(t.note);
  return (
    <div className="gradecard">
      <p>
        <strong>{t.n}.</strong> ({t.source}) <span className="muted">—{t.relation}→</span> ({t.target}) <span className="small muted">from {t.chunk}</span>
      </p>
      <details>
        <summary className="small">chunk text</summary>
        <pre className="chunk small">{t.chunk_text}</pre>
      </details>
      <div className="row">
        <span>
          {TRIPLE_GRADES.map((g) => (
            <label key={g} className="gradeopt">
              <input type="radio" name={`t-${t.n}`} checked={t.grade === g} onChange={() => onGrade(t.n, g, note)} /> {g}
            </label>
          ))}
        </span>
        <input type="text" className="note" placeholder="note (why)" value={note} onChange={(e) => setNote(e.target.value)} onBlur={() => t.grade && note !== t.note && onGrade(t.n, t.grade, note)} />
      </div>
    </div>
  );
}
