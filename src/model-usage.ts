export interface ModelUsage { inputTokens?: number; outputTokens?: number; totalTokens?: number; }
export interface ModelRequestAccounting { reserve(): Promise<string>; settle(reservationId: string, usage?: ModelUsage): Promise<void>; }

export function normalizeModelUsage(input: unknown): ModelUsage | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = input as ModelUsage;
  const usage: ModelUsage = {};
  for (const key of ["inputTokens", "outputTokens", "totalTokens"] as const) {
    if (value[key] !== undefined) {
      if (!Number.isSafeInteger(value[key]) || value[key]! < 0) return undefined;
      usage[key] = value[key];
    }
  }
  if (!Object.keys(usage).length) return undefined;
  const subtotal = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  if (!Number.isSafeInteger(subtotal) || (usage.totalTokens !== undefined && usage.totalTokens < subtotal)) return undefined;
  return usage;
}

export function readModelUsage(value: unknown): ModelUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as { response?: { usage?: any }; usage?: any };
  const raw = record.response?.usage ?? record.usage;
  return raw && typeof raw === "object" ? normalizeModelUsage({ inputTokens: raw.input_tokens, outputTokens: raw.output_tokens, totalTokens: raw.total_tokens }) : undefined;
}
