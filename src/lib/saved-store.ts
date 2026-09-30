/**
 * Shared storage for saved results: the website's Supabase table `saved_runs`, reached through its
 * REST API so anyone opening the site sees the same list. Without the two env vars below the app
 * falls back to this browser's localStorage only.
 *
 *   VITE_SUPABASE_URL              e.g. https://xxxx.supabase.co
 *   VITE_SUPABASE_PUBLISHABLE_KEY  the project's public (anon) key — safe in the browser; access is
 *                                  governed by the row-level-security policies in supabase/migrations
 */
const URL_BASE: string = (import.meta.env["VITE_SUPABASE_URL"] ?? "").replace(/\/+$/, "");
const KEY: string = import.meta.env["VITE_SUPABASE_PUBLISHABLE_KEY"] ?? "";

export const sharedStorageEnabled = Boolean(URL_BASE && KEY);

/** Most recent saved results fetched for the list. */
const LIST_LIMIT = 50;

interface Saveable {
  id: string;
  name: string;
  model: string;
  savedAt: string;
}

function headers(extra: Record<string, string> = {}) {
  return { apikey: KEY, Authorization: `Bearer ${KEY}`, ...extra };
}

async function check(resp: Response, action: string) {
  if (resp.ok) return;
  const detail = await resp.text().catch(() => "");
  throw new Error(
    `Shared storage ${action} failed (${resp.status}) ${detail.slice(0, 160)}`.trim(),
  );
}

export async function listShared<T extends Saveable>(): Promise<T[]> {
  const resp = await fetch(
    `${URL_BASE}/rest/v1/saved_runs?select=entry&order=saved_at.desc&limit=${LIST_LIMIT}`,
    { headers: headers() },
  );
  await check(resp, "load");
  const rows = (await resp.json()) as { entry: T }[];
  return rows.map((r) => r.entry);
}

export async function addShared(entry: Saveable): Promise<void> {
  const resp = await fetch(`${URL_BASE}/rest/v1/saved_runs`, {
    method: "POST",
    headers: headers({ "Content-Type": "application/json", Prefer: "return=minimal" }),
    body: JSON.stringify({
      id: entry.id,
      name: entry.name,
      model: entry.model,
      saved_at: entry.savedAt,
      entry,
    }),
  });
  await check(resp, "save");
}

export async function removeShared(id: string): Promise<void> {
  const resp = await fetch(`${URL_BASE}/rest/v1/saved_runs?id=eq.${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: headers(),
  });
  await check(resp, "delete");
}
