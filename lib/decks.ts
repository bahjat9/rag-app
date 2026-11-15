// V4 · Part B, polished: every quiz / set of flashcards is saved as a "deck" so the user can come
// back to it, see their scores, practise the questions they got wrong and review the cards with
// spaced repetition.
//
// Storage: one JSON file per deck in data/decks/ (never committed, like the traces: it is the
// user's own study data). No database: one user, one laptop.
//
// Spaced repetition = the Leitner system (a box of cards, 5 compartments):
//   every card starts in box 1. "I knew it" moves it one box up, "I didn't know" sends it back to
//   box 1. A card is due again after INTERVAL_DAYS[box] days: box 1 = tomorrow, box 5 = in 16 days.
//   So the cards you miss come back often and the ones you know come back rarely.
// We picked Leitner over SM-2 (Anki's algorithm) because it fits in a few lines and every step can
// be explained; the user only answers "knew it / didn't know".
import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { AppError } from "./errors";
import type { StudyItem } from "./study";

const DIR = path.join(process.cwd(), "data", "decks");
export const INTERVAL_DAYS = [0, 1, 2, 4, 8, 16]; // index = box (1..5)
const DAY = 24 * 3600 * 1000;

export type Attempt = { at: string; score: number; total: number; wrong: number[] };
export type CardState = { box: number; due: string; reviews: number };
export type Deck = {
  id: string;
  created_at: string;
  kind: "quiz" | "flashcards";
  title: string;
  docs: string[];
  difficulty: string;
  items: StudyItem[];
  attempts: Attempt[]; // quizzes: one per "Check my answers"
  cards: Record<number, CardState>; // flashcards: Leitner state per card number
  traceId: string;
};
export type DeckSummary = Pick<Deck, "id" | "created_at" | "kind" | "title" | "docs" | "difficulty"> & {
  items: number;
  last_score: { score: number; total: number } | null;
  best_score: number | null; // in %
  due: number; // flashcards due now
};

const fileOf = (id: string) => {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new AppError("invalid_request", "Unknown deck.");
  return path.join(DIR, `${id}.json`);
};

export async function saveDeck(d: Omit<Deck, "id" | "created_at" | "attempts" | "cards">): Promise<Deck> {
  const now = new Date().toISOString();
  const deck: Deck = { ...d, id: randomUUID(), created_at: now, attempts: [], cards: {} };
  // a new flashcard is in box 1 and due now
  if (deck.kind === "flashcards") for (const it of deck.items) deck.cards[it.n] = { box: 1, due: now, reviews: 0 };
  await fs.mkdir(DIR, { recursive: true });
  await fs.writeFile(fileOf(deck.id), JSON.stringify(deck, null, 1), "utf8");
  return deck;
}

export async function getDeck(id: string): Promise<Deck> {
  try {
    return JSON.parse(await fs.readFile(fileOf(id), "utf8")) as Deck;
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError("not_found", "This deck does not exist any more.");
  }
}

async function writeDeck(d: Deck) {
  await fs.writeFile(fileOf(d.id), JSON.stringify(d, null, 1), "utf8");
}

export const dueCards = (d: Deck, now = Date.now()) => (d.kind === "flashcards" ? d.items.filter((it) => Date.parse(d.cards[it.n]?.due ?? "0") <= now).map((it) => it.n) : []);

export function summarize(d: Deck): DeckSummary {
  const last = d.attempts.at(-1);
  const best = d.attempts.length ? Math.max(...d.attempts.map((a) => (a.total ? (a.score / a.total) * 100 : 0))) : null;
  return {
    id: d.id,
    created_at: d.created_at,
    kind: d.kind,
    title: d.title,
    docs: d.docs,
    difficulty: d.difficulty,
    items: d.items.length,
    last_score: last ? { score: last.score, total: last.total } : null,
    best_score: best == null ? null : Math.round(best),
    due: dueCards(d).length,
  };
}

export async function listDecks(): Promise<DeckSummary[]> {
  let files: string[];
  try {
    files = await fs.readdir(DIR);
  } catch {
    return [];
  }
  const out: DeckSummary[] = [];
  for (const f of files.filter((x) => x.endsWith(".json"))) {
    try {
      out.push(summarize(JSON.parse(await fs.readFile(path.join(DIR, f), "utf8")) as Deck));
    } catch {
      /* a damaged file is skipped */
    }
  }
  return out.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function deleteDeck(id: string) {
  await fs.rm(fileOf(id), { force: true });
}

/** Save the result of one quiz attempt (score can include halves: "partly right" short answers). */
export async function recordAttempt(id: string, score: number, wrong: number[]): Promise<Deck> {
  const d = await getDeck(id);
  if (d.kind !== "quiz") throw new AppError("invalid_request", "Only a quiz has scores.");
  const ns = new Set(d.items.map((i) => i.n));
  d.attempts.push({ at: new Date().toISOString(), score: Math.max(0, Math.min(d.items.length, score)), total: d.items.length, wrong: wrong.filter((n) => ns.has(n)) });
  await writeDeck(d);
  return d;
}

/** Leitner step for one card: knew it -> next box, didn't -> box 1; due again after its interval. */
export function leitner(state: CardState | undefined, knew: boolean, now = Date.now()): CardState {
  const box = knew ? Math.min(5, (state?.box ?? 1) + 1) : 1;
  return { box, due: new Date(now + INTERVAL_DAYS[box] * DAY).toISOString(), reviews: (state?.reviews ?? 0) + 1 };
}

export async function reviewCard(id: string, n: number, knew: boolean): Promise<Deck> {
  const d = await getDeck(id);
  if (d.kind !== "flashcards" || !d.items.some((i) => i.n === n)) throw new AppError("invalid_request", "No such card.");
  d.cards[n] = leitner(d.cards[n], knew);
  await writeDeck(d);
  return d;
}
