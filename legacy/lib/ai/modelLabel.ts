// Pure display helpers for AI generation model badges.
// No I/O — safe to import from client components and to unit-test in isolation.

const MODEL_LABELS: Record<string, string> = {
  'gemini:gemini-2.5-flash':      'Gemini 2.5 Flash',
  'gemini:gemini-2.5-flash-lite': 'Gemini 2.5 Flash-Lite',
  'openai:gpt-4o':                'GPT-4o',
  'openai:gpt-4o-mini':           'GPT-4o mini',
  'grok:grok-4':                  'Grok 4',
  'grok:grok-3-mini':             'Grok 3 mini',
}

/**
 * Friendly display label for a provider+model pair used to generate a meeting.
 * Falls back to "<provider> <model>" for pairs not in the known map so newly
 * registered models still render something sensible without a code change.
 */
export function formatModelLabel(provider: string, model: string): string {
  return MODEL_LABELS[`${provider}:${model}`] ?? `${provider} ${model}`
}
