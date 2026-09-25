export type Provider = "openrouter" | "groq" | "litellm";

export interface LlmSettings {
  provider: Provider;
  apiKey: string;
  baseUrl: string;
  model: string;
}

export const DEFAULT_BASE_URLS: Record<Provider, string> = {
  openrouter: "https://openrouter.ai/api/v1",
  // Groq's API is OpenAI-compatible (chat/completions, same request/response shape), so it needs
  // no special handling in chat() beyond skipping OpenRouter-only params (already gated below).
  groq: "https://api.groq.com/openai/v1",
  litellm: "http://localhost:4000/v1",
};

export interface ModelPreset {
  id: string;
  name: string;
  provider: Provider;
  tier?: "DEFAULT" | "BETTER" | "BEST" | "FREE";
  inputCost: number;
  outputCost: number;
}

export const MODEL_PRESETS: ModelPreset[] = [
  {
    id: "qwen/qwen3.8-flash",
    name: "Qwen 3.8 Flash",
    provider: "openrouter",
    tier: "DEFAULT",
    inputCost: 0.03,
    outputCost: 0.13,
  },
  {
    id: "deepseek/deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    provider: "openrouter",
    tier: "BETTER",
    inputCost: 0.07,
    outputCost: 0.14,
  },
  {
    id: "deepseek/deepseek-v4.1-flash",
    name: "DeepSeek V4.1 Flash",
    provider: "openrouter",
    tier: "BEST",
    inputCost: 0.15,
    outputCost: 0.6,
  },
  {
    id: "z-ai/glm-5.3-flash",
    name: "GLM 5.3 Flash",
    provider: "openrouter",
    inputCost: 0.15,
    outputCost: 0.5,
  },
  {
    id: "google/gemini-3.1-flash-lite",
    name: "Gemini 3.1 Flash Lite",
    provider: "openrouter",
    inputCost: 0.25,
    outputCost: 1.5,
  },
  // Groq: free-tier inference, and unusually fast — good for testing prompt changes quickly without
  // spending anything. Pricing is 0 because the free tier has no per-token cost (rate-limited instead).
  // Groq retired the Llama models from its free/developer tier (Aug 2026) — these are its current
  // free-tier chat models as of Sep 2026 (console.groq.com/docs/models); re-check if this breaks again.
  {
    id: "openai/gpt-oss-120b",
    name: "GPT-OSS 120B (Groq)",
    provider: "groq",
    tier: "FREE",
    inputCost: 0,
    outputCost: 0,
  },
  {
    id: "openai/gpt-oss-20b",
    name: "GPT-OSS 20B (Groq)",
    provider: "groq",
    tier: "FREE",
    inputCost: 0,
    outputCost: 0,
  },
  {
    id: "qwen/qwen3.6-27b",
    name: "Qwen 3.6 27B (Groq)",
    provider: "groq",
    tier: "FREE",
    inputCost: 0,
    outputCost: 0,
  },
];

/** Typical run when no inputs are loaded yet (label + spec merge + design). */
export const EST_RUN_TOKENS = { input: 6500, output: 3200 };

export const USD_TO_INR = 84;

export function runCostInr(
  m: ModelPreset,
  input = EST_RUN_TOKENS.input,
  output = EST_RUN_TOKENS.output,
) {
  return ((m.inputCost * input) / 1e6 + (m.outputCost * output) / 1e6) * USD_TO_INR;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

export interface CallOptions {
  maxTokens?: number;
  temperature?: number;
  /** Ask the provider for a JSON object response (falls back automatically if unsupported). */
  json?: boolean;
  /**
   * Thinking budget on reasoning-capable models (OpenRouter only). Reasoning tokens are billed as
   * output: small labelling tasks turn it off; the design step uses "medium" so it has room to
   * reason through several candidate filters against skill 08's 7-step method before answering.
   */
  reasoning?: "off" | "low" | "medium";
  signal?: AbortSignal;
  /** Give up on an attempt after this long (default scales with maxTokens). */
  timeoutMs?: number;
}

/** The provider says the prompt (plus the room reserved for the answer) doesn't fit the model. */
export class ContextLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextLimitError";
  }
}

const CONTEXT_ERROR =
  /context (length|window|limit)|maximum context|too many tokens|prompt is too long|input (is )?too (long|large)|exceeds? (the )?(max|maximum|limit|context)|token limit|reduce the length|max_tokens.*(exceed|too large)|input.{0,40}(limit|threshold)/i;

export const isContextError = (msg: string) => CONTEXT_ERROR.test(msg);


export interface CallResult {
  content: string;
  usage: Usage;
  finishReason: string | null;
}

// 429 has its own handling above (honours the provider's actual retry-after time) — not listed here.
const RETRYABLE = new Set([408, 500, 502, 503, 504]);

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    });
  });
}

// "Please try again in 41.82s" / "retry after 1m2s" / "try again in 500ms" — providers put the real
// wait time in the message text, not just (or instead of) a Retry-After header.
const RETRY_AFTER_TEXT = /(?:try again|retry)[^\d]{0,15}(\d+(?:\.\d+)?)\s*(ms|s|m)\b/i;

/**
 * How long to actually wait before retrying a 429, from the provider's own answer: the
 * Retry-After header (seconds, or an HTTP date) first, then the wait time embedded in the error
 * message text (Groq's style). Falls back to a short default when neither is present. Capped so
 * one rate-limited call can't block the whole run for minutes.
 */
function rateLimitDelayMs(resp: Response, errMsg: string | undefined): number {
  const CAP_MS = 45_000;
  const header = resp.headers.get("retry-after");
  if (header) {
    const secs = Number(header);
    if (Number.isFinite(secs)) return Math.min(Math.max(secs, 0) * 1000, CAP_MS);
    const at = Date.parse(header);
    if (!Number.isNaN(at)) return Math.min(Math.max(at - Date.now(), 0), CAP_MS);
  }
  const m = errMsg?.match(RETRY_AFTER_TEXT);
  if (m) {
    const n = Number(m[1]);
    const unitMs = m[2]!.toLowerCase() === "ms" ? 1 : m[2]!.toLowerCase() === "m" ? 60_000 : 1000;
    if (Number.isFinite(n)) return Math.min(n * unitMs, CAP_MS);
  }
  return 3000;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : ((part as { text?: string })?.text ?? "")))
      .join("");
  }
  return "";
}

export async function chat(
  settings: LlmSettings,
  messages: ChatMessage[],
  opts: CallOptions = {},
): Promise<CallResult> {
  const base = (settings.baseUrl || DEFAULT_BASE_URLS[settings.provider]).replace(/\/+$/, "");
  // Trim so an invisible leading/trailing space or newline from a paste never turns into a
  // silently-invalid key (the field is masked, so that kind of whitespace isn't visible to check).
  const apiKey = settings.apiKey.trim();
  if (!apiKey) {
    throw new Error(
      "No API key set (the field is empty or only whitespace) — the request would be sent without authentication.",
    );
  }
  // Catches the API key and server address fields being swapped: a URL is never a valid key,
  // and sending it as one produces a confusing "Missing Authentication header" from the provider.
  if (/^https?:\/\//i.test(apiKey)) {
    throw new Error(
      "The API key field contains a URL, not a key — it looks like it was swapped with the server address. Paste your actual API key there instead.",
    );
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  if (settings.provider === "openrouter") {
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    // OpenRouter can reject a request with a confusing "Missing Authentication header" error
    // when HTTP-Referer is a localhost/private address it doesn't recognise — so these optional
    // attribution headers are only sent for a real, public origin.
    if (origin && !/^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\]|.*\.local(:|$))/i.test(origin)) {
      headers["HTTP-Referer"] = origin;
      headers["X-Title"] = "Search Filter Generator";
    }
  }

  // Optional parameters: dropped together if the provider rejects the request as invalid.
  let useOptional = true;
  // Cheapest-provider routing: dropped after a timeout or a context-size error, so OpenRouter can
  // pick a faster provider or one with a bigger context window.
  let sortByPrice = true;
  let maxTokens = opts.maxTokens ?? 4000;
  let retriedTransient = false;
  let retriedTimeout = false;
  let retriedContext = false;
  let rateLimitRetries = 0;
  const timeoutMs = opts.timeoutMs ?? 90_000 + maxTokens * 15;

  for (;;) {
    const body: Record<string, unknown> = {
      model: settings.model,
      max_tokens: maxTokens,
      temperature: opts.temperature ?? 0.2,
      messages,
    };
    if (useOptional) {
      if (opts.json) body["response_format"] = { type: "json_object" };
      if (settings.provider === "openrouter") {
        // Route to the cheapest provider serving this model.
        if (sortByPrice) body["provider"] = { sort: "price" };
        // Thinking is off for small tasks and capped for the design step: uncapped thinking is what
        // makes some models look "stuck" (and it bills as output).
        if (opts.reasoning === "off") body["reasoning"] = { enabled: false };
        else if (opts.reasoning === "low") body["reasoning"] = { max_tokens: 1024, exclude: true };
        else if (opts.reasoning === "medium")
          body["reasoning"] = { max_tokens: 3000, exclude: true };
      }
    }
    const sentOptional = useOptional && Object.keys(body).length > 4;

    // One attempt = the caller's signal + our own timeout.
    const attempt = new AbortController();
    const onAbort = () => attempt.abort();
    opts.signal?.addEventListener("abort", onAbort);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      attempt.abort();
    }, timeoutMs);

    let resp: Response;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped provider JSON
    let data: any;
    try {
      try {
        resp = await fetch(`${base}/chat/completions`, {
          method: "POST",
          headers,
          signal: attempt.signal,
          body: JSON.stringify(body),
        });
        try {
          data = await resp.json();
        } catch (err) {
          if ((err as Error).name === "AbortError") throw err;
          data = null;
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          if (!timedOut) throw err;
          if (!retriedTimeout) {
            retriedTimeout = true;
            sortByPrice = false;
            continue;
          }
          throw new Error(
            `The model didn't answer within ${Math.round(timeoutMs / 1000)}s, twice (it may be overloaded or stuck thinking). Try again, or pick another model.`,
          );
        }
        throw new Error(
          settings.provider === "litellm"
            ? `Could not reach your LiteLLM server at ${base}. Check the address is running and allows requests from this page (CORS).`
            : settings.provider === "groq"
              ? "Could not reach Groq. Check your connection and that the key is valid."
              : "Could not reach OpenRouter. Check your connection and that the key is valid.",
        );
      }
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }

    const errMsg: string | undefined =
      data?.error?.message ?? (typeof data?.error === "string" ? data.error : undefined);

    if (!resp.ok || data?.error) {
      const detail = `${errMsg ?? ""} ${JSON.stringify(data?.error?.metadata ?? "")}`;
      if (isContextError(detail) || resp.status === 413) {
        // First try: less room reserved for the answer, any provider. Then let the caller shrink the prompt.
        if (!retriedContext) {
          retriedContext = true;
          sortByPrice = false;
          maxTokens = Math.max(1200, Math.floor(maxTokens * 0.6));
          continue;
        }
        throw new ContextLimitError(errMsg || "The prompt is too long for this model.");
      }
      // Some models/gateways reject response_format / reasoning / provider — retry once without them.
      if (sentOptional && (resp.status === 400 || resp.status === 422)) {
        useOptional = false;
        continue;
      }
      // Rate limit (per-minute tokens or requests): the provider names an exact wait time (header or
      // message text, e.g. Groq's "Please try again in 41.82s") — honour it instead of guessing, and
      // allow a couple of waits since a busy run can legitimately queue up several limited steps.
      if (resp.status === 429 && rateLimitRetries < 2) {
        rateLimitRetries++;
        await sleep(rateLimitDelayMs(resp, errMsg), opts.signal);
        continue;
      }
      if (RETRYABLE.has(resp.status) && !retriedTransient) {
        retriedTransient = true;
        await sleep(2500, opts.signal);
        continue;
      }
      if (!data) {
        throw new Error(
          `Server returned status ${resp.status} with an unreadable response. Check the key and model name.`,
        );
      }
      if (resp.status === 429) {
        throw new Error(
          `Still rate-limited after waiting: ${errMsg || "too many requests"}. Wait a bit longer and try again, or (on Groq) add a card for the Dev Tier's higher limits.`,
        );
      }
      throw new Error(errMsg || `Request failed with status ${resp.status}`);
    }

    const choice = data?.choices?.[0];
    return {
      content: contentToText(choice?.message?.content),
      usage: data?.usage ?? {},
      finishReason: choice?.finish_reason ?? null,
    };
  }
}

/** Back-compat helper: single system + user turn. */
export function callLlm(
  settings: LlmSettings,
  systemPrompt: string,
  userPrompt: string,
  maxTokens = 4000,
  signal?: AbortSignal,
) {
  return chat(
    settings,
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    signal ? { maxTokens, signal } : { maxTokens },
  );
}

/**
 * Pull a JSON object out of a model reply: drops <think> blocks and code fences,
 * trims prose around the outermost braces and tolerates trailing commas.
 */
export function extractJson<T = unknown>(text: string): T {
  let s = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  s = s.replace(/```(?:json)?/gi, "").trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("No JSON object found in the model reply.");
  const slice = s.slice(start, end + 1);
  try {
    return JSON.parse(slice) as T;
  } catch {
    return JSON.parse(slice.replace(/,\s*([}\]])/g, "$1")) as T;
  }
}

export function addUsage(total: Usage, u: Usage): Usage {
  return {
    prompt_tokens: (total.prompt_tokens ?? 0) + (u.prompt_tokens ?? 0),
    completion_tokens: (total.completion_tokens ?? 0) + (u.completion_tokens ?? 0),
  };
}

/**
 * Call the model expecting JSON. If the reply doesn't parse, sends one follow-up
 * turn with the parse error and asks for the corrected object.
 */
export async function chatJson<T>(
  settings: LlmSettings,
  messages: ChatMessage[],
  opts: CallOptions = {},
): Promise<{ data: T; raw: string; usage: Usage; messages: ChatMessage[] }> {
  const first = await chat(settings, messages, { ...opts, json: true });
  let usage = first.usage;
  try {
    const data = extractJson<T>(first.content);
    return {
      data,
      raw: first.content,
      usage,
      messages: [...messages, { role: "assistant", content: first.content }],
    };
  } catch (err) {
    if (first.finishReason === "length") {
      // Cut off mid-answer (the "Unterminated string in JSON" case): retry once with twice the room.
      const bigger = await chat(settings, messages, {
        ...opts,
        json: true,
        maxTokens: Math.min(8000, (opts.maxTokens ?? 4000) * 2),
      });
      usage = addUsage(usage, bigger.usage);
      try {
        const data = extractJson<T>(bigger.content);
        return {
          data,
          raw: bigger.content,
          usage,
          messages: [...messages, { role: "assistant", content: bigger.content }],
        };
      } catch {
        throw new Error(
          "The model's answer was cut off twice before it finished. Pick a model with a larger output limit, or trim the inputs.",
        );
      }
    }
    const followUp: ChatMessage[] = [
      ...messages,
      { role: "assistant", content: first.content.slice(0, 12000) },
      {
        role: "user",
        content: `That reply is not valid JSON (${(err as Error).message}). Reply again with ONLY the complete, valid JSON object — no prose, no code fences.`,
      },
    ];
    const second = await chat(settings, followUp, { ...opts, json: true });
    usage = addUsage(usage, second.usage);
    const data = extractJson<T>(second.content);
    return {
      data,
      raw: second.content,
      usage,
      messages: [...followUp, { role: "assistant", content: second.content }],
    };
  }
}
