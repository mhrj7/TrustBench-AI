// 3D model files bundled with the site, all from Sketchfab under CC BY 4.0 and credited on the page and in
// THIRD_PARTY_NOTICES.md. Each is a web copy made with glTF Transform `optimize` (textures resized and re-encoded as WebP,
// geometry and animation meshopt-compressed); the downloaded originals are kept outside the repository. A model is
// optional until its file is in src/assets: the glob resolves to nothing when the file is absent, so the scenes that need
// it simply do not render (and no request ever fails).
const glob = {
  astronaut: import.meta.glob('../assets/astronaut-wave.glb', { query: '?url', import: 'default', eager: true }),
  ipad: import.meta.glob('../assets/ipad.glb', { query: '?url', import: 'default', eager: true }),
  imac: import.meta.glob('../assets/imac.glb', { query: '?url', import: 'default', eager: true }),
  earth: import.meta.glob('../assets/earth.glb', { query: '?url', import: 'default', eager: true }),
} as Record<string, Record<string, string>>;
const url = (k: string): string | null => Object.values(glob[k])[0] ?? null;

export type Credit = { title: string; author: string; license: string; url: string };

/** A rigged astronaut with its own floating and waving loop: the journey's traveller and the one that lands and waves. */
export const ASTRONAUT_URL = url('astronaut');
export const ASTRONAUT_CREDIT: Credit = { title: 'Animated Astronaut in Space Suit Loop', author: 'LasquetiSpice', license: 'CC BY 4.0',
  url: 'https://sketchfab.com/3d-models/animated-astronaut-in-space-suit-loop-137d62cd820a4a6eba75304a11fb6f81' };

/** The tablet the journey starts in. */
export const IPAD_URL = url('ipad');
export const IPAD_CREDIT: Credit = { title: 'iPad Pro Space Gray with M2 Chipset', author: 'CitrixStorm2222', license: 'CC BY 4.0',
  url: 'https://sketchfab.com/3d-models/ipad-pro-space-gray-with-m2-chipset-free-2e36ce5957474eaa9b51d173e9a81087' };

/** The desktop screen the astronaut breaks out of. */
export const IMAC_URL = url('imac');
export const IMAC_CREDIT: Credit = { title: 'iMac 2021', author: 'DatSketch', license: 'CC BY 4.0',
  url: 'https://sketchfab.com/3d-models/imac-2021-304cb06ffb554883a7a642b2b56754c1' };

/** The planet under the astronaut at the start. */
export const EARTH_URL = url('earth');
export const EARTH_CREDIT: Credit = { title: 'Earth', author: 'airstudios3d', license: 'CC BY 4.0',
  url: 'https://sketchfab.com/3d-models/earth-5f9c35be31a047928eace8b415a8ee3a' };

export const JOURNEY_READY = !!(ASTRONAUT_URL && IPAD_URL && IMAC_URL && EARTH_URL);
export const JOURNEY_CREDITS: Credit[] = [ASTRONAUT_CREDIT, IPAD_CREDIT, IMAC_CREDIT, EARTH_CREDIT];

// The How it works stations (components/SystemModel.tsx), Sketchfab, CC BY 4.0.
const howGlob = import.meta.glob('../assets/how/*.glb', { query: '?url', import: 'default', eager: true }) as Record<string, string>;
const howUrl = (name: string) => howGlob[`../assets/how/${name}.glb`] ?? null;
export const HOW_MODELS = {
  robot: { url: howUrl('robot'), credit: { title: 'Humanoid Robot Face', author: 'kito1704', license: 'CC BY 4.0', url: 'https://sketchfab.com/3d-models/humanoid-robot-face-1532b74a76dc43d18a4fc2c5ba1f2229' } },
  detector: { url: howUrl('detector'), credit: { title: 'Metal detector (entrance)', author: 'menX1151', license: 'CC BY 4.0', url: 'https://sketchfab.com/3d-models/metal-detector-entrance-e05f5f48b3eb4fa88fc5c7548a3a324a' } },
  turnstile: { url: howUrl('turnstile'), credit: { title: 'Subway Turnstile', author: 'gunnarcorrea', license: 'CC BY 4.0', url: 'https://sketchfab.com/3d-models/subway-turnstile-eed7f05ffcff4251a3f1cbef98342093' } },
  rack: { url: howUrl('rack'), credit: { title: 'Server Rack', author: 'Spellkaze', license: 'CC BY 4.0', url: 'https://sketchfab.com/3d-models/server-rack-62f6779cb7e448b19aaf58544c3c7218' } },
  assembly: { url: howUrl('assembly'), credit: { title: 'Sci-fi Assembly Line', author: 'meeww', license: 'CC BY 4.0', url: 'https://sketchfab.com/3d-models/sci-fi-assembly-line-d30366ad73af49f6b7279923fe89faee' } },
  server: { url: howUrl('server'), credit: { title: 'Server V2 + console', author: 'FlevasGR', license: 'CC BY 4.0', url: 'https://sketchfab.com/3d-models/server-v2-console-f24594ece9634cec9c1210c041838371' } },
} satisfies Record<string, { url: string | null; credit: Credit }>;
export type HowModelUrls = { [K in keyof typeof HOW_MODELS]: string };
export const HOW_READY = Object.values(HOW_MODELS).every((m) => m.url);
