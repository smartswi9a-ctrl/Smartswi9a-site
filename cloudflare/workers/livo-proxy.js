const corsHeaders = {
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  // Sans Expose-Headers, le navigateur masque Retry-After au JS appelant
  // et le client ne peut pas respecter le backoff demande par Livo en 429.
  "Access-Control-Expose-Headers": "Retry-After",
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

/* ============================================================
   DATES LIVO
   Livo exige desired_date au format JJ/MM/AAAA et refuse toute
   date dans le passe (cf. AddOrderRequest.desired_date et
   EditOrderRequest.desired_date dans l'OpenAPI). On normalise et
   on valide ici pour renvoyer un message clair au lieu de laisser
   Livo repondre 400 "desired_date contains an invalid value".
   ============================================================ */
const LIVO_DATE_PATTERN = /^(\d{2})\/(\d{2})\/(\d{4})$/;

function formatLivoDate(date) {
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${day}/${month}/${date.getFullYear()}`;
}

function isDateInstance(value) {
  // Object.prototype.toString reste fiable meme si l'objet vient d'un autre
  // realm (instanceof Date echoue dans ce cas).
  return Object.prototype.toString.call(value) === "[object Date]";
}

// Retourne "JJ/MM/AAAA" ou null si la valeur est inexploitable.
function normalizeLivoDate(value) {
  if (isDateInstance(value)) {
    return Number.isNaN(value.getTime()) ? null : formatLivoDate(value);
  }

  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  let parts = trimmed.match(LIVO_DATE_PATTERN);
  if (parts) {
    parts = [parts[1], parts[2], parts[3]];
  } else {
    // Tolerance ISO 8601 (2026-06-10 ou 2026-06-10T00:00:00Z).
    const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/);
    if (!iso) return null;
    parts = [iso[3], iso[2], iso[1]];
  }

  const day = Number(parts[0]);
  const month = Number(parts[1]);
  const year = Number(parts[2]);

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null; // Rejette 31/02 ou 29/02 hors annee bissextile.
  }

  return `${parts[0]}/${parts[1]}/${parts[2]}`;
}

function isLivoDateInPast(formatted) {
  const [day, month, year] = formatted.split("/").map(Number);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return new Date(year, month - 1, day) < today;
}

async function verifyFirebaseToken(request, env) {
  // Verifie le jeton Firebase et renvoie ses claims, sans controle de role.
  // Le controle de role (admin/vendeur) est fait par les wrappers ci-dessous.

  const payload = await verifyFirebaseTokenClaims(request, env);

  const admins = (env.LIVO_ADMIN_UIDS || "")
    .split(",")
    .map((uid) => uid.trim())
    .filter(Boolean);

  if (!admins.includes(payload.sub)) {
    throw new Error("Acces administrateur refuse.");
  }

  return payload;
}

async function verifyFirebaseTokenClaims(request, env) {
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

  return payload;
}

// Autorise un vendeur approuve (role == 'vendor') a appeler le proxy.
// La cle API Livo reste cote serveur : le client ne voit jamais de secret.
function vendorUidsFromEnv(env) {
  return (env.LIVO_VENDOR_UIDS || "")
    .split(",")
    .map((uid) => uid.trim())
    .filter(Boolean);
}

async function verifyVendorToken(request, env) {
  const payload = await verifyFirebaseTokenClaims(request, env);
  const allowedVendors = vendorUidsFromEnv(env);

  // Allowlist optionnelle : si LIVO_VENDOR_UIDS est defini, on la respecte.
  // Sinon, tout jeton Firebase valide est accepte et le client_id Livo est
  // celui du compte (un seul client Livo cote Smart Swika).
  if (allowedVendors.length && !allowedVendors.includes(payload.sub)) {
    throw new Error("Acces vendeur refuse.");
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

  const passthrough = {
    "Content-Type":
      response.headers.get("Content-Type") ||
      "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };

  // Livo limite a 5 req/s et impose un budget horaire sur certains endpoints.
  // Sans Retry-After, le client ne peut pas respecter le backoff demande et
  // retombe immediatement en 429 : l'en-tete doit traverser le Worker intact.
  const retryAfter = response.headers.get("Retry-After");
  if (retryAfter) passthrough["Retry-After"] = retryAfter;

  return new Response(body, {
    status: response.status,
    headers: passthrough,
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

    // Controle des roles par route :
    //   /create-pickup  -> vendeur authentifie (verifie plus bas, role vendeur)
    //   autres routes   -> administrateur (UID present dans LIVO_ADMIN_UIDS)
    let callerUid = null;
    try {
      if (path === "/create-pickup") {
        const claims = await verifyVendorToken(request, env);
        callerUid = String(claims?.sub || "").trim();
      } else {
        const claims = await verifyFirebaseToken(request, env);
        callerUid = String(claims?.sub || "").trim();
      }
    } catch (error) {
      const message = error.message || "";

      const status =
        message === "Accès administrateur refusé." || message === "Accès vendeur refusé."
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
    let payload;
    if (["/create-order", "/cancel-order", "/create-pickup"].includes(path)) {
      try {
        payload = await request.json();
      } catch {
        return json({ error: "Corps JSON invalide." }, 400, headers);
      }
      if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
        return json({ error: "Le corps de la requete doit etre un objet JSON." }, 400, headers);
      }
    }

    let pickupPayload = null;

    if (path === "/create-pickup") {
      pickupPayload = payload;

      // AddPickupRequest (Livo) :
      //   client_id      requis, ajoute par le Worker (jamais par le navigateur)
      //   items          tableau d'identifiants d'articles en stock (1..500)
      //   products       alternative a items : [{ product_id, quantity >= 1 }]
      //   desired_date   JJ/MM/AAAA, jamais dans le passe
      //   comment        libre
      //   additionalProperties: false -> tout autre champ est rejete.
      const rawItems = pickupPayload?.items;
      const rawProducts = pickupPayload?.products;

      const items = Array.isArray(rawItems)
        ? rawItems.map((value) => String(value ?? "").trim()).filter(Boolean)
        : [];

      const products = Array.isArray(rawProducts)
        ? rawProducts.map((item) => ({
            product_id: String(item?.product_id ?? "").trim(),
            quantity: Number(item?.quantity),
          }))
        : [];

      if (!items.length && !products.length) {
        return json({
          error: "Selectionnez au moins un produit a envoyer (items ou products).",
        }, 400, headers);
      }

      if (items.length > 500) {
        return json({
          error: "Un ramassage ne peut pas depasser 500 articles.",
        }, 400, headers);
      }

      if (items.some((value) => value.length > 128 || /[/?#]/.test(value))) {
        return json({ error: "Identifiant d'article Livo invalide." }, 400, headers);
      }

      if (products.some((item) =>
        !item.product_id ||
        item.product_id.length > 128 ||
        !Number.isFinite(item.quantity) ||
        item.quantity < 1 ||
        item.quantity > 100000
      )) {
        return json({ error: "La liste des produits est invalide (quantites >= 1)." }, 400, headers);
      }

      if (items.length && products.length) {
        return json({
          error: "Envoyez soit 'items', soit 'products', pas les deux.",
        }, 400, headers);
      }

      // desired_date : meme regle que pour les commandes (AddPickupRequest).
      let pickupDate = null;
      const rawDate = pickupPayload?.desired_date;
      if (rawDate !== undefined && rawDate !== null && String(rawDate).trim() !== "") {
        pickupDate = normalizeLivoDate(rawDate);
        if (!pickupDate) {
          return json({ error: "La date de ramassage doit etre au format JJ/MM/AAAA." }, 400, headers);
        }
        if (isLivoDateInPast(pickupDate)) {
          return json({ error: "La date de ramassage ne peut pas etre dans le passe." }, 400, headers);
        }
      }

      const comment = typeof pickupPayload?.comment === "string"
        ? pickupPayload.comment.trim().slice(0, 500)
        : "";

      // client_id : compte Livo unique de Smart Swika, derive de l'environnement.
      // Le navigateur ne choisit jamais ce champ (sinon un vendeur pourrait
      // demander un ramassage sur le stock d'un autre client Livo).
      let clientId =
        (env.LIVO_CLIENT_ID || "").trim() ||
        (env.LIVO_CUSTOMER_ID || "").trim();

      // Identification d'appel : uniquement issue du jeton verifie (jamais d'un header client).
      const vendorUid = String(callerUid || "").trim();
      if (clientId && /\s/.test(clientId)) {
        return json({ error: "Configuration serveur invalide (LIVO_CLIENT_ID)." }, 500, headers);
      }
      if (clientId && clientId.length > 128) {
        return json({ error: "Configuration serveur invalide (LIVO_CLIENT_ID)." }, 500, headers);
      }

      pickupPayload = {
        ...(clientId ? { client_id: clientId } : {}),
        ...(items.length ? { items } : {}),
        ...(products.length ? { products } : {}),
        ...(pickupDate ? { desired_date: pickupDate } : {}),
        ...(comment ? { comment } : {}),
        ...(vendorUid ? { vendor_uid: vendorUid } : {}),
      };
    }

    let endpoint;
    let method;
    let livoPayload;

    if (path === "/create-pickup") {
      endpoint = "/pickups";
      method = "POST";
      // additionalProperties: false cote Livo : vendor_uid ne doit pas partir.
      const { vendor_uid: _vendorUid, ...toBeSent } = pickupPayload || {};
      livoPayload = toBeSent;
    }

    if (path === "/create-order") {
      const target = payload?.target;
      const products = payload?.products;
      const cost = Number(payload?.cost);
      // Spec AddOrderRequest : cost requis, number, minimum 0 (0 est valide).
      if (!Number.isFinite(cost) || cost < 0 || cost > 1000000) {
        return json({ error: "Le montant de la commande est invalide." }, 400, headers);
      }
      if (!target || !["name", "phone", "city", "address"].every((key) => typeof target[key] === "string" && target[key].trim())) {
        return json({ error: "Les informations du destinataire sont incomplètes (nom, téléphone, ville, adresse)." }, 400, headers);
      }
      // Spec AddOrderRequest : products 1..99, quantity entiere 1..99.
      if (!Array.isArray(products) || products.length < 1 || products.length > 99 || products.some((item) =>
        !item || (typeof item.product_id !== "string" && typeof item.product_id !== "number") ||
        !String(item.product_id).trim() || !Number.isInteger(Number(item.quantity)) ||
        Number(item.quantity) < 1 || Number(item.quantity) > 99
      )) {
        return json({ error: "La liste des produits Livo est invalide (1 à 99 articles, quantités de 1 à 99)." }, 400, headers);
      }
      if (payload?.status && !["draft", "pending"].includes(payload.status)) {
        return json({ error: "Statut de commande Livo non autorisé." }, 400, headers);
      }

      // Spec AddOrderRequest.desired_date : JJ/MM/AAAA, jamais dans le passe.
      let desiredDate = null;
      if (payload?.desired_date !== undefined && payload?.desired_date !== null && payload?.desired_date !== "") {
        desiredDate = normalizeLivoDate(payload.desired_date);
        if (!desiredDate) {
          return json({ error: "La date de livraison souhaitée doit être au format JJ/MM/AAAA." }, 400, headers);
        }
        if (isLivoDateInPast(desiredDate)) {
          return json({ error: "La date de livraison souhaitée ne peut pas être dans le passé." }, 400, headers);
        }
      }

      // Erreur Livo de type "prompt" (ex. duplicate_target) : le client doit
      // renvoyer la requete avec le confirm_text fourni dans details.
      const confirmText = typeof payload?.confirm_text === "string"
        ? payload.confirm_text.trim().slice(0, 200)
        : null;
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
        ...(desiredDate ? { desired_date: desiredDate } : {}),
        ...(typeof payload.openable === "boolean" ? { openable: payload.openable } : {}),
        ...(typeof payload.comment === "string" ? { comment: payload.comment.slice(0, 500) } : {}),
        ...(payload.status ? { status: payload.status } : {}),
        ...(typeof payload.client_order_id === "string" ? { client_order_id: payload.client_order_id.slice(0, 100) } : {}),
        ...(confirmText ? { confirm_text: confirmText } : {}),
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
