import { errorResponse } from "@/lib/errors";
import { listSets, loadQuestions } from "@/lib/questions";

export const dynamic = "force-dynamic";

// GET -> the question sets, their documents and their questions.
export async function GET() {
  try {
    const sets = await listSets();
    return Response.json({ sets: await Promise.all(sets.map(async (s) => ({ ...s, questions: await loadQuestions(s) }))) });
  } catch (error) {
    return errorResponse(error);
  }
}
