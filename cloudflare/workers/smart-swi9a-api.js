const ALLOWED_FUNCTIONS = new Set([
  "getLivoFees",
  "livoWebhook",
  "syncLivoCities",
  "signVendorContract",
  "loginVendor",
  "setVendorPassword",
  "adminVendorAction",
  "adminSetReturnFee",
  "requestWithdrawal",
  "createCustomerOrder",
  "createVerifiedReview",
  "backfillVendorOrderViews",
  "cancelCustomerOrder",
  "adminManageWallet",
  "adminPayoutAction",
  "releaseDueFunds",
  "productCatalogFeed",
  "adminDeleteVideo"
]);

const UPSTREAM = "https://europe-west1-smartswi9a-31063.cloudfunctions.net/";
const VIDEOS_BUCKET = "smartswi9a-videos";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    /* ------------------------------------------------------------
       Suppression interne d'une video R2 (appelee uniquement par la
       Cloud Function adminDeleteVideo, jamais par le navigateur).
       Protegee par le secret partage R2_DELETE_SECRET.
       ------------------------------------------------------------ */
    if (url.pathname === "/api/internal/r2-delete") {
      if (request.method !== "POST") {
        return Response.json({ success: false, message: "Methode non autorisee." }, { status: 405 });
      }
      const secret = env && env.R2_DELETE_SECRET;
      if (!secret || request.headers.get("x-internal-secret") !== secret) {
        return Response.json({ success: false, message: "Forbidden." }, { status: 403 });
      }
      let payload = {};
      try {
        payload = await request.json();
      } catch (_) {
        payload = {};
      }
      const key = String((payload && payload.key) || "").trim();
      if (!key || key.length > 200 || key.includes("/") || key.includes("..")) {
        return Response.json({ success: false, message: "Cle invalide." }, { status: 400 });
      }
      if (!env.VIDEOS) {
        return Response.json({ success: false, message: "Bucket R2 non lie." }, { status: 503 });
      }
      await env.VIDEOS.delete(key);
      return Response.json({ success: true, key, bucket: VIDEOS_BUCKET });
    }

    if (url.pathname === "/api/health") {
      return Response.json(
        { ok: true, service: "smart-swi9a-api-proxy" },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    if (!url.pathname.startsWith("/api/")) {
      return new Response("Not found", { status: 404 });
    }

    const functionName = url.pathname.slice("/api/".length);
    if (!ALLOWED_FUNCTIONS.has(functionName) || functionName.includes("/")) {
      return Response.json({ success: false, message: "API inconnue." }, { status: 404 });
    }

    if (!["GET", "POST", "OPTIONS"].includes(request.method)) {
      return Response.json({ success: false, message: "Méthode non autorisée." }, { status: 405 });
    }

    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.delete("content-length");
    headers.delete("cf-connecting-ip");
    headers.delete("x-forwarded-for");

    try {
      const upstream = await fetch(UPSTREAM + encodeURIComponent(functionName) + url.search, {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
        redirect: "manual"
      });

      const responseHeaders = new Headers(upstream.headers);
      responseHeaders.set("Cache-Control", "no-store");
      responseHeaders.set("X-Smart-Swi9a-API-Proxy", "1");

      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders
      });
    } catch (_) {
      return Response.json(
        { success: false, message: "Service API temporairement indisponible." },
        { status: 502, headers: { "Cache-Control": "no-store" } }
      );
    }
  }
};
