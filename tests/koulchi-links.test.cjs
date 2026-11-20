/* ============================================================
   tests/koulchi-links.test.cjs
   GARDE-FOU : bandeau dore + titre Koulchi cliquables,
   et bandeau lisible sur mobile.
   ------------------------------------------------------------
   Demandes client du 2026-11-18 :
     1. le bandeau dore de l accueil doit mener a /koulchi ;
     2. le titre de la section Koulchi de l accueil aussi ;
     3. sur mobile, le bandeau ne doit plus etre tronque.

   Mesure prod AVANT (390 px) : le marquee (padding-left: 100% +
   animation 20 s) placait le texte de 355 px de -65 a 290 px,
   donc coupe des deux cotes. Il tient pourtant dans 370 px
   utiles : on arrete le defilement sous 480 px.

   Ce test lit les sources (HTML / JS / CSS) : il ne depend pas du
   DOM et attrape une regression de structure ou de style.
   ============================================================ */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const lire = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

const INDEX = lire("index.html");
const PAGE_JS = lire("js/koulchi-page.js");
const STYLE = lire("style.css");
const PATCHES = lire("style-patches.css");

let verifications = 0;
let echecs = 0;

function ok(nom, detail) {
  verifications++;
  console.log("PASS: " + nom + (detail ? " -> " + detail : ""));
}

function ko(nom, detail) {
  verifications++;
  echecs++;
  console.error("ECHEC: " + nom + (detail ? " -> " + detail : ""));
}

function verifie(nom, condition, detail) {
  condition ? ok(nom, detail) : ko(nom, detail);
}

/* --------------------------------------------- 1. bandeau = lien */

verifie(
  "index.html : le bandeau dore est un lien vers /koulchi.html",
  /<a\s+class="navbar-promo-banner"\s+id="navbarPromoBanner"\s+href="\/koulchi\.html">/.test(
    INDEX
  )
);

verifie(
  "index.html : l ancien conteneur div a disparu",
  !/<div\s+class="navbar-promo-banner"/.test(INDEX)
);

verifie(
  "index.html : le texte i18n du bandeau est conserve",
  /class="marquee-text"\s+data-key="promoBannerText"/.test(INDEX)
);

/* --------------------------------------------- 2. titre = lien */

verifie(
  "koulchi-page.js : le titre Koulchi est enveloppe dans un lien /koulchi.html",
  /<a class="koulchi-home-title-link" href="\/koulchi\.html"><h2 class="section-title" id="koulchiHomeTitle">/.test(
    PAGE_JS
  )
);

verifie(
  "koulchi-page.js : l id koulchiHomeTitle est conserve (aria-labelledby)",
  /id="koulchiHomeTitle"/.test(PAGE_JS)
);

/* --------------------------------------------- 3. styles du bandeau */

const debutBandeau = STYLE.indexOf(".navbar-promo-banner {");
const finBandeau = debutBandeau >= 0 ? STYLE.indexOf("}", debutBandeau) : -1;
const blocBandeau =
  debutBandeau >= 0 && finBandeau > debutBandeau
    ? STYLE.slice(debutBandeau, finBandeau)
    : "";

verifie(
  "style.css : le bandeau est un bloc sans soulignement",
  /display:\s*block;/.test(blocBandeau) &&
    /text-decoration:\s*none;/.test(blocBandeau)
);

verifie(
  "style.css : un etat hover / focus est prevu",
  /\.navbar-promo-banner:hover,[\s\S]{0,120}\.navbar-promo-banner:focus-visible/.test(
    STYLE
  )
);

/* --------------------------------------------- 4. mobile sans marquee */

const debutMobile = PATCHES.indexOf("16. PROMO BANNER MARQUEE");
const finMobile = PATCHES.indexOf("17. RTL");
const sectionMobile =
  debutMobile >= 0 && finMobile > debutMobile
    ? PATCHES.slice(debutMobile, finMobile)
    : "";

verifie(
  "style-patches.css : section mobile du bandeau presente",
  sectionMobile.length > 0
);

verifie(
  "style-patches.css : defilement desactive sur mobile",
  /animation:\s*none;/.test(sectionMobile)
);

verifie(
  "style-patches.css : le texte demarre dans le cadre (padding-inline-start: 0)",
  /* Audit 2026-11-20 : la propriété est passée en LOGIQUE (RTL-safe).
     En LTR, padding-inline-start:0 === padding-left:0. On accepte les deux
     pour ne pas figer une propriété physique dans le garde-fou. */
  /padding-(inline-start|left):\s*0;/.test(sectionMobile)
);

verifie(
  "style-patches.css : le texte peut passer a la ligne",
  /white-space:\s*normal;/.test(sectionMobile)
);

verifie(
  "style-patches.css : plus de masque lateral sur mobile",
  /mask-image:\s*none;/.test(sectionMobile)
);

/* --------------------------------------------- 5. style du lien titre */

verifie(
  "style-patches.css : lien du titre stylise (or au survol)",
  /\.koulchi-home-title-link:hover \.section-title,[\s\S]{0,160}color:\s*var\(--gold\)/.test(
    PATCHES
  )
);

/* --------------------------------------------- resume */

console.log("\n" + verifications + " verification(s), " + echecs + " echec(s)");
process.exit(echecs === 0 ? 0 : 1);
