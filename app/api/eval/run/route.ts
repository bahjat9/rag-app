import { errorResponse } from "@/lib/errors";
import { gradeSummary, readRun } from "@/lib/evaluate";

export const dynamic = "force-dynamic";

// GET ?file=<run file> -> the full run (rows, answers, grades).
export async function GET(request: Request) {
  try {
    const run = await readRun(new URL(request.url).searchParams.get("file") ?? "");
    return Response.json({ ...run, grades: gradeSummary(run.rows) });
  } catch (error) {
    return errorResponse(error);
  }
}
