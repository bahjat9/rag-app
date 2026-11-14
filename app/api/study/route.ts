import { AppError, errorResponse } from "@/lib/errors";
import { generateStudy, StudyRequestSchema } from "@/lib/study";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// POST { docs, kind: quiz|flashcards, count, difficulty, types?, topic? } -> items, each with its chunk.
export async function POST(request: Request) {
  try {
    const parsed = StudyRequestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new AppError("invalid_request", "Send { docs: [...], kind: quiz | flashcards, count 1-15, difficulty: easy | medium | hard, types?, topic? }.");
    return Response.json(await generateStudy(parsed.data));
  } catch (error) {
    return errorResponse(error);
  }
}
