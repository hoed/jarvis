import { useMemo } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import {
  EffectComposer,
  Bloom,
  ChromaticAberration,
  Vignette,
  Noise,
} from '@react-three/postprocessing'
import { BlendFunction } from 'postprocessing'
import * as THREE from 'three'
import { ReactorCore }     from './ReactorCore'
import { InstrumentRings } from './InstrumentRings'
import { OuterRings }      from './OuterRings'
import { Particles }       from './Particles'
import { Orbits }          from './Orbits'
import { useStore, phaseColor, accentFor, type Phase } from '../store'

/** Halo spin speed per phase. More spin = more urgency. */
const spinFor: Record<Phase, number> = {
  offline:   0.06,
  boot:      3.0,
  dormant:   0.20,
  waking:    4.2,
  listening: 1.0,
  thinking:  2.6,
  tooling:   3.4,
  speaking:  1.3,
}

export type Drive = {
  color:   THREE.Color
  level:   number
  spin:    number
  amp:     number
  open:    number
  reactor: {
    color:     THREE.Color
    scale:     number
    intensity: number
    spin:      number
    style:     number
    visible:   boolean
  }
}

type Tint = { key: string; color: THREE.Color }
function aim(tint: Tint, css: string): THREE.Color {
  if (tint.key !== css) { tint.key = css; tint.color.set(css) }
  return tint.color
}

const STYLE_INDEX = { ring: 0, sphere: 1, wire: 2 } as const

function Rig() {
  const drive = useMemo<Drive>(() => ({
    color:   new THREE.Color(phaseColor.offline),
    level:   0,
    spin:    spinFor.offline,
    amp:     0.035,
    open:    0,
    reactor: {
      color:     new THREE.Color(phaseColor.offline),
      scale:     1,
      intensity: 1,
      spin:      1,
      style:     0,
      visible:   true,
    },
  }), [])

  const target        = useMemo<Tint>(() => ({ key: '', color: new THREE.Color() }), [])
  const reactorTarget = useMemo<Tint>(() => ({ key: '', color: new THREE.Color() }), [])

  useFrame((state, dt) => {
    const { phase, level, ui } = useStore.getState()
    const accent = accentFor(phase, ui)
    drive.color.lerp(aim(target, accent), Math.min(1, dt * 2.5))

    const r = ui.reactor
    drive.reactor.color.lerp(aim(reactorTarget, r.color ?? accent), Math.min(1, dt * 2.5))
    const k = Math.min(1, dt * 5)
    drive.reactor.scale     += (r.scale     - drive.reactor.scale)     * k
    drive.reactor.intensity += (r.intensity - drive.reactor.intensity) * k
    drive.reactor.spin      += (r.spin      - drive.reactor.spin)      * k
    drive.reactor.style      = STYLE_INDEX[r.style] ?? 0
    drive.reactor.visible    = r.visible

    drive.spin += (spinFor[phase] - drive.spin) * Math.min(1, dt * 2)
    drive.open  = phase === 'offline' ? 0.28 : phase === 'boot' ? 0.7 : 1.6

    const idle = phase === 'offline' ? 0.02 : phase === 'dormant' ? 0.05 : 0.12
    const breathe = (Math.sin(state.clock.elapsedTime * 0.9) * 0.5 + 0.5) * idle
    drive.level += (Math.max(level, breathe) - drive.level) * Math.min(1, dt * 9)

    // Very subtle camera breathe — handheld feel
    const t = state.clock.elapsedTime
    state.camera.position.x = Math.sin(t * 0.11) * 0.12
    state.camera.position.y = Math.cos(t * 0.15) * 0.08
    state.camera.lookAt(0, 0, 0)
  })

  return (
    <>
      <ReactorCore     drive={drive} />
      <InstrumentRings drive={drive} />
      <OuterRings      drive={drive} />
      <Particles       drive={drive} />
      <Orbits />
    </>
  )
}

export function Scene() {
  return (
    <Canvas
      className="scene"
      camera={{ position: [0, 0, 6.2], fov: 45 }}
      gl={{ antialias: true, alpha: true }}
      dpr={[1, 2]}
    >
      <Rig />
      <EffectComposer multisampling={0}>
        <Bloom
          intensity={1.6}
          luminanceThreshold={0.14}
          luminanceSmoothing={0.90}
          mipmapBlur
          radius={0.82}
        />
        <ChromaticAberration
          offset={new THREE.Vector2(0.0006, 0.0009)}
          radialModulation={false}
          modulationOffset={0}
        />
        <Noise opacity={0.028} blendFunction={BlendFunction.OVERLAY} />
        <Vignette eskil={false} offset={0.18} darkness={0.95} />
      </EffectComposer>
    </Canvas>
  )
}
