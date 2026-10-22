import { useRef, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { Drive } from './Scene'

/**
 * Outer decorative rings — the large dark circle with sparse ticks visible
 * at the very edge of the reference image, plus two slowly counter-rotating
 * arc segments that give the whole thing a sense of mechanical depth.
 */

const vert = /* glsl */ `varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`

// ── Outer ring + sparse ticks ─────────────────────────────────────────────────
const fragOuter = /* glsl */ `
  uniform vec3  uColor;
  uniform float uTime;
  uniform float uLevel;
  uniform float uOpen;
  uniform float uZoom;
  uniform float uIntensity;
  varying vec2 vUv;
  #define TAU 6.28318
  float band(float r,float r0,float w){return exp(-pow((r-r0)/w,2.));}
  void main(){
    vec2 p=(vUv*2.-1.)*uZoom; float r=length(p); float a=atan(p.y,p.x);
    // Main outer ring
    float ring=band(r,1.38,.005)*(0.30+uLevel*.12);
    // Sparse major ticks every 15 deg (24 ticks)
    float maj=smoothstep(.022,.005,abs(fract(a/TAU*24.))*TAU/24.*r);
    ring+=maj*band(r,1.375,.022)*(0.40+uLevel*.15);
    // Label blocks — two short wide segments at top/bottom
    float lblSeg=smoothstep(.09,.03,abs(fract(a/TAU*2.+.25)-.5)-.28);
    ring+=lblSeg*band(r,1.38,.012)*(0.18+uLevel*.1);
    // Very faint fill between outer rings
    ring+=band(r,1.36,.10)*.018;
    ring*=smoothstep(0.,.55,uOpen-r*.40)*uIntensity;
    gl_FragColor=vec4(uColor*ring,ring);
  }
`

// ── Slowly rotating inner arc band (3 arcs, co-rotating) ─────────────────────
const fragArcA = /* glsl */ `
  uniform vec3  uColor;
  uniform float uTime;
  uniform float uLevel;
  uniform float uOpen;
  uniform float uZoom;
  uniform float uIntensity;
  varying vec2 vUv;
  #define TAU 6.28318
  float band(float r,float r0,float w){return exp(-pow((r-r0)/w,2.));}
  void main(){
    vec2 p=(vUv*2.-1.)*uZoom; float r=length(p);
    float a=atan(p.y,p.x)+uTime*.08;
    // Three arcs, each ~80 deg wide, separated by 40 deg gaps
    float arcMask=smoothstep(.06,.02,abs(fract(a/TAU*3.)-.5)-.22);
    float ring=band(r,1.30,.006)*arcMask*(0.35+uLevel*.2);
    // Bright leading edge on each arc
    float lead=smoothstep(.04,.001,abs(fract(a/TAU*3.)-.5)-.28)
              *smoothstep(.034,.0,abs(fract(a/TAU*3.)-.5)-.28);
    ring+=lead*band(r,1.30,.012)*(0.7+uLevel*.4);
    ring*=smoothstep(0.,.55,uOpen-r*.40)*uIntensity;
    gl_FragColor=vec4(uColor*ring,ring);
  }
`

// ── Counter-rotating arc band (4 shorter arcs) ────────────────────────────────
const fragArcB = /* glsl */ `
  uniform vec3  uColor;
  uniform float uTime;
  uniform float uLevel;
  uniform float uOpen;
  uniform float uZoom;
  uniform float uIntensity;
  varying vec2 vUv;
  #define TAU 6.28318
  float band(float r,float r0,float w){return exp(-pow((r-r0)/w,2.));}
  void main(){
    vec2 p=(vUv*2.-1.)*uZoom; float r=length(p);
    float a=atan(p.y,p.x)-uTime*.055;
    // Four shorter arcs (50 deg each)
    float arcMask=smoothstep(.05,.015,abs(fract(a/TAU*4.)-.5)-.25);
    float ring=band(r,1.46,.005)*arcMask*(0.22+uLevel*.15);
    // Thin continuous underline
    ring+=band(r,1.46,.003)*0.10;
    ring*=smoothstep(0.,.58,uOpen-r*.38)*uIntensity;
    gl_FragColor=vec4(uColor*ring,ring);
  }
`

export function OuterRings({ drive }: { drive: Drive }) {
  const refs = [
    useRef<THREE.ShaderMaterial>(null),
    useRef<THREE.ShaderMaterial>(null),
    useRef<THREE.ShaderMaterial>(null),
  ]
  const col = useMemo(() => new THREE.Color('#19c4c4'), [])

  const uniforms = useMemo(() =>
    [fragOuter, fragArcA, fragArcB].map(() => ({
      uColor:     { value: new THREE.Color('#19c4c4') },
      uTime:      { value: 0 },
      uLevel:     { value: 0 },
      uOpen:      { value: 0 },
      uZoom:      { value: 1.0 },
      uIntensity: { value: 1 },
    })), [])

  useFrame((state, dt) => {
    const r = drive.reactor
    col.lerp(r.color, Math.min(1, dt * 2.5))
    for (const u of uniforms) {
      u.uTime.value = state.clock.elapsedTime
      u.uLevel.value += (drive.level - u.uLevel.value) * Math.min(1, dt * 8)
      u.uOpen.value += (drive.open - u.uOpen.value) * Math.min(1, dt * 1.6)
      u.uIntensity.value = r.intensity
      ;(u.uColor.value as THREE.Color).lerp(col, Math.min(1, dt * 2.5))
    }
  })

  return (
    <group>
      {[fragOuter, fragArcA, fragArcB].map((frag, i) => (
        <mesh key={i} frustumCulled={false}>
          <planeGeometry args={[5.4, 5.4]} />
          <shaderMaterial
            ref={refs[i]}
            uniforms={uniforms[i]}
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
