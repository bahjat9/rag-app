import { AppError, errorResponse } from "@/lib/errors";
import { getSettings, saveSettings, SettingsSchema } from "@/lib/settings";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(await getSettings());
}

export async function PUT(request: Request) {
  try {
    const parsed = SettingsSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new AppError("invalid_request", "Invalid settings: chunk size 100–4000, overlap 0–50 %, top-k 1–20, min paragraph 0–200.");
    }
    await saveSettings(parsed.data);
    return Response.json(parsed.data);
  } catch (error) {
    return errorResponse(error);
  }
}
