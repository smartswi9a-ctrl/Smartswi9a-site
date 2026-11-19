/* ============================================================
   js/traffic-chart.js
   Graphique SVG du trafic — logique PURE (aucune dependance).
   ------------------------------------------------------------
   Pourquoi du SVG a la main plutot qu une librairie ?
     - la CSP du site n autorise que les scripts de l origine ;
     - aucune dependance a maintenir ;
     - le rendu est testable sans navigateur (tests/traffic-chart.test.mjs).

   Entree : serie produite par analytics-core.buildTrafficSeries()
            [{ date: "2026-11-18", views: 12, visitors: 5 }, ...]
   Sortie : chaine SVG (barres = vues, ligne = visiteurs uniques).
   ============================================================ */

const SVG_NS = "http://www.w3.org/2000/svg";

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

function shortDate(iso) {
  const parts = String(iso || "").split("-");
  return parts.length === 3 ? parts[2] + "/" + parts[1] : String(iso || "");
}

/**
 * Construit le SVG du trafic.
 * @param {Array<{date:string, views:number, visitors:number}>} series
 * @param {object} [options] width, height, viewsColor, visitorsColor
 * @returns {string} balise SVG (ou message si serie vide)
 */
export function buildTrafficSvg(series, options = {}) {
  const data = Array.isArray(series)
    ? series.filter((d) => d && typeof d.date === "string")
    : [];

  if (data.length === 0) {
    return '<p style="color:var(--text-muted);margin:0;">Aucune donnée sur cette période.</p>';
  }

  const W = num(options.width) || 720;
  const H = num(options.height) || 240;
  const viewsColor = options.viewsColor || "#a57b2e";
  const visitorsColor = options.visitorsColor || "#1b2a4a";

  const padL = 38;
  const padR = 12;
  const padT = 16;
  const padB = 30;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const maxV = Math.max(
    1,
    ...data.map((d) => num(d.views)),
    ...data.map((d) => num(d.visitors))
  );

  const step = plotW / data.length;
  const barW = Math.max(2, Math.min(20, step * 0.55));
  const yOf = (v) => padT + plotH - (num(v) / maxV) * plotH;

  const grid = [];
  for (let i = 0; i <= 2; i++) {
    const value = Math.round((maxV * i) / 2);
    const y = yOf(value).toFixed(1);
    grid.push(
      `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="#e7e0d3" stroke-width="1"/>`
    );
    grid.push(
      `<text x="${padL - 6}" y="${(Number(y) + 3.5).toFixed(1)}" text-anchor="end" font-size="9" fill="#8a8071">${value}</text>`
    );
  }

  const bars = data
    .map((d, i) => {
      const views = num(d.views);
      const x = (padL + i * step + (step - barW) / 2).toFixed(1);
      const y = yOf(views).toFixed(1);
      const h = Math.max(0, padT + plotH - Number(y)).toFixed(1);
      return `<rect x="${x}" y="${y}" width="${barW.toFixed(1)}" height="${h}" rx="2" fill="${viewsColor}" opacity="0.85"><title>${d.date} : ${views} vue(s)</title></rect>`;
    })
    .join("");

  const points = data
    .map(
      (d, i) =>
        `${(padL + i * step + step / 2).toFixed(1)},${yOf(d.visitors).toFixed(1)}`
    )
    .join(" ");
  const line = `<polyline points="${points}" fill="none" stroke="${visitorsColor}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;

  const dots = data
    .map((d, i) => {
      const cx = (padL + i * step + step / 2).toFixed(1);
      const cy = yOf(d.visitors).toFixed(1);
      return `<circle cx="${cx}" cy="${cy}" r="2.4" fill="${visitorsColor}"><title>${d.date} : ${num(d.visitors)} visiteur(s)</title></circle>`;
    })
    .join("");

  const every = Math.max(1, Math.ceil(data.length / 8));
  const xLabels = data
    .map((d, i) => {
      if (i % every !== 0 && i !== data.length - 1) return "";
      const x = (padL + i * step + step / 2).toFixed(1);
      return `<text x="${x}" y="${H - 8}" text-anchor="middle" font-size="9" fill="#8a8071">${shortDate(d.date)}</text>`;
    })
    .join("");

  return `<svg xmlns="${SVG_NS}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Evolution des vues et des visiteurs uniques sur ${data.length} jours" style="display:block;width:100%;height:auto;">
            <title>Evolution du trafic sur ${data.length} jours</title>
            ${grid.join("")}
            ${bars}
            ${line}
            ${dots}
            ${xLabels}
        </svg>`;
}
