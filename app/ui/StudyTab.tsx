"use client";

// V4 · Part B: study artifacts. The user picks documents (left panel), a quiz or flashcards, how
// many, how hard, and optionally a topic. Every question / card has a "source" link that opens the
// passage it was built from. Quizzes are interactive: answer, then "Check my answers" gives a score.
import { useState, type FormEvent } from "react";
import { call, json, traceIdOf, useChunkModal } from "./common";
import { TraceModal, usd } from "./TraceView";

type Item = {
  n: number;
  type: "multiple_choice" | "true_false" | "short_answer" | "flashcard";
  question: string;
  options: string[];
  answer: string;
  explanation: string;
  chunk: { id: string; doc: string };
  check: boolean;
};
type Result = {
  kind: "quiz" | "flashcards";
  items: Item[];
  requested: number;
  dropped: { reason: string; n: number }[];
  warnings: string[];
  usage: { input_tokens: number; output_tokens: number; total_tokens: number } | null;
  cost_usd: number;
  llm_ms: number;
  traceId: string;
};
const TYPES = [
  ["multiple_choice", "Multiple choice"],
  ["true_false", "True / false"],
  ["short_answer", "Short answer"],
] as const;

export function StudyTab({ selected, notReady }: { selected: string[]; notReady: string[] }) {
  const [kind, setKind] = useState<"quiz" | "flashcards">("quiz");
  const [count, setCount] = useState(5);
  const [difficulty, setDifficulty] = useState<"easy" | "medium" | "hard">("medium");
  const [types, setTypes] = useState<string[]>(["multiple_choice", "true_false"]);
  const [topic, setTopic] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; traceId?: string } | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [trace, setTrace] = useState<string | null>(null);
  const { openChunk, modal } = useChunkModal();

  async function generate(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await call<Result>("/api/study", json("POST", { docs: selected, kind, count, difficulty, types: kind === "quiz" ? types : undefined, topic: topic.trim() || undefined })));
    } catch (err) {
      setError({ text: (err as Error).message, traceId: traceIdOf(err) });
    } finally {
      setBusy(false);
    }
  }

  const blocked = !selected.length ? "Select at least one document on the left." : notReady.length ? `Prepare the selected documents first (${notReady.join(", ")}).` : null;

  return (
    <>
      <section className="panel">
        <h2>Study</h2>
        <p className="small muted">Turn the selected documents into a quiz or flashcards. Every question links to the passage it comes from.</p>
        <form onSubmit={generate} className="formgrid">
          <div className="field">
            What
            <span className="retrievers">
              <label className="inline">
                <input type="radio" checked={kind === "quiz"} onChange={() => setKind("quiz")} /> Quiz
              </label>
              <label className="inline">
                <input type="radio" checked={kind === "flashcards"} onChange={() => setKind("flashcards")} /> Flashcards
              </label>
            </span>
          </div>
          <label>
            How many
            <input type="number" min={1} max={15} value={count} onChange={(e) => setCount(Math.max(1, Math.min(15, Number(e.target.value) || 1)))} />
          </label>
          <label>
            Difficulty
            <select value={difficulty} onChange={(e) => setDifficulty(e.target.value as typeof difficulty)}>
              <option value="easy">Easy</option>
              <option value="medium">Medium</option>
              <option value="hard">Hard</option>
            </select>
          </label>
          {kind === "quiz" && (
            <div className="field">
              Question types
              <span className="retrievers">
                {TYPES.map(([v, label]) => (
                  <label key={v} className="inline">
                    <input
                      type="checkbox"
                      checked={types.includes(v)}
                      onChange={(e) => {
                        const next = e.target.checked ? [...types, v] : types.filter((x) => x !== v);
                        if (next.length) setTypes(next);
                      }}
                    />{" "}
                    {label}
                  </label>
                ))}
              </span>
            </div>
          )}
          <label>
            Topic (optional)
            <input type="text" maxLength={200} value={topic} placeholder="e.g. refunds, error codes…" onChange={(e) => setTopic(e.target.value)} />
          </label>
          <div>
            <button type="submit" disabled={busy || !!blocked}>{busy ? "Writing your questions…" : kind === "quiz" ? "Create the quiz" : "Create the flashcards"}</button>
          </div>
        </form>
        {blocked && <p className="small warn">{blocked}</p>}
        {busy && <p className="notice busy small">Reading the passages and writing the {kind === "quiz" ? "questions" : "cards"}. This takes a few seconds.</p>}
        {error && (
          <p role="alert">
            {error.text} {error.traceId && <button className="link" onClick={() => setTrace(error.traceId!)}>What happened?</button>}
          </p>
        )}
      </section>

      {result && (
        <section className="panel">
          <div className="row">
            <h2>{result.kind === "quiz" ? "Your quiz" : "Your flashcards"}</h2>
            <span className="small muted">
              {result.items.length} item(s) · {result.usage?.total_tokens ?? 0} tokens · {usd(result.cost_usd)} · {(result.llm_ms / 1000).toFixed(1)} s{" "}
              <button className="link" onClick={() => setTrace(result.traceId)}>Details</button>
            </span>
          </div>
          {result.warnings.map((w) => (
            <p key={w} className="small warn">⚠ {w}</p>
          ))}
          {result.kind === "quiz" ? <Quiz items={result.items} openChunk={openChunk} /> : <Cards items={result.items} openChunk={openChunk} />}
        </section>
      )}
      {trace && <TraceModal id={trace} onClose={() => setTrace(null)} openChunk={openChunk} />}
      {modal}
    </>
  );
}

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

function Quiz({ items, openChunk }: { items: Item[]; openChunk: (id: string) => void }) {
  const [given, setGiven] = useState<Record<number, string>>({});
  const [checked, setChecked] = useState(false);
  const isRight = (it: Item) => {
    const g = given[it.n] ?? "";
    if (it.type === "short_answer") {
      const a = norm(it.answer);
      const b = norm(g);
      return !!b && (a === b || a.includes(b) || b.includes(a));
    }
    return g === it.answer;
  };
  const score = items.filter(isRight).length;
  return (
    <>
      {items.map((it) => (
        <div key={it.n} className={`gradecard ${checked ? (isRight(it) ? "right" : "wrongans") : ""}`}>
          <p>
            <strong>{it.n}.</strong> {it.question} {it.check && <span className="small warn" title="The answer shares no word with its passage">(check this one)</span>}
          </p>
          {it.type === "short_answer" ? (
            <input type="text" className="note" value={given[it.n] ?? ""} disabled={checked} placeholder="Your answer" onChange={(e) => setGiven({ ...given, [it.n]: e.target.value })} />
          ) : (
            <div>
              {it.options.map((o) => (
                <label key={o} className="gradeopt block">
                  <input type="radio" name={`q${it.n}`} disabled={checked} checked={given[it.n] === o} onChange={() => setGiven({ ...given, [it.n]: o })} /> {o}
                  {checked && o === it.answer && " ✓"}
                </label>
              ))}
            </div>
          )}
          {checked && (
            <p className="small">
              {isRight(it) ? "Right." : `Answer: ${it.answer}.`} {it.explanation}{" "}
              <button className="link small" onClick={() => openChunk(it.chunk.id)}>source: {it.chunk.id}</button>
            </p>
          )}
          {!checked && (
            <p className="small muted">
              <button className="link small" onClick={() => openChunk(it.chunk.id)}>source</button>
            </p>
          )}
        </div>
      ))}
      <div className="row">
        {checked ? (
          <strong>
            Score: {score} / {items.length}
          </strong>
        ) : (
          <span className="small muted">{Object.keys(given).length} / {items.length} answered</span>
        )}
        {checked ? (
          <button onClick={() => { setGiven({}); setChecked(false); }}>Try again</button>
        ) : (
          <button onClick={() => setChecked(true)}>Check my answers</button>
        )}
      </div>
    </>
  );
}

function Cards({ items, openChunk }: { items: Item[]; openChunk: (id: string) => void }) {
  const [i, setI] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const it = items[i];
  return (
    <>
      <button className="flashcard" onClick={() => setFlipped(!flipped)} aria-label="flip the card">
        <span className="small muted">{flipped ? "Answer" : "Card"} {i + 1} / {items.length} · click to flip</span>
        <span className="cardtext">{flipped ? it.answer : it.question}</span>
        {it.check && <span className="small warn">(check this one)</span>}
      </button>
      <div className="row">
        <button disabled={i === 0} onClick={() => { setI(i - 1); setFlipped(false); }}>← Previous</button>
        <button className="link small" onClick={() => openChunk(it.chunk.id)}>source: {it.chunk.id}</button>
        <button disabled={i === items.length - 1} onClick={() => { setI(i + 1); setFlipped(false); }}>Next →</button>
      </div>
    </>
  );
}
