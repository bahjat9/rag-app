// Document corpus: plain .md / .txt files stored in data/docs/.
import "server-only";
import { createHash } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { AppError } from "./errors";

export const DOCS_DIR = path.join(process.cwd(), "data", "docs");
export const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES) || 2_000_000;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.(md|txt)$/;

export type DocInfo = { id: string; bytes: number; modified: string };

export function checkDocId(id: string): string {
  // The id is the file name. The regex also blocks path traversal ("../").
  if (!NAME_RE.test(id)) throw new AppError("unsupported_file", "Invalid document name: use letters, digits, '.', '-', '_' and a .md or .txt extension.");
  return id;
}

export async function listDocs(): Promise<DocInfo[]> {
  await fs.mkdir(DOCS_DIR, { recursive: true });
  const names = (await fs.readdir(DOCS_DIR)).filter((n) => NAME_RE.test(n)).sort();
  return Promise.all(
    names.map(async (id) => {
      const st = await fs.stat(path.join(DOCS_DIR, id));
      return { id, bytes: st.size, modified: st.mtime.toISOString() };
    }),
  );
}

export async function readDoc(id: string): Promise<string> {
  checkDocId(id);
  try {
    return await fs.readFile(path.join(DOCS_DIR, id), "utf8");
  } catch {
    throw new AppError("not_found", `Document ${id} not found.`);
  }
}

export async function addDoc(id: string, content: string): Promise<DocInfo> {
  checkDocId(id);
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_UPLOAD_BYTES) throw new AppError("file_too_large", `The file is too large (max ${Math.round(MAX_UPLOAD_BYTES / 1000)} kB).`);
  if (!content.trim()) throw new AppError("invalid_request", "The file is empty.");
  if (content.includes("\u0000")) throw new AppError("unsupported_file", "This does not look like a text file.");
  await fs.mkdir(DOCS_DIR, { recursive: true });
  await fs.writeFile(path.join(DOCS_DIR, id), content.replace(/\r\n/g, "\n"), "utf8");
  const st = await fs.stat(path.join(DOCS_DIR, id));
  return { id, bytes: st.size, modified: st.mtime.toISOString() };
}

export async function deleteDoc(id: string): Promise<void> {
  checkDocId(id);
  try {
    await fs.unlink(path.join(DOCS_DIR, id));
  } catch {
    throw new AppError("not_found", `Document ${id} not found.`);
  }
}

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
