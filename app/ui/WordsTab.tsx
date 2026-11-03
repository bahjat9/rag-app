"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { call, json, pct, useChunkModal, type QuestionSet } from "./common";

type VocabWord = { word: string; count: number; chunks: number; stopword: boolean };
type Vocab = { distinct_words: number; total_tokens: number; chunks: number; matching: number; words: VocabWord[] };
type WordChunks = { word: string; count: number; chunks: { id: string; doc: string; count: number; snippet: string }[] };
type QWord = {
  word: string;
  stopword: boolean;
  in_corpus: boolean;
  count: number;
  chunks: number;
  share_of_chunks: number;
  in_evidence_chunks: string[];
  in_retrieved: string[];
  top_chunks: string[];
};
type QResult = { question: string; chunks_in_corpus: number; evidence_chunks: string[]; retrieved: { id: string; score: number }[]; retrieved_contains_evidence: boolean; words: QWord[]; absent: string[] };

export function WordsTab({ sets, selected }: { sets: QuestionSet[]; selected: string[] }) {
  const [corpus, setCorpus] = useState<string>("selected");
  const [mode, setMode] = useState<"corpus" | "question">("corpus");
  const docs = corpus === "selected" ? selected : sets.find((s) => s.id === corpus)?.docs ?? [];
  const set = sets.find((s) => s.id === corpus);
  const { openChunk, modal } = useChunkModal();

  return (
    <section className="panel">
      <h2>Words</h2>
      <p className="small muted">
        Explore the words of the corpus, counted in the <strong>chunks</strong> of the current index (current retrieval settings; overlapping text is counted in both chunks). Lower-cased; letters and
        digits, keeping inner &quot;-&quot;, &quot;.&quot;, &quot;&apos;&quot; (so <code>KST-2044</code> and <code>203.0.113.10</code> stay one word). The documents must be indexed with the current settings.
      </p>
      <div className="row">
        <label>
          Corpus{" "}
          <select value={corpus} onChange={(e) => setCorpus(e.target.value)}>
            <option value="selected">Selected documents ({selected.length})</option>
            {sets.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <nav className="tabs">
          <button className={mode === "corpus" ? "tab active" : "tab"} onClick={() => setMode("corpus")}>Corpus mode</button>
          <button className={mode === "question" ? "tab active" : "tab"} onClick={() => setMode("question")}>Question mode</button>
        </nav>
      </div>
      <p className="small muted">Documents: {docs.length ? docs.join(", ") : "none"}</p>
      {docs.length ? (
        mode === "corpus" ? <CorpusMode key={docs.join()} docs={docs} openChunk={openChunk} /> : <QuestionMode key={docs.join()} docs={docs} set={set} sets={sets} openChunk={openChunk} />
      ) : (
        <p className="muted">Select documents or a corpus.</p>
      )}
      {modal}
    </section>
  );
}

function CorpusMode({ docs, openChunk }: { docs: string[]; openChunk: (id: string) => void }) {
  const [filter, setFilter] = useState("");
  const [hideStop, setHideStop] = useState(true);
  const [sort, setSort] = useState<"count" | "chunks" | "alpha">("count");
  const [vocab, setVocab] = useState<Vocab | null>(null);
  const [word, setWord] = useState<WordChunks | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const q = new URLSearchParams({ docs: docs.join(","), filter, sort, stop: hideStop ? "hide" : "show", limit: "300" });
      setVocab(await call<Vocab>(`/api/words?${q}`));
    } catch (e) {
      setError((e as Error).message);
      setVocab(null);
    }
  }, [docs, filter, sort, hideStop]);
  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  async function showWord(w: string) {
    try {
      setWord(await call<WordChunks>(`/api/words?${new URLSearchParams({ docs: docs.join(","), word: w })}`));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="words">
      <div>
        <h3>Vocabulary</h3>
        <div className="row">
          <input type="text" placeholder="filter, e.g. kst-" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
            <option value="count">by occurrences</option>
            <option value="chunks">by number of chunks</option>
            <option value="alpha">alphabetical</option>
          </select>
          <label className="check"><input type="checkbox" checked={hideStop} onChange={(e) => setHideStop(e.target.checked)} /> hide stop words</label>
        </div>
        {error && <p role="alert">{error}</p>}
        {vocab && (
          <>
            <p className="small muted">
              {vocab.distinct_words} distinct words · {vocab.total_tokens} occurrences · {vocab.chunks} chunks · {vocab.matching} matching{vocab.matching > vocab.words.length ? ` (first ${vocab.words.length} shown)` : ""}
            </p>
            <div className="scroll">
              <table>
                <thead><tr><th>Word</th><th>Occurrences</th><th>Chunks</th><th>% of chunks</th></tr></thead>
                <tbody>
                  {vocab.words.map((w) => (
                    <tr key={w.word} className={word?.word === w.word ? "selected" : ""}>
                      <td><button className="link" onClick={() => showWord(w.word)}>{w.word}</button>{w.stopword && <span className="small muted"> (stop)</span>}</td>
                      <td>{w.count}</td>
                      <td>{w.chunks}</td>
                      <td>{pct(w.chunks / vocab.chunks, 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
      <div>
        <h3>Word → chunks</h3>
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            const w = new FormData(e.currentTarget as HTMLFormElement).get("w");
            if (typeof w === "string" && w.trim()) showWord(w);
          }}
        >
          <div className="row">
            <input name="w" type="text" placeholder="any word, e.g. phone" />
            <button type="submit">Find</button>
          </div>
        </form>
        {word && (
          <>
            <p>
              <strong>{word.word}</strong>: {word.count ? `${word.count} occurrence(s) in ${word.chunks.length} chunk(s)` : <span className="bad">not in the corpus</span>}
            </p>
            <div className="scroll">
              <ul className="refs">
                {word.chunks.map((c) => (
                  <li key={c.id}>
                    <button className="link" onClick={() => openChunk(c.id)}>{c.id}</button> <span className="small muted">× {c.count}</span>
                    <p className="preview">{c.snippet}</p>
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function QuestionMode({ docs, set, sets, openChunk }: { docs: string[]; set?: QuestionSet; sets: QuestionSet[]; openChunk: (id: string) => void }) {
  const [question, setQuestion] = useState("");
  const [evidence, setEvidence] = useState<string[]>([]);
  const [result, setResult] = useState<QResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pickable = set ? [set] : sets;

  async function analyse(q = question, ev = evidence) {
    if (!q.trim()) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await call<QResult>("/api/words", json("POST", { docs, question: q, evidence: ev.slice(0, 10) })));
    } catch (e) {
      setError((e as Error).message);
      setResult(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="row">
        <select
          value=""
          onChange={(e) => {
            const [sid, qid] = e.target.value.split("|");
            const q = sets.find((s) => s.id === sid)?.questions.find((x) => x.id === qid);
            if (!q) return;
            const ev = q.evidence.map((x) => x.quote);
            setQuestion(q.question);
            setEvidence(ev);
            analyse(q.question, ev);
          }}
        >
          <option value="">Pick a question from a set…</option>
          {pickable.map((s) => (
            <optgroup key={s.id} label={s.name}>
              {s.questions.map((q) => <option key={q.id} value={`${s.id}|${q.id}`}>{q.id} [{q.type}] {q.question}</option>)}
            </optgroup>
          ))}
        </select>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          analyse();
        }}
      >
        <textarea rows={2} value={question} placeholder="or type a question" onChange={(e) => { setQuestion(e.target.value); setEvidence([]); }} />
        <div className="row">
          <span className="small muted">{evidence.length ? `${evidence.length} evidence quote(s) from the question set: the chunks holding the answer are marked.` : "Typed question: no evidence known."}</span>
          <button type="submit" disabled={busy || !question.trim()}>{busy ? "Analysing…" : "Analyse"}</button>
        </div>
      </form>
      {error && <p role="alert">{error}</p>}
      {result && (
        <div className="result">
          {result.absent.length > 0 && (
            <p className="notice error">Not in the corpus at all: <strong>{result.absent.join(", ")}</strong></p>
          )}
          <p className="small">
            Chunks holding the answer:{" "}
            {result.evidence_chunks.length ? result.evidence_chunks.map((id) => <button key={id} className="link small" onClick={() => openChunk(id)}>{id}</button>) : <span className="muted">{evidence.length ? "none contains a whole quote (cut by a boundary?)" : "unknown"}</span>}
            {evidence.length > 0 && result.evidence_chunks.length > 0 && (
              <> · retrieval (top-{result.retrieved.length}) {result.retrieved_contains_evidence ? <span className="good">found one</span> : <span className="bad">MISSED them</span>}</>
            )}
          </p>
          <table>
            <thead>
              <tr><th>Word</th><th>In corpus</th><th>Occurrences</th><th>Chunks</th><th>% of chunks</th><th>In the answer chunk(s)</th><th>In retrieved top-{result.retrieved.length}</th></tr>
            </thead>
            <tbody>
              {result.words.map((w) => (
                <tr key={w.word} className={w.stopword ? "muted" : ""}>
                  <td>{w.word}{w.stopword && <span className="small"> (stop)</span>}</td>
                  <td className={w.in_corpus ? "good" : "bad"}>{w.in_corpus ? "yes" : "NO"}</td>
                  <td>{w.count}</td>
                  <td>{w.chunks}</td>
                  <td>{pct(w.share_of_chunks, 0)}</td>
                  <td>{result.evidence_chunks.length ? (w.in_evidence_chunks.length ? <span className="good">yes</span> : <span className="bad">no</span>) : "–"}</td>
                  <td className="small">{w.in_retrieved.length ? `${w.in_retrieved.length} of ${result.retrieved.length}` : "0"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3>Retrieved (current settings)</h3>
          <ol className="retrieved">
            {result.retrieved.map((r) => (
              <li key={r.id}>
                <button className="link" onClick={() => openChunk(r.id)}>{r.id}</button> <span className="small muted">{r.score.toFixed(3)}{result.evidence_chunks.includes(r.id) ? " · holds the answer" : ""}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
