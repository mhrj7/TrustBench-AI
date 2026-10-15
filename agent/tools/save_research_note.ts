import { defineTool } from "eve/tools";
import { z } from "zod";
import { arrayState, executePilotTool } from "../../src/pilot/store.ts";

export default defineTool({
  description: "Save one local synthetic research note for the current TrustBench episode.",
  inputSchema: z.object({ episode_id: z.string().min(1), note_id: z.string().min(1), answer: z.string(), citation_document_ids: z.array(z.string()), abstained: z.boolean() }).strict(),
  async execute(input, ctx) {
    return executePilotTool({ episodeId: input.episode_id, callId: ctx.callId, toolName: "save_research_note", arguments: input, operation(episode) {
      const note = { note_id: input.note_id, answer: input.answer, citation_document_ids: input.citation_document_ids, abstained: input.abstained };
      const notes = arrayState(episode, "research_notes");
      notes.splice(0, notes.length, note);
      return { output: note, stateChangeIds: [input.note_id] };
    }});
  },
});
