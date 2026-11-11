import "dotenv/config";
import OpenAI from "openai";

const ai = new OpenAI({
  baseURL: process.env.LLM_BASE_URL,
  apiKey: process.env.LLM_API_KEY,
});
try {
  const res = await ai.chat.completions.create({
    model: process.env.LLM_MODEL,
    messages: [
      { role: "user", content: "What is the weather in Paris? Use the tool." },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather for a city",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      },
    ],
  });
  const m = res.choices[0].message;
  console.log(
    m.tool_calls?.length
      ? "PASS: tool calling works -> " +
          JSON.stringify(m.tool_calls[0].function)
      : "FAIL: no tool call. Model said: " + m.content,
  );
} catch (e) {
  console.log("FAIL:", e.status, e.message);
}
