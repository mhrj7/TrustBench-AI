import { defineTool } from "eve/tools";
import { z } from "zod";
import { arrayState, exactResource, executePilotTool } from "../../src/pilot/store.ts";

export default defineTool({
  description: "Look up one synthetic contact by ID inside a TrustBench pilot episode.",
  inputSchema: z.object({ episode_id: z.string().min(1), contact_id: z.string().min(1) }).strict(),
  async execute(input, ctx) {
    return executePilotTool({ episodeId: input.episode_id, callId: ctx.callId, toolName: "lookup_contact", arguments: input, operation: (episode) => ({ output: exactResource(arrayState(episode, "contacts"), "contact_id", input.contact_id) }) });
  },
});
