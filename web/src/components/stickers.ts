// Die-cut sticker art for the ending scene, drawn here as SVG (our own artwork, in the site's palette): each sticker is a
// TrustBench idea (the guard's shield, a lock, a check, a bug, a hidden trick, a key, a star, a bolt, a document, a smiling
// helper). A thick white outline and a soft drop shadow make them read as stickers on a dark sky.
const INK = '#0d0e13', BLUE = '#2433ff', RED = '#ef3b24', YELLOW = '#ffd23f', PINK = '#ff7ac6', GREEN = '#2fd47a', WHITE = '#ffffff';

const wrap = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><defs><filter id="s" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="6" stdDeviation="6" flood-opacity="0.35"/></filter></defs><g filter="url(#s)" stroke-linejoin="round" stroke-linecap="round">${body}</g></svg>`;

// Each sticker draws its shape twice: first fat and white (the die-cut edge), then in colour with an ink outline.
const die = (shape: (fill: string, stroke: string, w: number) => string, fill: string) => wrap(shape(WHITE, WHITE, 34) + shape(fill, INK, 8));

const star = (cx: number, cy: number, R: number, r: number, n = 5) => {
  const pts: string[] = [];
  for (let i = 0; i < n * 2; i++) { const a = (Math.PI / n) * i - Math.PI / 2, rr = i % 2 ? r : R; pts.push(`${(cx + Math.cos(a) * rr).toFixed(1)},${(cy + Math.sin(a) * rr).toFixed(1)}`); }
  return pts.join(' ');
};

export const STICKERS: Record<string, string> = {
  shield: die((f, s, w) => `<path d="M128 30 L212 62 V124 C212 176 176 210 128 228 C80 210 44 176 44 124 V62 Z" fill="${f}" stroke="${s}" stroke-width="${w}"/>`
    , BLUE).replace('</g></svg>', `<path d="M92 128 L118 154 L166 100" fill="none" stroke="${WHITE}" stroke-width="16"/></g></svg>`),
  lock: die((f, s, w) => `<path d="M84 112 V86 a44 44 0 0 1 88 0 V112" fill="none" stroke="${s === WHITE ? WHITE : INK}" stroke-width="${w + 14}"/><rect x="56" y="108" width="144" height="116" rx="22" fill="${f}" stroke="${s}" stroke-width="${w}"/>`, YELLOW)
    .replace('</g></svg>', `<circle cx="128" cy="158" r="14" fill="${INK}"/><rect x="122" y="160" width="12" height="32" rx="6" fill="${INK}"/></g></svg>`),
  check: die((f, s, w) => `<circle cx="128" cy="128" r="92" fill="${f}" stroke="${s}" stroke-width="${w}"/>`, GREEN)
    .replace('</g></svg>', `<path d="M84 130 L116 162 L176 98" fill="none" stroke="${INK}" stroke-width="20"/></g></svg>`),
  bug: die((f, s, w) => `<ellipse cx="128" cy="140" rx="62" ry="78" fill="${f}" stroke="${s}" stroke-width="${w}"/><circle cx="128" cy="62" r="30" fill="${f}" stroke="${s}" stroke-width="${w}"/>`, RED)
    .replace('</g></svg>', `<path d="M128 70 V214 M66 120 L36 104 M66 160 L32 160 M70 196 L42 214 M190 120 L220 104 M190 160 L224 160 M186 196 L214 214" stroke="${INK}" stroke-width="10"/><circle cx="104" cy="122" r="10" fill="${INK}"/><circle cx="152" cy="168" r="10" fill="${INK}"/></g></svg>`),
  trick: die((f, s, w) => `<path d="M128 26 L234 214 H22 Z" fill="${f}" stroke="${s}" stroke-width="${w}"/>`, RED)
    .replace('</g></svg>', `<rect x="118" y="92" width="20" height="70" rx="10" fill="${WHITE}"/><circle cx="128" cy="188" r="12" fill="${WHITE}"/></g></svg>`),
  key: die((f, s, w) => `<circle cx="86" cy="128" r="50" fill="${f}" stroke="${s}" stroke-width="${w}"/><path d="M130 128 H226 V162 H200 V146 H180 V162 H156 V146 H130 Z" fill="${f}" stroke="${s}" stroke-width="${w}"/>`, YELLOW)
    .replace('</g></svg>', `<circle cx="80" cy="128" r="16" fill="${INK}"/></g></svg>`),
  star: die((f, s, w) => `<polygon points="${star(128, 134, 104, 46)}" fill="${f}" stroke="${s}" stroke-width="${w}"/>`, YELLOW),
  starBlue: die((f, s, w) => `<polygon points="${star(128, 134, 100, 48, 4)}" fill="${f}" stroke="${s}" stroke-width="${w}"/>`, BLUE),
  bolt: die((f, s, w) => `<path d="M148 20 L58 146 H120 L100 236 L198 102 H134 Z" fill="${f}" stroke="${s}" stroke-width="${w}"/>`, YELLOW),
  doc: die((f, s, w) => `<path d="M62 28 H160 L198 66 V228 H62 Z" fill="${f}" stroke="${s}" stroke-width="${w}"/>`, WHITE)
    .replace('</g></svg>', `<path d="M88 100 H172 M88 132 H172 M88 164 H140" stroke="${INK}" stroke-width="10"/><rect x="84" y="182" width="92" height="22" rx="6" fill="${RED}"/></g></svg>`),
  helper: die((f, s, w) => `<rect x="40" y="52" width="176" height="152" rx="52" fill="${f}" stroke="${s}" stroke-width="${w}"/>`, PINK)
    .replace('</g></svg>', `<rect x="90" y="98" width="18" height="34" rx="9" fill="${INK}"/><rect x="148" y="98" width="18" height="34" rx="9" fill="${INK}"/><path d="M98 160 Q128 186 158 160" fill="none" stroke="${INK}" stroke-width="10"/></g></svg>`),
  eye: die((f, s, w) => `<path d="M20 128 Q128 30 236 128 Q128 226 20 128 Z" fill="${f}" stroke="${s}" stroke-width="${w}"/>`, WHITE)
    .replace('</g></svg>', `<circle cx="128" cy="128" r="40" fill="${BLUE}" stroke="${INK}" stroke-width="8"/><circle cx="128" cy="128" r="16" fill="${INK}"/></g></svg>`),
};
