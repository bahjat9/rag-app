// V4 · Part C: personal data redaction.
//
// Before any text leaves the machine (the call to the LLM provider) and before it is written to a
// trace, personal data is replaced by placeholders: "write to anna.k@acme.com" becomes
// "write to [EMAIL_1]". The same value always gets the same placeholder inside one request, so the
// LLM can still reason about it ("[PERSON_1] leads the team"). When the answer comes back, the
// placeholders are put back locally, so the user still reads the real value. The mapping
// placeholder -> value only lives in memory for the duration of the request: it is never sent,
// never logged, never written to a trace.
//
// Detection = rules (no extra service, no extra LLM call):
//   EMAIL  e-mail addresses
//   PHONE  phone numbers: international (+33 6 12 34 56 78) and French (06 12 34 56 78), >= 9 digits
//   CARD   payment card numbers (13-19 digits that pass the Luhn check)
//   IBAN   bank account numbers (country code + check digits + 11-30 characters)
//   PERSON names: (a) the "person" entities of the concept graph, (b) the names listed in
//          data/pii-names.txt (one per line), (c) a name after a title (Mr, Mrs, Ms, Dr, M., Mme)
//          or after "my name is" / "je m'appelle", or a full name (two words) after "I'm" / "I am".
// Not detected (known limits): a person's name that is in none of these lists, postal addresses,
// dates of birth. IP addresses are NOT redacted: in this corpus they are documented server
// addresses (203.0.113.10), not personal data, and the answers need them.
import "server-only";
import { promises as fs } from "fs";
import path from "path";

export type PiiKind = "EMAIL" | "PHONE" | "CARD" | "IBAN" | "PERSON";

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const PHONE = /(?<![\w.+-])(?:\+\d{1,3}[ .-]?(?:\(0\)[ .-]?)?\d{1,4}(?:[ .-]?\d{2,4}){2,4}|0[1-9](?:[ .-]?\d{2}){4})(?![\w.-]*\d)/g;
const CARD = /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g;
const IBAN = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g;
const NAME_WORD = "[A-ZÀ-Ý][\\p{Ll}'’-]+";
const TITLED = new RegExp(`\\b(?:Mr|Mrs|Ms|Dr|Mme|Mlle|M)\\.?\\s+(${NAME_WORD}(?:\\s+${NAME_WORD})?)`, "gu");
const INTRO = new RegExp(`\\b(?:my name is|je m'appelle)\\s+(${NAME_WORD}(?:\\s+${NAME_WORD})?)`, "giu");
// "I'm" / "I am" only with a full name (two capitalised words): "I am Admin" is not a name
const INTRO_FULL = new RegExp(`\\b(?:I'm|I am|this is)\\s+(${NAME_WORD}\\s+${NAME_WORD})`, "gu");

const digits = (s: string) => s.replace(/\D/g, "");
function luhn(num: string): boolean {
  let sum = 0;
  for (let i = 0; i < num.length; i++) {
    let d = Number(num[num.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}
const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Names known to be persons: graph "person" entities + data/pii-names.txt. Cached for 60 s. */
let namesCache: { at: number; names: string[] } | null = null;
export async function knownNames(): Promise<string[]> {
  if (namesCache && Date.now() - namesCache.at < 60_000) return namesCache.names;
  const names = new Set<string>();
  const dir = path.join(process.cwd(), "data", "graph");
  try {
    for (const f of await fs.readdir(dir)) {
      if (!f.endsWith(".json")) continue;
      const g = JSON.parse(await fs.readFile(path.join(dir, f), "utf8")) as { nodes?: { type: string; names: string[] }[] };
      for (const n of g.nodes ?? []) if (n.type === "person") n.names.forEach((x) => x.trim().split(/\s+/).length >= 2 && names.add(x.trim()));
    }
  } catch {
    /* no graph yet */
  }
  try {
    const extra = await fs.readFile(path.join(process.cwd(), "data", "pii-names.txt"), "utf8");
    extra.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).forEach((l) => names.add(l));
  } catch {
    /* optional file */
  }
  namesCache = { at: Date.now(), names: [...names].sort((a, b) => b.length - a.length) };
  return namesCache.names;
}

export class Redactor {
  private toPlaceholder = new Map<string, string>(); // value -> placeholder
  private toValue = new Map<string, string>(); // placeholder -> value (memory only)
  private n: Record<PiiKind, number> = { EMAIL: 0, PHONE: 0, CARD: 0, IBAN: 0, PERSON: 0 };
  readonly counts: Record<PiiKind, number> = { EMAIL: 0, PHONE: 0, CARD: 0, IBAN: 0, PERSON: 0 };

  constructor(private names: string[] = [], readonly enabled = true) {}

  private placeholder(kind: PiiKind, value: string): string {
    const key = `${kind}:${kind === "PERSON" ? value.toLowerCase() : value}`;
    let p = this.toPlaceholder.get(key);
    if (!p) {
      p = `[${kind}_${++this.n[kind]}]`;
      this.toPlaceholder.set(key, p);
      this.toValue.set(p, value);
    }
    this.counts[kind]++;
    return p;
  }

  /** Replace personal data by placeholders. */
  redact(text: string): string {
    if (!this.enabled || !text) return text;
    let t = text.replace(EMAIL, (m) => this.placeholder("EMAIL", m));
    t = t.replace(IBAN, (m) => (/\d{2}/.test(m.slice(2, 4)) && digits(m).length >= 10 ? this.placeholder("IBAN", m) : m));
    t = t.replace(CARD, (m) => (luhn(digits(m)) && digits(m).length >= 13 ? this.placeholder("CARD", m) : m));
    t = t.replace(PHONE, (m) => (digits(m).length >= 9 ? this.placeholder("PHONE", m) : m));
    for (const name of this.names) {
      t = t.replace(new RegExp(`(?<![\\p{L}])${esc(name)}(?![\\p{L}])`, "giu"), (m) => this.placeholder("PERSON", m));
    }
    t = t.replace(TITLED, (m, name: string) => m.replace(name, this.placeholder("PERSON", name)));
    t = t.replace(INTRO, (m, name: string) => (/^\[/.test(name) ? m : m.replace(name, this.placeholder("PERSON", name))));
    t = t.replace(INTRO_FULL, (m, name: string) => m.replace(name, this.placeholder("PERSON", name)));
    return t;
  }

  /** Put the real values back (only done locally, on what the user will read). */
  restore(text: string): string {
    if (!this.enabled || !text) return text;
    return text.replace(/\[(EMAIL|PHONE|CARD|IBAN|PERSON)_(\d+)\]/g, (m) => this.toValue.get(m) ?? m);
  }

  get total(): number {
    return Object.values(this.counts).reduce((a, b) => a + b, 0);
  }
  /** Distinct values replaced, per kind (what the trace records: counts, never values). */
  summary(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const p of this.toValue.keys()) {
      const k = p.slice(1, p.indexOf("_"));
      out[k] = (out[k] ?? 0) + 1;
    }
    return out;
  }
}

export async function newRedactor(enabled: boolean): Promise<Redactor> {
  return new Redactor(enabled ? await knownNames() : [], enabled);
}
