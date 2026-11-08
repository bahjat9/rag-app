// Shared tokenizer: Words tab (V2) and BM25 (V3) use the same definition of a word.
const TOKEN_RE = /[\p{L}\p{N}]+(?:[-'’._][\p{L}\p{N}]+)*/gu;

export const STOPWORDS = new Set(
  (
    "a an the and or but if then else of to in on at by for with from into onto about as is are was were be been being am do does did doing have has had having " +
    "i me my we our you your he him his she her it its they them their this that these those there here what which who whom whose when where why how " +
    "not no nor so than too very can could should would will shall may might must also just only own same other such each few more most some any all both " +
    "up down out over under again further once off s t"
  ).split(" "),
);

export function tokenize(text: string): string[] {
  return (text.toLowerCase().replace(/’/g, "'").match(TOKEN_RE) ?? []).map((t) => t.replace(/[.'_-]+$/, ""));
}

