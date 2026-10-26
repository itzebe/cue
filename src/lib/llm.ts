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

export type LlmSource = "llm" | "proxy" | "openrouter" | "gemini" | "groq";

/**
 * A provider named directly by its own environment variable.
 *
 * A provider-specific variable is a deliberate choice, so it outranks anything
 * generic. These presets are the only third-party endpoints Cue will call: a
 * paid OpenAI endpoint is deliberately not among them (see `detectCandidates`).
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
    // Must be an id OpenRouter actually serves. The `:free` suffix is a rotating
    // allowance, not a modifier on an otherwise valid slug: `openai/gpt-oss-120b:free`
    // is not in the catalogue and 404s, while the bare slug is a real, tool-capable,
    // low-cost model. Set LLM_MODEL to pick a different one.
    model: "openai/gpt-oss-120b",
    keyVars: ["OPENROUTER_API_KEY"],
  },
  {
    source: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    // Google restricts the 2.5 family to projects that already used them: "we are
    // limiting access to the 2.5 models to users who have actively used them in the
    // past ... For any new projects, use our latest models: 3.5 Flash-Lite or 3.8
    // Flash" (ai.google.dev/gemini-api/docs/models). A fresh key therefore gets a 404
    // `model_not_permitted` for `gemini-2.5-flash` — a model-access restriction, not a
    // bad id. 3.8 Flash is the current Stable model Google's own OpenAI-compatibility
    // guide uses, and it is free of charge on the free tier.
    model: "gemini-3.8-flash",
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
 * A resolved provider plus the variable that supplied it.
 *
 * The list form exists so a failed primary can hand the same request to the next
 * provider. A single resolved config cannot express "and then try this instead",
 * which is why an OpenRouter outage previously meant no model at all even with a
 * working Gemini key sitting in the environment.
 */
export interface LlmCandidate {
  config: LlmConfig;
  source: LlmSource;
  keyVar: string;
}

/**
 * Resolve every usable provider, highest priority first.
 *
 * Preference order:
 *  1. Explicit LLM_* variables (any OpenAI-compatible provider). Terminal: when
 *     all three are set the operator has named the endpoint, so nothing else is
 *     offered as a fallback.
 *  2. Provider-specific keys: OpenRouter, Gemini, then Groq.
 *  3. The Agent Canvas managed proxy, which is OpenAI-compatible and lets the
 *     app run with zero user-supplied keys during development.
 *
 * There is deliberately no direct `api.openai.com` endpoint in this chain. A
 * paid OpenAI key is the one provider Cue will not silently reach for: it has no
 * free tier, so a present-but-unfunded key turns every cue sheet into a paid call
 * that fails. It previously did exactly that in production, shadowing the
 * provider-specific keys and leaving the app on the deterministic fallback while
 * a working key sat unused. OpenRouter, Gemini and Groq all have free tiers and
 * are reached by their own variables. `OPENAI_API_KEY` is still read, but only as
 * the credential for the Agent Canvas proxy, which is identified by its refresh
 * URL rather than by the variable name. An operator who genuinely wants OpenAI
 * can still have it through the terminal `LLM_*` triple.
 *
 * The source travels with the config so the report cannot drift from what the
 * pipeline actually uses.
 */
function detectCandidates(): LlmCandidate[] {
  const explicitKey = envValue("LLM_API_KEY");
  const explicitBase = envValue("LLM_BASE_URL");
  const explicitModel = envValue("LLM_MODEL");

  if (explicitKey && explicitBase && explicitModel) {
    return [
      {
        config: {
          baseUrl: explicitBase.replace(/\/$/, ""),
          apiKey: explicitKey,
          model: explicitModel,
          temperature: 0.4,
        },
        source: "llm",
        keyVar: "LLM_API_KEY",
      },
    ];
  }

  const candidates: LlmCandidate[] = [];

  for (const preset of PROVIDER_PRESETS) {
    const keyVar = preset.keyVars.find((name) => envValue(name) !== undefined);
    if (keyVar) {
      candidates.push({
        config: {
          baseUrl: preset.baseUrl.replace(/\/$/, ""),
          apiKey: envValue(keyVar)!,
          model: explicitModel || preset.model,
          temperature: 0.4,
        },
        source: preset.source,
        keyVar,
      });
    }
  }

  // The managed proxy is identified by its refresh URL, not by the key: the same
  // OPENAI_API_KEY name is used for both, so the base URL is what disambiguates.
  // Without a refresh URL there is no proxy, so an OPENAI_API_KEY on its own
  // resolves to nothing rather than to a paid endpoint.
  const proxyBase = envValue("OH_LLM_API_KEY_REFRESH_BASE_URLS")?.split(",")[0]?.trim();
  const proxyModel = explicitModel || "claude-sonnet-4-5-20250929";
  const openaiKey = envValue("OPENAI_API_KEY");
  const proxyOnlyKey = envValue("OH_LLM_PROXY_KEY");

  if (proxyBase && openaiKey) {
    candidates.push({
      config: { baseUrl: proxyBase.replace(/\/$/, ""), apiKey: openaiKey, model: proxyModel, temperature: 0.4 },
      source: "proxy",
      keyVar: "OPENAI_API_KEY",
    });
  }

  if (proxyBase && proxyOnlyKey) {
    candidates.push({
      config: { baseUrl: proxyBase.replace(/\/$/, ""), apiKey: proxyOnlyKey, model: proxyModel, temperature: 0.4 },
      source: "proxy",
      keyVar: "OH_LLM_PROXY_KEY",
    });
  }

  return candidates;
}

/** The primary provider, or null when nothing is configured. */
function detectLlm(): LlmCandidate | null {
  return detectCandidates()[0] ?? null;
}

export function resolveLlmConfig(): LlmConfig | null {
  return detectLlm()?.config ?? null;
}

export function hasLlm(): boolean {
  return detectLlm() !== null;
}

/** How many distinct providers are configured, for the config report. */
export function llmProviderCount(): number {
  return detectCandidates().length;
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
  const candidates = detectCandidates();
  const detected = candidates[0] ?? null;
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
    // The full fallback chain, in the order it will be tried. A second configured
    // provider is what makes a primary outage recoverable, so whether one exists
    // is worth reporting rather than leaving to inference.
    providerChain: candidates.map((candidate) => candidate.source),
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
  /**
   * The provider rejected the request because the model failed to produce a
   * well-formed tool call. Groq raises this as an HTTP 400 (`tool_use_failed` /
   * `json_validate_failed`) for reasoning models that do not reliably follow a
   * tool schema. It is a *request-shape* fault, not an auth, quota or outage
   * fault, and it is recoverable by asking differently rather than by giving up.
   */
  | "tool_format"
  | "http_error";

export interface LlmFailure {
  reason: LlmFailureReason;
  status: number | null;
  /** Short human sentence for the cue-sheet warning. */
  message: string;
  /** Upstream text, truncated. For the server log, not the public response. */
  detail: string;
  /**
   * The provider's own machine-readable error code, e.g. Groq's
   * `tool_use_failed` or `json_validate_failed`.
   *
   * Without this an unrecognised 400 collapses into "the provider returned 400",
   * which names the status and nothing else — the operator cannot tell a malformed
   * tool call from a bad parameter from an unavailable model, and the one piece of
   * information that identifies the fault is the piece that was being dropped.
   */
  providerCode?: string | null;
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

/**
 * Pull the provider's error code out of a response body, without ever carrying
 * key material or request echoes into a diagnostic string.
 *
 * OpenAI-compatible providers nest the useful part under `error`, but the shape
 * varies: Groq sets `code` and `type`, OpenAI sets `code` and `type`, and some
 * gateways return a bare string. All of these are read defensively, and the
 * result is length-capped and scrubbed so a body that happens to echo an
 * `Authorization` header cannot leak it into a log or a public response.
 */
export function extractProviderError(detail: string): {
  code: string | null;
  type: string | null;
  message: string;
} {
  let code: string | null = null;
  let type: string | null = null;
  let message = "";

  try {
    const parsed = JSON.parse(detail) as unknown;
    const error = (parsed as { error?: unknown })?.error ?? parsed;
    if (typeof error === "string") {
      message = error;
    } else if (error && typeof error === "object") {
      const record = error as Record<string, unknown>;
      if (typeof record.code === "string") code = record.code;
      if (typeof record.type === "string") type = record.type;
      if (typeof record.message === "string") message = record.message;
    }
  } catch {
    // Not JSON: fall back to the raw text as the message.
    message = detail;
  }

  return { code, type, message: sanitiseDiagnostic(message) };
}

/**
 * Strip anything that looks like a credential out of text that will be logged or
 * returned to a browser. Provider errors are normally safe, but they are upstream
 * data and an echoed header is exactly the kind of thing that ends up in a
 * screenshot.
 */
export function sanitiseDiagnostic(text: string): string {
  return text
    .replace(/\b(sk|gsk|ghu|ghp|xai|key)[-_][A-Za-z0-9_-]{8,}/gi, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]{8,}/gi, "Bearer [redacted]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted]")
    .slice(0, 300);
}

/** Provider codes that mean "the model did not emit a usable tool call". */
const TOOL_FORMAT_CODES = new Set([
  "tool_use_failed",
  "tool_call_validation_failed",
  "json_validate_failed",
  "invalid_tool_call",
  "failed_generation",
]);

/**
 * True when a failure is the model's tool-call formatting rather than anything
 * about the account, the network or the request's parameters. Only these are
 * worth re-asking with a different request shape; everything else is permanent
 * for this provider and should move straight to the fallback.
 */
export function isToolFormatFailure(failure: LlmFailure | null): boolean {
  if (!failure) return false;
  if (failure.reason === "tool_format") return true;
  const code = (failure.providerCode ?? "").toLowerCase();
  if (TOOL_FORMAT_CODES.has(code)) return true;
  const body = `${failure.detail} ${failure.message}`.toLowerCase();
  return (
    body.includes("tool_use_failed") ||
    body.includes("tool call") ||
    body.includes("failed_generation") ||
    body.includes("failed to validate json") ||
    body.includes("json_validate_failed")
  );
}

function classifyFailure(status: number, detail: string): LlmFailure {
  const { code, type, message: upstreamMessage } = extractProviderError(detail);
  const body = detail.toLowerCase();
  // The provider's own code, e.g. Groq's `tool_use_failed`. Carried on every
  // failure so the specific cause survives into the log and the sheet.
  const providerCode = code ?? type ?? null;
  // Prefer the provider's own sentence when it gave one. "Failed to validate
  // JSON. Please adjust your prompt." is far more actionable than a status code,
  // and it is the sentence an operator needs in order to recognise the fault.
  const detailText = upstreamMessage || sanitiseDiagnostic(detail);

  // A 403 is ambiguous: it covers both a rejected key and a key that is valid
  // but not permitted to use the requested model. Reported as "the API key was
  // rejected" the second case sends the operator to rotate a working credential
  // while the real fix is a different model or an entitlement change. The body is
  // the only thing that distinguishes them, so it is read before deciding.
  if (status === 403) {
    const modelAccess =
      body.includes("model") &&
      (body.includes("not allowed") ||
        body.includes("no access") ||
        body.includes("permission") ||
        body.includes("entitle") ||
        body.includes("only access models") ||
        body.includes("does not have access"));
    if (modelAccess) {
      return {
        reason: "model_not_permitted",
        status,
        message: "the configured model is not available to this key",
        detail: detailText,
        providerCode,
      };
    }
    return {
      reason: "invalid_key",
      status,
      message: "the configured API key was rejected",
      detail: detailText,
      providerCode,
    };
  }
  if (status === 401) {
    return {
      reason: "invalid_key",
      status,
      message: "the configured API key was rejected",
      detail: detailText,
      providerCode,
    };
  }
  // OpenAI reports an exhausted balance as 429, which is easy to misread as a
  // rate limit. The code is the only reliable discriminator. OpenRouter uses
  // 402 for the same condition, so both have to land on "out of credits" rather
  // than being reported as a rate limit or a generic HTTP error.
  if (
    status === 402 ||
    body.includes("insufficient_quota") ||
    body.includes("insufficient_credits") ||
    body.includes("credit_balance") ||
    body.includes("no credits remaining") ||
    body.includes("requires more credits") ||
    body.includes("exceeded your current quota")
  ) {
    return {
      reason: "insufficient_quota",
      status,
      message: "the provider reports no remaining credits",
      detail: detailText,
      providerCode,
    };
  }
  if (body.includes("rate limit") || body.includes("rate_limit") || status === 429) {
    return {
      reason: "rate_limited",
      status,
      message: "the provider rate-limited the request",
      detail: detailText,
      providerCode,
    };
  }
  // Checked before the model-availability branch: a tool-protocol rejection is a
  // 400 that mentions neither a model nor a parameter, and misclassifying it as
  // "model not available" would send the operator to change a model that is fine.
  if (
    (providerCode !== null && TOOL_FORMAT_CODES.has(providerCode.toLowerCase())) ||
    body.includes("tool_use_failed") ||
    body.includes("failed_generation") ||
    body.includes("json_validate_failed") ||
    body.includes("failed to validate json") ||
    body.includes("tool call validation")
  ) {
    return {
      reason: "tool_format",
      status,
      // The cause is named by the provider's own code, not paraphrased into a
      // status number. The provider's full sentence stays in `detail` for the
      // server log: it is accurate but it talks about internal fields such as
      // `failed_generation`, which is noise in a banner a producer reads.
      message: providerCode
        ? `the model did not return a valid tool call (${providerCode})`
        : "the model did not return a valid tool call",
      detail: detailText,
      providerCode,
    };
  }
  if (
    status === 404 ||
    body.includes("does not exist") ||
    body.includes("model_not_found") ||
    body.includes("not found") ||
    body.includes("unknown model") ||
    body.includes("not supported") ||
    body.includes("unsupported model")
  ) {
    return {
      reason: "model_not_permitted",
      status,
      message: "the configured model is not available to this key",
      detail: detailText,
      providerCode,
    };
  }
  // The generic case still names the provider's code, so an unclassified 400 is
  // diagnosable instead of collapsing to a bare status number.
  return {
    reason: "http_error",
    status,
    message: providerCode
      ? `the provider returned ${status} (${providerCode})`
      : `the provider returned ${status}`,
    detail: detailText,
    providerCode,
  };
}

/**
 * One minimal round trip to the configured endpoint, reporting the upstream
 * status so a misconfiguration is visible from outside the deployment.
 *
 * This walks the same chain the pipeline walks, so "the probe passed" means a
 * real cue sheet will get a model. Probing only the primary would report a
 * failure while a healthy fallback was available.
 */
export async function probeLlm(): Promise<{
  ok: boolean;
  status: number | null;
  reason?: LlmFailureReason;
  provider: LlmSource | null;
  attempts: Array<{ source: LlmSource; ok: boolean; status: number | null; reason?: LlmFailureReason }>;
  detail: string;
}> {
  const candidates = detectCandidates();
  if (candidates.length === 0) {
    return { ok: false, status: null, provider: null, attempts: [], detail: "No LLM configured." };
  }

  const attempts: Array<{ source: LlmSource; ok: boolean; status: number | null; reason?: LlmFailureReason }> = [];
  let lastStatus: number | null = null;
  let lastReason: LlmFailureReason | undefined;
  let lastDetail = "";

  for (const candidate of candidates) {
    const result = await probeOne(candidate.config);
    attempts.push({
      source: candidate.source,
      ok: result.ok,
      status: result.status,
      reason: result.reason,
    });
    if (result.ok) {
      return {
        ok: true,
        status: result.status,
        provider: candidate.source,
        attempts,
        detail: result.detail,
      };
    }
    lastStatus = result.status;
    lastReason = result.reason;
    lastDetail = result.detail;
  }

  return {
    ok: false,
    status: lastStatus,
    reason: lastReason,
    provider: null,
    attempts,
    detail: lastDetail,
  };
}

/** A single endpoint's probe. */
async function probeOne(config: LlmConfig): Promise<{
  ok: boolean;
  status: number | null;
  reason?: LlmFailureReason;
  detail: string;
}> {
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
/**
 * A single request/response round trip, with no recovery of its own.
 *
 * Split out so `chatDetailed` can re-ask with a different request shape without
 * duplicating transport, timeout and response-parsing logic three times.
 */
async function sendOnce(
  config: LlmConfig,
  messages: ChatMessage[],
  tools: ToolSpec[],
  temperature: number,
  timeoutMs: number,
): Promise<ChatResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    temperature,
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
      // sees unexplained "Track TBD" cues with no hint as to why. `failure.detail`
      // is already scrubbed of anything credential-shaped by `classifyFailure`.
      const detail = await res.text().catch(() => "");
      const failure = classifyFailure(res.status, detail);
      console.warn(
        `[cue] LLM call failed: ${res.status} ${failure.reason}` +
          `${failure.providerCode ? ` code=${failure.providerCode}` : ""} ` +
          `model=${config.model} ${failure.detail.slice(0, 200)}`,
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
          detail: sanitiseDiagnostic(JSON.stringify(json)),
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
        detail: error instanceof Error ? sanitiseDiagnostic(error.message) : "Unknown transport error",
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The JSON instruction used when a provider cannot be trusted with a tool schema.
 *
 * Derived from the same schema the tool call would have validated against, so the
 * two request shapes ask for exactly the same object and the caller's existing
 * parser can read either one.
 */
function jsonInstruction(tool: ToolSpec): string {
  return (
    `Respond with ONLY a single JSON object, no prose and no markdown fences.\n` +
    `It must validate against this JSON schema:\n${JSON.stringify(tool.parameters)}`
  );
}

/**
 * One turn of chat completion, with bounded recovery from a tool-protocol
 * rejection. Returns null instead of throwing so callers can fall back to the
 * deterministic planner.
 *
 * The recovery exists because a tool schema is not a request the model is
 * obliged to satisfy, and Groq enforces that at the transport level: when a
 * reasoning model emits a malformed tool call, the whole request is rejected
 * with HTTP 400 (`tool_use_failed` / `json_validate_failed`) rather than
 * returning a message Cue could ignore. Production hit this intermittently —
 * the identical scene returned a brief, then a 400, then a brief — which is the
 * signature of model-side nondeterminism rather than a bad key or a bad model.
 *
 * Recovery is deliberately narrow and bounded:
 *  - only a tool-format failure is retried; an auth, quota, rate-limit or
 *    model-availability error is permanent for this provider and is returned
 *    immediately so `chatWithFallback` can move to the next one;
 *  - at most two extra attempts, and all three share the caller's timeout budget
 *    so a recovery cannot silently double the wall-clock cost of a cue sheet;
 *  - the final attempt drops the tool schema and asks for the same JSON in
 *    content, which the existing `extractJson` path already parses.
 */
export async function chatDetailed(
  config: LlmConfig,
  messages: ChatMessage[],
  tools: ToolSpec[] = [],
  timeoutMs = 45_000,
): Promise<ChatResult> {
  const deadline = Date.now() + timeoutMs;
  const baseTemperature = config.temperature ?? 0.4;

  const result = await sendOnce(config, messages, tools, baseTemperature, timeoutMs);

  const firstFailure = result.failure;
  if (tools.length === 0 || !isToolFormatFailure(firstFailure) || firstFailure === null) {
    return result;
  }
  const remaining = () => deadline - Date.now();
  if (remaining() <= 1_000) return result;

  // Attempt 2: same request, lower temperature. This is the mitigation Groq's own
  // tool-use documentation prescribes for exactly this error, and lowering
  // temperature is the one lever that reliably reduces malformed tool calls.
  console.warn(
    `[cue] retrying ${config.model} at lower temperature after a tool-call rejection` +
      `${firstFailure.providerCode ? ` (${firstFailure.providerCode})` : ""}`,
  );
  const second = await sendOnce(
    config,
    messages,
    tools,
    Math.max(0.1, baseTemperature - 0.3),
    remaining(),
  );
  if (second.message) return second;

  // Attempt 3: drop the tool schema and ask for the same object as plain JSON.
  // The caller already parses `content` when no tool call is present, so this
  // recovers the scene read even though the provider refuses tool calling.
  if (isToolFormatFailure(second.failure) && remaining() > 1_000) {
    console.warn(
      `[cue] re-asking ${config.model} without tools after repeated tool-call rejection`,
    );
    const plain = await sendOnce(
      config,
      [...messages, { role: "user", content: jsonInstruction(tools[0]) }],
      [],
      0,
      remaining(),
    );
    if (plain.message) return plain;
    return { message: null, failure: plain.failure ?? second.failure };
  }

  // Recovery failed. Report the tool-protocol rejection itself rather than the
  // last symptom: it is the accurate description of what the provider refused.
  return { message: null, failure: second.failure ?? firstFailure };
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

/** One provider's turn at the request, and how it went. */
export interface LlmAttempt {
  source: LlmSource;
  keyVar: string;
  model: string;
  failure: LlmFailure | null;
}

export interface LlmRunResult {
  message: ChatMessage | null;
  /** The provider that answered. `null` when every provider failed. */
  provider: LlmSource | null;
  /** Every provider tried, in order, with why each one failed. */
  attempts: LlmAttempt[];
  /** The failure to report when nothing answered. */
  failure: LlmFailure | null;
}

/**
 * Run one request against the configured providers, in priority order.
 *
 * Each provider is tried at most once, and the first usable answer wins. This is
 * the whole point of the list: a rate-limited or unfunded primary is a reason to
 * ask the next provider, not a reason to give up and read the scene
 * deterministically while a working key sits unused in the environment.
 *
 * Retrying the *same* provider is deliberately absent. A rejected key or an
 * exhausted balance is permanent for that provider, so repeating the call only
 * adds latency; moving on to a different provider is what actually recovers.
 *
 * The caller's `timeoutMs` is a budget for the whole chain, not per attempt, so
 * a fallback cannot silently double the wall-clock cost of a cue sheet. Each
 * attempt gets whatever is left, with a floor so a slow primary cannot starve
 * the secondary entirely.
 */
export async function chatWithFallback(
  messages: ChatMessage[],
  tools: ToolSpec[] = [],
  timeoutMs = 45_000,
): Promise<LlmRunResult> {
  const candidates = detectCandidates();
  if (candidates.length === 0) {
    return { message: null, provider: null, attempts: [], failure: null };
  }

  const deadline = Date.now() + timeoutMs;
  const attempts: LlmAttempt[] = [];
  let lastFailure: LlmFailure | null = null;

  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    const remaining = deadline - Date.now();
    const isLast = index === candidates.length - 1;
    // A provider with no time left is not tried: reporting a timeout we chose to
    // cause would misattribute the fault to the provider.
    if (remaining <= 1_000) {
      attempts.push({
        source: candidate.source,
        keyVar: candidate.keyVar,
        model: candidate.config.model,
        failure: {
          reason: "timeout",
          status: null,
          message: "the request ran out of time before this provider was tried",
          detail: "",
        },
      });
      continue;
    }
    const budget = isLast ? remaining : Math.max(10_000, Math.floor(remaining / 2));

    const { message, failure } = await chatDetailed(
      candidate.config,
      messages,
      tools,
      Math.min(budget, remaining),
    );
    attempts.push({
      source: candidate.source,
      keyVar: candidate.keyVar,
      model: candidate.config.model,
      failure,
    });

    if (message) {
      return { message, provider: candidate.source, attempts, failure: null };
    }
    lastFailure = failure;
  }

  return { message: null, provider: null, attempts, failure: lastFailure };
}

/**
 * The message from whichever provider answers first, or `null`.
 *
 * Used by the calls that only need the content; `chatWithFallback` is for the
 * ones that must explain which provider spoke and which ones did not.
 */
export async function runLlm(
  messages: ChatMessage[],
  tools: ToolSpec[] = [],
  timeoutMs = 45_000,
): Promise<ChatMessage | null> {
  const { message } = await chatWithFallback(messages, tools, timeoutMs);
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
