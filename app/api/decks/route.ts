import { z } from "zod";
import { AppError, errorResponse } from "@/lib/errors";
import { deleteDeck, dueCards, getDeck, listDecks, recordAttempt, reviewCard, summarize } from "@/lib/decks";

export const dynamic = "force-dynamic";

// GET            -> the saved decks (title, kind, items, last / best score, cards due)
// GET ?id=       -> one deck with its items, attempts and card states, and the cards due now
// DELETE ?id=    -> delete a deck
// POST { id, action: "attempt", score, wrong: [n] } -> save a quiz attempt
// POST { id, action: "review", n, knew }            -> Leitner step for one flashcard
export async function GET(request: Request) {
  try {
    const id = new URL(request.url).searchParams.get("id");
    if (!id) return Response.json({ decks: await listDecks() });
    const d = await getDeck(id);
    return Response.json({ deck: d, summary: summarize(d), due: dueCards(d) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const id = new URL(request.url).searchParams.get("id");
    if (!id) throw new AppError("invalid_request", "Send ?id=");
    await deleteDeck(id);
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}

const Body = z.discriminatedUnion("action", [
  z.object({ id: z.string(), action: z.literal("attempt"), score: z.number().min(0).max(100), wrong: z.array(z.number().int()).max(100) }).strict(),
  z.object({ id: z.string(), action: z.literal("review"), n: z.number().int(), knew: z.boolean() }).strict(),
]);

export async function POST(request: Request) {
  try {
    const parsed = Body.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new AppError("invalid_request", 'Send { id, action: "attempt", score, wrong } or { id, action: "review", n, knew }.');
    const b = parsed.data;
    const d = b.action === "attempt" ? await recordAttempt(b.id, b.score, b.wrong) : await reviewCard(b.id, b.n, b.knew);
    return Response.json({ summary: summarize(d), due: dueCards(d), card: b.action === "review" ? d.cards[b.n] : undefined });
  } catch (error) {
    return errorResponse(error);
  }
}
