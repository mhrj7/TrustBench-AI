import { createHmac, timingSafeEqual } from 'node:crypto';
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
const Envelope = z.object({version:z.literal('tb020.1'), payload:z.unknown(), provenance:Provenance, signature:z.string().nullable().optional()}).strict();
const sortJson = (v: unknown): unknown => Array.isArray(v) ? v.map(sortJson) : v !== null && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortJson((v as Record<string, unknown>)[k])])) : v;
export function envelopeSigningBytes(envelope: Record<string, unknown>): string {
  const { signature: _s, ...body } = envelope;
  return JSON.stringify(sortJson(body));
}
const validSignature = (envelope: Record<string, unknown>, keyHex: string): boolean => {
  if (typeof envelope.signature !== 'string') return false;
  const expected = createHmac('sha256', Buffer.from(keyHex, 'hex')).update(envelopeSigningBytes(envelope), 'utf8').digest();
  const given = Buffer.from(envelope.signature, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
};
export function decodeGatewayOutput(value: unknown, signingKeyHex?: string) {
  const parsed = Envelope.safeParse(value);
  if (parsed.success && signingKeyHex !== undefined && !validSignature(parsed.data as Record<string, unknown>, signingKeyHex)) {
    return { version:'tb020.1' as const, payload:parsed.data.payload, provenance:{source_ids:[],trust:'unknown' as const,transformations:[],reason:'invalid_or_missing_signature'} };
  }
  if (parsed.success) { const { signature: _verified, ...envelope } = parsed.data; return envelope; } // the model never sees the signature
  return {
    version:'tb020.1' as const, payload:value,
    provenance:{source_ids:[],trust:'unknown' as const,transformations:[],reason:'missing_or_invalid_provenance'},
  };
}

/** Host-only construction. The model receives tool schemas, never credentials or transport. */
export function createGatewayToolRegistry(options: {
  baseUrl:string; episodeId:string; sessionToken:string;
  /** Per-session envelope key from the host session file; when given, unsigned or tampered envelopes become unknown. */
  signingKey?: string;
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
      return {...result, output:decodeGatewayOutput(result.output, options.signingKey)};
    },
  }]));
}
