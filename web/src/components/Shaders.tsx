// Shader surfaces from two libraries:
//  - ShaderGradient (@shadergradient/react, MIT, github.com/ruucm/shadergradient): the moving nebula behind the journey.
//  - Paper Shaders (@paper-design/shaders-react, Apache-2.0, github.com/paper-design/shaders): the liquid-metal frame of the
//    device. (The liquid-logo demo app is under a non-compete licence, so only the Apache-licensed shader library is used.)
import { ShaderGradient, ShaderGradientCanvas } from '@shadergradient/react';
import { LiquidMetal } from '@paper-design/shaders-react';

/** Deep space: a slow, grainy gradient of guard blue, violet and near-black. Lights are generated (no HDR download). */
export function SpaceGradient() {
  return (
    <ShaderGradientCanvas className="space-gradient" pixelDensity={1} fov={45} pointerEvents="none" lazyLoad={false} style={{ position: 'absolute', inset: 0 }}>
      <ShaderGradient control="props" type="sphere" animate="on" uTime={0} uSpeed={0.08} uStrength={0.35} uDensity={0.9} uFrequency={5.5} uAmplitude={2.4}
        positionX={-0.2} positionY={0} positionZ={0} rotationX={0} rotationY={130} rotationZ={70}
        color1="#05061a" color2="#2433ff" color3="#3b0d57" reflection={0.1} cAzimuthAngle={180} cPolarAngle={90} cDistance={3.4} cameraZoom={9}
        lightType="3d" brightness={0.55} grain="on" grainBlending={0.4} />
    </ShaderGradientCanvas>
  );
}

/** The device frame: brushed liquid metal, as in the Paper Shaders "Backdrop" preset, filling the frame behind the screen. */
export function DeviceMetal() {
  return (
    <LiquidMetal className="device-metal" colorBack="#9a9ca6" colorTint="#ffffff" speed={0.6} repetition={1.5} softness={0.05} shiftRed={0.3} shiftBlue={0.3}
      distortion={0.1} contour={0.4} angle={70} shape="none" scale={1} style={{ position: 'absolute', inset: 0 }} />
  );
}
