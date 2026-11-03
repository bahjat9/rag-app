import { AppError, errorResponse } from "@/lib/errors";
import { EvalOptionsSchema, listRuns, resultsMarkdown, runEval } from "@/lib/evaluate";

export const dynamic = "force-dynamic";
export const maxDuration = 900;

// GET -> summaries of every run (+ the results table in Markdown).
export async function GET() {
  try {
    const runs = await listRuns();
    return Response.json({ runs, markdown: resultsMarkdown(runs) });
  } catch (error) {
    return errorResponse(error);
  }
}

// POST { set, chunkSize?, overlapPercent?, minParagraphLength?, topK?, answers?, label? } -> run the evaluation.
// Builds the indexes the configuration needs. Retrieval only (free) unless answers = true.
export async function POST(request: Request) {
  try {
    const parsed = EvalOptionsSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new AppError("invalid_request", "Send { set, chunkSize?, overlapPercent?, minParagraphLength?, topK?, answers?, label? }.");
    return Response.json(await runEval(parsed.data));
  } catch (error) {
    return errorResponse(error);
  }
}
