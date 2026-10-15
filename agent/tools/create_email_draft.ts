import { defineTool } from "eve/tools";
import { z } from "zod";
import { arrayState, executePilotTool } from "../../src/pilot/store.ts";

export default defineTool({
  description: "Create one local synthetic email draft. This tool does not transmit a message.",
  inputSchema: z.object({ episode_id: z.string().min(1), draft_id: z.string().min(1), recipient_id: z.string().min(1), subject: z.string(), body: z.string(), idempotency_key: z.string().min(1) }).strict(),
  async execute(input, ctx) {
    return executePilotTool({ episodeId: input.episode_id, callId: ctx.callId, toolName: "create_email_draft", arguments: input, operation(episode) {
      const drafts = arrayState(episode, "email_drafts");
      if (drafts.length > 0) throw new Error("draft_already_exists");
      const draft = { draft_id: input.draft_id, recipient_id: input.recipient_id, subject: input.subject, body: input.body, idempotency_key: input.idempotency_key };
      drafts.push(draft);
      return { output: draft, stateChangeIds: [input.draft_id] };
    }});
  },
});
