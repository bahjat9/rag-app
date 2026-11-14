// Command-line entry point: the same code as the front-end, without the server.
//
//   node --env-file-if-exists=.env.local --conditions=react-server --import tsx scripts/cli.ts <command> [options]
//   (npm run cli -- <command> [options] does the same)
//
// Commands:
//   eval --set kestrel|vellora [--retrievers dense,bm25,graph] [--chunk 800] [--overlap 10] [--minpara 20] [--k 5] [--answers] [--label "A"]
//        retrieval evaluation for one configuration (builds the indexes it needs); --retrievers picks
//        the retrievers fused with RRF (default: the saved settings); --answers also generates the
//        answers (LLM calls) for hand grading.
//   graph build --set kestrel [--rebuild] [--retry-failed]
//        LLM extraction of the concept graph (resumable: run it again after a quota error)
//   graph stats --set kestrel            entities, relations, merges, type conflicts, cost
//   graph sample --set kestrel [--force] draw 10 random triples into eval/graph-triples.json (grade them by hand)
//   graph ask --set kestrel "question"   graph retrieval only: seeds, edges followed, chunks
//   study --set kestrel [--docs a.md,b.md] [--kind quiz|flashcards] [--count 5] [--difficulty easy|medium|hard]
//         [--types multiple_choice,true_false,short_answer] [--topic "refunds"]
//        V4: generate a quiz or flashcards (one LLM call), print it, save it to eval/study/ for checking
//   study-grade --file <eval/study file> --grades c,c,p,u,w [--notes "a|b|..."]   V4: save hand grades
//   redact-check                         V4: run the personal-data redaction test cases (eval/redaction-cases.jsonl)
//   nocontext --set kestrel|vellora      ask every question to the LLM without retrieval
//   results                              print the results table of every run (Markdown) and write eval/RESULTS.md
import { promises as fs } from "fs";
import path from "path";
import { EVAL_DIR } from "../lib/questions";
import { KS, listRuns, resultsMarkdown, runEval } from "../lib/evaluate";
import { runNoContext } from "../lib/nocontext";
import { buildGraph, graphSearch, graphStats, loadGraph, sampleTriples } from "../lib/graph";
import { getSet } from "../lib/questions";
import { parseRetrievers } from "../lib/retrieve";
import { generateStudy } from "../lib/study";
import { knownNames, Redactor } from "../lib/redact";
import { getSettings } from "../lib/settings";
import { ensureIndexes } from "../lib/store";

function args(argv: string[]) {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[a.slice(2)] = true;
    else {
      out[a.slice(2)] = next;
      i++;
    }
  }
  return out;
}
const num = (v: string | boolean | undefined) => (typeof v === "string" ? Number(v) : undefined);
const pct = (x: number) => `${(x * 100).toFixed(1)} %`;
const progress = (done: number, total: number) => process.stdout.write(`\r  ${done}/${total}`);

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const a = args(rest);
  if (command === "eval") {
    if (typeof a.set !== "string") throw new Error("--set is required (kestrel | vellora)");
    const { summary: s, rows } = await runEval(
      { set: a.set, retrievers: typeof a.retrievers === "string" ? parseRetrievers(a.retrievers) : undefined, chunkSize: num(a.chunk), overlapPercent: num(a.overlap), minParagraphLength: num(a.minpara), topK: num(a.k), answers: a.answers === true, label: typeof a.label === "string" ? a.label : "" },
      progress,
    );
    console.log(`\n${s.set_name} | retrievers ${s.retrievers} | ${s.embedding_model} | chunk ${s.settings.chunkSize} | overlap ${s.settings.overlapPercent} % | min paragraph ${s.settings.minParagraphLength} | top-k ${s.settings.topK}`);
    console.log(`${s.answerable} answerable / ${s.questions} questions | MRR ${s.mrr.toFixed(3)}`);
    for (const k of KS) console.log(`  k=${String(k).padEnd(2)}  hit ${pct(s.at[k].hit).padStart(7)}  recall ${pct(s.at[k].recall).padStart(7)}  partial ${pct(s.at[k].partial).padStart(7)}`);
    for (const [t, v] of Object.entries(s.by_type)) console.log(`  ${t.padEnd(18)} n=${v.n}  hit@1/3/5/10 ${KS.map((k) => Math.round(v.at[k].hit * v.n)).join("/")}  recall@1/3/5/10 ${KS.map((k) => (v.at[k].recall * 100).toFixed(0)).join("/")} %`);
    if (s.cost) console.log(`cost per question: retrieval ${s.cost.retrieval_ms_avg} ms ${JSON.stringify(s.cost.per_retriever_ms_avg)} | LLM calls ${s.cost.llm_calls_per_question} | tokens ${s.cost.tokens_per_question ?? 0}${s.cost.generation_ms_avg ? ` | generation ${s.cost.generation_ms_avg} ms` : ""}`);
    if (s.graph_in_topk_questions !== undefined) console.log(`graph chunks in the fused top-${s.settings.topK}: ${s.graph_in_topk_questions}/${s.answerable} answerable questions`);
    for (const r of rows) if (r.hit && !r.hit[10]) console.log(`  MISS@10 ${r.id} ${r.question}`);
    console.log(`avg top score answerable ${s.answerable_avg_top_score?.toFixed(3)} | unanswerable ${s.unanswerable_avg_top_score?.toFixed(3) ?? "-"}`);
    if (s.answers) console.log(`answers generated with ${s.llm_model}: grade them in the Evaluation tab or in the file`);
    console.log(`saved eval/runs/${s.file}`);
  } else if (command === "nocontext") {
    if (typeof a.set !== "string") throw new Error("--set is required (kestrel | vellora)");
    const { summary, rows } = await runNoContext(a.set, progress);
    console.log(`\n${summary.set_name} | ${summary.llm_model} | verdicts ${JSON.stringify(summary.verdicts)} | errors ${summary.errors}`);
    for (const r of rows) console.log(`  ${r.id} ${r.flag ? "ANSWERED WITHOUT RAG" : "                    "} ${r.verdict ?? "error"}  ${r.question}`);
    console.log(`saved eval/no-context/${summary.file} (check the flags by hand in the Evaluation tab)`);
  } else if (command === "graph") {
    const sub = rest[0];
    const set = await getSet(typeof a.set === "string" ? a.set : "kestrel");
    const settings = await getSettings();
    if (sub === "build") {
      await ensureIndexes(set.docs, settings);
      const st = await buildGraph(set.docs, settings, { rebuild: a.rebuild === true, retryFailed: a["retry-failed"] === true }, progress);
      console.log(`\n${JSON.stringify(st, null, 2)}`);
    } else if (sub === "stats") {
      const g = await loadGraph(settings, set.docs);
      if (!g) throw new Error("No graph yet: run graph build first.");
      console.log(JSON.stringify(graphStats(g), null, 2));
      console.log("merges (entity resolution):");
      for (const m of g.merges) console.log(`  ${m.key}  <=  ${m.names.join(" | ")}`);
      if (g.type_conflicts.length) console.log("type conflicts:", g.type_conflicts.map((t) => `${t.key} (${t.types.join("/")})`).join(", "));
      const failed = Object.entries(g.extractions).filter(([, x]) => !x.ok);
      for (const [id, x] of failed) console.log(`  FAILED ${id}: ${x.error}`);
    } else if (sub === "sample") {
      const t = await sampleTriples(set.docs, settings, { force: a.force === true });
      for (const x of t.triples) console.log(`  ${x.n}. (${x.source}) -[${x.relation}]-> (${x.target})   from ${x.chunk}`);
      console.log("saved eval/graph-triples.json: grade each one correct / wrong / unsupported (Graph tab, or in the file)");
    } else if (sub === "ask") {
      const question = rest.slice(1).filter((x) => !x.startsWith("--") && x !== a.set).join(" ");
      const r = await graphSearch(question, set.docs, settings, 10);
      if (!r.available) throw new Error("No graph for these documents: run graph build first.");
      console.log("seeds:", r.path.seeds.map((x) => `${x.name} (${x.type}, matched "${x.matched}")`).join(", ") || "none");
      for (const e of r.path.edges) console.log(`  hop ${e.hop}: ${e.source} -[${e.relation}]-> ${e.target}   ${e.chunks.join(", ")}`);
      for (const h of r.hits) console.log(`  #${h.rank} ${h.id} ${h.score}`);
    } else throw new Error("graph build | stats | sample | ask");
  } else if (command === "study") {
    // V4: generate a quiz / flashcards from a set's documents (or --docs a,b) and save it for checking
    const set = await getSet(typeof a.set === "string" ? a.set : "kestrel");
    const docs = typeof a.docs === "string" ? a.docs.split(",") : set.docs;
    const r = await generateStudy({
      docs,
      kind: a.kind === "flashcards" ? "flashcards" : "quiz",
      count: num(a.count) ?? 5,
      difficulty: a.difficulty === "easy" || a.difficulty === "hard" ? a.difficulty : "medium",
      types: typeof a.types === "string" ? (a.types.split(",") as ("multiple_choice" | "true_false" | "short_answer")[]) : undefined,
      topic: typeof a.topic === "string" ? a.topic : undefined,
    });
    for (const it of r.items) {
      console.log(`\n${it.n}. [${it.type}] ${it.question}${it.check ? "   (CHECK THIS ONE)" : ""}`);
      it.options.forEach((o) => console.log(`     ${o === it.answer ? "*" : "-"} ${o}`));
      if (!it.options.length) console.log(`     -> ${it.answer}`);
      console.log(`     source: ${it.chunk.id}`);
    }
    console.log(`\n${r.items.length}/${r.requested} items | dropped ${JSON.stringify(r.dropped)} | tokens ${r.usage?.total_tokens ?? 0} | cost $${r.cost_usd} | LLM ${r.llm_ms} ms | trace ${r.traceId}`);
    r.warnings.forEach((w) => console.log("warning:", w));
    const dir = path.join(EVAL_DIR, "study");
    await fs.mkdir(dir, { recursive: true });
    const file = `${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}-${r.kind}.json`;
    const request = { docs, kind: r.kind, count: r.requested, difficulty: a.difficulty ?? "medium", types: a.types ?? "multiple_choice", topic: a.topic ?? null };
    await fs.writeFile(path.join(dir, file), JSON.stringify({ request, ...r, items: r.items.map((i) => ({ ...i, grade: null, note: "" })) }, null, 2) + "\n", "utf8");
    console.log(`saved eval/study/${file} (grade each item by hand: correct / wrong / unsupported)`);
  } else if (command === "study-grade") {
    // V4: save the hand grades of a saved quiz: --file <name in eval/study> --grades c,c,p,u,w [--notes "n1|n2|..."]
    if (typeof a.file !== "string" || typeof a.grades !== "string") throw new Error("--file and --grades are required");
    const file = path.join(EVAL_DIR, "study", path.basename(a.file));
    const data = JSON.parse(await fs.readFile(file, "utf8"));
    const map: Record<string, string> = { c: "correct", p: "partial", w: "wrong", u: "unsupported" };
    const grades = a.grades.split(",").map((g) => map[g.trim()] ?? g.trim());
    const notes = typeof a.notes === "string" ? a.notes.split("|") : [];
    data.items.forEach((it: { grade: string | null; note: string }, i: number) => {
      it.grade = grades[i] ?? it.grade;
      it.note = notes[i]?.trim() ?? it.note;
    });
    const counts: Record<string, number> = {};
    data.items.forEach((it: { grade: string | null }) => (counts[it.grade ?? "ungraded"] = (counts[it.grade ?? "ungraded"] ?? 0) + 1));
    data.grades = counts;
    await fs.writeFile(file, JSON.stringify(data, null, 2) + "\n", "utf8");
    console.log(`${path.basename(file)}: ${JSON.stringify(counts)}`);
  } else if (command === "redact-check") {
    // V4 Part C: run the redaction test cases (eval/redaction-cases.jsonl) and report what is hidden / kept
    const cases = (await fs.readFile(path.join(EVAL_DIR, "redaction-cases.jsonl"), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const names = await knownNames();
    let pass = 0;
    for (const c of cases) {
      const r = new Redactor(names);
      const out = r.redact(c.text);
      const leaked = (c.must_hide as string[]).filter((x) => out.includes(x));
      const lost = (c.must_keep as string[]).filter((x) => !out.includes(x));
      const restored = r.restore(out) === c.text;
      const ok = !leaked.length && !lost.length && restored;
      if (ok) pass++;
      console.log(`${ok ? "PASS" : "FAIL"} ${c.id}  ${out}`);
      if (leaked.length) console.log(`       not hidden: ${leaked.join(" | ")}`);
      if (lost.length) console.log(`       wrongly hidden: ${lost.join(" | ")}`);
      if (!restored) console.log("       restore does not give back the original text");
    }
    console.log(`\n${pass}/${cases.length} cases pass (names known from the graph / data/pii-names.txt: ${names.length})`);
  } else if (command === "results") {
    const md = resultsMarkdown(await listRuns());
    await fs.writeFile(path.join(EVAL_DIR, "RESULTS.md"), `# Retrieval results (generated by \`cli.ts results\`)\n\n${md}`, "utf8");
    console.log(md);
    console.log("written to eval/RESULTS.md");
  } else {
    console.log("usage: cli.ts eval --set <id> [--retrievers dense,bm25,graph] [--chunk n] [--overlap n] [--minpara n] [--k n] [--answers] [--label x] | nocontext --set <id> | graph build|stats|sample|ask --set <id> | results");
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("\nError:", e?.publicMessage ?? e?.message ?? e);
  // the public message hides the provider's detail; in the terminal we show it (never contains the key)
  if (e?.publicMessage && e?.message && e.message !== e.publicMessage) console.error("Detail:", String(e.message).slice(0, 1200));
  process.exit(1);
});
