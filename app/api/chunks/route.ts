import { AppError, errorResponse } from "@/lib/errors";
import { getSettings } from "@/lib/settings";
import { getChunk } from "@/lib/store";

export const dynamic = "force-dynamic";

// GET /api/chunks?id=<doc>#<index> -> the chunk text and its position in the document.
export async function GET(request: Request) {
  try {
    const id = new URL(request.url).searchParams.get("id") ?? "";
    if (!id.includes("#")) throw new AppError("invalid_request", "Invalid chunk id.");
    const chunk = await getChunk(id, await getSettings());
    if (!chunk) throw new AppError("not_found", "This chunk does not exist with the current settings (re-indexed?).");
    return Response.json(chunk);
  } catch (error) {
    return errorResponse(error);
  }
}
