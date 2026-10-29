import { z } from "zod";
import { AppError, errorResponse } from "@/lib/errors";
import { getSettings } from "@/lib/settings";
import { buildIndex } from "@/lib/store";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

// POST { docs: string[] } -> (re)build the index of each document with the current settings.
export async function POST(request: Request) {
  try {
    const parsed = z.object({ docs: z.array(z.string()).min(1).max(50) }).safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new AppError("invalid_request", "Send { docs: [...] } with at least one document.");
    const settings = await getSettings();
    const results = [];
    for (const d of parsed.data.docs) results.push({ doc: d, ...(await buildIndex(d, settings)) });
    return Response.json({ indexed: results, settings });
  } catch (error) {
    return errorResponse(error);
  }
}
