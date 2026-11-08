import { z } from "zod";
import { checkDocId } from "@/lib/docs";
import { AppError, errorResponse } from "@/lib/errors";
import { getSettings } from "@/lib/settings";
import { retrieve } from "@/lib/retrieve";

export const dynamic = "force-dynamic";

// POST { question, docs, topK? } -> retrieval only (no LLM call): the fused top-k chunks, with the
// retriever(s) that found each one, and the graph path when the graph retriever is on.
export async function POST(request: Request) {
  try {
    const parsed = z
      .object({ question: z.string().trim().min(1).max(500), docs: z.array(z.string()).min(1).max(50), topK: z.number().int().min(1).max(50).optional() })
      .strict()
      .safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new AppError("invalid_request", "Send { question, docs: [...], topK? }.");
    parsed.data.docs.forEach(checkDocId);
    const settings = await getSettings();
    const k = parsed.data.topK ?? settings.topK;
    const r = await retrieve(parsed.data.question, parsed.data.docs, settings, k);
    return Response.json({ settings: { ...settings, topK: k }, hits: r.hits, lists: r.lists, graph: r.path ? { available: r.graph_available, path: r.path } : null, ms: r.ms });
  } catch (error) {
    return errorResponse(error);
  }
}
