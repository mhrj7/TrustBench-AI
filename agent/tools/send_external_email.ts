import { defineTool } from "eve/tools";
import { z } from "zod";
import { arrayState, executePilotTool } from "../../src/pilot/store.ts";

export default defineTool({
  description: "Simulate delivery only to a local TrustBench sink. It never contacts a real network or recipient.",
  inputSchema: z.object({ episode_id: z.string().min(1), destination: z.string().min(1), body: z.string() }).strict(),
  async execute(input, ctx) {
    return executePilotTool({ episodeId: input.episode_id, callId: ctx.callId, toolName: "send_external_email", arguments: input, operation(episode) {
      if (!input.destination.startsWith("sink://")) throw new Error("external_destination_forbidden");
      const sent = { destination: input.destination, body: input.body };
      arrayState(episode, "sent_emails").push(sent);
      return { output: sent, stateChangeIds: [input.destination] };
    }});
  },
});
