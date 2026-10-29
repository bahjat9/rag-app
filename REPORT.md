# REPORT – RAG V1

## Team details

| Member | Worked on |
|---|---|
| Bahjat Khouzam | Pipeline (chunking, embeddings, vector store), evaluation runs, report |
| Chris El Hazzouri | UI, API routes, error handling, question set |

> Every member must be able to answer for the whole code base. Keep the split visible in the git history.

## Corpus

| Document | Size | Why |
|---|---|---|
| `vellora-duo-espresso-machine.txt` | 31 kB, ~43 chunks (800 chars) | A support manual: questions have one checkable answer; the product is **fictional**, so the LLM cannot answer from training (retrieval really matters). 99 error codes that look alike (`E05`, `E50`…) make retrieval hard. |
| `crime-and-punishment.txt` | 1.2 MB, ~1,600 chunks | Volume and noise: the manual's chunks must win against 1,600 literary chunks; contains the injected *Denis Amselemovitch* needle from the course. |

Question set: `eval/questions.json` – 27 questions: 13 simple, 8 hard (paraphrases, vocabulary mismatch: "hard water" vs
"limescale", "foam" vs "crema", error codes), 2 multi-hop (two passages needed), 1 needle, 4 unanswerable.

## Decision log

| # | Decision | Options considered | Picked | Why |
|---|---|---|---|---|
| 1 | Stack | Python (FastAPI + ChromaDB, like norag-rag) · Next.js/TypeScript | Next.js + TypeScript | Same stack as the Triage app: Zod, error mapping and logging patterns reused; one process for UI and API. |
| 2 | Embedding model | all-MiniLM-L6-v2 local · hosted embedding API (Gemini, OpenAI) · bigger local model | all-MiniLM-L6-v2, local (transformers.js) | Same model as the lab; free, no quota, no text leaves the machine; 384 dims. Limit: 256 tokens, English-oriented. |
| 3 | Vector store | ChromaDB · Pinecone · JSON file + brute-force cosine | JSON file per document + brute force | ~1,650 chunks: an exact scan takes milliseconds and has no extra service to run. Index key = doc + model + chunk settings, so changing a setting never mixes incompatible vectors. Revisit if the corpus grows. |
| 4 | Chunking | fixed windows · paragraph/heading-aware · sentence-based | fixed 800 chars, 10 % overlap, drop paragraphs < 20 chars | Naive on purpose (V1 = baseline, like the lab). 800 chars ≈ 190 tokens < 256-token embedding limit. |
| 5 | Top-k | 3 · 5 · 10 | 5 | Lab default; trade-off between missing the answer and filling the context with noise. Editable in the UI. |
| 6 | Response schema | free text · JSON `{found, answer, citations}` | JSON checked with Zod | `found` gives a defined behaviour when the corpus has no answer; `citations` let the code check that every reference was really retrieved. |
| 7 | What a reference points to | file · chunk · line | chunk id `doc#index` + character offsets | Chunks are what the model actually saw; opening one shows exactly that text. |
| 8 | "Right passage retrieved" when chunk size changes | chunk ids · text evidence | evidence strings copied from the document; hit = a top-k chunk contains one (partial = contains half) | Chunk ids change with the settings; evidence text does not, so runs with different settings stay comparable. |
| 9 | Nothing relevant retrieved | refuse below a score threshold · let the LLM decide | V1: LLM decides (`found: false`) + warning when best score < 0.30 | No calibrated threshold yet; measure scores on answerable vs unanswerable questions first (Evaluation tab shows both averages). |
| 10 | LLM | Gemini (free tier) · school server | Gemini via OpenAI-compatible endpoint, configurable | Free, already used in the Triage app; any OpenAI-compatible endpoint works through `.env.local`. |

## Retrieval baseline (V1)

First real run, 24 Oct 2026, both documents indexed (43 + 1,600 chunks), retrieval only (no LLM call), 2.1 s for 27 questions.
Run file: `eval/runs/2026-10-24T15-44-56-all-MiniLM-L6-v2-c800-o10-k5.json`.

| Date | Embedding | Chunk / overlap / k | hit@k | partial | MRR | simple | hard | multi_hop | needle | avg top score answerable / unanswerable |
|---|---|---|---|---|---|---|---|---|---|---|
| 2026-10-24 | all-MiniLM-L6-v2 | 800 / 10 % / 5 | **69.6 %** (16/23) | 73.9 % | 0.587 | 9/12 | 6/8 (+1 partial) | 0/2 | 1/1 | 0.50 / 0.40 |

Indexing cost: 43 chunks in 8.6 s (includes the first model download), 1,600 chunks in 136 s on a laptop CPU.

## End-to-end answers (Gemini `gemini-3.1-flash-lite`, 24 Oct 2026)

| Question | Retrieval | Answer | Verdict |
|---|---|---|---|
| My machine shows E27, what should I do? | E27 chunk found | found = true, "pressure too high… set the grind adjuster three steps coarser", cites `#0020`; 3.8 s, 1,317 tokens | correct, grounded |
| The coffee drips out very slowly, what is wrong? | evidence cut across chunks (partial) | correct answer from chunk `#0040`; retrieval 57 ms, generation 1.8 s | correct |
| What does this say about Denis Amselemovitch? | needle at rank 1 | describes the injected paragraph, 1 citation | correct (where the full-context demo failed) |
| What does error code E47 mean? | **MISS** (E47 not in top 5) | found = false, "the documents do not contain information regarding error code E47" | safe failure: no hallucination, but the answer IS in the corpus → retrieval problem, not a model problem |
| How much does the Vellora Duo cost? | nothing relevant | found = false, no citation | correct refusal |
| Can I make tea with the Vellora Duo? | nothing relevant | found = false, but 1 citation returned | correct refusal; citing a passage while saying "not found" is inconsistent → V2: drop citations when `found` is false |

## Known failures (starting point for V2)

Observed on the first real run (settings 800 / 10 % / top-5). "Rank" = position of the passage holding the answer.

| Failure | Question that shows it | What we observed | Likely cause → V2 idea |
|---|---|---|---|
| Exact error codes | q11 "What does error code E47 mean?" | **MISS**: the E47 line is not in the top 5 (top 2: the last chunk and another error-code chunk). q12 "E27" was found, but only at rank 2. | Embeddings encode meaning, not exact tokens: the ~10 chunks of E-codes all look alike. → hybrid search: BM25 keyword score + embeddings. |
| A common term hides the precise fact | q01 "How large is the water tank?" | **MISS**: "water tank" appears in many chunks; the parts list with "(1.8 litres)" is not in the top 5. | Many chunks share the words of the question. → hybrid search, smaller chunks for lists. |
| Vocabulary mismatch | q18 "How much space should I leave behind the machine?" (doc: "10 centimetres between the back of the machine and the wall", inside error E79) | **MISS** (best score only 0.32). q16 "hard water … guarantee" vs "limescale … warranty" was found at rank 1. | The answer sits in an error-code entry with different words. → query rewriting, hybrid search. |
| Fact next to a stronger neighbour | q07 "When is customer service available?" | **MISS**: the warranty chunk ranks 1st, the chunk with "Monday to Friday, 9 am to 6 pm" is not in the top 5. | The last section is split between two chunks. → section-aware chunking. |
| Answer cut by a chunk boundary | q19 "The coffee drips out very slowly" | **partial** at rank 1: the top chunk holds only half of the evidence sentence. | Fixed 800-character windows ignore sentences. → sentence/section-aware chunking, more overlap. |
| Multi-hop questions | q20 (E61 + filter), q21 (E05 vs E74) | **0/2**: never both passages in the top 5. | One query, one top-k. → split the question, retrieve per part. |
| Noise from another document | q13, q16, q21 | A *Crime and Punishment* chunk appears in the top 2 of manual questions. | 1,600 literary chunks vs 43 manual chunks, no filter. → metadata filter / ask against the right document. |
| Unanswerable questions look like answerable ones | q22–q24, q27 | Average best score 0.40 for unanswerable vs 0.50 for answerable, with overlap (q23 "tea" scores 0.46, above several found answers). | A fixed similarity threshold cannot separate them; V1 relies on the LLM's `found: false`. → measure the LLM's refusal on these questions. |
| Long chunks partly invisible to the embedder | set chunk size to 2,000 and re-run | _to test_ | all-MiniLM-L6-v2 truncates input after 256 tokens. |

What worked: the needle question (q25 *Denis Amselemovitch*) is found at rank 1 with the best score of the run (0.73), where the full-context prompt of the course demo failed.
