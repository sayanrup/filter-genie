import { createFileRoute } from "@tanstack/react-router";
import { fetchMcatContext } from "@/lib/mcat-context";

/**
 * GET /api/mcat-context?mcat_id=135712 → the MCAT's Seller & Buyer Spec Audit as JSON.
 * Add `&format=markdown` for the audit text instead (what the category context input takes).
 */
export const Route = createFileRoute("/api/mcat-context")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const params = new URL(request.url).searchParams;
        const id = params.get("mcat_id")?.trim() ?? "";
        if (!/^\d+$/.test(id))
          return Response.json({ error: "mcat_id must be a number" }, { status: 400 });

        let context;
        try {
          context = await fetchMcatContext(id, AbortSignal.timeout(20_000));
        } catch (e) {
          // fetch() itself failing means the API wasn't reachable, not that the id was wrong.
          const unreachable = e instanceof TypeError || (e as Error).name === "TimeoutError";
          const error = unreachable
            ? "Couldn't reach the MCAT API. It only answers on the IndiaMART network, so run the app locally (npm run dev) there."
            : (e as Error).message;
          return Response.json({ error }, { status: unreachable ? 502 : 404 });
        }

        if (params.get("format") === "markdown")
          return new Response(context.markdown, {
            headers: { "content-type": "text/markdown; charset=utf-8" },
          });
        return Response.json(context.audit);
      },
    },
  },
});
