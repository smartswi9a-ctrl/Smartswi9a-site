#!/usr/bin/env node
/**
 * gen-legal-pages.cjs
 * Genere les pages HTML legales a la racine du site a partir des fichiers
 * Markdown de docs/legal/.
 *
 * Sortie (LF, UTF-8) :
 *   - cgu-acheteur.html
 *   - cgu-vendeur.html
 *   - contrat-vendeur.html
 *   - politique-confidentialite.html
 *
 * Usage : node scripts/gen-legal-pages.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LEGAL_DIR = path.join(ROOT, 'docs', 'legal');

const PAGES = [
  {
    src: 'cgu-acheteur.md',
    out: 'cgu-acheteur.html',
    title: 'CGU Acheteur',
    metaDesc:
      "Conditions générales d'utilisation applicables aux acheteurs de la marketplace Smartswika : commande, paiement, livraison, retours et réclamations.",
    intro:
      "Les présentes conditions générales encadrent l'utilisation du site Smartswika par les acheteurs et les modalités de commande, de paiement, de livraison et de réclamation.",
  },
  {
    src: 'cgu-vendeur.md',
    out: 'cgu-vendeur.html',
    title: 'CGU Vendeur',
    metaDesc:
      "Conditions générales d'utilisation applicables aux vendeurs partenaires de la marketplace Smartswika : inscription, obligations, commissions et résiliation.",
    intro:
      "Les présentes conditions générales encadrent l'inscription et l'activité des vendeurs partenaires au sein de la marketplace Smartswika.",
  },
  {
    src: 'contrat-vendeur.md',
    out: 'contrat-vendeur.html',
    title: 'Contrat Vendeur',
    metaDesc:
      "Contrat de partenariat commercial entre Smartswika et les vendeurs : objet, durée, obligations réciproques, rémunération et responsabilité.",
    intro:
      "Contrat de partenariat commercial liant Smartswika et le vendeur partenaire, conclu en complément des CGU Vendeur.",
  },
  {
    src: 'politique-confidentialite.md',
    out: 'politique-confidentialite.html',
    title: 'Politique de confidentialité',
    metaDesc:
      "Politique de confidentialité de Smartswika : données collectées, finalités, durée de conservation, droits des personnes et contact du responsable de traitement.",
    intro:
      "Smartswika accorde une importance particulière à la protection de votre vie privée. Cette politique détaille les données que nous collectons, pourquoi et comment exercer vos droits.",
  },
];

/* ------------------------------------------------------------------ */
/* Markdown -> HTML minimaliste (headings, listes, gras, liens, para)  */
/* ------------------------------------------------------------------ */

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inline(str) {
  let s = escapeHtml(str);
  // code inline
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  // gras
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // italique
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  // liens [txt](url)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, txt, url) => {
    const safe = /^(https?:|mailto:|\/|#|\.)/i.test(url) ? url : '#';
    return `<a href="${safe}" rel="noopener">${txt}</a>`;
  });
  return s;
}

function slugify(str) {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function mdToHtml(markdown) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let listType = null; // 'ul' | 'ol'
  let para = [];
  let inCode = false;
  let codeBuf = [];
  let skipFirstH1 = true;

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inline(para.join(' ').trim())}</p>`);
      para = [];
    }
  };
  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');

    if (/^```/.test(line)) {
      if (inCode) {
        out.push(`<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`);
        codeBuf = [];
        inCode = false;
      } else {
        flushPara();
        closeList();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(raw);
      continue;
    }

    if (!line.trim()) {
      flushPara();
      closeList();
      continue;
    }

    // Separateur horizontal
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      flushPara();
      closeList();
      out.push('<hr>');
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara();
      closeList();
      const level = h[1].length;
      const text = h[2].trim();
      // Le H1 du markdown est deja affiche par le layout : on l'ignore une fois
      if (level === 1 && skipFirstH1) {
        skipFirstH1 = false;
        continue;
      }
      if (level === 1) skipFirstH1 = false;
      const id = slugify(text).slice(0, 60) || `section-${out.length}`;
      if (level <= 3) {
        out.push(`<h${level} id="${id}">${inline(text)}</h${level}>`);
      } else {
        out.push(`<h${level}>${inline(text)}</h${level}>`);
      }
      continue;
    }

    // Citation
    if (/^>\s?/.test(line)) {
      flushPara();
      closeList();
      out.push(`<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`);
      continue;
    }

    // Liste non ordonnee
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) {
      flushPara();
      if (listType !== 'ul') {
        closeList();
        out.push('<ul>');
        listType = 'ul';
      }
      out.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }

    // Liste ordonnee
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ol) {
      flushPara();
      if (listType !== 'ol') {
        closeList();
        out.push('<ol>');
        listType = 'ol';
      }
      out.push(`<li>${inline(ol[1])}</li>`);
      continue;
    }

    // Sinon : paragraphe (les lignes consecutives sont fusionnees)
    para.push(line);
  }

  if (inCode && codeBuf.length) {
    out.push(`<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`);
  }
  flushPara();
  closeList();
  return out.join('\n');
}

function extractFirstParagraph(markdown) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const buf = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t || /^#{1,6}\s/.test(t) || /^[-*+]\s/.test(t) || /^\d+[.)]\s/.test(t)) {
      if (buf.length) break;
      continue;
    }
    buf.push(t);
  }
  return buf.join(' ')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .slice(0, 300);
}

function extractHeadings(markdown) {
  const items = [];
  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const m = line.match(/^(#{2,3})\s+(.*)$/);
    if (m) {
      const text = m[2].trim();
      items.push({ level: m[1].length, text, id: slugify(text).slice(0, 60) });
    }
  }
  return items;
}

/* ------------------------------------------------------------------ */
/* Template HTML (header / footer identiques a index.html)             */
/* ------------------------------------------------------------------ */

const LEGAL_FOOTER_COLUMN = `
        <nav class="footer-legal" aria-label="Informations légales">
            <h3 class="footer-legal-title">Informations légales</h3>
            <ul class="footer-legal-links">
                <li><a href="/cgu-acheteur.html">CGU Acheteur</a></li>
                <li><a href="/cgu-vendeur.html">CGU Vendeur</a></li>
                <li><a href="/contrat-vendeur.html">Contrat Vendeur</a></li>
                <li><a href="/politique-confidentialite.html">Politique de confidentialité</a></li>
            </ul>
        </nav>`;

function buildPage(cfg, markdown) {
  const body = mdToHtml(markdown);
  const toc = extractHeadings(markdown)
    .filter((h) => h.level === 2)
    .map((h) => `                <li><a href="#${h.id}">${escapeHtml(h.text)}</a></li>`)
    .join('\n');
  const desc = cfg.metaDesc;
  const canonical = `https://smartswika.ma/${cfg.out}`;
  const updated = new Date().toISOString().slice(0, 10);

  return `<!DOCTYPE html>
<html lang="fr" dir="ltr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
    <title>${escapeHtml(cfg.title)} | Smartswika</title>
    <meta name="description" content="${escapeHtml(desc)}">
    <meta name="robots" content="index, follow">
    <meta name="theme-color" content="#f8f6f2">
    <meta name="color-scheme" content="only light">
    <link rel="canonical" href="${canonical}">

    <link rel="icon" type="image/png" sizes="32x32" href="/assets/favicon-32.png">
    <link rel="icon" type="image/png" sizes="16x16" href="/assets/favicon-16.png">
    <link rel="apple-touch-icon" sizes="180x180" href="/assets/apple-touch-icon.png">
    <link rel="manifest" href="/site.webmanifest">

    <meta property="og:title" content="${escapeHtml(cfg.title)} | Smartswika">
    <meta property="og:description" content="${escapeHtml(desc)}">
    <meta property="og:type" content="article">
    <meta property="og:url" content="${canonical}">
    <meta property="og:site_name" content="Smartswika">
    <meta property="og:locale" content="fr_FR">

    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&family=Inter:wght@400;500;700&display=swap" rel="stylesheet">

    <link rel="stylesheet" href="/css/style.c422eb25.css">
    <link rel="stylesheet" href="/css/style-patches.1bd4b588.css">
    <link rel="stylesheet" href="/css/legal.css">
</head>
<body class="legal-page">
    <a class="skip-link" href="#legalContent">Aller au contenu</a>

    <nav id="navbar" role="navigation" aria-label="Navigation principale">
        <div class="nav-left">
            <a href="/" class="logo" aria-label="Smartswika - Accueil">
                <span class="logo-text">SMARTSWIKA</span>
            </a>
        </div>
        <ul class="nav-links" id="navLinks" role="menubar">
            <li role="none"><a href="/" role="menuitem">Produits</a></li>
            <li role="none"><a href="/boutique.html" role="menuitem">Boutique</a></li>
            <li role="none"><a href="/blog.html" role="menuitem">Blog</a></li>
            <li role="none"><a href="/villesmaroc.html" role="menuitem">Villes</a></li>
            <li role="none"><a href="/cgu-acheteur.html" role="menuitem">CGU</a></li>
            <li role="none"><a href="/vendor-login.html" role="menuitem">Espace vendeur</a></li>
        </ul>
        <div class="nav-right">
            <a class="btn-account" href="/">Retour à la boutique</a>
        </div>
    </nav>

    <main id="legalContent" class="legal-container">
        <nav class="legal-breadcrumb" aria-label="Fil d'Ariane">
            <a href="/">Accueil</a> <span aria-hidden="true">›</span> <span>${escapeHtml(cfg.title)}</span>
        </nav>

        <header class="legal-header">
            <h1>${escapeHtml(cfg.title)}</h1>
            <p class="legal-intro">${escapeHtml(cfg.intro)}</p>
            <p class="legal-updated">Dernière mise à jour : ${updated}</p>
        </header>
${toc ? `        <nav class="legal-toc" aria-label="Sommaire">
            <h2>Sommaire</h2>
            <ol>
${toc}
            </ol>
        </nav>
` : ''}
        <article class="legal-content">
${body}
        </article>

        <aside class="legal-crosslinks" aria-label="Autres documents légaux">
            <h2>Autres documents légaux</h2>
            <ul>
                <li><a href="/cgu-acheteur.html">CGU Acheteur</a></li>
                <li><a href="/cgu-vendeur.html">CGU Vendeur</a></li>
                <li><a href="/contrat-vendeur.html">Contrat Vendeur</a></li>
                <li><a href="/politique-confidentialite.html">Politique de confidentialité</a></li>
            </ul>
        </aside>
    </main>

    <footer class="site-footer" role="contentinfo">
        <div class="footer-logo">SMARTSWIKA</div>
        <p style="margin:0.5rem 0;">Votre boutique tech au Maroc. Livraison rapide, paiement à la livraison.</p>
        <div class="footer-contact">
            <a href="https://wa.me/212656613303" dir="ltr">+212 6 56 61 33 03</a>
            <a href="mailto:smartswi9a@gmail.com">smartswi9a@gmail.com</a>
        </div>
        <div class="footer-social-links">
            <a href="https://www.facebook.com/share/1dWNTuva1K/" target="_blank" rel="noopener noreferrer">Facebook</a>
            <a href="https://instagram.com/smartswi9a" target="_blank" rel="noopener noreferrer">Instagram</a>
            <a href="https://tiktok.com/@smartswi9a" target="_blank" rel="noopener noreferrer">TikTok</a>
            <a href="https://wa.me/212656613303" target="_blank" rel="noopener noreferrer">WhatsApp</a>
        </div>
${LEGAL_FOOTER_COLUMN}
        <p style="margin-top:0.8rem;font-size:0.75rem;opacity:0.5;">© 2026 Smartswika — Tous droits réservés</p>
    </footer>
</body>
</html>
`;
}

function main() {
  if (!fs.existsSync(LEGAL_DIR)) {
    console.error(`[gen-legal-pages] Dossier introuvable : ${LEGAL_DIR}`);
    process.exit(1);
  }

  let count = 0;
  for (const cfg of PAGES) {
    const srcPath = path.join(LEGAL_DIR, cfg.src);
    if (!fs.existsSync(srcPath)) {
      console.error(`[gen-legal-pages] Fichier source manquant : ${srcPath}`);
      process.exitCode = 1;
      continue;
    }
    const markdown = fs.readFileSync(srcPath, 'utf8').replace(/\r\n/g, '\n');
    const html = buildPage(cfg, markdown).replace(/\r\n/g, '\n');
    fs.writeFileSync(path.join(ROOT, cfg.out), html, { encoding: 'utf8' });
    console.log(`[gen-legal-pages] OK  ${cfg.out}  (${html.length} octets)`);
    count += 1;
  }
  console.log(`[gen-legal-pages] ${count} page(s) générée(s).`);
}

if (require.main === module) {
  main();
}

module.exports = { mdToHtml, buildPage, PAGES, LEGAL_FOOTER_COLUMN };
