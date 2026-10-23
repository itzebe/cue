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

export type LlmSource = "llm" | "openai" | "proxy" | "openrouter" | "gemini" | "groq";

/**
 * A provider named directly by its own environment variable.
 *
 * These exist because `OPENAI_API_KEY` is the generic fallback, and a key sitting
 * there with an exhausted balance otherwise shadows a perfectly good key the
 * operator set under the provider's own name. A provider-specific variable is a
 * deliberate choice, so it outranks the generic one.
 */
interface ProviderPreset {
  source: LlmSource;
  baseUrl: string;
  model: string;
  keyVars: string[];
}

const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    source: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openai/gpt-oss-120b:free",
    keyVars: ["OPENROUTER_API_KEY"],
  },
  {
    source: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    model: "gemini-3.5-flash",
    keyVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  },
  {
    source: "groq",
    baseUrl: "https://api.groq.com/openai/v1",
    model: "openai/gpt-oss-120b",
    keyVars: ["GROQ_API_KEY"],
  },
];

/** Every variable this module will read, for the config report. */
const KNOWN_KEY_VARS = [
  "LLM_API_KEY",
  ...PROVIDER_PRESETS.flatMap((preset) => preset.keyVars),
  "OPENAI_API_KEY",
  "OH_LLM_PROXY_KEY",
];

/**
 * Resolve LLM credentials from the environment.
 *
 * Preference order:
 *  1. Explicit LLM_* variables (any OpenAI-compatible provider).
 *  2. A provider-specific key: OpenRouter, Gemini, then Groq.
 *  3. OpenAI variables.
 *  4. The Agent Canvas managed proxy, which is OpenAI-compatible and lets the
 *     app run with zero user-supplied keys during development.
 *
 * The source is returned alongside the config so the report cannot drift from
 * what the pipeline actually uses.
 */
function detectLlm(): { config: LlmConfig; source: LlmSource; keyVar: string } | null {
  const explicitKey = envValue("LLM_API_KEY");
  const explicitBase = envValue("LLM_BASE_URL");
  const explicitModel = envValue("LLM_MODEL");

  if (explicitKey && explicitBase && explicitModel) {
    return {
      config: {
        baseUrl: explicitBase.replace(/\/$/, ""),
        apiKey: explicitKey,
        model: explicitModel,
        temperature: 0.4,
      },
      source: "llm",
      keyVar: "LLM_API_KEY",
    };
  }

  for (const preset of PROVIDER_PRESETS) {
    const keyVar = preset.keyVars.find((name) => envValue(name) !== undefined);
    if (keyVar) {
      return {
        config: {
          baseUrl: preset.baseUrl.replace(/\/$/, ""),
          apiKey: envValue(keyVar)!,
          model: explicitModel || preset.model,
          temperature: 0.4,
        },
        source: preset.source,
        keyVar,
      };
    }
  }

  const openaiKey = envValue("OPENAI_API_KEY");
  const openaiBase = envValue("OPENAI_BASE_URL");
  // The managed proxy is identified by its refresh URL, not by the key: the same
  // OPENAI_API_KEY name is used for both, so the base URL is what disambiguates.
  const proxyBase = envValue("OH_LLM_API_KEY_REFRESH_BASE_URLS")?.split(",")[0]?.trim();
  const proxyModel = explicitModel || "claude-sonnet-4-5-20250929";

  if (proxyBase && openaiKey && !openaiBase) {
    return {
      config: { baseUrl: proxyBase.replace(/\/$/, ""), apiKey: openaiKey, model: proxyModel, temperature: 0.4 },
      source: "proxy",
      keyVar: "OPENAI_API_KEY",
    };
  }

  if (openaiKey) {
    return {
      config: {
        baseUrl: (openaiBase || "https://api.openai.com/v1").replace(/\/$/, ""),
        apiKey: openaiKey,
        model: explicitModel || "gpt-4o-mini",
        temperature: 0.4,
      },
      source: "openai",
      keyVar: "OPENAI_API_KEY",
    };
  }

  const proxyOnlyKey = envValue("OH_LLM_PROXY_KEY");
  if (proxyBase && proxyOnlyKey) {
    return {
      config: { baseUrl: proxyBase.replace(/\/$/, ""), apiKey: proxyOnlyKey, model: proxyModel, temperature: 0.4 },
      source: "proxy",
      keyVar: "OH_LLM_PROXY_KEY",
    };
  }

  return null;
}

export function resolveLlmConfig(): LlmConfig | null {
  return detectLlm()?.config ?? null;
}

export function hasLlm(): boolean {
  return detectLlm() !== null;
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
  const detected = detectLlm();
  // Check the variable that actually supplied the key, so a stray space in a
  // provider-specific var is reported rather than masked by a clean generic one.
  const rawKey = detected ? process.env[detected.keyVar] : undefined;
  const key = detected?.config.apiKey;

  return {
    configured: detected !== null,
    source: detected?.source ?? "none",
    keyVar: detected?.keyVar ?? null,
    baseUrl: detected?.config.baseUrl ?? null,
    model: detected?.config.model ?? null,
    keyLength: key?.length ?? 0,
    // A paste that picked up surrounding whitespace is the classic silent 401.
    keyHadWhitespace:
      typeof rawKey === "string" && rawKey.length > 0 && rawKey !== rawKey.trim(),
    keyStartsWithSk: key ? key.startsWith("sk-") : false,
    // Which variables exist, so a key set under an unexpected name is visible
    // rather than silently ignored. Presence only, never values.
    presentKeyVars: KNOWN_KEY_VARS.filter((name) => envValue(name) !== undefined),
  };
}

/**
 * Why an LLM call failed, in terms an operator can act on.
 *
 * The pipeline degrades gracefully to the deterministic reader, which is right,
 * but a bare "fell back" warning is indistinguishable from "no LLM configured"
 * and hides the actual fault. Classifying the upstream response is what lets the
 * UI say *why* a configured model was not used.
 */
export type LlmFailureReason =
  | "insufficient_quota"
  | "invalid_key"
  | "model_not_permitted"
  | "rate_limited"
  | "timeout"
  | "empty_response"
  | "transport"
  | "http_error";

export interface LlmFailure {
  reason: LlmFailureReason;
  status: number | null;
  /** Short human sentence for the cue-sheet warning. */
  message: string;
  /** Upstream text, truncated. For the server log, not the public response. */
  detail: string;
}

/**
 * A completion together with why it is absent. `chat()` returns just the
 * message for the call sites that only need the happy path; the pipeline uses
 * this so it can explain a failure without sharing mutable state across the
 * concurrent requests that a single cue sheet issues.
 */
export interface ChatResult {
  message: ChatMessage | null;
  failure: LlmFailure | null;
}

function classifyFailure(status: number, detail: string): LlmFailure {
  const body = detail.toLowerCase();

  if (status === 401 || status === 403) {
    return {
      reason: "invalid_key",
      status,
      message: "the configured API key was rejected",
      detail,
    };
  }
  // OpenAI reports an exhausted balance as 429, which is easy to misread as a
  // rate limit. The code is the only reliable discriminator.
  if (
    body.includes("insufficient_quota") ||
    body.includes("credit_balance") ||
    body.includes("no credits remaining") ||
    body.includes("exceeded your current quota")
  ) {
    return {
      reason: "insufficient_quota",
      status,
      message: "the provider reports no remaining credits",
      detail,
    };
  }
  if (body.includes("rate limit") || body.includes("rate_limit") || status === 429) {
    return {
      reason: "rate_limited",
      status,
      message: "the provider rate-limited the request",
      detail,
    };
  }
  if (status === 404 || body.includes("does not exist") || body.includes("model_not_found")) {
    return {
      reason: "model_not_permitted",
      status,
      message: "the configured model is not available to this key",
      detail,
    };
  }
  return { reason: "http_error", status, message: `the provider returned ${status}`, detail };
}

/**
 * One minimal round trip to the configured endpoint, reporting the upstream
 * status so a misconfiguration is visible from outside the deployment.
 */
export async function probeLlm(): Promise<{
  ok: boolean;
  status: number | null;
  reason?: LlmFailureReason;
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
    if (res.ok) return { ok: true, status: res.status, detail: text.slice(0, 300) };
    // Reuse the same classifier as the pipeline so the health check and the
    // cue-sheet warning can never disagree about why a call failed.
    const failure = classifyFailure(res.status, text);
    return {
      ok: false,
      status: res.status,
      reason: failure.reason,
      detail: text.slice(0, 300),
    };
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return {
      ok: false,
      status: null,
      reason: aborted ? "timeout" : "transport",
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
export async function chatDetailed(
  config: LlmConfig,
  messages: ChatMessage[],
  tools: ToolSpec[] = [],
  timeoutMs = 45_000,
): Promise<ChatResult> {
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
      const failure = classifyFailure(res.status, detail);
      console.warn(
        `[cue] LLM call failed: ${res.status} ${failure.reason} model=${config.model} ${detail.slice(0, 300)}`,
      );
      return { message: null, failure };
    }

    const json = (await res.json()) as { choices?: ChatCompletionChoice[] };
    const choice = json.choices?.[0];
    if (!choice?.message) {
      // A 200 with no message is a silent failure; record it so the caller can
      // distinguish "the model declined to answer" from "the network broke".
      return {
        message: null,
        failure: {
          reason: "empty_response",
          status: res.status,
          message: "the provider returned no completion",
          detail: JSON.stringify(json).slice(0, 300),
        },
      };
    }

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
      message: {
        role: "assistant",
        content: choice.message.content ?? null,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      },
      failure: null,
    };
  } catch (error) {
    // An abort is a timeout, not a transport fault, and the two need different
    // fixes. Recording it here is what lets the warning say which happened.
    const aborted = error instanceof Error && error.name === "AbortError";
    return {
      message: null,
      failure: {
        reason: aborted ? "timeout" : "transport",
        status: null,
        message: aborted
          ? `the provider did not answer within ${Math.round(timeoutMs / 1000)}s`
          : "the request to the provider failed",
        detail: error instanceof Error ? error.message : "Unknown transport error",
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

/** The message, or `null`. Use `chatDetailed` when the reason matters. */
export async function chat(
  config: LlmConfig,
  messages: ChatMessage[],
  tools: ToolSpec[] = [],
  timeoutMs = 45_000,
): Promise<ChatMessage | null> {
  const { message } = await chatDetailed(config, messages, tools, timeoutMs);
  return message;
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
