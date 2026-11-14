# REPORT – RAG project

> V4 (final release) first, then V3, V2 and V1.

# V4 – final release

## V4 – what we built

| Part | What | Where |
|---|---|---|
| Clean-up | Simple main screen for a non-programmer: **Ask**, **Study**, **Activity**; the V2/V3 tools (evaluation, words, graph, retrieval settings) moved behind a **Developer tools** switch. Step-by-step guidance when nothing is ready, progress messages, "Prepare" instead of "index", plain-language errors, each with a **What happened?** link. README rewritten as a first-time install guide. | `app/page.tsx`, `README.md` |
| A. Observable | One trace per question, indexing run, graph build and quiz, one span per step; **What happened? (details)** under every answer; **Activity** tab with the list of traces and the optional metrics page. | `lib/trace.ts`, `app/ui/TraceView.tsx`, `app/ui/ActivityTab.tsx` |
| B. New feature | **Study artifacts**: quiz (multiple choice, true/false, short answer) or flashcards from the selected documents; number, difficulty, optional topic; every item links to its source passage; interactive quiz with a score. | `lib/study.ts`, `app/ui/StudyTab.tsx` |
| C. Responsible AI | **Personal data redaction**: e-mails, phone numbers, card and bank numbers and names are replaced by placeholders before any text is sent to the LLM provider or written to a trace, and put back locally in what the user reads. | `lib/redact.ts` |

## V4 – A. Traces

**What we trace.** A question: the whole retrieval and each retriever (dense, BM25, graph) with the chunk ids it
returned, the redaction step (how many items of which kind, never the values), the LLM call (model, tokens in/out,
cost, number of calls including the retry), the answer check (citations kept or removed, warnings) and the restore
step; the trace also stores the outcome (answered / not found / invalid / error), the question and the answer **after
redaction**, the selected documents and the settings. An indexing run: per document, read (size only), chunk (count),
embed, save, BM25. A graph build: one span per chunk extraction with its tokens. A quiz: chunk selection, redaction,
LLM call, item checks (kept / dropped and why).

**Never in a trace:** the API key, whole documents (chunk ids and sizes only, never chunk text), personal data (see C),
and the words of the question that BM25 matched (they are words of the question). The person names found by the graph
retriever are written as `[PERSON]`.

**Where, how long, who.** JSON lines in `data/traces/<YYYY-MM-DD>.jsonl`, one file per day, deleted after 30 days
(`TRACE_RETENTION_DAYS`) when a new trace is written. The folder is in `.gitignore`. Traces stay on the laptop; only
the app itself (localhost) reads them, through `/api/traces` and `/api/metrics`. A failing trace write never breaks the
request.

**From the answer to the trace.** The API returns the trace id with every answer (and with every error); the UI
button **What happened? (details)** opens a timeline of the steps in plain language, each step expandable.

**Metrics page (optional, done).** The **Activity** tab computes everything from the traces: number of questions and
outcomes (answered / not found / invalid / error), p50 and p95 latency of the whole request and of each step, tokens
and cost per question, per indexed document (indexing is local: 0 tokens; documents cost tokens only through the graph
build) and per day. Cost = tokens × price per million tokens from `.env.local` (default: paid list price of
gemini-3.1-flash-lite; 0 on the free tier).

**Other options considered.** Langfuse or Arize Phoenix (self-hosted: a second service and a database to run on a
laptop, the "easy to install" goal suffers); a hosted tool (traces, i.e. questions and chunk ids, would leave the
machine: against part C); OpenTelemetry SDK (heavy for one process and still needs a backend to view the spans);
SQLite (one more native dependency on Windows). JSON lines are enough for one user and are easy to read and delete.

**A trace we opened** (question "What does error KST-2044 mean and how do I fix it?", trace `1e641182`): *Answered*,
4.82 s, 1 AI call, 1,334 tokens (1,207 in / 127 out), $0.00049 at the paid price. The steps show where the time goes:
the search took 2.6 s (search by meaning 1.8 s: it was the first question after starting the app, the local embedding
model was loading; BM25 0.7 s) and the AI model 2.2 s. The redaction step replaced 1 e-mail address found in the
passages before sending them. The LLM step lists the 5 passages sent and the 1 it cited
(`support-runbook-errors.md#0004`, the KST-2044 entry); each id opens the passage. Nothing in the trace shows the
document text or the e-mail address.

## V4 – B. Study artifacts

**How it works.** One LLM call per quiz: the app picks the passages (with a topic: the passages dense + BM25 return for
that topic; without: passages spread evenly over the selected documents, from a random start, skipping passages under
250 characters), hides personal data, asks the model for JSON (checked with Zod), then checks every item against the
passages it was given: the passage id must be one of them, a multiple-choice question needs 2-4 different options with
the answer among them, a true/false answer must be True or False, no duplicates. Bad items are dropped and counted; an
item whose answer shares no word with its passage is kept but marked **check this one**.

**Traced:** spans `study.pick_chunks`, `redact.prompt`, `llm.generate` (tokens, cost), `study.check` (kept, dropped and
why).

**Cost per use (gemini-3.1-flash-lite, our runs below):** one LLM call per quiz; 2,170–2,560 tokens and 2.7–2.9 s
for 5 items, 3,474 tokens and 5.8 s for 15 items. At the paid list price that is $0.001–0.0015 per quiz of 5
($0.0036 for 15); on the free tier it costs 0.

**Failures:** invalid JSON → retried once, then "the AI model returned an answer the app could not check"; some
invalid items → dropped, "Only N of the M requested items could be built"; no valid item → clear error and "try
again, ask for fewer items, or pick other documents"; provider unreachable → message + **What happened?**.

**Checked.** Five runs with `npm run cli -- study …`, every item checked by hand against the passage it points to,
grades saved in `eval/study/` (`cli study-grade`):

| # | Documents | Request | Items kept | Correct / partial / wrong / unsupported | What we found |
|---|---|---|---|---|---|
| 1 | Kestrel (5 docs) | quiz, 5, medium, multiple choice + true/false | **4 / 5** (1 dropped: type not asked for) | 4 / 0 / 0 / 0 | Good distractors; the true/false items test exactly the rule changes (seat removal, query time limit). |
| 2 | Kestrel | flashcards, 5, topic "refunds" | 5 / 5 | 5 / 0 / 0 / 0 | The topic works: every card is about refunds, from both policies, and keeps 2025 and 2026 apart. `billing@kestrel.example` was hidden from the model and restored on the card. |
| 3 | Vellora manual | quiz, 5, hard, short answer | 5 / 5 | 3 / 1 / 0 / 1 | "Hard" mostly gives error-code procedures. #3 (E43) asks *why* the grinder must run, which the manual does not say (unsupported); #5 says the warranty is "void" where the manual says "not covered" (partial). |
| 4 | Crime and Punishment | quiz, 3, easy | **1 / 3** (2 dropped: type not asked for) | 1 / 0 / 0 / 0 | The one question is correct; the model ignored "multiple choice only" twice. |
| 5 | service-catalog.md only (6 passages) | quiz, 15 | 15 / 15 | 14 / 0 / 1 / 0 | 15 questions from 6 passages without repeats. #7 says Payments Core is "responsible for the Billing and Refund Policy rules": the catalog says its service *applies* them; the policy's owner is Finance (wrong). #4 (120 seconds) was flagged "check this one" by mistake. |

Overall 27 / 29 kept items fully correct, 1 partial, 1 wrong, 1 unsupported; no invented item.

**What we changed after these runs (measured):**
1. *Dropped items* (runs 1 and 4: the model used a question type that was not asked for, so the user got 4 / 5 and
   1 / 3). The prompt now says "every item's type MUST be one of…", and the app asks for 2 extra items and cuts after
   the checks. Re-run of 1 (Kestrel, quiz, 5): **5 / 5 kept, 0 dropped**, 5 / 5 correct (new Owner must be an Admin,
   pending invitations use no seat, 120-second limit, suspended not deleted after 60 days, KST-1012 action).
   Re-run of 4 (Crime and Punishment, quiz, 3, easy): **3 / 3 kept, 0 dropped**, 3 / 3 correct (Luzhin's
   rank "counsellor", Zossimov's gold watch, the "ordinary / extraordinary" article). A first try of the re-run of 1
   hit a provider timeout: the user got "The AI provider…" with **What happened?**; the trace shows the LLM step in red. That message
   said "cannot be reached" for a timeout: the SDK calls its timeout error `APIConnectionTimeoutError`, which our
   mapping read as a connection error; fixed (timeout checked first, "took too long" message).
2. *False "check this one"* (run 5 #4: "120 seconds" vs "120-second" in the passage). The grounding check now uses
   the BM25 tokenizer (hyphenated words also split) and ignores a final "s": this item is no longer flagged.

## V4 – C. Personal data redaction

**Detection (rules, no extra service, no extra LLM call):** e-mail addresses; phone numbers (international and French,
at least 9 digits); payment card numbers (13-19 digits that pass the Luhn check); IBANs; person names: the `person`
entities of our concept graph, the names listed in `data/pii-names.txt`, a name after a title (Mr, Mrs, Dr, Mme…), after
"my name is" / "je m'appelle", or a full name after "I'm" / "I am".

**Where it applies:** to everything that leaves the machine (the question and the passages of every answer, the
passages of a quiz, the passages sent for graph extraction, the questions of the no-context test) and to everything
written to a trace. Retrieval runs on the original question: it is local (local embeddings, BM25, graph).

**Placeholders, restored locally.** `anna.keller@acme.com` becomes `[EMAIL_1]`; the same value always gets the same
placeholder within a request, so the model can still answer ("[PERSON_1] leads Analytics Engine"); the app puts the
real values back before showing the answer. The mapping lives only in memory during the request.

**Checked:** `npm run cli -- redact-check` runs `eval/redaction-cases.jsonl` (10 cases: what must be hidden and what
must stay, e.g. error codes, the documented IP addresses 203.0.113.10/11, invoice numbers, dates, prices): **9 / 10
pass**. The failing case is the known limit: a first name alone ("my colleague Sarah") is not detected. On the corpus:
the Kestrel e-mail addresses (billing@, privacy@) and the 6 team leads of the service catalog are hidden; in *Crime and
Punishment* the titled names (Mr. Luzhin…) are hidden too (harmless false positives: restored in the answer).

## V4 – decision log (new entries)

| # | Decision | Options considered | Picked | Why |
|---|---|---|---|---|
| 26 | Clean-up | keep every control on screen · hide them | Ask / Study / Activity for the user; V2-V3 tools behind "Developer tools" | The user knows the documents, not RAG; the tools stay one click away for the evaluation. |
| 27 | Trace storage | Langfuse / Phoenix · hosted tool · OpenTelemetry · SQLite · JSON lines | JSON lines per day in `data/traces/`, 30 days | One user, one laptop: no extra service, nothing leaves the machine, easy to delete. |
| 28 | Trace content | full prompt and chunks · ids and counts | ids, sizes, counts, tokens; question/answer after redaction | Documents and personal data must not be copied into logs. |
| 29 | Personal data in traces | store as is · drop the question · store redacted | redacted question and answer, no mapping | A trace must still explain the request without exposing anyone. |
| 30 | Cost | tokens only · tokens × price | tokens × configurable price (0 on the free tier) | Shows what the same use would cost on a paid plan. |
| 31 | New feature | study · concept map · conversation · reranking… | study artifacts | Useful for a non-programmer, one LLM call, every item checkable against its passage. |
| 32 | Quiz passages | random · retrieval by topic | evenly spread (random start), or retrieval when a topic is given | Covers the whole document by default; the topic reuses our V3 retrieval. |
| 33 | Quiz checks | trust the model · check | Zod + item checks (passage id, options, answer), drop and count | The model sometimes points to wrong passages or gives an answer outside the options. |
| 34 | Responsible-AI feature | injection scanner · redaction | personal data redaction | Questions and passages leave the machine on every call; traces keep copies. |
| 35 | Detection | regex · NER library · LLM | rules + names from the graph and a list | No extra download or LLM call (an LLM call would send the data out to detect it). |
| 36 | Redaction style | delete · mask · reversible placeholders | reversible placeholders, mapping in memory | The answer still names the person / address for the user; the provider never sees it. |

## V4 – known failures (updated)

| Failure | Example | What happens | Idea |
|---|---|---|---|
| A first name alone, or a name in no list | "my colleague Sarah" | not hidden | a small NER model run locally |
| Fictional names after a title | Crime and Punishment "Mr. Luzhin" | hidden, then restored: the model reasons on `[PERSON_1]` | turn redaction off per corpus |
| Postal addresses, dates of birth | – | not detected | more rules |
| Quiz quality depends on the passages | a passage cut in the middle of a sentence | the question can be vague | section-aware chunking |
| Grounding check is lexical | an answer paraphrased with other words | marked "check this one" although correct | ask the model to quote the passage |
| Traces are per laptop | – | no team view | fine for one user |

---

# V3 report

## V3 – results table

Every run: chunks 800 / 10 % / min paragraph 20, all-MiniLM-L6-v2, top 10 retrieved, top-k 5 for answers. Kestrel now has
10 answerable questions (q11, q12 added in V3); V2 rows had 8. Full table with V1/V2 runs and per-type recall: `eval/RESULTS.md`
(`cli.ts results`).

### Kestrel KB (10 answerable questions)

| Configuration | hit@1 | hit@3 | hit@5 | hit@10 | recall@1 | recall@3 | recall@5 | recall@10 | MRR | retrieval ms / q |
|---|---|---|---|---|---|---|---|---|---|---|
| dense | 50 % | 80 % | 90 % | 100 % | 33 % | 65 % | 80 % | 90 % | 0.692 | 44 |
| bm25 (extra) | 60 % | 90 % | 90 % | 90 % | 40 % | 63 % | 63 % | 85 % | 0.733 | 2 |
| dense + bm25 | 50 % | 100 % | 100 % | 100 % | 30 % | 78 % | 90 % | 95 % | 0.700 | 44 |
| dense + bm25 + graph | **60 %** | 90 % | 100 % | 100 % | 40 % | 68 % | 90 % | 90 % | **0.753** | 116 (*) |

Per type, hit@1 / 3 / 5 / 10 (questions):

| Configuration | exact_identifier (2) | split_answer (2) | two_hop (3) | versions (2) | vocabulary (1) |
|---|---|---|---|---|---|
| dense | 1 / 1 / 1 / 2 | 2 / 2 / 2 / 2 | 1 / 3 / 3 / 3 | 0 / 1 / 2 / 2 | 1 / 1 / 1 / 1 |
| bm25 | 2 / 2 / 2 / 2 | 1 / 2 / 2 / 2 | 2 / 3 / 3 / 3 | 1 / 2 / 2 / 2 | 0 / 0 / 0 / 0 |
| dense + bm25 | 1 / 2 / 2 / 2 | 1 / 2 / 2 / 2 | 2 / 3 / 3 / 3 | 1 / 2 / 2 / 2 | 0 / 1 / 1 / 1 |
| dense + bm25 + graph | 2 / 2 / 2 / 2 | 1 / 2 / 2 / 2 | 2 / 3 / 3 / 3 | 1 / 1 / 2 / 2 | 0 / 1 / 1 / 1 |

Per type, recall@1 / 3 / 5 / 10 (%):

| Configuration | exact_identifier | split_answer | two_hop | versions | vocabulary |
|---|---|---|---|---|---|
| dense | 25 / 50 / 50 / 100 | 63 / 100 / 100 / 100 | 17 / 50 / 67 / 67 | 0 / 50 / 100 / 100 | 100 / 100 / 100 / 100 |
| bm25 | 75 / 100 / 100 / 100 | 25 / 38 / 38 / 100 | 33 / 50 / 50 / 83 | 50 / 100 / 100 / 100 | 0 / 0 / 0 / 0 |
| dense + bm25 | 25 / 100 / 100 / 100 | 25 / 63 / 100 / 100 | 33 / 50 / 67 / 83 | 50 / 100 / 100 / 100 | 0 / 100 / 100 / 100 |
| dense + bm25 + graph | 75 / 100 / 100 / 100 | 25 / 63 / 100 / 100 | 33 / 50 / 67 / 67 | 50 / 50 / 100 / 100 | 0 / 100 / 100 / 100 |

(*) The graph run was made on our laptop (dense 98 ms, BM25 6 ms, graph 2 ms); the other rows on a faster machine
(dense ~40 ms). Compare the per-retriever times, not the totals across machines.

### Vellora manual + Crime and Punishment (23 answerable questions)

| Configuration | hit@1 | hit@3 | hit@5 | hit@10 | recall@1 | recall@3 | recall@5 | recall@10 | MRR | retrieval ms / q |
|---|---|---|---|---|---|---|---|---|---|---|
| dense | 52 % | 65 % | 78 % | 87 % | 52 % | 63 % | 74 % | 85 % | 0.628 | 22 |
| bm25 (extra) | 48 % | 74 % | 87 % | 91 % | 46 % | 72 % | 85 % | 91 % | 0.617 | 21 |
| dense + bm25 | 57 % | 78 % | 87 % | 96 % | 52 % | 74 % | 83 % | 96 % | 0.693 | 51 |

Per type, hit@1 / 3 / 5 / 10: see `eval/RESULTS.md` (two_hop: dense 0/1/2/2 → dense+bm25 2/2/2/2; vocabulary 4/4/5/5 → 3/4/4/6).

### Cost per question

| Configuration | LLM calls (retrieval) | LLM calls (answer) | tokens / answer | latency (our laptop, `--answers` runs) |
|---|---|---|---|---|
| dense | 0 | 1 | 1,280 | 84 ms (generation 4.9 s) |
| dense + bm25 | 0 | 1 | 1,310 | 78 ms, bm25 13 ms (generation 4.5 s) |
| dense + bm25 + graph | 0 (the graph is searched by names) | 1 | 1,280 | 136 ms, graph 7 ms (generation 9.5 s, slowed by Gemini 503 retries) |
| graph build (once, Kestrel) | 42 calls (one per chunk), 37,028 input + 13,301 output tokens, 302 s of LLM time | | | ≈ 1.0 call, 1,200 tokens per chunk |

### Default configuration

Our default is **dense + BM25**. It is better than dense alone on both corpora: on Kestrel hit@5 goes from 90 % to
100 % and recall@5 from 80 % to 90 %; on our corpus hit@5 goes from 78 % to 87 %, hit@10 from 87 % to 96 % and MRR from
0.628 to 0.693. BM25 adds about 10 ms per question and no LLM call. Adding the graph on Kestrel gives the best hit@1
(50 → 60 %) and MRR (0.700 → 0.753), but it loses hit@3 (100 → 90 %, question q06) and two_hop recall@10
(83 → 67 %, question q12), it only exists for Kestrel, and it costs 42 LLM calls every time it is rebuilt. So the graph
stays a switch: it is useful when the question names an error code (q01 moved from rank 3 to rank 1), not as the default.

## V3 – BM25

**Index.** BM25 has its own small index next to the dense one: one JSON file per document and chunk setting
(`data/index/<doc>__bm25__800_10_20.json`). For every chunk it stores the chunk length and how many times each word
appears. It is built from exactly the same chunks (same ids) as the dense index, so both retrievers talk about the same
chunks and RRF can add their votes.

**Tokenization.** We reuse the tokenizer of the Words tab: lower-case, letters and digits, and error codes like KST-2044
or IP addresses like 203.0.113.10 stay one token. Stop words are removed. A hyphenated word also gives its parts
(`two-factor` → `two-factor`, `two`, `factor`), so an exact code still matches exactly and "factor" still matches "two-factor".
Scoring is standard BM25 (k1 = 1.2, b = 0.75). The document frequencies are computed at query time over the documents
the question is asked against, so adding or removing a document never leaves old statistics.

**Updates.** The file keeps the hash of the document. If the document changed, or the file is missing, it is rebuilt
automatically before the next search (same check as the dense index).

**What it changed.** BM25 fixes exact identifiers: for Kestrel q01 (KST-2044) dense had the answer at rank 6, BM25 at
rank 1, and after fusion it is at rank 3. On our corpus it found q07 (customer service hours, missed by dense) and q18.
What it cannot do: Kestrel q05 ("I lost my phone and can't log in") – the document talks about the second factor and
backup codes, there is no word in common, and BM25 does not find the answer in its top 20.

## V3 – concept graph

The graph is built only on Kestrel. At indexing time an LLM reads each chunk and returns (entity, relation, entity)
triples with a fixed list of types; we check every answer with Zod, keep where each fact came from, and merge entities
with the same name. At question time we look for entity names in the question and follow the edges to find chunks.
The details:

- **Schema (fixed):** entity types error_code, service, team, person, channel, plan, feature, role, policy, setting, value, concept; relations raised_by, escalate_to, owned_by, led_by, on_call_channel, included_in, configured_in, requires, replaces, has_value, related_to (`lib/graph.ts`).
- **Extraction:** one LLM call per chunk (42 chunks), JSON schema mode + Zod check. Invalid output → retried once → the chunk is recorded as failed (listed in the Graph tab and `graph stats`) and skipped; `--retry-failed` tries again. A quota error stops the build without marking the chunk; running it again resumes.
- **Headings problem we found:** the chunker drops paragraphs shorter than 20 characters, so headings like `### connector-hub` and `### postroom` are not in any chunk: a chunk says "Owner: Data Integrations" without saying of what. The extraction prompt therefore also gets the headings of the sections the chunk overlaps (computed from the document). The chunks themselves are unchanged.
- **Provenance:** every entity and edge keeps the ids of the chunks it was extracted from; the UI opens them.
- **Entity resolution:** names normalised (case, "the", punctuation, KST codes upper-case, trailing "service/team/plan/policy/channel" removed); same normalised name = same entity. 7 merges. **Correct merge:** `Free` + `Free plan` → one entity `free` (the trailing "plan" is removed). **Missed merge:** `annual plan` was merged into `annual`, but `annual plans` (plural) stayed a separate entity: plurals are not normalised, so one concept is two entities. **Wrong type:** `Analytics Engine` is typed team in some chunks and service in others (8 such type conflicts; the majority type is kept).
- **Retrieval:** entities whose name appears in the question are the seeds (values excluded, the most specific name kept); edges are followed 2 hops (weights 1, 1, 0.5); every chunk behind a seed / edge / reached entity gets the weight; chunks ranked by total weight.
- **Cost:** 42 LLM calls, 37,028 input + 13,301 output tokens, 302 s (gemini-3.1-flash-lite, paced 4 s between calls). One chunk's first output was invalid (relation names used as keys); Zod rejected it, the retry was valid: 0 failed chunks. Gemini refused our nested JSON schema with HTTP 400, so the extraction asks for the format in the prompt instead (`lib/llm.ts`); Zod checks the result the same way.
- **Where it fails:**
  - no entity named in the question → no seed → nothing (q03, q05, q09).
  - generic words match entity names: "Which **team**…" matches the plan *Team*, "**support**" and "**plan**" are entities too (q02, q08, q10, q11, q12 have such seeds). Their chunks (plans table, billing) take places in the graph's list.
  - the second hop is not reached: q08's second quote (Messaging row) is only rank 20 in the graph list; q12's second hop goes through the IP addresses, which are `value` entities (never seeds, not followed at hop 2), so connector-hub is never reached.
  - extraction errors (3 wrong, 1 unsupported out of 10 sampled triples).
- **Optional features:** none (aliases are only the merged surface names).

### Graph in numbers

| | |
|---|---|
| Chunks read / failed | 42 / 0 |
| Entities / relations | 198 / 156 |
| Entity types | value 44, feature 24, concept 23, error_code 21, policy 17, setting 15, plan 13, service 12, team 10, channel 8, person 6, role 5 |
| Relation types | has_value 59, included_in 23, related_to 18, owned_by 13, configured_in 12, escalate_to 9, requires 6, led_by 6, on_call_channel 6, raised_by 2, replaces 2 |
| Merges (entity resolution) / type conflicts | 7 / 8 |
| Build cost | 42 calls, 37,028 + 13,301 tokens, 302 s |
| Retrieval latency | 2 ms per question, 0 LLM calls |

### Extraction quality (10 random triples)

`eval/graph-triples.json` (seeded random draw, graded by hand). **correct 6 · wrong 3 · unsupported 1.** The wrong ones attach a value to the wrong subject (12 months is for a corrected invoice copy, not a refund window; 50 recipients is per schedule, not per dashboard; KST-5038 is not "included in" Enterprise, the longer token lifetime is). `has_value` is the most frequent relation (59 / 156) and the least reliable.

### Did the graph's chunks reach the top-k after fusion?

Yes: graph chunks are in the fused top-5 for **8 of the 10** answerable questions (5 of 5 places for q02, q04, q08, q11, and for the unanswerable q10). They are not always the evidence chunks:

| Question | graph seeds | evidence rank in the graph list | fused rank, dense+bm25 → +graph |
|---|---|---|---|
| q01 KST-2044 | KST-2044 | 1, 1 | 3, 3 → **1, 1** |
| q06 annual plan refund | plan; annual plan | –, – | 3, 3 → **5, 5** |
| q08 KST-5031 | Team; support; KST-5031 | 4, 20 | 1, – → 1, – |
| q11 KST-3012 | Team; support; KST-3012 | 12, 10 | 2, 4 → 2, 4 |
| q12 KST-2044 → IP owner | Team; KST-2044 | 7, – | 1, 10 → 1, **–** |

We did not change the fusion: the graph chunks already reach the top-k. What would help is better seeds (ignore generic words such as team, support, plan) and following values at hop 2 – not done in V3 (see known failures).

## V3 – one question where adding a retriever made things worse

**Kestrel q06** – "Can I get a refund on my annual plan 45 days after it renewed?" (type versions). With dense + BM25
both evidence quotes are at rank 3; when we add the graph they drop to rank 5, which is the hit@3 drop from 100 % to 90 %.
The graph finds "plan" and "annual plan" in the question and uses them as seeds. These are very general entities that
appear in many chunks (plans, billing), so the graph's list is full of chunks about plans in general and does not contain
the 2026 refund rule at all. With RRF every list votes, so chunks that get a graph vote on top
of their dense or BM25 vote pass the evidence chunk, which gets no graph vote. The graph made things worse because the question only names generic entities; it helps when the
question names something specific, like an error code (q01).

Other cases we saw: q12 (graph: the second quote leaves the top 10), q03 (BM25: the 2026 chunk is dense #1 but only
BM25 #8, and the old 2025 policy, which uses the same words, passes it; recall@3 100 % → 25 %) and Vellora q14 (BM25:
rank 4 → 8, because BM25 has no evidence chunk in its top 20 and the evidence only gets the dense vote).

## V3 – decision log (new entries)

| # | Decision | Options considered | Picked | Why |
|---|---|---|---|---|
| 16 | Keyword retriever | BM25 library · own BM25 | own BM25 (~100 lines), k1 1.2, b 0.75 | Small corpora; we control the tokenizer (error codes, IPs whole) and can show what matched. |
| 17 | Where the BM25 index lives | in memory at start · file next to the dense index | file per document + chunk setting, IDF at query time | Same chunks and ids as dense; rebuilt with the same document-hash check; IDF follows the selected documents. |
| 18 | Fusion | weighted score sum · RRF | RRF, k = 60, top 20 per retriever | Scores of cosine, BM25 and graph are on different scales; RRF only uses ranks. |
| 19 | Graph schema | free extraction · fixed schema | 12 entity types, 11 relations | Fixed types can be validated with Zod and compared; free relations explode into near-duplicates. |
| 20 | Invalid extraction | stop the build · skip the chunk | retry once, then record and skip; quota errors stop and resume | One bad chunk must not lose the build; failures stay visible. |
| 21 | Headings for extraction | change the chunker · add headings to the prompt | headings in the extraction prompt only | Changing the chunker changes every V2 number; the graph needs to know which service a paragraph is about. |
| 22 | Graph query | LLM extracts entities from the question · name matching | name matching | No LLM call at query time (cost, latency); the limit is questions that do not name an entity. |
| 23 | New questions | edit q08 · add | add q11, q12 (two_hop) with evidence for each hop | Never edit questions silently. |
| 24 | Default retrievers | dense · dense+bm25 · dense+bm25+graph | dense + bm25 (graph switchable, Kestrel only) | Best hit@3 on Kestrel (100 %) and better than dense on both corpora; the graph adds hit@1 (50 → 60 %) but loses q06 and q12 and costs 42 LLM calls per build. |
| 25 | Graph output format | JSON schema mode · format in the prompt | JSON schema, falls back to the prompt when the provider refuses the schema (400) | Gemini refused the nested schema; Zod checks the output in both cases. |

## V3 – known failures (updated)

| Failure | Question | What we observed | Idea |
|---|---|---|---|
| No shared word, no named entity | Kestrel q05 | BM25 and graph find nothing; only dense finds it | keep dense in the default |
| Old and new policy share the words | Kestrel q03 | BM25 ranks the 2026 chunk 8th; the runbook and the 2025 policy pass it (rank 1 → 5) | prefer the newest version / metadata filter |
| One-retriever evidence loses in RRF | Vellora q14 | evidence found by dense only drops 4 → 8 | weighted RRF, or a larger top-k |
| Headings removed by the chunker | service-catalog | chunks lose the service name ("connector-hub") | section-aware chunking |
| Generic words become graph seeds | Kestrel q02, q08, q10–q12 | "team", "support", "plan" match entities; their chunks fill the graph list | stop list for seeds, or let the LLM pick the entities in the question |
| Second hop through a value | Kestrel q12 | IP addresses are values: never followed, connector-hub never reached | follow value nodes when they are shared by two chunks |
| Wrong subject in has_value | 3 of 10 sampled triples | value attached to the wrong entity | narrower relations (per value kind), or attach values to the sentence's subject only |
| Plurals not merged | annual plan / annual plans | one concept, two entities | singularise names in the normalisation |

---

# V2 report


## V2 – results table

Both corpora × three configurations (embedding all-MiniLM-L6-v2, top 10 retrieved). Generated by
`cli.ts results` (copied from `eval/RESULTS.md`); every run file is in `eval/runs/`.

### Kestrel KB (provided)

Hit rate (at least one evidence quote in the top k) and recall (share of the evidence quotes in the top k), 8 answerable questions.

| Configuration | hit@1 | hit@3 | hit@5 | hit@10 | recall@5 | recall@10 | MRR | avg top score answerable / unanswerable |
|---|---|---|---|---|---|---|---|---|
| **A** 800 / 10 % / min 20 | 63 % | 75 % | 88 % | 100 % | 81 % | 94 % | 0.740 | 0.53 / 0.41 |
| **B** 400 / 25 % / min 20 | 75 % | 88 % | 88 % | 88 % | 66 % | 78 % | 0.792 | 0.57 / 0.45 |
| **C** 1200 / 10 % / min 20 | 75 % | 100 % | 100 % | 100 % | 94 % | 100 % | 0.854 | 0.50 / 0.39 |

Per question type, hit@1 / hit@3 / hit@5 / hit@10 (n = questions of that type):

| Configuration | exact_identifier (n=2) | split_answer (n=2) | two_hop (n=1) | versions (n=2) | vocabulary (n=1) |
|---|---|---|---|---|---|
| **A** 800 / 10 % | 1 / 1 / 1 / 2 | 2 / 2 / 2 / 2 | 1 / 1 / 1 / 1 | 0 / 1 / 2 / 2 | 1 / 1 / 1 / 1 |
| **B** 400 / 25 % | 1 / 2 / 2 / 2 | 2 / 2 / 2 / 2 | 0 / 0 / 0 / 0 | 2 / 2 / 2 / 2 | 1 / 1 / 1 / 1 |
| **C** 1200 / 10 % | 1 / 2 / 2 / 2 | 2 / 2 / 2 / 2 | 1 / 1 / 1 / 1 | 1 / 2 / 2 / 2 | 1 / 1 / 1 / 1 |

### Vellora manual + Crime and Punishment (ours)

Hit rate (at least one evidence quote in the top k) and recall (share of the evidence quotes in the top k), 23 answerable questions.

| Configuration | hit@1 | hit@3 | hit@5 | hit@10 | recall@5 | recall@10 | MRR | avg top score answerable / unanswerable |
|---|---|---|---|---|---|---|---|---|
| **A** 800 / 10 % / min 20 | 52 % | 65 % | 78 % | 87 % | 74 % | 85 % | 0.628 | 0.50 / 0.40 |
| **B** 400 / 25 % / min 20 | 43 % | 61 % | 74 % | 83 % | 74 % | 80 % | 0.564 | 0.56 / 0.43 |
| **C** 1200 / 10 % / min 20 | 35 % | 70 % | 78 % | 91 % | 74 % | 87 % | 0.541 | 0.48 / 0.39 |

Per question type, hit@1 / hit@3 / hit@5 / hit@10 (n = questions of that type):

| Configuration | exact_identifier (n=2) | other (n=12) | split_answer (n=1) | two_hop (n=2) | vocabulary (n=6) |
|---|---|---|---|---|---|
| **A** 800 / 10 % | 0 / 1 / 1 / 2 | 8 / 9 / 10 / 10 | 0 / 0 / 0 / 1 | 0 / 1 / 2 / 2 | 4 / 4 / 5 / 5 |
| **B** 400 / 25 % | 0 / 0 / 2 / 2 | 7 / 10 / 10 / 11 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 1 | 3 / 4 / 5 / 5 |
| **C** 1200 / 10 % | 1 / 1 / 1 / 2 | 5 / 9 / 10 / 11 | 1 / 1 / 1 / 1 | 0 / 2 / 2 / 2 | 1 / 3 / 4 / 5 |

## V2 – what we changed between configurations, and what moved

| Run | Chunk size | Overlap | Min paragraph | What changed vs A |
|---|---|---|---|---|
| A | 800 | 10 % | 20 | V1 baseline |
| B | 400 | 25 % | 20 | smaller chunks, more overlap |
| C | 1200 | 10 % | 20 | larger chunks |

Configuration C (1,200 characters) works best on Kestrel (MRR 0.854, every answer found by k = 3), while A (800) is best on our corpus for exact first-rank hits (MRR 0.628). Kestrel's answers are long and spread over several paragraphs, so bigger chunks keep the related information together in one piece. With small chunks (B), the two-hop question q08 is missed at every k: the question mentions neither "postroom" nor "Messaging", so neither small chunk looks similar enough to it. On our corpus, the manual is made of short, separate facts; large chunks mix unrelated topics together, which lowers hit@1 from 52 % (A) to 35 % (C), even though C finds more by k = 10 (91 %).

## V2 – no-context test

Results in `eval/no-context/` (gemini-3.1-flash-lite, an LLM judge proposes a verdict, flags checked by hand).

Kestrel: the model answered 0 of the 8 answerable questions without retrieval, because Kestrel is a fictional company and the model has no background knowledge about it.

Our corpus: the model answered 6 questions correctly without retrieval (q04, q08, q14, q18, q19, q26). It used general knowledge (basic coffee-machine care, and Crime and Punishment, a famous book), not our documents. We checked the judge's flags by hand and removed q06 and q07, where the model actually said it did not know. (q21 had a provider error and has no result.)

Decision: we keep these questions so our results stay comparable across versions, and we will add new questions about facts that only our manual contains (exact error codes, the 1.8-litre tank) to really test retrieval.

## V2 – hand grades

We graded configuration C (1,200 / 10 % / top-5) on the Kestrel set, using the rules in `eval/GRADING.md`
(run file: `eval/runs/2026-11-02T22-20-14-kestrel-c1200-o10-k5-answers.json`).

Correct: 3 · Partial: 7 · Wrong: 0 · Unsupported: 0

- q01 partial: does not say that adding only one IP causes intermittent errors. Evidence was in the chunks → generation failure.
- q03 partial: does not say that nothing is deleted. Evidence was in the chunks → generation failure.
- q04 partial: leaves out "test with one Admin, then enforce". Evidence was in the chunks → generation failure.
- q05 partial: leaves out "up to 2 business days". Evidence was in the chunks → generation failure.
- q06 partial: does not mention the old 30-day rule of the 2025 policy. Evidence was in the chunks → generation failure.
- q07 partial: does not mention the old 15 % of the 2025 policy. Evidence was in the chunks → generation failure.
- q08 partial: never names Messaging or #oncall-messaging. The service-catalog chunk was only at rank 9, outside the top 5 → retrieval failure (second hop).
- q02, q09, q10 correct. q09 and q10 correctly say "not in the documents".

The model never invented anything (0 wrong, 0 unsupported); it mostly drops secondary details.

## V2 – two diagnosed misses (one per corpus)

**Kestrel q01** ("What does error KST-2044 mean and how do I fix it?", config A): the answer is in chunk `support-runbook-errors.md#0004`, but it is only retrieved at rank 6; the top chunk (`#0003`) is the one about KST-2040. In the Words tab, "kst-2044" appears in exactly one chunk, the right one, while "error" appears in 9 chunks but not in the answer chunk, and "mean" and "fix" are not in the corpus at all. The model searches by general meaning instead of exact letters, and since both codes mean "connection error", it sees them as almost the same thing.

**Our q01** ("How large is the water tank?", missed in every configuration): the answer is in `vellora-duo-espresso-machine.txt#0002` ("the water tank (1.8 litres)"), which is never in the top 5. "water" appears in 70 chunks and "tank" in 15, so many chunks look as relevant as the right one, and the search cannot find the one specific sentence about the tank.

## V2 – decision log (new entries)

| # | Decision | Options considered | Picked | Why |
|---|---|---|---|---|
| 11 | Retrieval measure | chunk ids · evidence text | hit@k and recall@k for k = 1, 3, 5, 10, overall and per type; a chunk is relevant if it comes from the evidence's source and contains the quote | Text evidence stays valid when chunk size changes, so configurations are comparable; recall shows whether all parts of split and two-hop answers were found. |
| 12 | Our V1 questions | rewrite them · convert them | converted to the Kestrel JSONL format, same ids, Kestrel type labels, "other" for the rest | Never edit old questions silently; same format lets one script evaluate both corpora. |
| 13 | What a "word" is (Words tab) | split on spaces · letters/digits only | lower-case, letters and digits, keeping inner "-" and "." (KST-2044, 203.0.113.10 stay one word), counted in chunks, stop words hideable | Error codes and IP addresses must stay whole to diagnose exact-identifier misses; counting in chunks shows what retrieval actually sees. |
| 14 | Configurations compared | chunk size · overlap · top-k | A 800/10 %, B 400/25 %, C 1,200/10 % | Chunk size is the parameter that changes most what a chunk contains; k is read at 1, 3, 5, 10 in every run anyway. |
| 15 | No-context judge | grade all by hand · LLM judge | LLM proposes a verdict, we check the flags by hand | Faster for 37 questions, but the judge made mistakes (q06, q07), so a human check is needed. |

## V2 – known failures (updated)

| Failure | Question that shows it | What we observed | Idea for V3+ |
|---|---|---|---|
| Exact identifiers | Kestrel q01 (KST-2044) | Right chunk only at rank 6, neighbour code KST-2040 first | Combine exact-word search (BM25) with embeddings |
| Two-hop with small chunks | Kestrel q08 | Missed at every k with 400-character chunks; with 1,200 the answer still misses the second hop | Split the question into two searches |
| Common words hide the fact | our q01 (water tank) | Missed in every configuration; "water" is in 70 chunks | Break text by paragraphs/sections instead of character counts; hybrid search |
| Questions the model already knows | our q04, q08, q14, q18, q19, q26 | Answered without retrieval | Add questions only our manual can answer |
| Answers drop secondary details | Kestrel q01, q03–q07 (graded partial) | Evidence was retrieved, but the answer leaves out a detail | Ask the model in the prompt to give every condition, number and old/new version |

---

# V1 report

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
