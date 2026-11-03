import { z } from "zod";
import { AppError, errorResponse } from "@/lib/errors";
import { listNoContext, runNoContext, setNoContextFlag } from "@/lib/nocontext";

export const dynamic = "force-dynamic";
export const maxDuration = 900;

// GET -> every no-context run (newest first).
export async function GET() {
  try {
    return Response.json({ runs: await listNoContext() });
  } catch (error) {
    return errorResponse(error);
  }
}

// POST { set } -> ask every question of the set to the LLM without retrieval (2 LLM calls per question).
export async function POST(request: Request) {
  try {
    const parsed = z.object({ set: z.string() }).strict().safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new AppError("invalid_request", "Send { set }.");
    return Response.json(await runNoContext(parsed.data.set));
  } catch (error) {
    return errorResponse(error);
  }
}

// PATCH { file, id, flag } -> a human confirms or corrects the flag.
export async function PATCH(request: Request) {
  try {
    const parsed = z.object({ file: z.string(), id: z.string(), flag: z.boolean() }).strict().safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new AppError("invalid_request", "Send { file, id, flag }.");
    return Response.json({ summary: await setNoContextFlag(parsed.data.file, parsed.data.id, parsed.data.flag) });
  } catch (error) {
    return errorResponse(error);
  }
}
