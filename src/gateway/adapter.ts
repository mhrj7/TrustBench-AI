import { z } from 'zod';
import { createHttpToolRegistry } from '../agent/http-tools.ts';
import type { AgentToolRegistry } from '../agent/contracts.ts';

const Provenance = z.object({
  source_ids: z.array(z.string().min(1)),
  trust: z.enum(['untrusted', 'unknown']),
  transformations: z.array(z.string().min(1)),
  reason: z.string().nullable(),
}).strict().superRefine((value, ctx) => {
  if ((value.trust === 'untrusted' && !value.source_ids.length) ||
      (value.trust === 'unknown' && !value.reason)) {
    ctx.addIssue({code:'custom', message:'incomplete provenance'});
  }
});
const Envelope = z.object({version:z.literal('tb020.1'), payload:z.unknown(), provenance:Provenance}).strict();
export function decodeGatewayOutput(value: unknown) {
  const parsed = Envelope.safeParse(value);
  return parsed.success ? parsed.data : {
    version:'tb020.1' as const, payload:value,
    provenance:{source_ids:[],trust:'unknown' as const,transformations:[],reason:'missing_or_invalid_provenance'},
  };
}

/** Host-only construction. The model receives tool schemas, never credentials or transport. */
export function createGatewayToolRegistry(options: {
  baseUrl:string; episodeId:string; sessionToken:string;
  fetchImpl?: typeof fetch;
}): AgentToolRegistry {
  if (!options.sessionToken.trim()) throw new Error('gateway_session_required');
  const transport = options.fetchImpl ?? fetch;
  const raw = createHttpToolRegistry({
    baseUrl:options.baseUrl, episodeId:options.episodeId,
    fetchImpl: async (url, init) => {
      const headers = new Headers(init?.headers);
      headers.set('authorization', `Bearer ${options.sessionToken}`);
      return transport(url, {...init, headers});
    },
  });
  return Object.fromEntries(Object.entries(raw).map(([name, tool]) => [name, {
    async execute(args, context) {
      const result = await tool.execute(args, context);
      return {...result, output:decodeGatewayOutput(result.output)};
    },
  }]));
}
