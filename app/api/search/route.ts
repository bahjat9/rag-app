import { z } from "zod";
import { checkDocId } from "@/lib/docs";
import { AppError, errorResponse } from "@/lib/errors";
import { getSettings } from "@/lib/settings";
import { search } from "@/lib/store";

export const dynamic = "force-dynamic";

// POST { question, docs, topK? } -> retrieval only (no LLM call): the top-k chunks with their scores.
export async function POST(request: Request) {
  try {
    const parsed = z
      .object({ question: z.string().trim().min(1).max(500), docs: z.array(z.string()).min(1).max(50), topK: z.number().int().min(1).max(50).optional() })
      .strict()
      .safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new AppError("invalid_request", "Send { question, docs: [...], topK? }.");
    parsed.data.docs.forEach(checkDocId);
    const settings = await getSettings();
    const hits = await search(parsed.data.question, parsed.data.docs, { ...settings, topK: parsed.data.topK ?? settings.topK });
    return Response.json({ settings: { ...settings, topK: parsed.data.topK ?? settings.topK }, hits });
  } catch (error) {
    return errorResponse(error);
  }
}
