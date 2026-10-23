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
 * Environment reads are trimmed. A trailing newline picked up when pasting a key
 * into a dashboard is the most common cause of a 401 that looks like a bad key,
 * and it is invisible in every log that prints only the status.
 */
function envValue(name: string): string | undefined {
  const raw = process.env[name];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export type LlmSource = "llm" | "openai" | "proxy";

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
  const explicitKey = envValue("LLM_API_KEY");
  const explicitBase = envValue("LLM_BASE_URL");
  const explicitModel = envValue("LLM_MODEL");

  if (explicitKey && explicitBase && explicitModel) {
    return {
      baseUrl: explicitBase.replace(/\/$/, ""),
      apiKey: explicitKey,
      model: explicitModel,
      temperature: 0.4,
    };
  }

  const openaiKey = envValue("OPENAI_API_KEY");
  const openaiBase = envValue("OPENAI_BASE_URL");
  // The managed proxy is identified by its refresh URL, not by the key: the same
  // OPENAI_API_KEY name is used for both, so the base URL is what disambiguates.
  const proxyBase = envValue("OH_LLM_API_KEY_REFRESH_BASE_URLS")?.split(",")[0]?.trim();
  if (proxyBase && openaiKey && !openaiBase) {
    return {
      baseUrl: proxyBase.replace(/\/$/, ""),
      apiKey: openaiKey,
      model: explicitModel || "claude-sonnet-4-5-20250929",
      temperature: 0.4,
    };
  }

  if (openaiKey) {
    return {
      baseUrl: (openaiBase || "https://api.openai.com/v1").replace(/\/$/, ""),
      apiKey: openaiKey,
      model: explicitModel || "gpt-4o-mini",
      temperature: 0.4,
    };
  }

  const proxyOnlyKey = envValue("OH_LLM_PROXY_KEY");
  if (proxyBase && proxyOnlyKey) {
    return {
      baseUrl: proxyBase.replace(/\/$/, ""),
      apiKey: proxyOnlyKey,
      model: explicitModel || "claude-sonnet-4-5-20250929",
      temperature: 0.4,
    };
  }

  return null;
}

export function hasLlm(): boolean {
  return resolveLlmConfig() !== null;
}

/**
 * Non-secret description of the resolved LLM configuration, for /api/cue.
 *
 * When track naming silently degrades, the question is always "which endpoint and
 * which model did it actually try, and was the key shaped like a key at all?".
 * This answers that from the deployed app, without shipping the secret or needing
 * log access. Only lengths and booleans are exposed, never key material.
 */
export function llmDiagnostics() {
  const config = resolveLlmConfig();
  const rawKey =
    process.env.LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? process.env.OH_LLM_PROXY_KEY;
  const key = config?.apiKey;

  let source: LlmSource | "none" = "none";
  if (config) {
    if (envValue("LLM_API_KEY") && envValue("LLM_BASE_URL") && envValue("LLM_MODEL")) {
      source = "llm";
    } else if (envValue("OPENAI_BASE_URL")) {
      source = "openai";
    } else if (envValue("OH_LLM_API_KEY_REFRESH_BASE_URLS")) {
      source = "proxy";
    } else {
      source = "openai";
    }
  }

  return {
    configured: config !== null,
    source,
    baseUrl: config?.baseUrl ?? null,
    model: config?.model ?? null,
    keyLength: key?.length ?? 0,
    // A paste that picked up surrounding whitespace is the classic silent 401.
    keyHadWhitespace:
      typeof rawKey === "string" && rawKey.length > 0 && rawKey !== rawKey.trim(),
    keyStartsWithSk: key ? key.startsWith("sk-") : false,
  };
}

/**
 * One minimal round trip to the configured endpoint, reporting the upstream
 * status so a misconfiguration is visible from outside the deployment.
 */
export async function probeLlm(): Promise<{
  ok: boolean;
  status: number | null;
  detail: string;
}> {
  const config = resolveLlmConfig();
  if (!config) return { ok: false, status: null, detail: "No LLM configured." };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: "user", content: "Reply with the single word: pong" }],
      }),
      signal: controller.signal,
    });
    const text = await res.text().catch(() => "");
    return { ok: res.ok, status: res.status, detail: text.slice(0, 300) };
  } catch (error) {
    return {
      ok: false,
      status: null,
      detail: error instanceof Error ? error.message : "Unknown transport error",
    };
  } finally {
    clearTimeout(timer);
  }
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

    if (!res.ok) {
      // A misconfigured model or revoked key must be visible in the server log.
      // Without this the pipeline silently degrades to "no LLM" and the operator
      // sees unexplained "Track TBD" cues with no hint as to why.
      const detail = await res.text().catch(() => "");
      console.warn(
        `[cue] LLM call failed: ${res.status} model=${config.model} ${detail.slice(0, 300)}`,
      );
      return null;
    }

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
