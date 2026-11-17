/* ============================================================
   js/lang-toggle.js
   SÉLECTEUR DE LANGUE AUTONOME — SMARTSWIKA
   ============================================================
   Rôle : permettre le basculement FR / AR / EN sur les pages qui
   ne chargent PAS app.js (pages légales, espace vendeur, 404,
   reset-password). Sur les pages de la boutique, c'est déjà assuré
   par la délégation d'événements de events.js.

   UTILISATION — dans le HTML de la page :

     <script src="/translations.js"></script>

     <select id="langSelect" data-lang-toggle
             data-aria-key="ariaLangChange"
             aria-label="Changer la langue">
       <option value="ar">🇲🇦 AR</option>
       <option value="fr" selected>🇫🇷 FR</option>
       <option value="en">🇬🇧 EN</option>
     </select>

     <script type="module">
       import { initLangToggle } from '/js/lang-toggle.js';
       initLangToggle();
     </script>

   Le module :
   1. applique la langue sauvegardée (ou ?lang=, ou celle du navigateur) ;
   2. positionne <html lang> et <html dir="rtl"> pour l arabe ;
   3. applique les traductions sur tous les [data-key] et [data-aria-key] ;
   4. écoute le changement du select et met à jour la page SANS reload ;
   5. redirige proprement si la page n a pas de sélecteur (sécurité).

   IMPORTANT : ce fichier ne contient AUCUN commentaire de ligne (//)
   pour résister à un aplatissement du fichier (ALERTE 1 du projet).
   ============================================================ */

import { initLang, setLang, getLang, t } from "./utils.js";
import { applyTranslations } from "./events.js";

/**
 * Applique les textes traduits à une page autonome.
 * Les libellés traduits par JS sont rafraîchis si la page expose
 * window.__onLangChange (optionnel).
 * @returns {void}
 */
function refreshPage() {
  applyTranslations();

  /* Met à jour les aria-label marqués data-aria-key. */
  document.querySelectorAll("[data-aria-key]").forEach((el) => {
    const key = el.getAttribute("data-aria-key");
    if (!key) return;
    const value = t(key);
    if (value && value !== key) el.setAttribute("aria-label", value);
  });

  /* Le <title> est traduit si la page déclare data-title-key. */
  const titleKey = document.documentElement.getAttribute("data-title-key");
  if (titleKey) {
    const value = t(titleKey);
    if (value && value !== titleKey) document.title = value;
  }

  /* Crochet pour les pages qui génèrent du texte en JS. */
  if (typeof window.__onLangChange === "function") {
    try {
      window.__onLangChange(getLang());
    } catch (e) {
      console.warn("[lang-toggle] __onLangChange a échoué :", e && e.message);
    }
  }
}

/**
 * Initialise le sélecteur de langue d une page autonome.
 * Idempotent : un double appel ne duplique pas les écouteurs.
 * @returns {string} la langue active
 */
export function initLangToggle() {
  const lang = initLang();

  const select = document.getElementById("langSelect");
  if (select && select.value !== lang) select.value = lang;

  refreshPage();

  if (select && !select.dataset.langToggleReady) {
    select.dataset.langToggleReady = "1";
    select.addEventListener("change", () => {
      const next = select.value;
      if (!next) return;
      setLang(next);
      refreshPage();
    });
  }

  /* Un changement de langue déclenché ailleurs (ex. data-action) doit
     aussi rafraîchir cette page. */
  document.addEventListener("lang-changed", () => {
    const s = document.getElementById("langSelect");
    const current = getLang();
    if (s && s.value !== current) s.value = current;
    refreshPage();
  });

  return lang;
}

export default initLangToggle;
