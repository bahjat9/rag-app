# Ask the docs – RAG final release (V4)

Ask questions about your own documents (.md / .txt) and get an answer **with the passages it comes from**.
Turn documents into a **quiz or flashcards**. Open **"What happened?"** on any answer to see every step it went
through. Personal data (e-mails, phone numbers, names…) is **hidden from the AI provider**.

Built for *AI Systems Integration and Operations* (BCS S5 2026), versions tagged `v1` → `v2` → `v3` → `final`.
Design choices, results and known failures: [`REPORT.md`](./REPORT.md).

## Install and run (first time)

You need **Node.js 20.9 or newer** (`node -v`) and an LLM: by default a free **Gemini API key**
(https://aistudio.google.com/apikey), or **any OpenAI-compatible endpoint** (see *Use your own LLM* below).

```sh
git clone https://github.com/bahjat9/rag-app
cd rag-app
npm install
cp .env.example .env.local        # Windows (PowerShell): Copy-Item .env.example .env.local
```

Open `.env.local` and paste your key after `LLM_API_KEY=` (nothing else is required for Gemini). Then:

```sh
npm run dev
```

and open **http://localhost:3044**.

The first time you prepare a document, the app downloads its small language model for embeddings (~25 MB, needs
internet, once) into `.cache/`. Your API key stays in `.env.local`, which is never committed.

### Use your own LLM (not Google)

The app only talks to an **OpenAI-compatible chat endpoint**, configured by three variables in `.env.local`
(or `.env`; `.env.local` wins):

```sh
LLM_URL=https://api.openai.com/v1        # base URL: the app calls <LLM_URL>/chat/completions
LLM_API_KEY=sk-...                       # may stay empty for a server on localhost (Ollama, LM Studio…)
LLM_MODEL=gpt-4o-mini                    # the model name that endpoint expects
```

Examples: Ollama `LLM_URL=http://localhost:11434/v1`, LM Studio `LLM_URL=http://localhost:1234/v1`. Restart the app
after changing them. If the endpoint does not support JSON-schema output (`response_format`), the app notices the
400/422 error and describes the format in the prompt instead (every answer is still checked with Zod). A local model
is usually slower: raise `LLM_TIMEOUT_MS` if needed. (`LLM_BASE_URL`, the old name of `LLM_URL`, still works.)

> Windows: if the folder path contains `&` (e.g. `AI Systems Integration & Operations`), `npm run …` fails.
> Run `node node_modules/next/dist/bin/next dev --port 3044` instead (same for the other scripts: see `package.json`).

## Using the app

1. **Your documents** (left): tick the documents to use, or **Quick select** a corpus. Add your own with **+ Add .md / .txt files**.
   A document must be **prepared** once (cut into passages and indexed on your computer): click **Prepare**.
2. **Ask**: type a question, press Enter. The answer comes with **Where this comes from**: click a passage to read it.
   If the documents do not contain the answer, the app says so instead of guessing.
3. **What happened? (details)** under each answer: the steps of that request (search by meaning, by exact words, the
   AI call), with time, tokens and cost, and how much personal data was hidden.
4. **Concept graph**: for the selected documents (your own included), click **Build the concept graph**: the AI
   reads each passage once and extracts the concepts and their relations (one AI call per passage: try a small
   document first). Only the documents without a graph are sent. Then **explore** it (click a concept to see its
   relations and the passages they come from), try the graph retriever, and tick **Use the graph when answering
   questions** to combine it with the other searches in the Ask tab.
5. **Study**: a quiz (multiple choice, true/false, short answer) or flashcards from the selected documents, with a
   number of items, a difficulty and an optional topic. Every item links to its source passage.
   - Every quiz and set of cards is saved in **My decks** (on your computer, `data/decks/`): open it again any time.
   - **Check my answers**: short answers are graded by the AI against the passage (right / partly right / wrong, with
     one sentence of feedback); the score of every attempt is kept; **Practise my mistakes** asks only the questions
     you missed.
   - **Flashcards** are reviewed with **spaced repetition** (Leitner boxes): flip the card, then *I knew it* (it comes
     back later and later: 1, 2, 4, 8, 16 days) or *I didn't know* (back to tomorrow). "N cards to review today".
   - **Export to Anki** (flashcards, tab-separated file) and **Print / PDF** (a quiz on paper, answer key on the last page).
6. **Activity**: every question, quiz and preparation run, with its trace, plus metrics (answered / not found / errors,
   p50 / p95 latency, tokens and cost per question, per document, per day).
7. **Privacy** (left): hiding personal data is on by default.
8. **Developer tools** (top right): the evaluation, words analytics and retrieval settings of V2 / V3 (and the graphs
   of the question sets, in the Concept graph tab).

## V4 at a glance

| V4 requirement | Where |
|---|---|
| Clean-up: easy to install and run, natural to use | this README; simple main screen (Ask / Study / Activity), developer tools hidden by default, step-by-step guidance, progress messages, plain-language errors with "What happened?" |
| **A.** A trace for every question and every indexing run, one span per step | `lib/trace.ts` (traces in `data/traces/<day>.jsonl`, never committed); spans recorded in `lib/rag.ts`, `lib/retrieve.ts`, `lib/store.ts` (indexing), `lib/graph.ts` (graph build), `lib/study.ts` |
| **A.** From the answer to its trace | **What happened? (details)** button under every answer, quiz and error; `GET /api/traces?id=` |
| **A.** Optional metrics page | **Activity** tab, `GET /api/metrics` (computed from the traces only) |
| **B.** New feature: study artifacts | **Study** tab, `lib/study.ts`, `POST /api/study`, `cli study` |
| **B.** pushed further (15 Nov): saved decks, scores, practise mistakes, AI grading of short answers, spaced repetition, export | `lib/decks.ts`, `GET/POST/DELETE /api/decks`, `POST /api/study/grade`, `cli grade-check` (grader vs our hand grades, `eval/grading-cases.jsonl`) |
| Concept graph of **any** added document, explorable, used as a retriever (update of 15 Nov) | **Concept graph** tab; `POST /api/graph { docs }`, `GET /api/graph?docs=`; `lib/graph.ts` (`buildGraphForDocs`, `graphForDocs`); `cli graph build --docs a.md,b.txt` |
| Any LLM through `LLM_URL`, `LLM_API_KEY`, `LLM_MODEL` (update of 15 Nov) | `lib/llm.ts`, `.env.example`, *Use your own LLM* above |
| **C.** Responsible AI: personal data redaction | `lib/redact.ts`; applied to every LLM call (answers, quizzes, graph build, no-context test) and to the traces; **Privacy** switch; test cases `eval/redaction-cases.jsonl`, `cli redact-check` |

### Traces

Every question, quiz, indexing run and graph build writes one trace: the steps (spans) with their duration, the chunk
ids each retriever found, the LLM call (model, tokens in/out, cost, attempts) and the outcome (answered / not found /
invalid / error). The question and answer are stored **after** redaction; documents are never copied into a trace
(chunk ids and sizes only); the API key never is. Traces are kept 30 days (`TRACE_RETENTION_DAYS`), on this computer only.

### Command line (no server needed)

```sh
npm run cli -- study --set kestrel --kind quiz --count 5 --difficulty medium --types multiple_choice,true_false
npm run cli -- study --set kestrel --kind flashcards --count 5 --topic "refunds"
npm run cli -- redact-check
npm run cli -- grade-check     # short-answer grader vs our hand grades -> eval/grading-results.json
```

`study` prints the items and saves them to `eval/study/` for checking by hand. All V2 / V3 commands still work (below).

## V3 at a glance (hybrid retrieval)

| V3 requirement | Where |
|---|---|
| BM25 keyword retriever, both corpora | `lib/bm25.ts`; index `data/index/<doc>__bm25__<size>_<overlap>_<minpara>.json` (built with the same chunks as the dense index, rebuilt when the document changes) |
| Concept graph on Kestrel: LLM extraction of (entity, relation, entity) triples at indexing time, fixed schema, Zod validation, provenance, entity resolution, cost | `lib/graph.ts`; graph file `data/graph/graph__<docs>__<size>_<overlap>_<minpara>.json`; *Concept graph* tab; `cli graph build / stats` |
| Graph retriever returns a ranked list of chunks | `graphSearch` in `lib/graph.ts` |
| RRF fusion of the retrievers switched on, from the UI **and** the eval command | `lib/retrieve.ts`; *Retrieval settings → Retrievers* and the *Evaluation* form; `cli eval --retrievers dense,bm25,graph` |
| Each reference shows which retriever(s) found it and at what rank | *Ask* tab: “found by dense #3 · bm25 #1”; eval rows: rank of each quote in each retriever's own list |
| Graph path in the UI: entities found in the question, edges followed, chunks they came from | *Ask* tab (*Graph path*), *Concept graph* tab (*Try the graph retriever*) |
| Configurations dense / dense+BM25 (both corpora) / dense+BM25+graph (Kestrel), hit@k and recall@k for k = 1, 3, 5, 10, overall and per type | `eval/runs/*-dense.json`, `*-dense-bm25.json`, `*-dense-bm25-graph.json`; `eval/RESULTS.md` |
| Two new two_hop questions on Kestrel (q11, q12), added, nothing edited | `eval/kestrel.questions.jsonl` |
| Extraction quality: 10 random triples graded correct / wrong / unsupported | *Concept graph* tab → *Extraction quality*, `cli graph sample`; `eval/graph-triples.json` |
| Cost per question per configuration (LLM calls, tokens, latency) | `cost` in every run summary; printed by `cli eval`; graph build cost in `cli graph stats` |

### Switch the retrievers

- **UI:** *Retrieval settings* (left) → *Retrievers (fused with RRF)*: tick dense, BM25, graph → *Save settings*. No re-indexing
  needed. The *Evaluation* form has its own checkboxes (they only apply to that run).
- **Terminal:** `--retrievers dense`, `--retrievers dense,bm25`, `--retrievers dense,bm25,graph` (any combination; default = saved settings).

With one retriever on, the order is that retriever's order. With several, each returns its top 20 and the lists are
fused with Reciprocal Rank Fusion: `score = Σ 1 / (60 + rank)`. The graph needs a built graph for the selected documents
(otherwise it returns nothing and the Ask tab says so).

### Build the graph (Kestrel, or any documents)

```sh
node --env-file-if-exists=.env.local --conditions=react-server --import tsx scripts/cli.ts graph build --set kestrel
node --env-file-if-exists=.env.local --conditions=react-server --import tsx scripts/cli.ts graph stats --set kestrel     # numbers, merges, failures, cost
node --env-file-if-exists=.env.local --conditions=react-server --import tsx scripts/cli.ts graph ask --set kestrel "Error KST-5031 on scheduled reports: which team?"
node --env-file-if-exists=.env.local --conditions=react-server --import tsx scripts/cli.ts graph sample --set kestrel    # 10 random triples to grade
```

or the *Concept graph* tab → *Build the concept graph*. For documents you added:
`… scripts/cli.ts graph build --docs my-notes.md` (then `graph stats --docs my-notes.md`, `graph ask --docs my-notes.md "…"`).
Each group of documents built together gets its own graph file in `data/graph/`; at question time every graph that
covers a selected document is used (merged in memory). One LLM call per chunk (42 chunks with 800 / 10 % / 20), paced with
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
cp .env.example .env.local     # put your key in LLM_API_KEY (and LLM_URL / LLM_MODEL for another provider)
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

Offline test without any key: `node scripts/mock-llm.mjs` and in `.env.local` set `LLM_URL=http://localhost:4011/v1`,
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
| `GET /api/traces?id=` / `GET /api/traces?kind=&limit=` | – | one trace / the latest traces (V4) |
| `GET /api/metrics` | – | metrics computed from the traces (V4) |
| `POST /api/study` | `{docs, kind: quiz\|flashcards, count, difficulty, types?, topic?}` | quiz / flashcards, each item with its chunk (V4) |
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
| Document not prepared (new doc, settings changed, file changed) | "Click Prepare in the documents panel first"; the Ask and Study buttons stay disabled until it is done | 409 |
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
| *V4* AI provider unreachable (no internet, wrong URL) | "The AI provider cannot be reached right now…" + **What happened?** | 502 |
| *V4* Any failed question / quiz / preparation | the error message has a **What happened?** link to its trace (the failing step is red) | – |
| *V4* Quiz: an item points to a passage it was not given, a multiple-choice answer that is not one of the options, a true/false answer that is not True/False, a duplicate | the item is dropped; "Only N of the M requested items could be built" | 200 |
| *V4* Quiz: an answer that shares no word with its passage | kept, marked **(check this one)** | 200 |
| *V4* Quiz: no usable item at all | "The model did not return any usable question… Try again, ask for fewer items, or pick other documents" | 502 |
| *V4* Documents with no passage long enough for a quiz | "These documents have no passage long enough…" | 400 |

Every question is logged to `logs/queries.jsonl` (trace id, documents, model, tokens, latency, status: no question
text, no API key), and traced in `data/traces/` (V4).
