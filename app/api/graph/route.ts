import { z } from "zod";
import { AppError, errorResponse } from "@/lib/errors";
import { buildGraph, graphStats, loadGraph } from "@/lib/graph";
import { getSet } from "@/lib/questions";
import { getSettings } from "@/lib/settings";
import { ensureIndexes } from "@/lib/store";

export const dynamic = "force-dynamic";
export const maxDuration = 900;

// GET ?set=kestrel -> the graph of that set (current chunk settings): stats, cost, entities, edges,
// merges (entity resolution), type conflicts, failed chunks. null if not built.
export async function GET(request: Request) {
  try {
    const set = await getSet(new URL(request.url).searchParams.get("set") ?? "kestrel");
    const g = await loadGraph(await getSettings(), set.docs);
    if (!g || !g.built_at) return Response.json({ graph: null });
    const failed = Object.entries(g.extractions)
      .filter(([, x]) => !x.ok)
      .map(([id, x]) => ({ id, error: x.error ?? "" }));
    return Response.json({ graph: { stats: graphStats(g), nodes: g.nodes, edges: g.edges, merges: g.merges, type_conflicts: g.type_conflicts, failed } });
  } catch (error) {
    return errorResponse(error);
  }
}

// POST { set, rebuild?, retryFailed? } -> build (or resume) the graph: one LLM call per chunk.
export async function POST(request: Request) {
  try {
    const parsed = z
      .object({ set: z.string(), rebuild: z.boolean().optional(), retryFailed: z.boolean().optional() })
      .strict()
      .safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new AppError("invalid_request", "Send { set, rebuild?, retryFailed? }.");
    const set = await getSet(parsed.data.set);
    const settings = await getSettings();
    await ensureIndexes(set.docs, settings);
    return Response.json({ stats: await buildGraph(set.docs, settings, { rebuild: parsed.data.rebuild, retryFailed: parsed.data.retryFailed }) });
  } catch (error) {
    return errorResponse(error);
  }
}
