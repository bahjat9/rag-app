import { AppError, errorResponse } from "@/lib/errors";
import { getTrace, readTraces } from "@/lib/trace";

export const dynamic = "force-dynamic";

// GET ?id=<trace id> -> one trace (spans, tokens, cost).
// GET ?kind=ask&limit=50 -> the latest traces, summarised (no spans).
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    if (id) {
      const t = await getTrace(id);
      if (!t) throw new AppError("not_found", "Trace not found (traces are kept for a limited time).");
      return Response.json(t);
    }
    const kind = url.searchParams.get("kind");
    const limit = Math.min(200, Number(url.searchParams.get("limit")) || 50);
    const traces = (await readTraces()).filter((t) => !kind || t.kind === kind).slice(0, limit);
    return Response.json({
      traces: traces.map((t) => ({
        id: t.id,
        kind: t.kind,
        started_at: t.started_at,
        duration_ms: t.duration_ms,
        outcome: t.outcome,
        error: t.error,
        summary: String(t.input.question ?? t.input.topic ?? (Array.isArray(t.input.docs) ? (t.input.docs as string[]).join(", ") : "")).slice(0, 140),
        totals: t.totals,
        spans: t.spans.length,
      })),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
