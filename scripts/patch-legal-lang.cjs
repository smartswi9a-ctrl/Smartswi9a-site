/* ============================================================
   scripts/patch-legal-lang.cjs
   ------------------------------------------------------------
   Equipe les pages legales d un selecteur de langue SANS traduire
   le contenu juridique.

   POURQUOI : les CGU engagent juridiquement l editeur. Une version
   AR/EN non relue par un juriste creerait un risque de divergence
   contractuelle. Le selecteur est donc ajoute (navigation et cadre
   traduits) et un BANDEAU INFORME le visiteur que la version de
   reference est le francais.

   USAGE :
     node scripts/patch-legal-lang.cjs --dry-run
     node scripts/patch-legal-lang.cjs
   ============================================================ */

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DRY = process.argv.includes("--dry-run");

const PAGES = [
  "cgu-acheteur.html",
  "cgu-vendeur.html",
  "contrat-vendeur.html",
  "politique-confidentialite.html",
];

const NAV_KEYS = {
  '<li role="none"><a href="/" role="menuitem">Produits</a></li>':
    '<li role="none"><a href="/" role="menuitem" data-key="navProducts">Produits</a></li>',
  '<li role="none"><a href="/boutique.html" role="menuitem">Boutique</a></li>':
    '<li role="none"><a href="/boutique.html" role="menuitem" data-key="navShop">Boutique</a></li>',
  '<li role="none"><a href="/blog.html" role="menuitem">Blog</a></li>':
    '<li role="none"><a href="/blog.html" role="menuitem" data-key="navBlog">Blog</a></li>',
  '<li role="none"><a href="/villesmaroc.html" role="menuitem">Villes</a></li>':
    '<li role="none"><a href="/villesmaroc.html" role="menuitem" data-key="navCities">Villes</a></li>',
  '<li role="none"><a href="/vendor-login.html" role="menuitem">Espace vendeur</a></li>':
    '<li role="none"><a href="/vendor-login.html" role="menuitem" data-key="vendorSpace">Espace vendeur</a></li>',
  '<a class="btn-account" href="/">Retour à la boutique</a>':
    '<a class="btn-account" href="/" data-key="backToShop">Retour à la boutique</a>',
  '<h3 class="footer-legal-title">Informations légales</h3>':
    '<h3 class="footer-legal-title" data-key="footerLegalTitle">Informations légales</h3>',
  '<li><a href="/cgu-acheteur.html">CGU Acheteur</a></li>':
    '<li><a href="/cgu-acheteur.html" data-key="footerLegalCguBuyer">CGU Acheteur</a></li>',
  '<li><a href="/cgu-vendeur.html">CGU Vendeur</a></li>':
    '<li><a href="/cgu-vendeur.html" data-key="footerLegalCguVendor">CGU Vendeur</a></li>',
  '<li><a href="/contrat-vendeur.html">Contrat Vendeur</a></li>':
    '<li><a href="/contrat-vendeur.html" data-key="footerLegalContract">Contrat Vendeur</a></li>',
  '<li><a href="/politique-confidentialite.html">Politique de confidentialité</a></li>':
    '<li><a href="/politique-confidentialite.html" data-key="footerLegalPrivacy">Politique de confidentialité</a></li>',
};

const SELECT_HTML = `          <div class="nav-right legal-nav-right">
              <select id="langSelect" class="legal-lang-select" data-aria-key="ariaLangChange" aria-label="Changer la langue">
                  <option value="ar">🇲🇦 AR</option>
                  <option value="fr" selected>🇫🇷 FR</option>
                  <option value="en">🇬🇧 EN</option>
              </select>
              <a class="btn-account" href="/" data-key="backToShop">Retour à la boutique</a>
          </div>
      </nav>`;

/* Bandeau affiche uniquement hors francais (gere par js/lang-toggle.js). */
const NOTICE_HTML = `
      <div id="legalLangNotice" class="legal-lang-notice" role="status" hidden>
          <strong data-key="legalNoticeTitle">Version de référence</strong>
          <span data-key="legalNoticeText">Seule la version française de ce document fait foi. La traduction intégrale est en cours de validation juridique.</span>
      </div>`;

const STYLE = `
        .legal-lang-select {
            padding: .45rem .65rem;
            border: 1px solid var(--border-gold);
            border-radius: 8px;
            background: var(--bg-card);
            color: var(--text);
            font: inherit;
            font-size: .85rem;
            font-weight: 600;
            cursor: pointer;
        }
        .legal-lang-select:focus {
            outline: none;
            border-color: var(--gold);
            box-shadow: 0 0 0 3px rgba(165, 123, 46, .14);
        }
        .legal-nav-right { display: flex; align-items: center; gap: .7rem; }
        .legal-lang-notice {
            max-width: 860px;
            margin: 1.25rem auto 0;
            padding: .9rem 1.15rem;
            border-radius: 10px;
            border: 1px solid var(--border-gold);
            background: rgba(212, 163, 75, .10);
            color: var(--text);
            font-size: .87rem;
            line-height: 1.6;
        }
        .legal-lang-notice strong { display: block; color: var(--gold); margin-bottom: .15rem; }
        .legal-lang-notice[hidden] { display: none !important; }
        [dir="rtl"] .legal-lang-notice { text-align: right; }
`;

const SCRIPT_HTML = `
      <script type="module">
          import { initLangToggle } from '/js/lang-toggle.js';
          initLangToggle();
      </script>`;

let changed = 0;

for (const file of PAGES) {
  const abs = path.join(ROOT, file);
  if (!fs.existsSync(abs)) {
    console.warn("  [skip] absent : " + file);
    continue;
  }

  let html = fs.readFileSync(abs, "utf8");
  const before = html;

  if (!html.includes("/translations.js")) {
    html = html.replace(/<\/head>/i, '    <script src="/translations.js"></script>\n</head>');
  }

  if (!html.includes("legal-lang-select")) {
    html = html.replace(/<\/head>/i, "    <style>" + STYLE + "    </style>\n</head>");
  }

  for (const [from, to] of Object.entries(NAV_KEYS)) {
    if (html.includes(from)) html = html.split(from).join(to);
  }

  if (!html.includes('id="langSelect"')) {
    const navRightRe = /<div class="nav-right">[\s\S]*?<\/div>\s*<\/nav>/;
    if (navRightRe.test(html)) html = html.replace(navRightRe, SELECT_HTML);
  }

  if (!html.includes("legalLangNotice")) {
    html = html.replace(/(<main[^>]*>)/i, "$1" + NOTICE_HTML);
  }

  if (!html.includes("lang-toggle.js")) {
    html = html.replace(/<\/body>/i, SCRIPT_HTML + "\n  </body>");
  }

  if (html !== before) {
    if (!DRY) fs.writeFileSync(abs, html, "utf8");
    changed++;
    console.log("  MAJ  " + file);
  } else {
    console.log("  --   " + file + " (deja a jour)");
  }
}

console.log("");
console.log((DRY ? "Simulation : " : "") + changed + " page(s) modifiee(s).");

