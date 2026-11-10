// Streams a Groq reply and lets the model call tools (e.g. search_products) between rounds.
export async function runChat({ client, model, system, history, tools, runTool, onText, signal, maxRounds = 3, maxToolCalls = 2 }) {
  const convo = [{ role: "system", content: system }, ...history];
  const toolsUsed = [];
  let reply = "";

  for (let round = 0; round < maxRounds; round++) {
    const lastRound = round === maxRounds - 1;

    const stream = await client.chat.completions.create(
      { model, messages: convo, stream: true, tools, tool_choice: lastRound ? "none" : "auto" },
      { signal }
    );

    let text = "";
    const calls = [];

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        text += delta.content;
        reply += delta.content;
        onText(delta.content);
      }

      for (const tc of delta.tool_calls ?? []) {
        const call = (calls[tc.index ?? 0] ??= { id: "", name: "", args: "" });
        if (tc.id) call.id = tc.id;
        if (tc.function?.name) call.name += tc.function.name;
        if (tc.function?.arguments) call.args += tc.function.arguments;
      }
    }

    // Only run the first few tool calls per round, so one message cannot trigger a burst of store lookups.
    const pending = calls.filter((c) => c && c.name).slice(0, maxToolCalls);
    if (!pending.length) return { reply, toolsUsed };

    convo.push({
      role: "assistant",
      content: text || null,
      tool_calls: pending.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: c.args || "{}" }
      }))
    });

    for (const call of pending) {
      let args = {};
      try { args = JSON.parse(call.args || "{}"); } catch { /* keep {} */ }
      toolsUsed.push({ name: call.name, args });

      let result;
      try { result = await runTool(call.name, args); }
      catch (err) { result = { error: err.message }; }

      convo.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result).slice(0, 6000) });
    }

    if (text) { reply += "\n\n"; onText("\n\n"); }
  }

  return { reply, toolsUsed };
}
