"use client";

// V4 · Part B: study artifacts. The user picks documents (left panel), a quiz or flashcards, how
// many, how hard, and optionally a topic. Every question / card has a "source" link that opens the
// passage it was built from.
// Polished after the 15 Nov message:
//   - every quiz / set of cards is saved as a deck ("My decks"): open it again later;
//   - a quiz keeps the score of every attempt; "Practise my mistakes" asks only the questions
//     answered wrong last time; short answers are graded by the AI against the passage, with feedback;
//   - flashcards are reviewed with spaced repetition (Leitner boxes): "I knew it" / "I didn't know";
//   - export: flashcards to Anki (tab-separated file), a quiz to paper / PDF (print, with answer key).
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
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
  deckId: string;
};
type Attempt = { at: string; score: number; total: number; wrong: number[] };
type CardState = { box: number; due: string; reviews: number };
type Deck = { id: string; created_at: string; kind: "quiz" | "flashcards"; title: string; docs: string[]; difficulty: string; items: Item[]; attempts: Attempt[]; cards: Record<number, CardState>; traceId: string };
type DeckSummary = { id: string; created_at: string; kind: "quiz" | "flashcards"; title: string; difficulty: string; items: number; last_score: { score: number; total: number } | null; best_score: number | null; due: number };
type Grade = { verdict: "correct" | "partly" | "wrong"; feedback: string; by: "rule" | "ai"; traceId?: string };

const TYPES = [
  ["multiple_choice", "Multiple choice"],
  ["true_false", "True / false"],
  ["short_answer", "Short answer"],
] as const;
const date = (iso: string) => iso.replace("T", " ").slice(0, 16);

export function StudyTab({ selected, notReady }: { selected: string[]; notReady: string[] }) {
  const [kind, setKind] = useState<"quiz" | "flashcards">("quiz");
  const [count, setCount] = useState(5);
  const [difficulty, setDifficulty] = useState<"easy" | "medium" | "hard">("medium");
  const [types, setTypes] = useState<string[]>(["multiple_choice", "true_false"]);
  const [topic, setTopic] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; traceId?: string } | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [decks, setDecks] = useState<DeckSummary[]>([]);
  const [deck, setDeck] = useState<{ deck: Deck; due: number[] } | null>(null);
  const [trace, setTrace] = useState<string | null>(null);
  const { openChunk, modal } = useChunkModal();

  const loadDecks = useCallback(async () => {
    try {
      setDecks((await call<{ decks: DeckSummary[] }>("/api/decks")).decks);
    } catch {
      /* the list is optional */
    }
  }, []);
  useEffect(() => {
    loadDecks();
  }, [loadDecks]);

  async function openDeck(id: string) {
    try {
      const r = await call<{ deck: Deck; due: number[] }>(`/api/decks?id=${id}`);
      setDeck(r);
      setError(null);
      if (result?.deckId !== id) setResult(null);
    } catch (e) {
      setError({ text: (e as Error).message });
    }
  }

  async function removeDeck(id: string) {
    if (!confirm("Delete this deck and its scores?")) return;
    await call(`/api/decks?id=${id}`, { method: "DELETE" }).catch(() => null);
    if (deck?.deck.id === id) setDeck(null);
    await loadDecks();
  }

  async function generate(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    setDeck(null);
    try {
      const r = await call<Result>("/api/study", json("POST", { docs: selected, kind, count, difficulty, types: kind === "quiz" ? types : undefined, topic: topic.trim() || undefined }));
      setResult(r);
      await openDeck(r.deckId);
      await loadDecks();
    } catch (err) {
      setError({ text: (err as Error).message, traceId: traceIdOf(err) });
    } finally {
      setBusy(false);
    }
  }

  const blocked = !selected.length ? "Select at least one document on the left." : notReady.length ? `Prepare the selected documents first (${notReady.join(", ")}).` : null;
  const dueTotal = decks.reduce((a, d) => a + d.due, 0);

  return (
    <>
      <section className="panel noprint">
        <h2>Study</h2>
        <p className="small muted">Turn the selected documents into a quiz or flashcards. Every question links to the passage it comes from, and every quiz is saved in “My decks” below.</p>
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

      {decks.length > 0 && (
        <section className="panel noprint">
          <div className="row">
            <h2>My decks</h2>
            {dueTotal > 0 && <span className="small"><strong>{dueTotal}</strong> card(s) to review today</span>}
          </div>
          <table className="small">
            <thead><tr><th>Deck</th><th>Type</th><th>Items</th><th>Created</th><th>Progress</th><th></th></tr></thead>
            <tbody>
              {decks.map((d) => (
                <tr key={d.id} className={deck?.deck.id === d.id ? "focus" : undefined}>
                  <td><button className="link" onClick={() => openDeck(d.id)} title="open">{d.title.length > 60 ? d.title.slice(0, 60) + "…" : d.title}</button></td>
                  <td>{d.kind === "quiz" ? "Quiz" : "Flashcards"} · {d.difficulty}</td>
                  <td>{d.items}</td>
                  <td>{date(d.created_at)}</td>
                  <td>
                    {d.kind === "quiz"
                      ? d.last_score
                        ? `last ${fmt(d.last_score.score)} / ${d.last_score.total} · best ${d.best_score} %`
                        : "not taken yet"
                      : d.due
                        ? <strong>{d.due} to review</strong>
                        : "nothing due"}
                  </td>
                  <td><button className="link danger" onClick={() => removeDeck(d.id)} aria-label="delete deck">×</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {deck && (
        <section className="panel">
          <div className="row noprint">
            <h2>{deck.deck.kind === "quiz" ? "Quiz" : "Flashcards"}: {deck.deck.title.length > 50 ? deck.deck.title.slice(0, 50) + "…" : deck.deck.title}</h2>
            <span className="small muted">
              {deck.deck.items.length} item(s)
              {result && result.deckId === deck.deck.id && <> · {result.usage?.total_tokens ?? 0} tokens · {usd(result.cost_usd)} · {(result.llm_ms / 1000).toFixed(1)} s</>}{" "}
              <button className="link" onClick={() => setTrace(deck.deck.traceId)}>Details</button>
            </span>
          </div>
          {result && result.deckId === deck.deck.id && result.warnings.map((w) => <p key={w} className="small warn noprint">⚠ {w}</p>)}
          {deck.deck.kind === "quiz" ? (
            <Quiz key={deck.deck.id} deck={deck.deck} openChunk={openChunk} onTrace={setTrace} onSaved={loadDecks} />
          ) : (
            <Cards key={deck.deck.id} deck={deck.deck} due={deck.due} openChunk={openChunk} onSaved={async () => { await loadDecks(); }} />
          )}
        </section>
      )}
      {trace && <TraceModal id={trace} onClose={() => setTrace(null)} openChunk={openChunk} />}
      {modal}
    </>
  );
}

const fmt = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(1));
const VERDICT = { correct: "Right.", partly: "Partly right.", wrong: "Not quite." } as const;

function Quiz({ deck, openChunk, onTrace, onSaved }: { deck: Deck; openChunk: (id: string) => void; onTrace: (id: string) => void; onSaved: () => void }) {
  const [given, setGiven] = useState<Record<number, string>>({});
  const [grades, setGrades] = useState<Record<number, Grade> | null>(null);
  const [grading, setGrading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempts, setAttempts] = useState<Attempt[]>(deck.attempts);
  const [only, setOnly] = useState<number[] | null>(null); // "practise my mistakes": these items only
  const items = useMemo(() => (only ? deck.items.filter((i) => only.includes(i.n)) : deck.items), [deck.items, only]);
  const lastWrong = attempts.at(-1)?.wrong ?? [];

  async function check() {
    setGrading(true);
    setError(null);
    const out: Record<number, Grade> = {};
    try {
      // multiple choice and true/false: compared here; short answers: graded on the server
      await Promise.all(
        items.map(async (it) => {
          const g = given[it.n] ?? "";
          if (it.type === "short_answer") {
            out[it.n] = await call<Grade>("/api/study/grade", json("POST", { deckId: deck.id, n: it.n, answer: g }));
          } else {
            out[it.n] = g === it.answer ? { verdict: "correct", feedback: "", by: "rule" } : { verdict: "wrong", feedback: g ? "" : "No answer given.", by: "rule" };
          }
        }),
      );
      setGrades(out);
      const score = items.reduce((a, it) => a + (out[it.n].verdict === "correct" ? 1 : out[it.n].verdict === "partly" ? 0.5 : 0), 0);
      const wrong = items.filter((it) => out[it.n].verdict !== "correct").map((it) => it.n);
      if (!only) {
        // only a full attempt counts in the history (practice rounds are not scored)
        await call("/api/decks", json("POST", { id: deck.id, action: "attempt", score, wrong }));
        setAttempts([...attempts, { at: new Date().toISOString(), score, total: items.length, wrong }]);
        onSaved();
      }
    } catch (e) {
      setError(`${(e as Error).message} Your answers are kept: try "Check my answers" again.`);
      const t = traceIdOf(e);
      if (t) onTrace(t);
    } finally {
      setGrading(false);
    }
  }

  function restart(onlyThese: number[] | null) {
    setGiven({});
    setGrades(null);
    setOnly(onlyThese);
  }

  const score = grades ? items.reduce((a, it) => a + (grades[it.n]?.verdict === "correct" ? 1 : grades[it.n]?.verdict === "partly" ? 0.5 : 0), 0) : 0;
  const answered = items.filter((it) => (given[it.n] ?? "").trim()).length;

  return (
    <>
      {only && <p className="small notice noprint">Practising your {only.length} mistake(s) from the last attempt. This round is not added to your scores. <button className="link" onClick={() => restart(null)}>back to the full quiz</button></p>}
      {attempts.length > 0 && !grades && (
        <p className="small muted noprint">
          Your attempts: {attempts.slice(-5).map((a) => `${fmt(a.score)}/${a.total}`).join(" → ")}
          {!only && lastWrong.length > 0 && (
            <>
              {" "}· <button className="link" onClick={() => restart(lastWrong)}>Practise my {lastWrong.length} mistake(s)</button>
            </>
          )}
        </p>
      )}
      {items.map((it, idx) => {
        const g = grades?.[it.n];
        return (
          <div key={it.n} className={`gradecard ${g ? (g.verdict === "correct" ? "right" : g.verdict === "partly" ? "partlyans" : "wrongans") : ""}`}>
            <p>
              <strong>{idx + 1}.</strong> {it.question} {it.check && <span className="small warn noprint" title="The answer shares no word with its passage">(check this one)</span>}
            </p>
            {it.type === "short_answer" ? (
              <>
                <input type="text" className="note noprint" value={given[it.n] ?? ""} disabled={!!grades || grading} placeholder="Your answer (graded against the passage)" onChange={(e) => setGiven({ ...given, [it.n]: e.target.value })} />
                <p className="printonly">Answer: ______________________________________________</p>
              </>
            ) : (
              <div>
                {it.options.map((o, k) => (
                  <label key={o} className="gradeopt block">
                    <input type="radio" name={`q${deck.id}-${it.n}`} disabled={!!grades || grading} checked={given[it.n] === o} onChange={() => setGiven({ ...given, [it.n]: o })} />{" "}
                    <span className="printonly">{String.fromCharCode(65 + k)}. </span>
                    {o}
                    {g && o === it.answer && " ✓"}
                  </label>
                ))}
              </div>
            )}
            {g && (
              <p className="small">
                <strong>{VERDICT[g.verdict]}</strong> {g.verdict !== "correct" && `Expected: ${it.answer}.`} {g.feedback && g.by === "ai" && <em>{g.feedback} </em>}
                {it.explanation}{" "}
                <button className="link small" onClick={() => openChunk(it.chunk.id)}>source: {it.chunk.id}</button>
                {g.traceId && (
                  <>
                    {" "}· <button className="link small" onClick={() => onTrace(g.traceId!)}>how it was graded</button>
                  </>
                )}
              </p>
            )}
            {!g && (
              <p className="small muted noprint">
                <button className="link small" onClick={() => openChunk(it.chunk.id)}>source</button>
              </p>
            )}
          </div>
        );
      })}
      {error && <p role="alert" className="noprint">{error}</p>}
      <div className="row noprint">
        {grades ? (
          <strong>
            Score: {fmt(score)} / {items.length}
          </strong>
        ) : (
          <span className="small muted">{answered} / {items.length} answered</span>
        )}
        <span>
          <button className="link small" onClick={() => window.print()} title="Print the quiz, or save it as PDF, with the answer key on the last page">Print / PDF</button>{" "}
          {grades ? (
            <>
              {!only && items.some((it) => grades[it.n]?.verdict !== "correct") && (
                <button className="secondary" onClick={() => restart(items.filter((it) => grades[it.n]?.verdict !== "correct").map((it) => it.n))}>Practise my mistakes</button>
              )}{" "}
              <button onClick={() => restart(only)}>Try again</button>
            </>
          ) : (
            <button onClick={check} disabled={grading}>{grading ? "Grading…" : "Check my answers"}</button>
          )}
        </span>
      </div>
      <div className="printonly answerkey">
        <h3>Answer key</h3>
        <ol>
          {items.map((it) => (
            <li key={it.n}>{it.answer} <span className="small">({it.chunk.id})</span></li>
          ))}
        </ol>
      </div>
    </>
  );
}

function Cards({ deck, due: dueAtOpen, openChunk, onSaved }: { deck: Deck; due: number[]; openChunk: (id: string) => void; onSaved: () => void }) {
  const [mode, setMode] = useState<"review" | "browse">(dueAtOpen.length ? "review" : "browse");
  const [queue, setQueue] = useState<number[]>(dueAtOpen);
  const [cards, setCards] = useState(deck.cards);
  const [i, setI] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const byN = new Map(deck.items.map((it) => [it.n, it]));
  const it = mode === "review" ? byN.get(queue[0]) : deck.items[i];

  async function answer(knew: boolean) {
    if (!it) return;
    try {
      const r = await call<{ card: CardState }>("/api/decks", json("POST", { id: deck.id, action: "review", n: it.n, knew }));
      setCards({ ...cards, [it.n]: r.card });
      setQueue(queue.slice(1));
      setFlipped(false);
      setError(null);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function exportAnki() {
    // Anki: File > Import, "Fields separated by: Tab"; 3rd field = where the card comes from
    const clean = (s: string) => s.replace(/[\t\r\n]+/g, " ").trim();
    const tsv = deck.items.map((c) => `${clean(c.question)}\t${clean(c.answer)}\t${clean(c.chunk.id)}`).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([tsv + "\n"], { type: "text/tab-separated-values;charset=utf-8" }));
    a.download = `${deck.title.replace(/[^\w-]+/g, "_").slice(0, 40) || "flashcards"}.anki.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const boxes = [1, 2, 3, 4, 5].map((b) => deck.items.filter((c) => (cards[c.n]?.box ?? 1) === b).length);
  const nextDue = deck.items.map((c) => cards[c.n]?.due).filter(Boolean).sort()[0];

  return (
    <>
      <div className="row">
        <span className="retrievers small">
          <label className="inline">
            <input type="radio" checked={mode === "review"} onChange={() => { setMode("review"); setFlipped(false); }} /> Review ({queue.length} due)
          </label>
          <label className="inline">
            <input type="radio" checked={mode === "browse"} onChange={() => { setMode("browse"); setFlipped(false); }} /> Browse all
          </label>
        </span>
        <button className="link small" onClick={exportAnki} title="A tab-separated file: in Anki, File > Import">Export to Anki</button>
      </div>
      <p className="small muted">
        Boxes {boxes.map((n, b) => `${b + 1}: ${n}`).join(" · ")}. A card you know moves up one box and comes back later (box 1: tomorrow → box 5: in 16 days); a card you miss goes back to box 1.
      </p>
      {mode === "review" && !it && (
        <p className="notice small">Nothing to review right now. {nextDue && `Next card due ${date(nextDue)} (UTC).`} Use “Browse all” to look at the cards anyway.</p>
      )}
      {it && (
        <>
          <button className="flashcard" onClick={() => setFlipped(!flipped)} aria-label="flip the card">
            <span className="small muted">
              {flipped ? "Answer" : "Card"} {mode === "review" ? `· ${queue.length} left` : `${i + 1} / ${deck.items.length}`} · box {cards[it.n]?.box ?? 1} · click to flip
            </span>
            <span className="cardtext">{flipped ? it.answer : it.question}</span>
            {it.check && <span className="small warn">(check this one)</span>}
          </button>
          {mode === "review" ? (
            <div className="row">
              <button className="secondary" disabled={!flipped} onClick={() => answer(false)}>✗ I didn&apos;t know</button>
              <button className="link small" onClick={() => openChunk(it.chunk.id)}>source: {it.chunk.id}</button>
              <button disabled={!flipped} onClick={() => answer(true)}>✓ I knew it</button>
            </div>
          ) : (
            <div className="row">
              <button disabled={i === 0} onClick={() => { setI(i - 1); setFlipped(false); }}>← Previous</button>
              <button className="link small" onClick={() => openChunk(it.chunk.id)}>source: {it.chunk.id}</button>
              <button disabled={i === deck.items.length - 1} onClick={() => { setI(i + 1); setFlipped(false); }}>Next →</button>
            </div>
          )}
          {mode === "review" && !flipped && <p className="small muted">Think of the answer, flip the card, then say whether you knew it.</p>}
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </>
  );
}
