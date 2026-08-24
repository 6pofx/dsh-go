// Generated-by-hand Typert host manifest for the opencodeUsage Remote.
// The typert-loader imports this via package.json exports["./typert"] and
// registers it into ctx.typert.local, which the Host gateway uses to claim
// and dispatch the "opencodeUsage/usage" and "opencodeUsage/refresh"
// endpoints in strict mode.
import { z } from "zod";

const windowSchema = z.object({
  status: z.string().nullable(),
  percent: z.number().nullable(),
  resetsAt: z.string().nullable(),
});

const modelSchema = z.object({
  model: z.string(),
  count: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  totalTokens: z.number(),
  estCost: z.number().nullable(),
  tiered: z.boolean(),
  costPeak: z.number().nullable(),
  costOff: z.number().nullable(),
});

const daySchema = z.object({
  day: z.string(),
  cost: z.number(),
});

const dshSchema = z.object({
  models: z.array(modelSchema),
  byDay: z.array(daySchema),
  scannedSessions: z.number(),
  durationMs: z.number(),
  scanning: z.boolean(),
});

const priceEntrySchema = z.object({
  model: z.string(),
  tiered: z.boolean(),
  in: z.number(),
  out: z.number(),
  cache: z.number(),
  peakIn: z.number().nullable(),
  peakOut: z.number().nullable(),
  peakCache: z.number().nullable(),
});

const resultSchema = z.object({
  fetchedAt: z.number(),
  keySource: z.string().nullable(),
  goInModels: z.boolean().nullable(),
  account: z
    .object({
      rolling: windowSchema.nullable(),
      weekly: windowSchema.nullable(),
      monthly: windowSchema.nullable(),
    })
    .nullable(),
  accountError: z.string().nullable(),
  price: z
    .object({
      source: z.string(),
      fetchedAt: z.number().nullable(),
      error: z.string().nullable(),
      models: z.number(),
    })
    .nullable(),
  prices: z.array(priceEntrySchema),
  dsh: dshSchema.nullable(),
  dshError: z.string().nullable(),
});

export const TYPERT = {
  package: "dsh-go-usage",
  face: "host",
  schemas: [],
  invocations: [
    {
      id: "dsh-go-usage#opencodeUsage/usage",
      service: "opencodeUsage",
      namespace: "opencodeUsage",
      method: "usage",
      invocation: { kind: "direct" },
      parameters: [],
      result: {
        mode: "strict",
        typeSymbol: "dsh-go-usage#OpencodeUsageResult",
        schema: resultSchema,
      },
    },
    {
      id: "dsh-go-usage#opencodeUsage/refresh",
      service: "opencodeUsage",
      namespace: "opencodeUsage",
      method: "refresh",
      invocation: { kind: "direct" },
      parameters: [],
      result: {
        mode: "strict",
        typeSymbol: "dsh-go-usage#RefreshResult",
        schema: z.object({ triggered: z.boolean() }),
      },
    },
  ],
  model: { services: [], events: [], objects: [] },
};
