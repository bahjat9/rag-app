import { z } from "zod";
import { AppError, errorResponse } from "@/lib/errors";
import { getSettings } from "@/lib/settings";
import { buildIndex } from "@/lib/store";
import { startTrace } from "@/lib/trace";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

// POST { docs: string[] } -> (re)build the index of each document with the current settings.
export async function POST(request: Request) {
  try {
    const parsed = z.object({ docs: z.array(z.string()).min(1).max(50) }).safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new AppError("invalid_request", "Send { docs: [...] } with at least one document.");
    const settings = await getSettings();
    // V4: one trace for the whole indexing run, one span per step and per document
    const tracer = startTrace("index", { docs: parsed.data.docs, settings: { chunkSize: settings.chunkSize, overlapPercent: settings.overlapPercent, minParagraphLength: settings.minParagraphLength } });
    const results = [];
    try {
      for (const d of parsed.data.docs) results.push({ doc: d, ...(await buildIndex(d, settings, tracer)) });
    } catch (error) {
      await tracer.end("error", error);
      throw Object.assign(error as object, { traceId: tracer.id });
    }
    tracer.setOutput({ chunks: results.reduce((a, r) => a + r.chunks, 0) });
    await tracer.end("ok");
    return Response.json({ indexed: results, settings, traceId: tracer.id });
  } catch (error) {
    return errorResponse(error);
  }
}
