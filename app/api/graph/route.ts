import { z } from "zod";
import { AppError, errorResponse } from "@/lib/errors";
import { buildGraph, buildGraphForDocs, graphForDocs, graphStats, loadGraph, restrictGraph } from "@/lib/graph";
import { listDocs } from "@/lib/docs";
import { getSet } from "@/lib/questions";
import { getSettings } from "@/lib/settings";
import { ensureIndexes } from "@/lib/store";

export const dynamic = "force-dynamic";
export const maxDuration = 900;

// GET ?docs=a.md,b.txt -> the graph used for these documents (every graph covering one of them,
//     merged, restricted to what comes from these documents), plus which of them are covered.
// GET ?set=kestrel     -> the graph built for exactly that question set (V3 evaluation).
// Both: stats, cost, entities, edges, merges (entity resolution), type conflicts, failed chunks.
export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const settings = await getSettings();
    const docsParam = params.get("docs");
    const docs = docsParam != null ? docsParam.split(",").filter(Boolean) : null;
    const full = docs ? await graphForDocs(settings, docs) : null;
    const g = docs ? full && restrictGraph(full, docs) : await loadGraph(settings, (await getSet(params.get("set") ?? "kestrel")).docs);
    const coverage = docs ? { covered: docs.filter((d) => g?.docs.includes(d)), missing: docs.filter((d) => !g?.docs.includes(d)) } : null;
    if (!g || !g.built_at) return Response.json({ graph: null, coverage });
    const failed = Object.entries(g.extractions)
      .filter(([, x]) => !x.ok)
      .map(([id, x]) => ({ id, error: x.error ?? "" }));
    return Response.json({ graph: { stats: graphStats(g), nodes: g.nodes, edges: g.edges, merges: g.merges, type_conflicts: g.type_conflicts, failed }, coverage });
  } catch (error) {
    return errorResponse(error);
  }
}

// POST { docs, rebuild?, retryFailed? } -> build the graph of the selected documents that have none
//      yet (one LLM call per chunk); the documents already covered are not sent again.
// POST { set, rebuild?, retryFailed? }  -> build (or resume) the graph of a question set (V3).
export async function POST(request: Request) {
  try {
    const parsed = z
      .object({ set: z.string().optional(), docs: z.array(z.string().min(1)).min(1).max(50).optional(), rebuild: z.boolean().optional(), retryFailed: z.boolean().optional() })
      .strict()
      .refine((b) => !!b.set !== !!b.docs, "Send either set or docs.")
      .safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new AppError("invalid_request", "Send { docs: [...] } or { set }, with rebuild? / retryFailed?.");
    const settings = await getSettings();
    const opts = { rebuild: parsed.data.rebuild, retryFailed: parsed.data.retryFailed };
    if (parsed.data.docs) {
      const known = new Set((await listDocs()).map((d) => d.id));
      const unknown = parsed.data.docs.filter((d) => !known.has(d));
      if (unknown.length) throw new AppError("not_found", `Unknown document(s): ${unknown.join(", ")}.`);
      await ensureIndexes(parsed.data.docs, settings);
      return Response.json(await buildGraphForDocs(parsed.data.docs, settings, opts));
    }
    const set = await getSet(parsed.data.set!);
    await ensureIndexes(set.docs, settings);
    return Response.json({ stats: await buildGraph(set.docs, settings, opts) });
  } catch (error) {
    return errorResponse(error);
  }
}
