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
      const user = (body.messages || []).find((m) => m.role === "user")?.content || "";
      const ids = [...user.matchAll(/<excerpt id="([^"]+)">\n([\s\S]*?)\n<\/excerpt>/g)];
      const q = (user.split("Question:").pop() || "").toLowerCase();
      const found = !/cost|price|watts|smartphone|tea/.test(q);
      let content = JSON.stringify({
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
