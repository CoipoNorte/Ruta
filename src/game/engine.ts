/* ============================================================================
 * engine.ts — SIMULACIÓN (sin render, sin React)
 * ----------------------------------------------------------------------------
 * Autopista infinita y determinista: la curvatura y las colinas son FUNCIONES
 * PURAS del índice de segmento (capas de senos con zona muerta). No hay array
 * de carretera que crezca: memoria constante aunque conduzcas 500 km.
 *
 * Unidades: 100 u = 1 metro · velocidades en u/s · km/h = u/s * 0.036
 * Filosofía: conducción tranquila. No hay choques ni "game over"; el contacto
 * se resuelve como frenada de cortesía (igual que un crucero adaptativo).
 * ==========================================================================*/

/* ------------------------------ CONSTANTES -------------------------------- */
export const SEG = 300              // 3 m por segmento
export const ROAD_W = 2000          // semiancho 10 m → 3 carriles de ~6,6 m
export const LANES = 3
export const DRAW = 260             // segmentos visibles (~780 m)
export const CAM_H = 1500           // altura de cámara
export const CAM_DEPTH = 1 / Math.tan(((92 / 2) * Math.PI) / 180)

export const MAX_SPEED = 5600       // ≈ 200 km/h
const ACCEL = 560                   // 0–100 km/h en ~6 s (respuesta viva)
const BRAKE = 1250
const DRAG = 180                    // retención del motor al soltar
const OFFROAD_MAX = 1700            // ≈ 61 km/h en la banquina
const OFFROAD_DECEL = 1400
const STEER_RATE = 1.7              // unidades de calzada por segundo a tope
const CENTRIFUGAL = 0.085
const RETURN_RATE = 10              // auto-centrado del volante
const STEER_ATTACK = 22             // rapidez con que el volante sigue al dedo

/* Geometría del coche propio. El render PROYECTA estas medidas con la misma
 * fórmula que el tráfico, así la escala nunca se desajusta (antes era un
 * porcentaje fijo del ancho de pantalla y se veía gigante). */
export const PLAYER_W = 380         // mismo ancho físico que un turismo IA
export const PLAYER_Z = 1750        // distancia cámara → coche (17,5 m)

export const kmh = (u: number) => u * 0.036
export const toKm = (u: number) => u / 100000

/* --------------------------- CARRETERA PROCEDURAL ------------------------- */
/** Curvatura del segmento i. Zona muerta → aparecen rectas naturales. */
export function curveAt(i: number): number {
  const raw =
    Math.sin(i * 0.00168 + 0.4) * 0.95 +
    Math.sin(i * 0.00061 + 2.1) * 0.72 +
    Math.sin(i * 0.00317 + 5.0) * 0.28
  const s = Math.sign(raw)
  const mag = Math.max(0, Math.abs(raw) - 0.42)
  return s * mag * 3.4
}

/** Altura (colinas suaves) del segmento i. */
export function hillAt(i: number): number {
  return Math.sin(i * 0.0042) * 1150 + Math.sin(i * 0.0011 + 1.7) * 820
}

/** Hash determinista 0..1 — mobiliario de carretera sin estado. */
export function hash(i: number): number {
  const s = Math.sin(i * 12.9898) * 43758.5453
  return s - Math.floor(s)
}

/** Centro del carril l (0 = derecho/lento … LANES-1 = izquierdo/rápido). */
export const laneCenter = (l: number) => -1 + ((2 * l + 1) / LANES)

/* --------------------------------- TIPOS ---------------------------------- */
export interface TrafficCar {
  id: number
  z: number          // posición longitudinal absoluta
  x: number          // lateral, -1..1 (±1 = borde de calzada)
  lane: number
  speed: number      // u/s
  desired: number    // velocidad de crucero deseada
  color: number
  length: number
  width: number
  truck: boolean
  cooldown: number   // segundos hasta poder volver a cambiar de carril
  blinker: -1 | 0 | 1
  ahead: boolean     // iba por delante del jugador (para contar adelantamientos)
}

export interface Input {
  steer: number      // -1..1 (objetivo del volante)
  steering: boolean  // ¿hay dedo en el volante?
  throttle: boolean
  brake: boolean
}

/* ================================= JUEGO ================================== */
export class Game {
  z = 0                 // posición en la autopista (u)
  x = 0                 // lateral -1..1
  speed = 0
  steer = 0             // posición real del volante (suavizada)
  dist = 0              // odómetro (u)
  time = 0              // segundos conduciendo
  overtakes = 0
  gear = 1
  rpm = 0.2
  cars: TrafficCar[] = []
  shake = 0             // vibración de banquina
  courtesy = 0          // >0 mientras frenamos por cortesía tras otro coche
  flow = 1              // 0..1 "ritmo": sube conduciendo suave

  /* ---- DINÁMICA DE CHASIS Y CÁMARA (presentación: no altera la trayectoria)
   * Es la capa que da "peso" al coche. Todo son muelles amortiguados de
   * primer/segundo orden alimentados por la física real del frame. */
  camLag = 0            // la cámara persigue al coche → inercia lateral
  pitch = 0             // cabeceo: hunde el morro al frenar, lo eleva al acelerar
  roll = 0              // balanceo de carrocería en apoyo
  susp = 0              // suspensión: desplazamiento vertical
  suspV = 0             // velocidad del muelle
  slip = 0              // ángulo de deriva visual (el coche "apunta" al giro)
  lateralG = 0          // 0..1 carga lateral → chirrido y vibración
  shiftFlash = 0        // >0 justo tras un cambio de marcha
  gearChanged = 0       // 1 subida · -1 reducción · 0 nada (se consume por frame)
  private prevSpeed = 0
  private prevGear = 1
  private nextId = 1
  private spawnAcc = 0

  constructor() { this.seedTraffic() }

  get km() { return toKm(this.dist) }
  get speedPct() { return this.speed / MAX_SPEED }
  /** Curvatura justo bajo el coche (para la fuerza centrífuga y el HUD). */
  get curve() { return curveAt(Math.floor(this.z / SEG)) }

  /* ------------------------------ TRÁFICO -------------------------------- */
  private seedTraffic() {
    for (let i = 0; i < 16; i++) this.spawn(4000 + Math.random() * DRAW * SEG)
  }

  private spawn(relZ: number) {
    const lane = Math.floor(Math.random() * LANES)
    const truck = lane === 0 && Math.random() < 0.3
    // Velocidades típicas por carril: derecha lenta, izquierda rápida
    const base = truck ? 2300 : [2550, 2950, 3450][lane]
    const desired = base + (Math.random() * 2 - 1) * 180
    const car: TrafficCar = {
      id: this.nextId++,
      z: this.z + relZ,
      x: laneCenter(lane),
      lane,
      speed: desired,
      desired,
      color: Math.floor(Math.random() * 7),
      length: truck ? 1500 : 620,
      width: truck ? 480 : 380,
      truck,
      cooldown: Math.random() * 4,
      blinker: 0,
      ahead: relZ > 0,
    }
    this.cars.push(car)
  }

  /** Coche más cercano por delante en un carril (incluye al jugador). */
  private leader(from: number, lane: number, ignore: number) {
    let best: { z: number; speed: number } | null = null
    for (const c of this.cars) {
      if (c.id === ignore || c.lane !== lane) continue
      const d = c.z - from
      if (d > 0 && d < 9000 && (!best || c.z < best.z)) best = { z: c.z, speed: c.speed }
    }
    // El jugador también es tráfico para la IA: frenan y respetan su hueco
    const pl = this.playerLane()
    if (pl === lane) {
      const d = this.z - from
      if (d > 0 && d < 9000 && (!best || this.z < best.z)) best = { z: this.z, speed: this.speed }
    }
    return best
  }

  /** ¿Está libre el carril `lane` alrededor de la posición z? */
  private laneFree(z: number, lane: number, ignore: number) {
    for (const c of this.cars) {
      if (c.id === ignore || c.lane !== lane) continue
      const d = c.z - z
      if (d > -2200 && d < 4200) return false
    }
    const pl = this.playerLane()
    if (pl === lane) {
      const d = this.z - z
      if (d > -2600 && d < 4600) return false
    }
    return true
  }

  playerLane() {
    let best = 0, bd = Infinity
    for (let l = 0; l < LANES; l++) {
      const d = Math.abs(this.x - laneCenter(l))
      if (d < bd) { bd = d; best = l }
    }
    return bd < 0.42 ? best : -1
  }

  private updateTraffic(dt: number) {
    for (const c of this.cars) {
      c.cooldown -= dt

      // --- control longitudinal: mantener distancia de seguridad ---
      const lead = this.leader(c.z, c.lane, c.id)
      let target = c.desired
      if (lead) {
        const gap = lead.z - c.z - c.length
        const safe = c.speed * 1.5 + 700      // ~1,5 s de separación
        if (gap < safe) {
          const f = Math.max(0, gap / safe)
          target = Math.min(c.desired, lead.speed * (0.72 + 0.28 * f))
        }
      }
      const diff = target - c.speed
      c.speed += Math.sign(diff) * Math.min(Math.abs(diff), (diff > 0 ? 260 : 900) * dt)
      c.speed = Math.max(600, c.speed)
      c.z += c.speed * dt

      // --- decisiones de carril (adelantar por la izquierda, volver a la derecha) ---
      if (c.cooldown <= 0 && Math.abs(c.x - laneCenter(c.lane)) < 0.06) {
        const blocked = lead ? lead.z - c.z - c.length < c.speed * 1.9 + 800 : false
        if (blocked && c.lane < LANES - 1 && this.laneFree(c.z, c.lane + 1, c.id)) {
          c.lane++; c.cooldown = 3.5; c.blinker = -1
        } else if (!blocked && c.lane > 0 && this.laneFree(c.z, c.lane - 1, c.id)) {
          // cortesía: liberar el carril izquierdo cuando ya no hace falta
          c.lane--; c.cooldown = 5; c.blinker = 1
        }
      }
      const tx = laneCenter(c.lane)
      c.x += (tx - c.x) * Math.min(1, 2.4 * dt)
      if (Math.abs(tx - c.x) < 0.02) c.blinker = 0
    }

    // --- reciclado: fuera de la ventana de interés ---
    const back = this.z - 9000
    const front = this.z + DRAW * SEG * 1.15
    for (const c of this.cars) {
      if (c.z < back || c.z > front) {
        // reaparece delante (o detrás si es un coche rápido que nos alcanzará)
        const detras = Math.random() < 0.25
        const lane = detras ? LANES - 1 : Math.floor(Math.random() * LANES)
        c.lane = lane
        c.x = laneCenter(lane)
        c.z = detras ? this.z - 7000 - Math.random() * 4000 : this.z + DRAW * SEG * (0.75 + Math.random() * 0.35)
        c.truck = lane === 0 && Math.random() < 0.3
        c.length = c.truck ? 1500 : 620
        c.width = c.truck ? 480 : 380
        c.desired = (c.truck ? 2300 : [2550, 2950, 3450][lane]) + (Math.random() * 2 - 1) * 180
        c.speed = c.desired
        c.color = Math.floor(Math.random() * 7)
        c.ahead = c.z > this.z
        c.blinker = 0
      }
    }

    // densidad viva: de vez en cuando entra alguien nuevo si hay poco tráfico
    this.spawnAcc += dt
    if (this.spawnAcc > 3 && this.cars.length < 20) {
      this.spawnAcc = 0
      if (Math.random() < 0.5) this.spawn(DRAW * SEG * 0.9)
    }
  }

  /* ----------------------------- ACTUALIZACIÓN ---------------------------- */
  update(dt: number, input: Input) {
    this.time += dt

    /* --- volante: sigue al dedo y vuelve solo al centro al soltar --- */
    const objetivo = input.steering ? input.steer : 0
    const k = input.steering ? STEER_ATTACK : RETURN_RATE
    this.steer += (objetivo - this.steer) * Math.min(1, k * dt)
    if (!input.steering && Math.abs(this.steer) < 0.004) this.steer = 0

    /* --- caja automática: solo acelerar y frenar --- */
    if (input.brake) {
      this.speed -= BRAKE * dt
    } else if (input.throttle) {
      // la aceleración cae con la velocidad (resistencia aerodinámica)
      this.speed += ACCEL * (1 - 0.62 * this.speedPct) * dt
    } else {
      this.speed -= DRAG * dt
    }

    /* --- banquina: se puede pisar, pero frena y vibra (sin castigo real) --- */
    const fuera = Math.abs(this.x) > 1
    if (fuera) {
      if (this.speed > OFFROAD_MAX) this.speed -= OFFROAD_DECEL * dt
      this.shake = Math.min(1, this.shake + dt * 4)
    } else {
      this.shake = Math.max(0, this.shake - dt * 3)
    }
    this.speed = Math.max(0, Math.min(MAX_SPEED, this.speed))

    /* --- dirección: ágil ya desde baja velocidad, estable en punta --- */
    const pct = this.speedPct
    this.x += this.steer * STEER_RATE * (0.55 + 0.45 * Math.min(1, pct * 2.4)) * dt
    /* --- fuerza centrífuga: hay que apoyar el volante en las curvas --- */
    this.x -= this.curve * pct * pct * CENTRIFUGAL * dt
    this.x = Math.max(-1.32, Math.min(1.32, this.x))

    /* --- cortesía: nunca chocamos; nos acoplamos al coche de delante --- */
    this.courtesy = Math.max(0, this.courtesy - dt)
    for (const c of this.cars) {
      const dz = c.z - this.z
      if (dz > -c.length && dz < c.length + 450) {
        if (Math.abs(c.x - this.x) < (c.width + 380) / ROAD_W + 0.03) {
          if (dz > 0 && this.speed > c.speed) {
            this.speed = Math.max(c.speed * 0.9, this.speed - 2600 * dt)
            this.courtesy = 0.6
          }
          // separación lateral suave (nadie se raya la pintura)
          this.x += Math.sign(this.x - c.x || 1) * 0.55 * dt
        }
      }
    }

    this.z += this.speed * dt
    this.dist += this.speed * dt

    /* --- adelantamientos: contamos a quién dejamos atrás --- */
    for (const c of this.cars) {
      if (c.ahead && c.z < this.z) { this.overtakes++; c.ahead = false }
      else if (!c.ahead && c.z > this.z + 600) c.ahead = true
    }

    /* --- ritmo: premia ir suave y lejos de la banquina --- */
    const suave = !input.brake && !fuera && this.courtesy === 0 ? 1 : 0
    this.flow += ((suave ? 1 : 0.25) - this.flow) * Math.min(1, dt * 0.6)

    this.updateDynamics(dt)
    this.updateTraffic(dt)
    this.updateGear()
  }

  /* ---------------------- DINÁMICA DE CHASIS / CÁMARA --------------------- */
  private updateDynamics(dt: number) {
    const pct = this.speedPct

    // cabeceo: derivada real de la velocidad (dive al frenar, squat al acelerar)
    const accel = (this.speed - this.prevSpeed) / Math.max(dt, 0.0001)
    this.prevSpeed = this.speed
    const objPitch = Math.max(-1, Math.min(1, accel / 1500))
    this.pitch += (objPitch - this.pitch) * Math.min(1, dt * 6)

    // carga lateral = volante + centrífuga de la curva que estamos trazando
    const lat = this.steer * pct - this.curve * pct * pct * 0.4
    this.lateralG = Math.min(1, Math.abs(lat) * 1.7)
    this.roll += (lat - this.roll) * Math.min(1, dt * 7)

    // deriva: la carrocería gira un poco antes que la trayectoria
    this.slip += (this.steer * (0.3 + 0.7 * pct) - this.slip) * Math.min(1, dt * 9)

    // cámara con inercia: a más velocidad, más pegada; en maniobra, se retrasa
    this.camLag += (this.x - this.camLag) * Math.min(1, dt * (3.4 + 4.2 * pct))

    // suspensión: muelle amortiguado excitado por el relieve + textura del asfalto
    const i = Math.floor(this.z / SEG)
    const jolt = ((hillAt(i + 1) - 2 * hillAt(i) + hillAt(i - 1)) / SEG) * this.speed * 0.9
    const textura = (hash(i) - 0.5) * pct * 26
    this.suspV += (-this.susp * 170 - this.suspV * 15 + jolt + textura) * dt
    this.susp += this.suspV * dt
    this.susp = Math.max(-16, Math.min(16, this.susp))

    this.shiftFlash = Math.max(0, this.shiftFlash - dt * 2.6)
  }

  /** Caja automática de 6 marchas: solo informativa + sonido del motor. */
  private updateGear() {
    const v = kmh(this.speed)
    const lim = [0, 32, 58, 88, 122, 160, 999]
    let g = 1
    for (let i = 1; i < lim.length; i++) if (v >= lim[i]) g = i + 1
    this.gear = Math.min(6, g)
    const lo = lim[this.gear - 1], hi = lim[this.gear] === 999 ? 210 : lim[this.gear]
    this.rpm = 0.18 + 0.82 * Math.max(0, Math.min(1, (v - lo) / (hi - lo)))

    // cambio de marcha: la caída de vueltas ya sale sola del mapeo anterior;
    // aquí solo señalizamos el evento para el sonido y el destello del HUD.
    if (this.gear !== this.prevGear) {
      this.gearChanged = this.gear > this.prevGear ? 1 : -1
      this.shiftFlash = 1
      this.prevGear = this.gear
    } else {
      this.gearChanged = 0
    }
  }
}

/* ============================== AUDIO DEL MOTOR ============================
 * Síntesis WebAudio: dos osciladores (motor) + ruido filtrado (viento/rodadura).
 * Cero archivos — misma filosofía que los proyectos anteriores.
 * ==========================================================================*/
export class EngineAudio {
  private ctx: AudioContext | null = null
  private osc1: OscillatorNode | null = null
  private osc2: OscillatorNode | null = null
  private gain: GainNode | null = null
  private windGain: GainNode | null = null
  private windLP: BiquadFilterNode | null = null
  private tireGain: GainNode | null = null
  muted = false

  start() {
    if (this.ctx) { void this.ctx.resume(); return }
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!AC) return
      const a = new AC()
      this.ctx = a

      const g = a.createGain(); g.gain.value = 0; g.connect(a.destination)
      const lp = a.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900; lp.connect(g)
      const o1 = a.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = 70; o1.connect(lp)
      const o2 = a.createOscillator(); o2.type = 'square'; o2.frequency.value = 35
      const g2 = a.createGain(); g2.gain.value = 0.35; o2.connect(g2); g2.connect(lp)
      o1.start(); o2.start()
      this.osc1 = o1; this.osc2 = o2; this.gain = g

      // viento / rodadura: ruido blanco en bucle con paso bajo
      const buf = a.createBuffer(1, a.sampleRate * 2, a.sampleRate)
      const d = buf.getChannelData(0)
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
      const src = a.createBufferSource(); src.buffer = buf; src.loop = true
      const wlp = a.createBiquadFilter(); wlp.type = 'lowpass'; wlp.frequency.value = 700
      const wg = a.createGain(); wg.gain.value = 0
      src.connect(wlp); wlp.connect(wg); wg.connect(a.destination); src.start()
      this.windGain = wg; this.windLP = wlp

      // chirrido de neumáticos: mismo ruido, pasa-banda agudo y ganancia
      // gobernada por la carga lateral del chasis
      const tsrc = a.createBufferSource(); tsrc.buffer = buf; tsrc.loop = true
      const bp = a.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2400; bp.Q.value = 6
      const tg = a.createGain(); tg.gain.value = 0
      tsrc.connect(bp); bp.connect(tg); tg.connect(a.destination); tsrc.start()
      this.tireGain = tg
    } catch { /* sin audio disponible */ }
  }

  /** Golpe seco del cambio de marcha (clunk de transmisión). */
  shift() {
    const a = this.ctx
    if (!a || this.muted) return
    const t = a.currentTime
    const o = a.createOscillator(); o.type = 'triangle'
    o.frequency.setValueAtTime(190, t)
    o.frequency.exponentialRampToValueAtTime(72, t + 0.09)
    const g = a.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(0.06, t + 0.008)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.13)
    o.connect(g); g.connect(a.destination)
    o.start(t); o.stop(t + 0.16)
  }

  /** Llamar cada frame: la marcha hace que el tono "reinicie" al cambiar. */
  update(rpm: number, speedPct: number, throttle: boolean, lateralG = 0, offroad = 0) {
    const a = this.ctx
    if (!a || !this.gain || !this.osc1 || !this.osc2 || !this.windGain || !this.windLP) return
    const t = a.currentTime
    const vol = this.muted ? 0 : 1
    const f = 58 + rpm * 150
    this.osc1.frequency.setTargetAtTime(f, t, 0.05)
    this.osc2.frequency.setTargetAtTime(f * 0.5, t, 0.05)
    this.gain.gain.setTargetAtTime(vol * (throttle ? 0.085 : 0.045) * (0.45 + 0.55 * rpm), t, 0.1)
    this.windGain.gain.setTargetAtTime(vol * 0.055 * speedPct * speedPct, t, 0.2)
    this.windLP.frequency.setTargetAtTime(500 + speedPct * 2600, t, 0.2)
    if (this.tireGain) {
      // chirría al cargar el tren delantero y rechina sobre la banquina
      const carga = Math.max(0, lateralG - 0.38) * speedPct
      this.tireGain.gain.setTargetAtTime(vol * (carga * 0.11 + offroad * 0.05 * speedPct), t, 0.1)
    }
  }

  stop() {
    if (!this.ctx || !this.gain || !this.windGain) return
    const t = this.ctx.currentTime
    this.gain.gain.setTargetAtTime(0, t, 0.1)
    this.windGain.gain.setTargetAtTime(0, t, 0.1)
  }
}
