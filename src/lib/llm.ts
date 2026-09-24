export type Provider = "openrouter" | "litellm";

export interface LlmSettings {
  provider: Provider;
  apiKey: string;
  baseUrl: string;
  model: string;
}

export const DEFAULT_BASE_URLS: Record<Provider, string> = {
  openrouter: "https://openrouter.ai/api/v1",
  litellm: "http://localhost:4000/v1",
};

export interface ModelPreset {
  id: string;
  name: string;
  tier?: "DEFAULT" | "BETTER" | "BEST";
  inputCost: number;
  outputCost: number;
}

export const MODEL_PRESETS: ModelPreset[] = [
  {
    id: "qwen/qwen3.8-flash",
    name: "Qwen 3.8 Flash",
    tier: "DEFAULT",
    inputCost: 0.03,
    outputCost: 0.13,
  },
  {
    id: "deepseek/deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    tier: "BETTER",
    inputCost: 0.07,
    outputCost: 0.14,
  },
  {
    id: "deepseek/deepseek-v4.1-flash",
    name: "DeepSeek V4.1 Flash",
    tier: "BEST",
    inputCost: 0.15,
    outputCost: 0.6,
  },
  { id: "z-ai/glm-5.3-flash", name: "GLM 5.3 Flash", inputCost: 0.15, outputCost: 0.5 },
  {
    id: "google/gemini-3.1-flash-lite",
    name: "Gemini 3.1 Flash Lite",
    inputCost: 0.25,
    outputCost: 1.5,
  },
];

/** Typical run when no inputs are loaded yet (label + spec merge + design). */
export const EST_RUN_TOKENS = { input: 6500, output: 2400 };

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
   * output, so small labelling tasks turn it off and the design step keeps it low.
   */
  reasoning?: "off" | "low";
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

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    });
  });
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
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${settings.apiKey}`,
  };
  if (settings.provider === "openrouter") {
    headers["HTTP-Referer"] =
      typeof window !== "undefined" ? window.location.origin : "https://filter-generator.app";
    headers["X-Title"] = "Search Filter Generator";
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
