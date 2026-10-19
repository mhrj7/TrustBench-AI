// Whether the 3D scenes should run in their light form: the person asked for reduced motion, or the browser has no
// graphics processor and draws WebGL in software (SwiftShader, llvmpipe and the like), where a full scene takes seconds
// per frame and freezes the page. The light form is the same as under reduced motion: still scenes and the journey as a
// plain list. Kept apart from lib/gpu.ts so the page does not pull the 3D libraries into the main bundle.
import { useReducedMotion } from 'motion/react';

export const SOFTWARE_GL: boolean = (() => {
  if (typeof document === 'undefined') return false;
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl');
    if (!gl) return true;
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /swiftshader|llvmpipe|softpipe|software|basic render/i.test(renderer);
  } catch {
    return false;
  }
})();

export function useLite3D() {
  return !!useReducedMotion() || SOFTWARE_GL;
}
