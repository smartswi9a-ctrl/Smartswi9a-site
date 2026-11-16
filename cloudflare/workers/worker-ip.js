/* ============================================================
   Worker Cloudflare : worker-ip
   ------------------------------------------------------------
   Role : renvoyer a l'appelant son IP publique telle que vue par
   Cloudflare, pour la signature legale des contrats (Loi 53-05).

   HISTORIQUE (audit 2026-11-16)
   -----------------------------
   Ce Worker etait deploye en production depuis le 2026-10-23 via
   l'editeur rapide du dashboard, SANS aucune source versionnee dans ce
   depot. Le code n'existait qu'en production.

   Deux problemes corriges ici :
     1. CORS figeait 'https://smartswi9a.top' alors que le domaine
        exploite est smartswika.ma -> le navigateur bloquait la reponse
        quand le Worker etait appele depuis le site, et la capture d'IP
        pour les contrats echouait silencieusement.
     2. Aucun en-tete de securite, aucune limitation.

   Ce fichier est desormais la SOURCE DE VERITE. Deployer avec :
     npx wrangler deploy --config wrangler.worker-ip.toml

   ATTENTION : l'endpoint reste public par nature (il renvoie l'IP de
   l'appelant, sans authentification). Ne JAMAIS y ajouter de donnees
   supplementaires (geolocalisation fine, referer, cookies).
   ============================================================ */

/* Liste blanche d'origines, surchargeable sans redeploiement via la
   variable d'environnement ALLOWED_ORIGINS (separee par des virgules).
   Par defaut : domaines de production + localhost pour le dev. */
const DEFAULT_ALLOWED_ORIGINS = [
  'https://smartswika.ma',
  'https://www.smartswika.ma',
  'https://smartswi9a.top',
  'https://www.smartswi9a.top',
  'http://localhost:8080',
  'http://127.0.0.1:8080'
];

function parseAllowedOrigins(env) {
  const raw = (env && env.ALLOWED_ORIGINS) || '';
  const fromEnv = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return fromEnv.length ? fromEnv : DEFAULT_ALLOWED_ORIGINS;
}

export default {
  async fetch(request, env) {
    const allowed = parseAllowedOrigins(env);
    const origin = request.headers.get('Origin');
    const originAllowed = !!origin && allowed.includes(origin);

    /* Fail-closed : on n'emet Access-Control-Allow-Origin que si
       l'origine appelante est explicitement autorisee. */
    const baseHeaders = {
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '600',
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer'
    };
    const corsHeaders = originAllowed
      ? { ...baseHeaders, 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }
      : { ...baseHeaders, Vary: 'Origin' };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== 'GET') {
      return new Response(
        JSON.stringify({ error: 'Methode non autorisee.', code: 'method_not_allowed' }),
        { status: 405, headers: { ...corsHeaders, Allow: 'GET, OPTIONS' } }
      );
    }

    /* CF-Connecting-IP est pose par Cloudflare et non falsifiable par le
       client : c'est la seule source fiable d'IP reelle. */
    const ip = request.headers.get('CF-Connecting-IP');
    if (!ip) {
      return new Response(
        JSON.stringify({ error: 'IP indisponible.', code: 'ip_unavailable' }),
        { status: 503, headers: corsHeaders }
      );
    }

    const payload = {
      ip,
      country: (request.cf && request.cf.country) || null,
      timestamp: new Date().toISOString()
    };

    return new Response(JSON.stringify(payload), { status: 200, headers: corsHeaders });
  }
};
