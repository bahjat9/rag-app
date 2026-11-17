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

// V4 update: the graph of ANY documents. By default the tab works on the documents selected on the
// left: it shows which of them already have a graph, builds the missing ones, lets the user explore
// the result (entities, their relations, the passages behind them) and switch the graph retriever
// on for the answers. The question sets (Kestrel, Vellora) stay available for the V3 evaluation.
const SELECTED = "__selected__";

export function GraphTab({
  sets,
  settings,
  selected,
  docInfo,
  dev,
  onUseGraph,
}: {
  sets: QuestionSet[];
  settings: Settings | null;
  selected: string[];
  docInfo: { id: string; bytes: number; chunks: number | null }[];
  dev: boolean;
  onUseGraph: (on: boolean) => void;
}) {
  const [set, setSet] = useState(SELECTED);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [coverage, setCoverage] = useState<{ covered: string[]; missing: string[] } | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [triples, setTriples] = useState<Triples>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [q, setQ] = useState("");
  const [search, setSearch] = useState<SearchResult | null>(null);
  const { openChunk, modal } = useChunkModal();

  const mine = set === SELECTED;
  // passages of the documents without a graph (estimated from the size when not prepared yet)
  const passages = coverage
    ? coverage.missing.reduce((a, id) => {
        const d = docInfo.find((x) => x.id === id);
        return a + (d ? d.chunks ?? Math.ceil(d.bytes / 720) : 0);
      }, 0)
    : null;
  const docsKey = selected.join(",");
  const load = useCallback(async () => {
    try {
      const r = await call<{ graph: Graph | null; coverage: { covered: string[]; missing: string[] } | null }>(
        mine ? `/api/graph?docs=${encodeURIComponent(docsKey)}` : `/api/graph?set=${encodeURIComponent(set)}`,
      );
      setGraph(r.graph);
      setCoverage(r.coverage);
      setFocus(null);
      if (!mine) setTriples((await call<{ triples: Triples }>("/api/graph/triples")).triples);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [set, mine, docsKey]);
  useEffect(() => {
    load();
  }, [load]);

  async function build(opts: { rebuild?: boolean; retryFailed?: boolean }) {
    if (opts.rebuild && !confirm("Rebuild from scratch? Every passage is sent to the AI model again.")) return;
    if (mine && !opts.rebuild && !opts.retryFailed && passages != null && passages > 60 && !confirm(`About ${passages} passages: one AI call each, several minutes and part of your daily quota. Continue?`)) return;
    setBusy("The AI model reads every passage and extracts the concepts and their relations: one call per passage (paced). If it stops on a quota error, click Build again: it resumes where it stopped.");
    setError(null);
    try {
      await call("/api/graph", json("POST", mine ? { docs: selected, ...opts } : { set, ...opts }));
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
    const docs = mine ? selected : sets.find((s) => s.id === set)?.docs ?? [];
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
          The AI model reads every passage of your documents once and extracts the concepts (people, teams, products, places, error codes…) and how they are related. The graph is then used to find
          passages that a word search would miss, by following the relations (e.g. error code → service → team that owns it). Every concept keeps the passages it comes from.
        </p>
        <div className="row">
          <select value={set} onChange={(e) => setSet(e.target.value)}>
            <option value={SELECTED}>The documents selected on the left ({selected.length})</option>
            {dev && sets.map((x) => (
              <option key={x.id} value={x.id}>Question set: {x.name}</option>
            ))}
          </select>
          <span>
            {mine ? (
              <button onClick={() => build({})} disabled={!!busy || !selected.length || (coverage != null && coverage.missing.length === 0)}>
                {coverage && coverage.missing.length && coverage.covered.length ? `Build the graph of the ${coverage.missing.length} new document(s)` : "Build the concept graph"}
              </button>
            ) : (
              <button onClick={() => build({})} disabled={!!busy}>{graph ? "Build (resume)" : "Build the graph"}</button>
            )}{" "}
            {graph && graph.failed.length > 0 && <button onClick={() => build({ retryFailed: true })} disabled={!!busy}>Retry failed passages</button>}{" "}
            {graph && dev && <button className="link danger" onClick={() => build({ rebuild: true })} disabled={!!busy}>rebuild from scratch</button>}
          </span>
        </div>
        {mine && !selected.length && <p className="small warn">Select one or more documents on the left (you can add your own with “+ Add”).</p>}
        {mine && coverage && selected.length > 0 && (
          <p className="small">
            {coverage.covered.length > 0 && <>Graph ready for: <strong>{coverage.covered.join(", ")}</strong>. </>}
            {coverage.missing.length > 0 && (
              <>
                No graph yet for: <strong>{coverage.missing.join(", ")}</strong>
                {passages != null && <span className="muted"> (about {passages} passage(s), one AI call each)</span>}.
              </>
            )}
          </p>
        )}
        {settings && (
          <label className="inline small">
            <input type="checkbox" checked={!!settings.retrievers?.graph} onChange={(e) => onUseGraph(e.target.checked)} /> Use the graph when answering questions (combined with the word and meaning searches)
          </label>
        )}
        {dev && settings && <p className="small muted">Chunk settings {settings.chunkSize} / {settings.overlapPercent} % / {settings.minParagraphLength}: the graph uses the same passages as the other retrievers. CLI: <code>npm run cli -- graph build {mine ? `--docs ${selected.join(",")}` : `--set ${set}`}</code></p>}
        {busy && <p className="notice busy small">{busy}</p>}
        {error && <p role="alert">{error}</p>}
        {!graph && !busy && <p className="muted">{mine ? "No graph yet for the selected documents." : "No graph built for this set with the current chunk settings."}</p>}
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
            <input type="text" className="note" value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. a question that names a concept of the graph" />
            <button onClick={tryQuestion} disabled={!q.trim()}>Search</button>
          </div>
          <p className="small muted">Same search as the Ask tab, without the AI answer. {settings?.retrievers?.graph ? "The graph is on: the path it followed is shown." : "Tick “Use the graph when answering questions” above to include the graph."}</p>
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
          <h2>Explore the graph</h2>
          <h3>Merged names (entity resolution)</h3>
          <p className="small muted">Each line = one concept that several spellings were merged into.</p>
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
          <h3>Concepts</h3>
          <p className="small muted">Click a concept to see its relations and the passages they come from.</p>
          <input type="text" className="note" placeholder="filter (name, type)…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <table className="small">
            <thead><tr><th>Entity</th><th>Type</th><th>Names</th><th>Edges</th><th>Chunks (provenance)</th></tr></thead>
            <tbody>
              {nodes.map((n) => (
                <tr key={n.key} className={focus === n.key ? "focus" : undefined}>
                  <td><button className="link" onClick={() => setFocus(focus === n.key ? null : n.key)} title="show its relations">{n.name}</button></td>
                  <td>{n.type}</td>
                  <td>{n.names.join(" | ")}</td>
                  <td>{degree.get(n.key) ?? 0}</td>
                  <td>{n.chunks.slice(0, 4).map((c) => <button key={c} className="link" onClick={() => openChunk(c)}>{c.replace(/\.md#0*(\d)/, "#$1")}</button>)}{n.chunks.length > 4 && ` +${n.chunks.length - 4}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {graph.nodes.length > nodes.length && <p className="small muted">{nodes.length} of {graph.nodes.length} shown: use the filter.</p>}
          {focus && <Relations graph={graph} focus={focus} onFocus={setFocus} openChunk={openChunk} />}
        </section>
      )}

      {graph && !mine && (
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

function Relations({ graph, focus, onFocus, openChunk }: { graph: Graph; focus: string; onFocus: (k: string) => void; openChunk: (id: string) => void }) {
  const name = (k: string) => graph.nodes.find((n) => n.key === k)?.name ?? k;
  const rel = graph.edges.filter((e) => e.source === focus || e.target === focus);
  return (
    <div className="relations">
      <h3>Relations of “{name(focus)}”</h3>
      {!rel.length && <p className="small muted">No relation: this concept was only mentioned.</p>}
      <ul className="small">
        {rel.map((e) => (
          <li key={`${e.source}|${e.relation}|${e.target}`}>
            <button className="link" onClick={() => onFocus(e.source)}>{name(e.source)}</button> <span className="muted">—{e.relation}→</span>{" "}
            <button className="link" onClick={() => onFocus(e.target)}>{name(e.target)}</button>{" "}
            <span className="muted">
              from {e.chunks.slice(0, 3).map((c) => <button key={c} className="link" onClick={() => openChunk(c)}>{c}</button>)}
              {e.chunks.length > 3 && ` +${e.chunks.length - 3}`}
            </span>
          </li>
        ))}
      </ul>
    </div>
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
