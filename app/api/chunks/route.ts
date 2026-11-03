import { AppError, errorResponse } from "@/lib/errors";
import { getSettings, SettingsSchema } from "@/lib/settings";
import { getChunk } from "@/lib/store";

export const dynamic = "force-dynamic";

// GET /api/chunks?id=<doc>#<index>[&cfg=<chunkSize>_<overlap>_<minParagraph>]
// -> the chunk text and its position in the document. Without cfg: the current settings;
// with cfg: the chunks of another configuration (e.g. an evaluation run).
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const id = url.searchParams.get("id") ?? "";
    if (!id.includes("#")) throw new AppError("invalid_request", "Invalid chunk id.");
    let settings = await getSettings();
    const cfg = url.searchParams.get("cfg");
    if (cfg) {
      const [chunkSize, overlapPercent, minParagraphLength] = cfg.split("_").map(Number);
      const parsed = SettingsSchema.safeParse({ ...settings, chunkSize, overlapPercent, minParagraphLength });
      if (!parsed.success) throw new AppError("invalid_request", "Invalid cfg.");
      settings = parsed.data;
    }
    const chunk = await getChunk(id, settings);
    if (!chunk) throw new AppError("not_found", "This chunk does not exist with these settings (re-indexed?).");
    return Response.json(chunk);
  } catch (error) {
    return errorResponse(error);
  }
}
