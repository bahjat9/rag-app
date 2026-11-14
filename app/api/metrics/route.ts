import { errorResponse } from "@/lib/errors";
import { metricsOf, readTraces } from "@/lib/trace";

export const dynamic = "force-dynamic";

// GET -> the metrics page numbers, all computed from the traces (lib/trace.ts, metricsOf).
export async function GET() {
  try {
    return Response.json(metricsOf(await readTraces()));
  } catch (error) {
    return errorResponse(error);
  }
}
