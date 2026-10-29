// One JSON line per question in logs/queries.jsonl. Never the key.
import "server-only";
import { promises as fs } from "fs";
import path from "path";

export const LOG_FILE = path.join(process.cwd(), "logs", "queries.jsonl");

export async function logQuery(line: Record<string, unknown>): Promise<void> {
  try {
    await fs.mkdir(path.dirname(LOG_FILE), { recursive: true });
    await fs.appendFile(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), ...line }) + "\n", "utf8");
  } catch (error) {
    console.error("log write failed", error);
  }
}
