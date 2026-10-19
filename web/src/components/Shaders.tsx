// Shader surfaces from two libraries:
//  - ShaderGradient (@shadergradient/react, MIT, github.com/ruucm/shadergradient): the moving nebula behind the journey.
//  - Paper Shaders (@paper-design/shaders-react, Apache-2.0, github.com/paper-design/shaders): the liquid-metal frame of the
//    device. (The liquid-logo demo app is under a non-compete licence, so only the Apache-licensed shader library is used.)
import { ShaderGradient, ShaderGradientCanvas } from '@shadergradient/react';
import { LiquidMetal } from '@paper-design/shaders-react';

/** Deep space: ShaderGradient's own "Universe" preset (violet, rose and black on a moving water plane), its 3D lights only, so
 *  nothing is downloaded. */
export function SpaceGradient() {
  return (
    <ShaderGradientCanvas className="space-gradient" pixelDensity={1} fov={45} pointerEvents="none" lazyLoad={false} style={{ position: 'absolute', inset: 0 }}>
      <ShaderGradient control="props" type="waterPlane" animate="on" uTime={0.2} uSpeed={0.1} uStrength={2.4} uDensity={1.1} uFrequency={5.5} uAmplitude={0}
        positionX={-0.5} positionY={0.1} positionZ={0} rotationX={0} rotationY={0} rotationZ={235}
        color1="#5606ff" color2="#fe8989" color3="#000000" reflection={0.1} cAzimuthAngle={180} cPolarAngle={115} cDistance={3.9} cameraZoom={1}
        lightType="3d" brightness={1.1} grain="off" />
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
