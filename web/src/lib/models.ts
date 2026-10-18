// 3D model files bundled with the site. A model is optional until its file is added to src/assets: the glob resolves to
// nothing when the file is absent, so the scenes that need it simply do not render (and no request ever fails).
const found = import.meta.glob('../assets/astronaut.glb', { query: '?url', import: 'default', eager: true }) as Record<string, string>;

/** The astronaut: "Astronaut" by Poly (Google), CC BY 2.0, as shipped in google/model-viewer (packages/shared-assets). */
export const ASTRONAUT_URL: string | null = Object.values(found)[0] ?? null;
export const ASTRONAUT_CREDIT = { title: 'Astronaut', author: 'Poly by Google', license: 'CC BY 2.0',
  url: 'https://github.com/google/model-viewer/blob/master/packages/shared-assets/ATTRIBUTIONS.md' };
