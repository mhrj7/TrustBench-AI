// 3D model files bundled with the site. A model is optional until its file is added to src/assets: the glob resolves to
// nothing when the file is absent, so the scenes that need it simply do not render (and no request ever fails).
const found = import.meta.glob('../assets/astronaut.glb', { query: '?url', import: 'default', eager: true }) as Record<string, string>;
const waving = import.meta.glob('../assets/astronaut-wave.glb', { query: '?url', import: 'default', eager: true }) as Record<string, string>;

/** The astronaut: "Astronaut" by Poly (Google), CC BY 2.0, as shipped in google/model-viewer (packages/shared-assets). */
export const ASTRONAUT_URL: string | null = Object.values(found)[0] ?? null;
export const ASTRONAUT_CREDIT = { title: 'Astronaut', author: 'Poly by Google', license: 'CC BY 2.0',
  url: 'https://github.com/google/model-viewer/blob/master/packages/shared-assets/ATTRIBUTIONS.md' };

/** Optional: a rigged astronaut that waves ("Animated Astronaut in Space Suit Loop" by LasquetiSpice on Sketchfab, CC BY 4.0).
 *  When its file is in src/assets, the ending uses it and plays its own wave; otherwise the model above rocks a hello. */
export const WAVE_URL: string | null = Object.values(waving)[0] ?? null;
export const WAVE_CREDIT = { title: 'Animated Astronaut in Space Suit Loop', author: 'LasquetiSpice', license: 'CC BY 4.0',
  url: 'https://sketchfab.com/3d-models/animated-astronaut-in-space-suit-loop-137d62cd820a4a6eba75304a11fb6f81' };
