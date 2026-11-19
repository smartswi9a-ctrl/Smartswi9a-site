/* ============================================================
   js/barcode-code128.js
   Encodeur Code 128B PUR (aucune dependance, aucun DOM).
   Utilise pour les etiquettes SKU vendeur.
   ============================================================ */

/* Motifs officiels Code 128 (valeurs 0 a 106). Chaque motif est une
   suite de modules : 1 = barre, 0 = espace. */
const BARS = [
    11011001100, 11001101100, 11001100110, 10010011000, 10010001100,
    10001001100, 10011001000, 10011000100, 10001100100, 11001001000,
    11001000100, 11000100100, 10110011100, 10011011100, 10011001110,
    10111001100, 10011101100, 10011100110, 11001110010, 11001011100,
    11001001110, 11011100100, 11001110100, 11101101110, 11101001100,
    11100101100, 11100100110, 11101100100, 11100110100, 11100110010,
    11011011000, 11011000110, 11000110110, 10100011000, 10001011000,
    10001000110, 10110001000, 10001101000, 10001100010, 11010001000,
    11000101000, 11000100010, 10110111000, 10110001110, 10001101110,
    10111011000, 10111000110, 10001110110, 11101110110, 11010001110,
    11000101110, 11011101000, 11011100010, 11011101110, 11101011000,
    11101000110, 11100010110, 11101101000, 11101100010, 11100011010,
    11101111010, 11001000010, 11110001010, 10100110000, 10100001100,
    10010110000, 10010000110, 10000101100, 10000100110, 10110010000,
    10110000100, 10011010000, 10011000010, 10000110100, 10000110010,
    11000010010, 11001010000, 11110111010, 11000010100, 10001111010,
    10100111100, 10010111100, 10010011110, 10111100100, 10011110100,
    10011110010, 11110100100, 11110010100, 11110010010, 11011011110,
    11011110110, 11110110110, 10101111000, 10100011110, 10001011110,
    10111101000, 10111100010, 11110101000, 11110100010, 10111011110,
    10111101110, 11101011110, 11110101110, 11010000100, 11010010000,
    11010011100, 1100011101011
];

const START_B = 104;
const STOP = 106;
const MODULO = 103;

/** Le texte est-il encodable en Code 128B ? (ASCII 32-126) */
export function isValidCode128B(text) {
    const value = String(text == null ? '' : text);
    if (!value.length) return false;
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if (code < 32 || code > 126) return false;
    }
    return true;
}

/** Valeurs Code 128B, checksum inclus (sans STOP). */
export function code128BValues(text) {
    const value = String(text == null ? '' : text);
    if (!isValidCode128B(value)) {
        throw new Error('Code 128B : caractere non encodable.');
    }
    const values = [START_B];
    for (let i = 0; i < value.length; i++) {
        values.push(value.charCodeAt(i) - 32);
    }
    let sum = START_B;
    for (let i = 1; i < values.length; i++) {
        sum += values[i] * (i);
    }
    values.push(sum % MODULO);
    return values;
}

/**
 * Construit le SVG du code-barres.
 * @param {string} text
 * @param {{moduleWidth?:number, height?:number, margin?:number, showText?:boolean}} [options]
 * @returns {string} SVG autonome
 */
export function buildCode128Svg(text, options = {}) {
    const moduleWidth = Number(options.moduleWidth) > 0 ? Number(options.moduleWidth) : 1.5;
    const height = Number(options.height) > 0 ? Number(options.height) : 50;
    const margin = Number(options.margin) >= 0 ? Number(options.margin) : 10;
    const showText = options.showText !== false;

    const values = code128BValues(text).concat([STOP]);
    let modules = '';
    for (const v of values) modules += String(BARS[v]);

    const textHeight = showText ? 18 : 0;
    const width = moduleWidth * modules.length + margin * 2;
    const totalHeight = height + textHeight + margin;

    let rects = '';
    let x = 0;
    while (x < modules.length) {
        if (modules[x] === '1') {
            let run = 1;
            while (x + run < modules.length && modules[x + run] === '1') run++;
            rects += `<rect x="${(margin + x * moduleWidth).toFixed(2)}" y="${margin}" width="${(run * moduleWidth).toFixed(2)}" height="${height}" />`;
            x += run;
        } else {
            x++;
        }
    }

    const label = showText
        ? `<text x="${(width / 2).toFixed(2)}" y="${(margin + height + 14).toFixed(2)}" text-anchor="middle" font-family="monospace" font-size="13">${escapeXml(String(text))}</text>`
        : '';

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width.toFixed(2)} ${totalHeight.toFixed(2)}" width="${width.toFixed(2)}" height="${totalHeight.toFixed(2)}" role="img" aria-label="Code-barres ${escapeXml(String(text))}" fill="#000">${rects}${label}</svg>`;
}

function escapeXml(value) {
    return value.replace(/[<>&"']/g, ch => ({
        '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;'
    })[ch]);
}
