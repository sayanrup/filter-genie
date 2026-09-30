/**
 * Shared storage for saved results: a Firebase Firestore collection `saved_runs`, reached through
 * Firestore's REST API so anyone opening the site sees the same list. Without the two env vars
 * below the app falls back to this browser's localStorage only.
 *
 *   VITE_FIREBASE_API_KEY     the web app's apiKey (public by design; access is set by firestore.rules)
 *   VITE_FIREBASE_PROJECT_ID  the Firebase project id
 *   VITE_FIREBASE_DATABASE_ID optional: the Firestore database id when it isn't "(default)"
 *
 * Firestore documents are limited to 1 MiB, so each entry is stored as one gzip+base64 string. If an
 * entry is still too large the inputs (keyword files etc.) are dropped and only the results are kept.
 */
const API_KEY: string = import.meta.env["VITE_FIREBASE_API_KEY"] ?? "";
const PROJECT: string = import.meta.env["VITE_FIREBASE_PROJECT_ID"] ?? "";
const DATABASE: string = import.meta.env["VITE_FIREBASE_DATABASE_ID"] || "(default)";

export const sharedStorageEnabled = Boolean(API_KEY && PROJECT);

const DOCS = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/${DATABASE}/documents`;
/** Most recent saved results fetched for the list. */
const LIST_LIMIT = 20;
/** Stay under Firestore's 1 MiB document limit (string bytes + field overhead). */
const MAX_PAYLOAD_CHARS = 900_000;

interface Saveable {
  id: string;
  name: string;
  model: string;
  savedAt: string;
  inputs?: unknown;
}

// ── gzip + base64 (plain JSON when the browser has no CompressionStream) ──

async function pipe(data: BodyInit, stream: CompressionStream | DecompressionStream) {
  const out = new Response(new Response(data).body!.pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

function toBase64(bytes: Uint8Array) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function fromBase64(b64: string) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function pack(entry: unknown): Promise<string> {
  const json = JSON.stringify(entry);
  if (typeof CompressionStream === "undefined") return `json:${json}`;
  return `gz:${toBase64(await pipe(json, new CompressionStream("gzip")))}`;
}

async function unpack<T>(payload: string): Promise<T> {
  if (payload.startsWith("json:")) return JSON.parse(payload.slice(5)) as T;
  const bytes = await pipe(
    new Blob([fromBase64(payload.slice(3)) as BlobPart]),
    new DecompressionStream("gzip"),
  );
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

// ── REST ──

async function check(resp: Response, action: string) {
  if (resp.ok) return;
  const detail = await resp.text().catch(() => "");
  throw new Error(
    `Shared storage ${action} failed (${resp.status}) ${detail.slice(0, 160)}`.trim(),
  );
}

const str = (value: string) => ({ stringValue: value });

export async function listShared<T extends Saveable>(): Promise<T[]> {
  const resp = await fetch(`${DOCS}:runQuery?key=${API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: "saved_runs" }],
        orderBy: [{ field: { fieldPath: "savedAt" }, direction: "DESCENDING" }],
        limit: LIST_LIMIT,
      },
    }),
  });
  await check(resp, "load");
  const rows = (await resp.json()) as {
    document?: { fields?: { payload?: { stringValue?: string } } };
  }[];
  const out: T[] = [];
  for (const r of rows) {
    const payload = r.document?.fields?.payload?.stringValue;
    if (!payload) continue;
    try {
      out.push(await unpack<T>(payload));
    } catch {
      /* skip an entry that can't be read */
    }
  }
  return out;
}

export async function addShared(entry: Saveable): Promise<void> {
  let payload = await pack(entry);
  if (payload.length > MAX_PAYLOAD_CHARS) payload = await pack({ ...entry, inputs: undefined });
  if (payload.length > MAX_PAYLOAD_CHARS)
    throw new Error("this result is too large for shared storage even without its inputs");
  const resp = await fetch(
    `${DOCS}/saved_runs?documentId=${encodeURIComponent(entry.id)}&key=${API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fields: {
          id: str(entry.id),
          name: str(entry.name),
          model: str(entry.model),
          savedAt: str(entry.savedAt),
          payload: str(payload),
        },
      }),
    },
  );
  await check(resp, "save");
}

export async function removeShared(id: string): Promise<void> {
  const resp = await fetch(`${DOCS}/saved_runs/${encodeURIComponent(id)}?key=${API_KEY}`, {
    method: "DELETE",
  });
  await check(resp, "delete");
}
