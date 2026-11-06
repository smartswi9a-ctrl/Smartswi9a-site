const ALLOWED_FUNCTIONS = new Set([
  "getLivoFees",
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
  "adminPayoutAction",
  "releaseDueFunds"
]);

const UPSTREAM = "https://europe-west1-smartswi9a-31063.cloudfunctions.net/";

export default {
  async fetch(request) {
    const url = new URL(request.url);

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
