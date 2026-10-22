/**
 * Provider-agnostic LLM access.
 *
 * Cue talks to any OpenAI-compatible chat-completions endpoint, so the demo is
 * not welded to one vendor. The agent loop lives in planner.ts; this module only
 * handles transport, tool schema plumbing and graceful degradation.
 */

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
}

/**
 * Resolve LLM credentials from the environment.
 *
 * Preference order:
 *  1. Explicit LLM_* variables (any OpenAI-compatible provider).
 *  2. OpenAI variables.
 *  3. The Agent Canvas managed proxy, which is OpenAI-compatible and lets the
 *     app run with zero user-supplied keys during development.
 */
export function resolveLlmConfig(): LlmConfig | null {
  const explicitKey = process.env.LLM_API_KEY;
  const explicitBase = process.env.LLM_BASE_URL;
  const explicitModel = process.env.LLM_MODEL;

  if (explicitKey && explicitBase && explicitModel) {
    return {
      baseUrl: explicitBase.replace(/\/$/, ""),
      apiKey: explicitKey,
      model: explicitModel,
      temperature: 0.4,
    };
  }

  if (process.env.OPENAI_API_KEY) {
    return {
      baseUrl: (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(
        /\/$/,
        "",
      ),
      apiKey: process.env.OPENAI_API_KEY,
      model: explicitModel || "gpt-4o-mini",
      temperature: 0.4,
    };
  }

  const proxyBase = process.env.OH_LLM_API_KEY_REFRESH_BASE_URLS?.split(",")[0]?.trim();
  const proxyKey = process.env.OPENAI_API_KEY || process.env.OH_LLM_PROXY_KEY;
  if (proxyBase && proxyKey) {
    return {
      baseUrl: proxyBase.replace(/\/$/, ""),
      apiKey: proxyKey,
      model: explicitModel || "claude-sonnet-4-5-20250929",
      temperature: 0.4,
    };
  }

  return null;
}

export function hasLlm(): boolean {
  return resolveLlmConfig() !== null;
}

interface ChatCompletionChoice {
  message?: {
    content?: string | null;
    tool_calls?: Array<{
      id: string;
      type?: string;
      function?: { name?: string; arguments?: string };
    }>;
  };
  finish_reason?: string;
}

/**
 * One turn of chat completion. Returns null instead of throwing so callers can
 * fall back to the deterministic planner.
 */
export async function chat(
  config: LlmConfig,
  messages: ChatMessage[],
  tools: ToolSpec[] = [],
  timeoutMs = 45_000,
): Promise<ChatMessage | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    temperature: config.temperature ?? 0.4,
  };
  if (tools.length > 0) {
    body.tools = tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
    body.tool_choice = "auto";
  }

  try {
    const res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) return null;

    const json = (await res.json()) as { choices?: ChatCompletionChoice[] };
    const choice = json.choices?.[0];
    if (!choice?.message) return null;

    const toolCalls = (choice.message.tool_calls ?? [])
      .filter((call) => call.function?.name)
      .map((call) => ({
        id: call.id,
        type: "function" as const,
        function: {
          name: call.function!.name!,
          arguments: call.function!.arguments ?? "{}",
        },
      }));

    return {
      role: "assistant",
      content: choice.message.content ?? null,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract the first JSON object from a model response that may include prose or
 * code fences. Returns null when nothing parseable is present.
 */
export function extractJson<T>(text: string | null): T | null {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
