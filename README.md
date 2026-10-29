# Ask the docs – RAG V1

A web application where a user asks a question about a document corpus and receives a **grounded** answer,
with **references** to the passages it was built from. Built for *AI Systems Integration and Operations* (BCS S5 2026),
RAG project **V1 – naive RAG app** (due 29 Oct 2026). Design choices and known failures: [`REPORT.md`](./REPORT.md).

## What it does

| Requirement (V1 spec) | Where |
|---|---|
| Two phases, indexing and answering, as in `norag_rag/ask_rag_google.py`, behind a web API | `lib/store.ts` (index, search), `lib/rag.ts` (answer), `app/api/*` |
| LLM response validated against a schema (Zod) before it reaches the UI; invalid response = handled error | `lib/schema.ts`, `lib/llm.ts` (retry once, then `502`) |
| `.md` and `.txt` documents; add, delete, choose which documents a question is asked against | *Documents* panel, `app/api/documents` |
| Chunk size, overlap and top-k changed from the UI, without editing code | *Retrieval settings* panel, `data/settings.json` |
| Question box, answer, references; opening a reference shows the chunk it points to | *Ask* tab, `app/api/chunks` |
| Controlled failures: every anticipated failure has a defined behaviour | table below, `lib/errors.ts` |
| Retrieval baseline: question set + repeatable measurement | `eval/questions.json`, *Evaluation* tab, `npm run eval` |

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

1. Tick the documents, click **Index selected documents**. The first time, the embedding model (~25 MB) is downloaded
   into `.cache/`; indexing *Crime and Punishment* (1.2 MB, ~1,600 chunks) takes about a minute on a laptop CPU.
2. Ask a question in the **Ask** tab. Click a reference to see the exact chunk.
3. **Evaluation** tab → *Run the baseline* (no LLM call, free). Or `npm run eval` while the app runs.

Offline test without any key: `node scripts/mock-llm.mjs` and in `.env.local` set `LLM_BASE_URL=http://localhost:4011/v1`,
`LLM_API_KEY=mock`, `LLM_MODEL=mock-llm`, `EMBEDDINGS=mock` (numbers are meaningless in mock mode).

## API

| Route | Body | Answer |
|---|---|---|
| `GET /api/documents` | – | documents + index status for the current settings |
| `POST /api/documents` | multipart `file` (.md/.txt) | added documents |
| `DELETE /api/documents?id=` | – | deletes the document and its indexes |
| `GET/PUT /api/settings` | `{chunkSize, overlapPercent, topK, minParagraphLength}` | settings |
| `POST /api/index` | `{docs: [...]}` | chunks per document, time |
| `POST /api/ask` | `{question, docs: [...]}` | `{found, answer, citations, retrieved, warnings, usage, latency, …}` |
| `GET /api/chunks?id=doc#0012` | – | chunk text and position |
| `GET/POST /api/eval` | – | list runs / run the retrieval baseline |

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
