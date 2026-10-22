import { useRef, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { Drive } from './Scene'

/**
 * The instrument ring stack.
 *
 * Five rings from inside out, each on its own fullscreen quad:
 *
 *   A  r=0.68  Thin dashed arc + tick marks every 30°          (teal)
 *   B  r=0.80  Dot-matrix ring — 64 dots, wave-pulsed          (bright teal)
 *   C  r=0.92  Segmented arcs + 4 red cardinal-point accents   (teal + red)
 *   D  r=1.04  Fine tick graduation — 120 ticks, 20 major      (dim teal)
 *   E  r=1.16  Outermost thin halo                             (very dim)
 *
 * All rings share the same field-coordinate space as ReactorCore, so radii
 * and the uZoom uniform must match. Zoom is fixed at 1.0 here (the rings are
 * large enough to not need the core's viewport correction).
 */

const vert = /* glsl */ `
  varying vec2 vUv;
  void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}
`

// ── Ring A ────────────────────────────────────────────────────────────────────
const fragA = /* glsl */ `
  uniform vec3  uColor;
  uniform float uTime;
  uniform float uLevel;
  uniform float uOpen;
  uniform float uIntensity;
  varying vec2 vUv;
  #define TAU 6.28318
  float band(float r,float r0,float w){return exp(-pow((r-r0)/w,2.));}
  void main(){
    vec2 p=vUv*2.-1.; float r=length(p); float a=atan(p.y,p.x);
    // Dashed ring (24 dashes)
    float dash=smoothstep(.12,.03,abs(fract(a/TAU*24.)-.5)-.18);
    float ring=band(r,.68,.007)*dash*(0.50+uLevel*.30);
    // Tick marks every 30 deg
    float tick=smoothstep(.025,.005,abs(fract(a/TAU*12.))*TAU/12.*r);
    ring+=tick*band(r,.675,.018)*(0.60+uLevel*.20);
    ring*=smoothstep(0.,.45,uOpen-r*.45)*uIntensity;
    gl_FragColor=vec4(uColor*ring,ring);
  }
`

// ── Ring B: dot matrix ────────────────────────────────────────────────────────
const fragB = /* glsl */ `
  uniform vec3  uColor;
  uniform float uTime;
  uniform float uLevel;
  uniform float uOpen;
  uniform float uIntensity;
  varying vec2 vUv;
  #define TAU 6.28318
  float band(float r,float r0,float w){return exp(-pow((r-r0)/w,2.));}
  void main(){
    vec2 p=vUv*2.-1.; float r=length(p); float a=atan(p.y,p.x);
    // 64 dots
    float dotPhase=fract(a/TAU*64.);
    float dotR=smoothstep(.14,.04,abs(dotPhase-.5));
    float ring=band(r,.80,.014)*dotR;
    // Travelling brightness wave
    float wave=sin(a*8.-uTime*2.)*.5+.5;
    ring*=(0.55+wave*uLevel*.60+uLevel*.30);
    ring*=smoothstep(0.,.45,uOpen-r*.45)*uIntensity;
    vec3 col=mix(uColor,vec3(.55,1.,1.),wave*uLevel*.5);
    gl_FragColor=vec4(col*ring,ring);
  }
`

// ── Ring C: segmented + red accents ──────────────────────────────────────────
const fragC = /* glsl */ `
  uniform vec3  uColor;
  uniform float uTime;
  uniform float uLevel;
  uniform float uOpen;
  uniform float uIntensity;
  varying vec2 vUv;
  #define TAU 6.28318
  float band(float r,float r0,float w){return exp(-pow((r-r0)/w,2.));}
  void main(){
    vec2 p=vUv*2.-1.; float r=length(p); float a=atan(p.y,p.x);
    // 8 segments
    float seg=smoothstep(.06,.02,abs(fract(a/TAU*8.)-.5)-.28);
    float ring=band(r,.92,.010)*seg*(0.45+uLevel*.30);
    // Red accent ticks at 4 cardinal points
    float redTick=smoothstep(.020,.004,abs(fract(a/TAU*4.)*TAU/4.*r));
    float redBand=band(r,.915,.022)*redTick;
    // Radar sweep
    float sweepA=mod(uTime*.40,TAU);
    float dA=mod(a-sweepA+TAU+3.14159,TAU)-3.14159;
    float wake=smoothstep(-1.8,-.10,dA)*(1.-smoothstep(0.,.18,dA));
    ring+=wake*band(r,.92,.018)*(0.40+uLevel*.40);
    ring*=smoothstep(0.,.45,uOpen-r*.45)*uIntensity;
    vec4 base=vec4(uColor*ring,ring);
    float rb=redBand*uIntensity;
    vec4 red=vec4(vec3(.9,.15,.10)*rb,rb);
    gl_FragColor=base+red;
  }
`

// ── Ring D: fine tick graduation ──────────────────────────────────────────────
const fragD = /* glsl */ `
  uniform vec3  uColor;
  uniform float uTime;
  uniform float uLevel;
  uniform float uOpen;
  uniform float uIntensity;
  varying vec2 vUv;
  #define TAU 6.28318
  float band(float r,float r0,float w){return exp(-pow((r-r0)/w,2.));}
  void main(){
    vec2 p=vUv*2.-1.; float r=length(p); float a=atan(p.y,p.x);
    // 120 fine ticks
    float fine=smoothstep(.018,.004,abs(fract(a/TAU*120.))*TAU/120.*r);
    // 20 major ticks (every 18 deg)
    float major=smoothstep(.025,.006,abs(fract(a/TAU*20.))*TAU/20.*r);
    float ring=( band(r,1.04,.022)*fine*.28
               + band(r,1.04,.030)*major*.48
               )*(0.35+uLevel*.20);
    // Thin continuous ring
    ring+=band(r,1.045,.004)*0.22;
    ring*=smoothstep(0.,.50,uOpen-r*.43)*uIntensity;
    gl_FragColor=vec4(uColor*ring,ring);
  }
`

// ── Ring E: outer halo ────────────────────────────────────────────────────────
const fragE = /* glsl */ `
  uniform vec3  uColor;
  uniform float uTime;
  uniform float uLevel;
  uniform float uOpen;
  uniform float uIntensity;
  varying vec2 vUv;
  #define TAU 6.28318
  float band(float r,float r0,float w){return exp(-pow((r-r0)/w,2.));}
  void main(){
    vec2 p=vUv*2.-1.; float r=length(p); float a=atan(p.y,p.x);
    float wob=sin(a*16.+uTime*.15)*.006;
    float ring=band(r,1.16+wob,.006)*(0.20+uLevel*.14);
    ring+=band(r,1.22,.004)*0.11;
    ring*=smoothstep(0.,.50,uOpen-r*.42)*uIntensity;
    gl_FragColor=vec4(uColor*ring,ring);
  }
`

const FRAGS = [fragA, fragB, fragC, fragD, fragE]

export function InstrumentRings({ drive }: { drive: Drive }) {
  // Five refs — one per ring
  const refs = Array.from({ length: 5 }, () => useRef<THREE.ShaderMaterial>(null))
  const col  = useMemo(() => new THREE.Color('#19c4c4'), [])

  const allUniforms = useMemo(() =>
    FRAGS.map(() => ({
      uColor:     { value: new THREE.Color('#19c4c4') },
      uTime:      { value: 0 },
      uLevel:     { value: 0 },
      uOpen:      { value: 0 },
      uIntensity: { value: 1 },
    })), [])

  useFrame((state, dt) => {
    const r = drive.reactor
    col.lerp(r.color, Math.min(1, dt * 2.5))
    for (const u of allUniforms) {
      u.uTime.value = state.clock.elapsedTime
      u.uLevel.value += (drive.level - u.uLevel.value) * Math.min(1, dt * 8)
      u.uOpen.value  += (drive.open  - u.uOpen.value)  * Math.min(1, dt * 1.6)
      u.uIntensity.value = r.intensity
      ;(u.uColor.value as THREE.Color).lerp(col, Math.min(1, dt * 2.5))
    }
  })

  return (
    <group>
      {FRAGS.map((frag, i) => (
        <mesh key={i} frustumCulled={false}>
          <planeGeometry args={[5.4, 5.4]} />
          <shaderMaterial
            ref={refs[i]}
            uniforms={allUniforms[i]}
            vertexShader={vert}
            fragmentShader={frag}
            transparent
            blending={THREE.AdditiveBlending}
            depthWrite={false}
          />
        </mesh>
      ))}
    </group>
  )
}
