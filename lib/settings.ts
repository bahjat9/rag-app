// Retrieval settings, editable from the UI (no code change needed).
// Stored in data/settings.json. Changing chunk size, overlap or the minimum
// paragraph length changes the chunks, so the documents must be re-indexed.
// top-k only changes the query, so no re-indexing is needed.
import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { z } from "zod";

export const SettingsSchema = z
  .object({
    chunkSize: z.number().int().min(100).max(4000), // characters
    overlapPercent: z.number().int().min(0).max(50),
    topK: z.number().int().min(1).max(20),
    minParagraphLength: z.number().int().min(0).max(200),
  })
  .strict();
export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = { chunkSize: 800, overlapPercent: 10, topK: 5, minParagraphLength: 20 };

const FILE = path.join(process.cwd(), "data", "settings.json");

export async function getSettings(): Promise<Settings> {
  try {
    const parsed = SettingsSchema.safeParse(JSON.parse(await fs.readFile(FILE, "utf8")));
    return parsed.success ? parsed.data : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(settings, null, 2) + "\n", "utf8");
}

/** The part of the settings that defines the chunks (and therefore the index). */
export function indexKey(s: Settings): string {
  return `${s.chunkSize}_${s.overlapPercent}_${s.minParagraphLength}`;
}
