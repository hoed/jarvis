import { useRef, useMemo } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import type { Drive } from './Scene'

/**
 * Central reactor — the glowing teal orb from the reference image.
 *
 * Layers (inside out):
 *   • Bright teal nucleus glow + inner rim
 *   • Hex-grid membrane (the subtle geometric pattern inside the first ring)
 *   • Two bright concentric rings at r≈0.42 and r≈0.52
 *   • Amber/white hot-spot at ~11 o'clock (matches the orange detail in image)
 *   • Radar sweep on the inner ring
 */

const vert = /* glsl */ `
  varying vec2 vUv;
  void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}
`

const frag = /* glsl */ `
  uniform vec3  uColor;
  uniform vec3  uHot;
  uniform float uLevel;
  uniform float uTime;
  uniform float uOpen;
  uniform float uZoom;
  uniform float uIntensity;
  varying vec2 vUv;

  vec2 hash2(vec2 p){p=vec2(dot(p,vec2(127.1,311.7)),dot(p,vec2(269.5,183.3)));return-1.+2.*fract(sin(p)*43758.5453);}
  float noise(vec2 p){vec2 i=floor(p),f=fract(p),u=f*f*(3.-2.*f);return mix(mix(dot(hash2(i),f),dot(hash2(i+vec2(1,0)),f-vec2(1,0)),u.x),mix(dot(hash2(i+vec2(0,1)),f-vec2(0,1)),dot(hash2(i+vec2(1,1)),f-vec2(1,1)),u.x),u.y);}
  float fbm(vec2 p){float v=0.,a=.5;for(int i=0;i<4;i++){v+=a*noise(p);p*=2.02;a*=.5;}return v;}
  float band(float r,float r0,float w){return exp(-pow((r-r0)/w,2.));}

  // Hex grid — returns 0 at cell edge, 1 at cell centre
  float hex(vec2 p){
    vec2 q=vec2(p.x*1.1547,p.y+p.x*.5774);
    vec2 pf=fract(q)-.5;
    float v=max(abs(pf.x)*.866+pf.y*.5,abs(pf.y));
    return v;
  }

  #define TAU 6.28318

  void main(){
    vec2 p=(vUv*2.-1.)*uZoom;
    float r=length(p);
    float a=atan(p.y,p.x);

    // ---- nucleus ----
    float core=exp(-r*3.2)*(0.55+uLevel*.55);
    float coreRim=band(r,.20,.035)*(0.65+uLevel*.45);

    // ---- hex membrane (inside the first bright ring) ----
    float h=hex(p*9.)*.5+.5;
    float hexGrid=smoothstep(.44,.40,h)*smoothstep(.38,.43,r)*.22;

    // ---- rings ----
    float wob=fbm(vec2(a*3.+uTime*.3,r*4.))*0.010;
    float ring1=band(r,.42+wob,.009)*(0.95+uLevel*.5);
    float ring2=band(r,.53,.007)*(0.55+uLevel*.25);
    float ring3=band(r,.62,.005)*0.35;

    // ---- amber hot-spot at ~11 o'clock ----
    vec2 hotDir=normalize(vec2(-.42,.62));
    float hot=exp(-pow(dot(normalize(p),hotDir)-.82,2.)*16.)
             *exp(-r*4.2)*(0.55+uLevel*.75);

    // ---- radar sweep on ring 1 ----
    float sweepA=mod(uTime*.55,TAU);
    float dA=mod(a-sweepA+TAU+3.14159,TAU)-3.14159;
    float wake=smoothstep(-2.0,-.12,dA)*(1.-smoothstep(0.,.20,dA));
    float sweep=wake*band(r,.42,.045)*(0.65+uLevel*.5);

    // ---- combine ----
    float v=(core+coreRim+hexGrid+ring1+ring2+ring3+sweep+hot*.65)*uIntensity;
    v*=smoothstep(0.,.40,uOpen-r*.5);

    vec3 col=mix(uColor,uHot,clamp(hot*1.3+sweep*.45,0.,1.));
    gl_FragColor=vec4(col*v,v);
  }
`

export function ReactorCore({ drive }: { drive: Drive }) {
  const mat  = useRef<THREE.ShaderMaterial>(null)
  const mesh = useRef<THREE.Mesh>(null)
  const viewport = useThree((s) => s.viewport)

  const uniforms = useMemo(() => ({
    uColor:     { value: new THREE.Color('#19c4c4') },
    uHot:       { value: new THREE.Color('#ffe4a0') },
    uLevel:     { value: 0 },
    uTime:      { value: 0 },
    uOpen:      { value: 0 },
    uZoom:      { value: 1.2 },
    uIntensity: { value: 1 },
  }), [])

  useFrame((state, dt) => {
    if (!mat.current || !mesh.current) return
    const u  = mat.current.uniforms
    const r  = drive.reactor
    mesh.current.visible = r.visible
    mesh.current.scale.setScalar(r.scale)
    // Keep field units independent of canvas size
    const fit = Math.min(viewport.width, viewport.height)
    u.uZoom.value = (0.68 * 2.7) / (0.60 * 0.5 * fit)
    u.uLevel.value += (drive.level - u.uLevel.value) * Math.min(1, dt * 8)
    u.uTime.value = state.clock.elapsedTime
    u.uOpen.value += (drive.open - u.uOpen.value) * Math.min(1, dt * 1.6)
    u.uIntensity.value = r.intensity
    ;(u.uColor.value as THREE.Color).lerp(r.color, Math.min(1, dt * 2.5))
  })

  return (
    <mesh ref={mesh} frustumCulled={false}>
      <planeGeometry args={[5.4, 5.4]} />
      <shaderMaterial
        ref={mat}
        uniforms={uniforms}
        vertexShader={vert}
        fragmentShader={frag}
        transparent
        blending={THREE.AdditiveBlending}
        depthWrite={false}
      />
    </mesh>
  )
}
