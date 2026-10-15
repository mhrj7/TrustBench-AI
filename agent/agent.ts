import { defineAgent } from "eve";
import { chatgpt } from "eve/models/openai";

export default defineAgent({
  defaultTools: false,
  model: chatgpt("gpt-6-luna-fast"),
  reasoning: "medium",
  limits: {
    maxInputTokensPerSession: 20_000,
    maxOutputTokensPerSession: 2_000,
    maxTokenCostUsdPerSession: 0.01,
  },
});
