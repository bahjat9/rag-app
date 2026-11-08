import { z } from "zod";
import { AppError, errorResponse } from "@/lib/errors";
import { gradeTriple, readTriples, sampleTriples, TRIPLE_GRADES } from "@/lib/graph";
import { getSet } from "@/lib/questions";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

// Extraction quality: 10 random triples (eval/graph-triples.json), graded by hand.
export async function GET() {
  try {
    return Response.json({ triples: await readTriples() });
  } catch (error) {
    return errorResponse(error);
  }
}

// POST { set } -> draw 10 triples (replaces the file: do it once, before grading).
export async function POST(request: Request) {
  try {
    const parsed = z.object({ set: z.string(), force: z.boolean().optional() }).strict().safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new AppError("invalid_request", "Send { set }.");
    const set = await getSet(parsed.data.set);
    return Response.json({ triples: await sampleTriples(set.docs, await getSettings(), { force: parsed.data.force }) });
  } catch (error) {
    return errorResponse(error);
  }
}

// PATCH { n, grade, note } -> save a hand grade (correct | wrong | unsupported).
export async function PATCH(request: Request) {
  try {
    const parsed = z
      .object({ n: z.number().int(), grade: z.enum(TRIPLE_GRADES).nullable(), note: z.string().max(400).default("") })
      .strict()
      .safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new AppError("invalid_request", "Send { n, grade: correct | wrong | unsupported, note }.");
    return Response.json({ counts: await gradeTriple(parsed.data.n, parsed.data.grade, parsed.data.note) });
  } catch (error) {
    return errorResponse(error);
  }
}
