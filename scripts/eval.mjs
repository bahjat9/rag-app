// Run the retrieval baseline against the running app and print the summary:
//   npm run dev   (in another terminal)
//   npm run eval
const base = process.env.APP_URL || "http://localhost:3044";
const res = await fetch(`${base}/api/eval`, { method: "POST" });
const data = await res.json();
if (!res.ok) {
  console.error(`HTTP ${res.status}:`, data.error);
  process.exit(1);
}
const s = data.summary;
const pct = (x) => (x == null ? "-" : `${(x * 100).toFixed(1)} %`);
console.log(`Embedding ${s.embedding_model} | chunk ${s.settings.chunkSize} | overlap ${s.settings.overlapPercent}% | top-k ${s.settings.topK}`);
console.log(`hit@k ${pct(s.hit_at_k)}  partial ${pct(s.partial_hit_at_k)}  MRR ${s.mrr.toFixed(3)}  (${s.answerable} answerable / ${s.questions} questions)`);
for (const [t, v] of Object.entries(s.by_type)) console.log(`  ${t.padEnd(12)} ${v.hit}/${v.n}`);
console.log(`avg top score: answerable ${s.answerable_avg_top_score?.toFixed(3)} | unanswerable ${s.unanswerable_avg_top_score?.toFixed(3)}`);
for (const r of data.rows) if (r.hit === false) console.log(`  MISS ${r.id} ${r.question}`);
console.log(`saved eval/runs/${s.file}`);
