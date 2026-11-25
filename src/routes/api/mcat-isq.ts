import { createFileRoute } from "@tanstack/react-router";
import { GetisqTokenError, fetchLiveIsqs } from "@/lib/getisq";

/** GETISQ_TOKEN from the server's environment, or from .env.local when the app runs locally. */
function token(): string | undefined {
  if (typeof process === "undefined") return undefined;
  if (!process.env["GETISQ_TOKEN"]) {
    try {
      process.loadEnvFile(".env.local");
    } catch {
      // No .env.local (or not Node): the token has to come from the environment.
    }
  }
  return process.env["GETISQ_TOKEN"]?.trim() || undefined;
}

/**
 * GET /api/mcat-isq?mcat_id=135712 → the MCAT's live ISQs from the getisq API, as input 4 takes them:
 * `{mcat_id, status, isqs: [{name, values}]}`.
 */
export const Route = createFileRoute("/api/mcat-isq")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const id = new URL(request.url).searchParams.get("mcat_id")?.trim() ?? "";
        if (!/^\d+$/.test(id))
          return Response.json({ error: "mcat_id must be a number" }, { status: 400 });
        const t = token();
        if (!t)
          return Response.json(
            {
              error:
                "Set GETISQ_TOKEN in .env.local (or the server's environment) and restart the app.",
            },
            { status: 500 },
          );
        try {
          return Response.json(await fetchLiveIsqs(id, t, AbortSignal.timeout(30_000)));
        } catch (e) {
          if (e instanceof GetisqTokenError)
            return Response.json({ error: `${e.message}. Check GETISQ_TOKEN.` }, { status: 401 });
          // fetch() itself failing means the API wasn't reachable, not that the id was wrong.
          const unreachable = e instanceof TypeError || (e as Error).name === "TimeoutError";
          if (unreachable)
            return Response.json(
              {
                error:
                  "Couldn't reach the getisq API. It only answers on the IndiaMART network, so run the app locally (npm run dev) there.",
              },
              { status: 502 },
            );
          // The API answered with an error for this MCAT: the others may still load.
          return Response.json({ error: (e as Error).message }, { status: 422 });
        }
      },
    },
  },
});
