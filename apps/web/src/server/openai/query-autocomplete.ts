import OpenAI from "openai";
import { createTTLCache } from "@/server/cache/lru";
import { appConfig } from "@/server/config";

const openai = appConfig.openAiApiKey
  ? new OpenAI({ apiKey: appConfig.openAiApiKey })
  : null;

const autocompleteCache = createTTLCache<string, string[]>(
  Math.min(appConfig.cache.ttlMs, 2 * 60 * 1000),
  Math.min(appConfig.cache.maxEntries, 300),
);

function normalizePrefix(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s+\?/g, "?");
}

function fallbackCompletions(prefix: string): string[] {
  const base = normalizePrefix(prefix);
  if (base.length < 3) return [];

  if (/^what are the\b/i.test(base)) {
    return [
      `${base} top ranked targets for this disease context?`,
      `${base} strongest pathway-to-target mechanism with compound support?`,
      `${base} key caveats before advancing this mechanism?`,
    ];
  }

  if (/^for\b/i.test(base)) {
    return [
      `${base} what mechanism path has the strongest evidence?`,
      `${base} which target is most actionable with current compounds?`,
      `${base} what are the highest-priority evidence gaps to close?`,
    ];
  }

  return [
    `${base} strongest disease-to-target mechanism path?`,
    `${base} most actionable target with pathway and drug support?`,
    `${base} highest-priority evidence gaps before nomination?`,
  ];
}

export async function suggestQueryCompletions(
  prefix: string,
  limit = 3,
): Promise<string[]> {
  const normalized = normalizePrefix(prefix);
  if (normalized.length < 4) return [];

  const cacheKey = `${normalized.toLowerCase()}::${limit}`;
  const cached = autocompleteCache.get(cacheKey);
  if (cached) return cached;

  const fallback = fallbackCompletions(normalized).slice(0, limit);
  if (!openai) {
    autocompleteCache.set(cacheKey, fallback);
    return fallback;
  }

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      suggestions: {
        type: "array",
        items: { type: "string" },
      },
    },
    required: ["suggestions"],
  } as const;

  const systemPrompt = [
    "You autocomplete translational biomedicine questions.",
    "Return 2-3 concise full suggestions that all start with the exact provided prefix.",
    "Stay within disease-target-pathway-drug mechanism analysis scope.",
    "Prefer practical prompts a translational biologist would ask.",
    "Keep each suggestion <= 18 words.",
    "No markdown, no commentary, suggestions only.",
  ].join(" ");

  try {
    const response = await Promise.race([
      openai.responses.create({
        model: appConfig.openai.smallModel,
        max_output_tokens: 140,
        reasoning: { effort: "minimal" },
        input: [
          {
            role: "system",
            content: [{ type: "input_text", text: systemPrompt }],
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: `Prefix: ${normalized}`,
              },
            ],
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "query_autocomplete",
            schema,
            strict: true,
          },
        },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("autocomplete timeout")), 1800),
      ),
    ]);

    const parsed = JSON.parse(response.output_text) as { suggestions?: string[] };
    const suggestions = (parsed.suggestions ?? [])
      .map((item) => normalizePrefix(item))
      .filter((item) => item.length > normalized.length + 2)
      .map((item) => (item.startsWith(normalized) ? item : `${normalized} ${item}`))
      .filter((item) => item.toLowerCase().startsWith(normalized.toLowerCase()))
      .slice(0, limit);

    const deduped: string[] = [];
    const seen = new Set<string>();
    for (const suggestion of suggestions) {
      const key = suggestion.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(suggestion);
    }

    const result = deduped.length > 0 ? deduped : fallback;
    autocompleteCache.set(cacheKey, result);
    return result;
  } catch {
    autocompleteCache.set(cacheKey, fallback);
    return fallback;
  }
}
