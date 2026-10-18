// 3D model files bundled with the site. A model is optional until its file is added to src/assets: the glob resolves to
// nothing when the file is absent, so the scenes that need it simply do not render (and no request ever fails).
const found = import.meta.glob('../assets/astronaut.glb', { query: '?url', import: 'default', eager: true }) as Record<string, string>;

/** The astronaut: "Animated Floating Astronaut in Space Suit Loop" by LasquetiSpice on Sketchfab, CC BY 4.0. */
export const ASTRONAUT_URL: string | null = Object.values(found)[0] ?? null;
export const ASTRONAUT_CREDIT = { title: 'Animated Floating Astronaut in Space Suit Loop', author: 'LasquetiSpice', license: 'CC BY 4.0',
  url: 'https://sketchfab.com/3d-models/animated-floating-astronaut-in-space-suit-loop-e2c4b146e58141e4b87917456a9970b1' };
