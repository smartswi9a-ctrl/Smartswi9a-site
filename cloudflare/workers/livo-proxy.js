const corsHeaders = {
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Vary": "Origin",
};

const PROJECT_ID = "smartswi9a-31063";
const LIVO_BASE_URL = "https://rest.livo.ma";

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...headers,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function getAllowedOrigins(env) {
  return (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function getCorsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = getAllowedOrigins(env);

  if (origin && allowed.includes(origin)) {
    return {
      ...corsHeaders,
      "Access-Control-Allow-Origin": origin,
    };
  }

  return corsHeaders;
}

function decodeBase64Url(value) {
  const base64 = value
    .replace(/-/g, "+")
    .replace(/_/g, "/");

  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  return atob(padded);
}

async function verifyFirebaseToken(request, env) {
  const authorization = request.headers.get("Authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    throw new Error("Jeton Firebase manquant.");
  }

  const parts = match[1].split(".");

  if (parts.length !== 3) {
    throw new Error("Jeton Firebase invalide.");
  }

  let header;
  let payload;

  try {
    header = JSON.parse(decodeBase64Url(parts[0]));
    payload = JSON.parse(decodeBase64Url(parts[1]));
  } catch {
    throw new Error("Format du jeton invalide.");
  }

  if (header.alg !== "RS256" || !header.kid) {
    throw new Error("En-tête du jeton invalide.");
  }

  const now = Math.floor(Date.now() / 1000);

  if (
    payload.aud !== PROJECT_ID ||
    payload.iss !== `https://securetoken.google.com/${PROJECT_ID}` ||
    typeof payload.sub !== "string" ||
    !payload.sub ||
    payload.sub.length > 128 ||
    !Number.isFinite(payload.exp) ||
    payload.exp <= now ||
    !Number.isFinite(payload.iat) ||
    payload.iat > now ||
    !Number.isFinite(payload.auth_time) ||
    payload.auth_time > now
  ) {
    throw new Error("Jeton Firebase expiré ou claims invalides.");
  }

  const keyResponse = await fetch(
    "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"
  );

  if (!keyResponse.ok) {
    throw new Error("Vérification Firebase indisponible.");
  }

  const keySet = await keyResponse.json();
  const jwk = keySet.keys?.find((key) => key.kid === header.kid);

  if (!jwk) {
    throw new Error("Clé de signature Firebase inconnue.");
  }

  const publicKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
    },
    false,
    ["verify"]
  );

  let signature;

  try {
    signature = Uint8Array.from(
      decodeBase64Url(parts[2]),
      (character) => character.charCodeAt(0)
    );
  } catch {
    throw new Error("Signature Firebase invalide.");
  }

  const signedContent = new TextEncoder().encode(
    `${parts[0]}.${parts[1]}`
  );

  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    publicKey,
    signature,
    signedContent
  );

  if (!valid) {
    throw new Error("Signature Firebase invalide.");
  }

  const admins = (env.LIVO_ADMIN_UIDS || "")
    .split(",")
    .map((uid) => uid.trim())
    .filter(Boolean);

  if (!admins.includes(payload.sub)) {
    throw new Error("Accès administrateur refusé.");
  }

  return payload;
}

// Proxy sécurisé vers les endpoints Livo documentés.
// Les réponses et erreurs de Livo sont relayées sans exposer la clé.
async function callLivo(request, env, endpoint, method = "GET", payload) {
  if (!env.LIVO_API_KEY) {
    return json(
      { error: "Configuration serveur incomplète." },
      500
    );
  }

  const baseUrl = (env.LIVO_API_BASE_URL || LIVO_BASE_URL).replace(/\/+$/, "");
  const upstreamUrl = `${baseUrl}${endpoint}`;

  const response = await fetch(upstreamUrl, {
    method,
    headers: {
      Authorization: `Bearer ${env.LIVO_API_KEY}`,
      Accept: "application/json",
      ...(payload ? { "Content-Type": "application/json" } : {}),
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });

  const body = await response.text();

  return new Response(body, {
    status: response.status,
    headers: {
      "Content-Type":
        response.headers.get("Content-Type") ||
        "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const origin = request.headers.get("Origin");
    const allowed = getAllowedOrigins(env);
    const headers = getCorsHeaders(request, env);

    // Refuser les origines de navigateur non autorisées.
    if (origin && !allowed.includes(origin)) {
      return json({ error: "Origine non autorisée." }, 403);
    }

    // Pré-vérification CORS.
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers,
      });
    }

    // Vérification de fonctionnement du Worker.
    if (path === "/health") {
      if (request.method !== "GET") {
        return json(
          { error: "Méthode non autorisée." },
          405,
          headers
        );
      }

      return json({
        ok: true,
        service: "livo-proxy",
        message: "Worker opérationnel",
      }, 200, headers);
    }

    // Données publiques Livo, récupérées côté serveur.
    // La clé API reste exclusivement dans les secrets Cloudflare.
    if (path === "/cities" || path === "/fees") {
      if (request.method !== "GET") {
        return json(
          { error: "Méthode non autorisée." },
          405,
          headers
        );
      }

      try {
        const endpoint =
          path === "/cities" ? "/cities" : "/fees/public";

        const upstream = await callLivo(
          request,
          env,
          endpoint
        );

        const responseHeaders = new Headers(upstream.headers);

        for (const [key, value] of Object.entries(headers)) {
          responseHeaders.set(key, value);
        }

        return new Response(upstream.body, {
          status: upstream.status,
          headers: responseHeaders,
        });
      } catch {
        return json({
          error: "Impossible de joindre l'API Livo.",
        }, 502, headers);
      }
    }

    const knownRoutes = [
      "/create-order",
      "/cancel-order",
      "/create-pickup",
    ];

    const isTracking =
      path.startsWith("/track/") &&
      path.length > "/track/".length;

    if (!knownRoutes.includes(path) && !isTracking) {
      return json({
        error: "Route inconnue.",
      }, 404, headers);
    }

    // Vérifier les méthodes avant l'authentification.
    if (knownRoutes.includes(path) && !["POST"].includes(request.method)) {
      return json({
        error: "Méthode non autorisée.",
      }, 405, headers);
    }

    if (isTracking && request.method !== "GET") {
      return json({
        error: "Méthode non autorisée.",
      }, 405, headers);
    }

    // Les opérations administratives exigent un jeton Firebase valide
    // et un UID présent dans LIVO_ADMIN_UIDS.
    try {
      await verifyFirebaseToken(request, env);
    } catch (error) {
      const message = error.message || "";

      const status =
        message === "Accès administrateur refusé."
          ? 403
          : message.includes("indisponible")
            ? 503
            : 401;

      return json({
        error: "Authentification refusée.",
        message,
      }, status, headers);
    }

    // Le contrat Livo public confirme POST/PATCH /orders et GET /orders/{id}.
    // Le Worker conserve la clé API côté serveur et limite les champs transmis.
    if (path === "/create-pickup") {
      return json({
        error: "Ramassage non configuré.",
        message: "Livo exige des informations de point de ramassage qui ne sont pas encore collectées par le site. Aucun ramassage n’a été créé.",
      }, 501, headers);
    }

    let payload;
    if (path === "/create-order" || path === "/cancel-order") {
      try {
        payload = await request.json();
      } catch {
        return json({ error: "Corps JSON invalide." }, 400, headers);
      }
    }

    let endpoint;
    let method;
    let livoPayload;

    if (path === "/create-order") {
      const target = payload?.target;
      const products = payload?.products;
      const cost = Number(payload?.cost);
      if (!Number.isFinite(cost) || cost <= 0 || cost > 1000000) {
        return json({ error: "Le montant de la commande est invalide." }, 400, headers);
      }
      if (!target || !["name", "phone", "city", "address"].every((key) => typeof target[key] === "string" && target[key].trim())) {
        return json({ error: "Les informations du destinataire sont incomplètes (nom, téléphone, ville, adresse)." }, 400, headers);
      }
      if (!Array.isArray(products) || products.length < 1 || products.length > 50 || products.some((item) =>
        !item || (typeof item.product_id !== "string" && typeof item.product_id !== "number") ||
        !String(item.product_id).trim() || !Number.isInteger(Number(item.quantity)) ||
        Number(item.quantity) < 1 || Number(item.quantity) > 100
      )) {
        return json({ error: "La liste des produits Livo est invalide." }, 400, headers);
      }
      if (payload?.status && !["draft", "pending"].includes(payload.status)) {
        return json({ error: "Statut de commande Livo non autorisé." }, 400, headers);
      }
      endpoint = "/orders";
      method = "POST";
      livoPayload = {
        cost,
        target: {
          name: target.name.trim().slice(0, 100),
          phone: target.phone.trim().slice(0, 30),
          city: target.city.trim().slice(0, 100),
          address: target.address.trim().slice(0, 500),
        },
        products: products.map((item) => ({
          product_id: item.product_id,
          quantity: Number(item.quantity),
          ...(typeof item.refr === "string" ? { refr: item.refr.slice(0, 100) } : {}),
        })),
        ...(typeof payload.desired_date === "string" ? { desired_date: payload.desired_date } : {}),
        ...(typeof payload.openable === "boolean" ? { openable: payload.openable } : {}),
        ...(typeof payload.comment === "string" ? { comment: payload.comment.slice(0, 500) } : {}),
        ...(payload.status ? { status: payload.status } : {}),
        ...(typeof payload.client_order_id === "string" ? { client_order_id: payload.client_order_id.slice(0, 100) } : {}),
      };
    } else if (path === "/cancel-order") {
      const id = String(payload?.id || "").trim();
      if (!id || id.length > 128 || /[/?#]/.test(id)) {
        return json({ error: "Identifiant de commande Livo invalide." }, 400, headers);
      }
      endpoint = "/orders";
      method = "PATCH";
      livoPayload = { id, status: "cancelled" };
    } else if (isTracking) {
      let id;
      try { id = decodeURIComponent(path.slice("/track/".length)); } catch {
        return json({ error: "Identifiant de suivi invalide." }, 400, headers);
      }
      if (!id || id.length > 128 || /[/?#]/.test(id)) {
        return json({ error: "Identifiant de suivi invalide." }, 400, headers);
      }
      endpoint = `/orders/${encodeURIComponent(id)}`;
      method = "GET";
    }

    try {
      const upstream = await callLivo(request, env, endpoint, method, livoPayload);
      const responseHeaders = new Headers(upstream.headers);
      for (const [key, value] of Object.entries(headers)) responseHeaders.set(key, value);
      return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
    } catch {
      return json({ error: "Impossible de joindre l’API Livo." }, 502, headers);
    }
  },
};
