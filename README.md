# Ask the docs – RAG V3

A web application where a user asks a question about a document corpus and receives a **grounded** answer,
with **references** to the passages it was built from. Built for *AI Systems Integration and Operations* (BCS S5 2026):
RAG project **V1 – naive RAG app** (tag `v1`), **V2 – two corpora, a first evaluation, words analytics** (tag `v2`) and
**V3 – hybrid retrieval: dense + BM25 + concept graph, fused with RRF** (tag `v3`).
Design choices, results and known failures: [`REPORT.md`](./REPORT.md).

## V3 at a glance

| V3 requirement | Where |
|---|---|
| BM25 keyword retriever, both corpora | `lib/bm25.ts`; index `data/index/<doc>__bm25__<size>_<overlap>_<minpara>.json` (built with the same chunks as the dense index, rebuilt when the document changes) |
| Concept graph on Kestrel: LLM extraction of (entity, relation, entity) triples at indexing time, fixed schema, Zod validation, provenance, entity resolution, cost | `lib/graph.ts`; graph file `data/graph/graph__<docs>__<size>_<overlap>_<minpara>.json`; *Graph* tab; `cli graph build / stats` |
| Graph retriever returns a ranked list of chunks | `graphSearch` in `lib/graph.ts` |
| RRF fusion of the retrievers switched on, from the UI **and** the eval command | `lib/retrieve.ts`; *Retrieval settings → Retrievers* and the *Evaluation* form; `cli eval --retrievers dense,bm25,graph` |
| Each reference shows which retriever(s) found it and at what rank | *Ask* tab: “found by dense #3 · bm25 #1”; eval rows: rank of each quote in each retriever's own list |
| Graph path in the UI: entities found in the question, edges followed, chunks they came from | *Ask* tab (*Graph path*), *Graph* tab (*Try the graph retriever*) |
| Configurations dense / dense+BM25 (both corpora) / dense+BM25+graph (Kestrel), hit@k and recall@k for k = 1, 3, 5, 10, overall and per type | `eval/runs/*-dense.json`, `*-dense-bm25.json`, `*-dense-bm25-graph.json`; `eval/RESULTS.md` |
| Two new two_hop questions on Kestrel (q11, q12), added, nothing edited | `eval/kestrel.questions.jsonl` |
| Extraction quality: 10 random triples graded correct / wrong / unsupported | *Graph* tab → *Extraction quality*, `cli graph sample`; `eval/graph-triples.json` |
| Cost per question per configuration (LLM calls, tokens, latency) | `cost` in every run summary; printed by `cli eval`; graph build cost in `cli graph stats` |

### Switch the retrievers

- **UI:** *Retrieval settings* (left) → *Retrievers (fused with RRF)*: tick dense, BM25, graph → *Save settings*. No re-indexing
  needed. The *Evaluation* form has its own checkboxes (they only apply to that run).
- **Terminal:** `--retrievers dense`, `--retrievers dense,bm25`, `--retrievers dense,bm25,graph` (any combination; default = saved settings).

With one retriever on, the order is that retriever's order. With several, each returns its top 20 and the lists are
fused with Reciprocal Rank Fusion: `score = Σ 1 / (60 + rank)`. The graph needs a built graph for the selected documents
(otherwise it returns nothing and the Ask tab says so).

### Build the graph (Kestrel)

```sh
node --env-file-if-exists=.env.local --conditions=react-server --import tsx scripts/cli.ts graph build --set kestrel
node --env-file-if-exists=.env.local --conditions=react-server --import tsx scripts/cli.ts graph stats --set kestrel     # numbers, merges, failures, cost
node --env-file-if-exists=.env.local --conditions=react-server --import tsx scripts/cli.ts graph ask --set kestrel "Error KST-5031 on scheduled reports: which team?"
node --env-file-if-exists=.env.local --conditions=react-server --import tsx scripts/cli.ts graph sample --set kestrel    # 10 random triples to grade
```

or the *Graph* tab → *Build the graph*. One LLM call per chunk (42 chunks with 800 / 10 % / 20), paced with
`LLM_BATCH_DELAY_MS`. Each chunk's extraction is saved as soon as it returns: after a quota error, run the same
command again and it resumes. `--retry-failed` re-runs the chunks whose output failed validation twice; `--rebuild`
starts from scratch. The graph is tied to the chunk settings: after changing chunk size / overlap / min paragraph, re-index and rebuild.

### Run the V3 evaluation

```sh
node --env-file-if-exists=.env.local --conditions=react-server --import tsx scripts/cli.ts eval --set kestrel --retrievers dense
node --env-file-if-exists=.env.local --conditions=react-server --import tsx scripts/cli.ts eval --set kestrel --retrievers dense,bm25
node --env-file-if-exists=.env.local --conditions=react-server --import tsx scripts/cli.ts eval --set kestrel --retrievers dense,bm25,graph
node --env-file-if-exists=.env.local --conditions=react-server --import tsx scripts/cli.ts eval --set vellora --retrievers dense
node --env-file-if-exists=.env.local --conditions=react-server --import tsx scripts/cli.ts eval --set vellora --retrievers dense,bm25
node --env-file-if-exists=.env.local --conditions=react-server --import tsx scripts/cli.ts results     # -> eval/RESULTS.md
```

Add `--answers` to also measure the generation cost per question (one LLM call each). Retrieval itself makes no
LLM call: the graph is searched by matching entity names in the question; its LLM cost is paid once, at build time.

## V2 at a glance

| V2 requirement | Where |
|---|---|
| Two corpora: the Kestrel KB (provided) and our own (Vellora espresso manual + *Crime and Punishment*) | `data/docs/`, `eval/sets.json`; *Select a corpus* buttons in the Documents panel |
| Both question sets in JSONL (Kestrel format) | `eval/kestrel.questions.jsonl` (the 10 starter questions, unchanged), `eval/vellora.questions.jsonl` (our 27 V1 questions converted, same ids) |
| No-context test (LLM without retrieval), on both sets | *Evaluation* tab → *No-context test*, or `cli nocontext`; results in `eval/no-context/` |
| Retrieval evaluation, repeatable, from the terminal (one command) **and** from the front-end, saved to a file | *Evaluation* tab, or `cli eval`; results in `eval/runs/*.json` + `eval/runs.jsonl` |
| Hit rate and recall for k = 1, 3, 5, 10, overall and per question type; unanswerable questions left out | `lib/evaluate.ts` |
| At least two configurations compared | runs A / B / C, table in `eval/RESULTS.md` (`cli results`) |
| On demand, generate the answers and save them next to their chunks; grade them by hand | *also generate the answers* checkbox / `--answers`; grading form in the opened run; grades saved in the run file; rules in `eval/GRADING.md` |
| *Words* tab: vocabulary, word → chunks, question → words | *Words* tab, `lib/words.ts`, `app/api/words` |

## What it does

| Requirement (V1 spec) | Where |
|---|---|
| Two phases, indexing and answering, as in `norag_rag/ask_rag_google.py`, behind a web API | `lib/store.ts` (index, search), `lib/rag.ts` (answer), `app/api/*` |
| LLM response validated against a schema (Zod) before it reaches the UI; invalid response = handled error | `lib/schema.ts`, `lib/llm.ts` (retry once, then `502`) |
| `.md` and `.txt` documents; add, delete, choose which documents a question is asked against | *Documents* panel, `app/api/documents` |
| Chunk size, overlap and top-k changed from the UI, without editing code | *Retrieval settings* panel, `data/settings.json` |
| Question box, answer, references; opening a reference shows the chunk it points to | *Ask* tab, `app/api/chunks` |
| Controlled failures: every anticipated failure has a defined behaviour | table below, `lib/errors.ts` |
| Retrieval baseline: question set + repeatable measurement | V1: `eval/questions.json`; V2: see above |

## Pipeline

```
Phase 1 – indexing (once, then when a document or a chunk setting changes)
  document (.md/.txt) → paragraphs ≥ min length → one text → fixed windows (chunk size, overlap)
  → all-MiniLM-L6-v2 (local, 384 dims) → data/index/<doc>__<model>__<size>_<overlap>_<minpara>.json

Phase 2 – answering (every question)
  question → same embedding model → cosine similarity with every chunk of the selected documents → top-k
  → prompt (instructions + <excerpt id=…> + question) → LLM (JSON: found, answer, citations)
  → Zod check → citations checked against the retrieved ids → answer + references
```

## Run it

Requires Node.js 20.9+.

```sh
npm install
cp .env.example .env.local     # put your Gemini key in LLM_API_KEY
npm run dev                     # http://localhost:3044
```

1. Click a corpus (*Kestrel KB* or *Vellora manual + Crime and Punishment*) or tick documents, then **Index selected documents**.
   The first time, the embedding model (~25 MB) is downloaded into `.cache/`; indexing *Crime and Punishment*
   (1.2 MB, ~1,600 chunks) takes about a minute on a laptop CPU.
2. Ask a question in the **Ask** tab. Click a reference to see the exact chunk.
3. **Evaluation** tab: choose a question set and a configuration, *Run the evaluation*. Open a run to see every question.
4. **Words** tab (top right, next to *Evaluation*): choose a corpus, then *Corpus mode* (vocabulary, word → chunks) or
   *Question mode* (pick a question from a set or type one).

> Windows: if the project folder name contains `&` (e.g. `AI Systems Integration & Operations`), `npm run …` fails.
> Run the commands directly: `node node_modules/next/dist/bin/next dev --port 3044`, and for the CLI the `node …` command below.

## Run the evaluation from the terminal

One command, no server needed (it uses the same code as the front-end and reads `.env.local`):

```sh
# retrieval only (free, no LLM call): set + configuration; builds the missing indexes
node --env-file-if-exists=.env.local --conditions=react-server --import tsx scripts/cli.ts eval --set kestrel --chunk 800 --overlap 10 --k 5 --label A
node --env-file-if-exists=.env.local --conditions=react-server --import tsx scripts/cli.ts eval --set vellora --chunk 400 --overlap 25 --label B

# also generate the answers (one LLM call per question) for hand grading, with top-k = --k
node --env-file-if-exists=.env.local --conditions=react-server --import tsx scripts/cli.ts eval --set kestrel --chunk 1200 --overlap 10 --k 5 --answers --label "C answers"

# no-context test (two LLM calls per question)
node --env-file-if-exists=.env.local --conditions=react-server --import tsx scripts/cli.ts nocontext --set kestrel

# results table of every run (Markdown) -> eval/RESULTS.md
node --env-file-if-exists=.env.local --conditions=react-server --import tsx scripts/cli.ts results
```

`npm run cli -- <command> …` is the same command (when the folder name has no `&`).

### How retrieval is measured

Each answerable question lists evidence `{source, quote}` pairs copied from the documents. A retrieved chunk is
**relevant** to a quote if it comes from that source **and** contains the quote (case and whitespace normalised).
Retrieval is run once with k = 10 and read at k = 1, 3, 5, 10:

- **hit@k**: at least one evidence quote is in the top k (HitRate@k);
- **recall@k**: share of the question's quotes in the top k (Recall@k) – shows whether *all* the parts of a
  split or two-hop answer were found. Our questions q16 and q19 list two alternative quotes (`"evidence_match": "any"`);
- **partial**: a chunk holds only one half of a quote (cut by a chunk boundary);
- **MRR**: 1 / rank of the first relevant chunk.

Unanswerable questions (`answerable: false`) are left out of these numbers; their best similarity score is kept to compare
with answerable questions. Defined on text, not on chunk ids, so runs with different chunk sizes stay comparable.

Offline test without any key: `node scripts/mock-llm.mjs` and in `.env.local` set `LLM_BASE_URL=http://localhost:4011/v1`,
`LLM_API_KEY=mock`, `LLM_MODEL=mock-llm`, `EMBEDDINGS=mock` (numbers are meaningless in mock mode).
`EMBEDDINGS_MODEL_DIR=<folder>` loads the embedding model from a local folder (`<folder>/Xenova/all-MiniLM-L6-v2/…`)
instead of downloading it.

## API

| Route | Body | Answer |
|---|---|---|
| `GET /api/documents` | – | documents + index status for the current settings |
| `POST /api/documents` | multipart `file` (.md/.txt) | added documents |
| `DELETE /api/documents?id=` | – | deletes the document and its indexes |
| `GET/PUT /api/settings` | `{chunkSize, overlapPercent, topK, minParagraphLength, retrievers: {dense, bm25, graph}}` | settings |
| `POST /api/index` | `{docs: [...]}` | chunks per document, time |
| `POST /api/ask` | `{question, docs: [...]}` | `{found, answer, citations, retrieved, warnings, usage, latency, …}` |
| `GET /api/chunks?id=doc#0012[&cfg=800_10_20]` | – | chunk text and position (current settings, or another configuration) |
| `POST /api/search` | `{question, docs, topK?}` | retrieval only: fused top-k chunks, the retriever(s) and rank behind each, each retriever's own list, graph path |
| `GET /api/graph?set=` | – | graph stats, cost, entities, edges, merges, type conflicts, failed chunks |
| `POST /api/graph` | `{set, rebuild?, retryFailed?}` | build / resume the graph |
| `GET/POST/PATCH /api/graph/triples` | – / `{set, force?}` / `{n, grade, note}` | the 10 sampled triples / draw them / grade one |
| `GET /api/sets` | – | question sets, their documents and questions |
| `GET /api/eval` | – | every run summary + results table (Markdown) |
| `POST /api/eval` | `{set, retrievers?, chunkSize?, overlapPercent?, minParagraphLength?, topK?, answers?, label?}` | run the evaluation |
| `GET /api/eval/run?file=` | – | one run with its rows, answers and grades |
| `POST /api/eval/grade` | `{file, id, grade: correct\|partial\|wrong\|unsupported\|null, note}` | save a hand grade |
| `GET/POST/PATCH /api/nocontext` | `{set}` / `{file, id, flag}` | list / run the no-context test / correct a flag by hand |
| `GET /api/words?docs=a,b[&filter&stop=hide&sort]` | – | vocabulary (words, occurrences, chunks) |
| `GET /api/words?docs=a,b&word=x` | – | chunks containing the word, with counts |
| `POST /api/words` | `{docs, question, evidence?}` | question mode: each word in the corpus? where? in the answer chunks? in the retrieved chunks? |

## Controlled failures

| What goes wrong | What the user sees | Status |
|---|---|---|
| Empty question, question > 500 characters | clear message, no model call | 400 |
| No document selected | "Select at least one document" | 400 |
| Document not indexed with the current settings (new doc, settings changed, file changed) | "Click Index selected documents" | 409 |
| Unknown document / chunk | not found | 404 |
| Not a `.md`/`.txt`, binary content, bad file name (path traversal blocked) | "Only .md and .txt files" | 415 |
| File > 2 MB | "The file is too large" | 413 |
| Corpus does not contain the answer | answer marked **Not found in the documents** (LLM `found: false`), retrieved passages still visible | 200 |
| Model cites a chunk that was not retrieved | citation removed, warning shown | 200 |
| Model says found but cites nothing | warning "not grounded, verify it" | 200 |
| Best similarity below 0.30 | warning "weak retrieval" | 200 |
| LLM output not JSON / wrong schema | retried once, then "could not validate" | 502 |
| Provider 429 / 5xx / timeout | safe message, no provider detail | 429 / 502 / 504 |
| Missing key or model | "LLM is not configured" | 500 |
| Embedding model cannot load | "embedding model could not be loaded" | 500 |

Every question is logged to `logs/queries.jsonl` (settings, models, retrieved ids and scores, citations, tokens,
latency, status) without the API key.
