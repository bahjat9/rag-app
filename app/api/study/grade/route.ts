import { z } from "zod";
import { AppError, errorResponse } from "@/lib/errors";
import { getDeck } from "@/lib/decks";
import { gradeAnswer } from "@/lib/study";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST { deckId, n, answer } -> { verdict: correct | partly | wrong, feedback, by: rule | ai, traceId? }
// Grades the user's answer to short-answer question n of a saved quiz, against its passage.
export async function POST(request: Request) {
  try {
    const parsed = z
      .object({ deckId: z.string(), n: z.number().int(), answer: z.string().max(500) })
      .strict()
      .safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new AppError("invalid_request", "Send { deckId, n, answer } (answer: 500 characters max).");
    const deck = await getDeck(parsed.data.deckId);
    const it = deck.items.find((x) => x.n === parsed.data.n);
    if (!it || it.type !== "short_answer") throw new AppError("invalid_request", "Only a short-answer question is graded this way.");
    return Response.json(await gradeAnswer({ question: it.question, expected: it.answer, given: parsed.data.answer, chunkId: it.chunk.id }));
  } catch (error) {
    return errorResponse(error);
  }
}
