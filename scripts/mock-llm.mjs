// Offline mock of an OpenAI-compatible chat endpoint for testing the app without a key:
//   node scripts/mock-llm.mjs   (http://localhost:4011/v1)
// It answers by quoting the first excerpt and cites its id. Not a real model.
import http from "node:http";
http
  .createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      if (body.model === "mock-400" && body.response_format) {
        res.writeHead(400);
        return res.end();
      }
      const user = (body.messages || []).find((m) => m.role === "user")?.content || "";
      const ids = [...user.matchAll(/<excerpt id="([^"]+)">\n([\s\S]*?)\n<\/excerpt>/g)];
      const q = (user.split("Question:").pop() || "").toLowerCase();
      const found = !/cost|price|watts|smartphone|tea/.test(q);
      const sys = (body.messages || []).find((m) => m.role === "system")?.content || "";
      const schemaName = body.response_format?.json_schema?.name || (/knowledge graph/.test(sys) ? "graph_extraction" : undefined);
      let content;
      if (schemaName === "no_context_answer") {
        // pretend the model "knows" generic questions only
        content = JSON.stringify({ knows: /dishwasher|warranty|marmeladov/.test(q), answer: "(mock) a guess from general knowledge" });
      } else if (schemaName === "judge") {
        content = JSON.stringify({ verdict: /does not know|guess/.test(user) ? "wrong" : "abstained", reason: "(mock judge)" });
      } else if (schemaName === "graph_extraction") {
        // crude pattern extraction, only to test the graph pipeline offline
        const text = ids[0]?.[2] || "";
        const ent = new Map();
        const rel = [];
        let heading = null;
        const secs = ((user.match(/<sections>\n([\s\S]*?)\n?<\/sections>/) || [])[1] || "").split("\n").map((x) => x.split(" > ").pop()).filter((x) => /^[a-z][a-z-]+$/.test(x || ""));
        let owner = 0;
        for (const line of text.split("\n")) {
          const h = line.match(/^###\s+([a-z][a-z-]+)\s*$/);
          if (h) { heading = h[1]; ent.set(heading, "service"); }
          const own = line.match(/^Owner: \*\*(.+?)\*\*/);
          if (own && !heading && secs.length) heading = secs[Math.min(owner++, secs.length - 1)], ent.set(heading, "service");
          if (own && heading) { ent.set(own[1], "team"); rel.push({ source: heading, relation: "owned_by", target: own[1] }); }
          const owns = line.match(/(KST-\d{4}).*?team that owns (\w+)/) || null;
          if (owns) { ent.set(owns[2], "service"); }
          const codes = line.match(/KST-\d{4}/g) || [];
          const services = [...line.matchAll(/`([a-z][a-z-]+)`/g)].map((m) => m[1]);
          const channels = line.match(/#[a-z][a-z-]+/g) || [];
          const cells = line.startsWith("|") ? line.split("|").map((x) => x.trim()).filter(Boolean) : [];
          codes.forEach((c) => ent.set(c, "error_code"));
          services.forEach((x) => ent.set(x, "service"));
          channels.forEach((x) => ent.set(x, "channel"));
          for (const c of codes) for (const x of services) rel.push({ source: c, relation: "raised_by", target: x });
          if (cells.length >= 3 && channels.length && !/^-+$/.test(cells[0])) {
            ent.set(cells[0], "team");
            rel.push({ source: cells[0], relation: "on_call_channel", target: channels[0] });
            if (/^[A-Z][a-zé]+ [A-Z][a-z]+$/.test(cells[1])) {
              ent.set(cells[1], "person");
              rel.push({ source: cells[0], relation: "led_by", target: cells[1] });
            }
          }
        }
        const bad = /#0003$/.test(ids[0]?.[1] || ""); // one chunk returns an invalid type, to test validation
        content = JSON.stringify({
          entities: [...ent].slice(0, 40).map(([name, type]) => ({ name, type: bad ? "thing" : type })),
          relations: rel.slice(0, 30),
        });
      } else content = JSON.stringify({
        found,
        answer: found ? `(mock) ${ids[0]?.[2].slice(0, 160).replace(/\s+/g, " ")}` : "(mock) The documents do not contain this information.",
        citations: found ? [ids[0]?.[1], "invented.txt#9999"].filter(Boolean) : [],
      });
      if (body.model === "mock-garbage") content = "not json";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "m", object: "chat.completion", created: 0, model: body.model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: Math.ceil(user.length / 4), completion_tokens: Math.ceil(content.length / 4), total_tokens: Math.ceil((user.length + content.length) / 4) } }));
    });
  })
  .listen(Number(process.env.MOCK_PORT) || 4011, () => console.log("mock LLM on http://localhost:4011/v1"));
