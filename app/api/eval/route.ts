import { errorResponse } from "@/lib/errors";
import { listRuns, runEval } from "@/lib/evaluate";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

export async function GET() {
  return Response.json({ runs: await listRuns() });
}

// POST -> run the retrieval baseline with the current settings (no LLM call).
export async function POST() {
  try {
    return Response.json(await runEval());
  } catch (error) {
    return errorResponse(error);
  }
}
