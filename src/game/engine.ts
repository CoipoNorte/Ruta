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

/* ===================== DOS CARRETERAS, UNA MISMA RUTA =====================
 * `RUTA`  : 3 carriles, tranquila, paisajística.
 * `SUPER` : 8 carriles estilo interestatal, mucho más ancha y con más tráfico.
 * Son `let` exportados a propósito: los módulos ES mantienen *live bindings*,
 * así que render y engine ven el valor nuevo en cuanto cambia de carretera.
 * ========================================================================= */
export let ROAD_W = 2000            // semiancho (10 m → 3 carriles de ~6,6 m)
export let LANES = 3
export const RUTA_W = 2000, SUPER_W = 5000
export const RUTA_LANES = 3, SUPER_LANES = 8
/** Fija el tipo de vía. El ancho se interpola desde el motor para que la
 *  incorporación se vea como una calzada que se abre, no como un salto. */
export function setRoadWidth(w: number) { ROAD_W = w }
export function setLanes(n: number) { LANES = n }
// 180 segmentos (~540 m) son suficientes con niebla atmosférica. Los 260
// anteriores pintaban cientos de objetos invisibles y castigaban a móviles.
export const DRAW = 180
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
/* VOLUMEN DEL VEHÍCULO (pseudo-3D en un render 2D)
 * El coche no es un punto: ocupa ANCHO (x), LARGO (z) y ALTO (y). El alto no
 * interviene en la colisión plana, pero define la silueta del sprite.
 * CLAVE: la cámara va 17,5 m DETRÁS del coche, así que la posición real del
 * vehículo es `z + PLAYER_Z`. Calcular los choques en `z` (la cámara) hacía
 * que colisionaras con coches que visualmente ya tenías detrás. */
export const PLAYER_W = 380         // ancho (3,8 m) — igual que un turismo IA
export const PLAYER_L = 820         // largo (8,2 m con margen de parachoques)
export const PLAYER_H = 300         // alto (solo para el dibujo)
export const PLAYER_Z = 1750        // distancia cámara → eje trasero (17,5 m)

export const kmh = (u: number) => u * 0.036
export const toKm = (u: number) => u / 100000
const clamp01 = (v: number) => Math.max(0, Math.min(1, v))

/** Límite legal del tramo (km/h). Zonas de ~2,7 km, deterministas.
 *  Cinco categorías: obras/urbano (60), travesía (80), normal (100),
 *  autopista (120) y tramo rápido (130). Los NPC ajustan su ritmo al cruzar
 *  cada zona, de modo que el tráfico se comprime y se estira solo. */
export function limitAt(i: number): number {
  const zona = Math.floor(i / 900)
  const h = hash(zona * 1.7 + 0.3)
  return h < 0.1 ? 60 : h < 0.28 ? 80 : h < 0.52 ? 100 : h < 0.85 ? 120 : 130
}

/* ============================== METEOROLOGÍA ==============================
 * El clima no es aleatorio: DEPENDE DEL PAISAJE. Nieva en la cordillera,
 * hay polvo en suspensión en el desierto, bruma en el bosque y la Patagonia,
 * y lluvia en el valle. Cada fenómeno afecta de forma distinta a la
 * conducción (agarre, frenada, visibilidad).
 * ========================================================================= */
export type WeatherKind = 'seco' | 'lluvia' | 'nieve' | 'niebla' | 'tierra'

export const BIOMA_KM = 7.5     // longitud de cada tramo de paisaje
export const BIOME_COUNT = 8

/** Índice de bioma (0..7) y mezcla con el siguiente tramo. Fuente única:
 *  el render pinta exactamente el bioma que aquí decide el clima. */
export function biomeMix(km: number) {
  const f = km / BIOMA_KM
  const i = Math.floor(f)
  const t = f - i
  const pick = (n: number) => Math.floor(hash(n * 2.137 + 11.3) * BIOME_COUNT) % BIOME_COUNT
  const k = t < 0.7 ? 0 : 0.5 - 0.5 * Math.cos(((t - 0.7) / 0.3) * Math.PI)
  return { a: pick(i), b: pick(i + 1), k }
}

/** Fenómeno dominante de cada bioma (mismo orden que `BIOMAS` en render). */
const CLIMA_BIOMA: WeatherKind[] = [
  'tierra',   // 0 Desierto   — polvo en suspensión
  'lluvia',   // 1 Valle
  'niebla',   // 2 Ciudad     — smog
  'niebla',   // 3 Bosque     — bruma entre los árboles
  'lluvia',   // 4 Sierra
  'nieve',    // 5 Cordillera
  'niebla',   // 6 Patagonia  — viento y bruma
  'nieve',    // 7 Austral
]

/** Frente meteorológico en un kilómetro dado: tipo e intensidad 0..1. */
export function weatherAt(km: number): { kind: WeatherKind; power: number } {
  const { a, b, k } = biomeMix(km)
  const idx = k < 0.5 ? a : b
  // los frentes van y vienen: no siempre hay fenómeno activo
  const w = Math.sin(km * 0.23 + 1.3) * 0.62 + Math.sin(km * 0.071) * 0.5
  const power = clamp01((w - 0.3) * 2.0)
  return { kind: power < 0.05 ? 'seco' : CLIMA_BIOMA[idx], power }
}

export const WEATHER_LABEL: Record<WeatherKind, string> = {
  seco: 'despejado', lluvia: 'lluvia', nieve: 'nieve', niebla: 'niebla', tierra: 'polvo',
}

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

/** Centro del carril l (0 = DERECHO/lento … LANES-1 = IZQUIERDO/rápido).
 *  OJO: `x` crece hacia la derecha de la pantalla, así que el carril 0 (lento,
 *  camiones) va en +x y "adelantar" significa ir hacia −x. Tener esto espejado
 *  era la causa de que los NPC señalizaran al revés y parecieran volverse. */
export const laneCenter = (l: number) => 1 - ((2 * l + 1) / LANES)

/* --------------------------------- TIPOS ---------------------------------- */
/* ============================ PERSONALIDADES ==============================
 * Cada conductor tiene una forma de entender la carretera. De esto depende su
 * velocidad objetivo, el carril que prefiere y la agresividad al adelantar.
 *  · sinprisa : 10–20 km/h POR DEBAJO del límite, vive en el carril derecho.
 *  · conprisa : en el límite, adelanta con seguridad y vuelve a la derecha.
 *  · corredor : por encima del límite, zigzaguea y bordea el arcén si hace falta.
 *  · ambulancia: corredor con prioridad — el resto se aparta.
 *  · patrulla : persigue corredores; al alcanzarlos ambos se orillan.
 * ========================================================================= */
export type Kind = 'sinprisa' | 'conprisa' | 'corredor' | 'camion' | 'ambulancia' | 'patrulla'

export const esEmergencia = (k: Kind) => k === 'ambulancia' || k === 'patrulla'
/** Conductores civiles que pueden cambiar de humor con el tiempo. */
export const esCivil = (k: Kind) => k === 'sinprisa' || k === 'conprisa' || k === 'corredor'

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
  kind: Kind         // personalidad / tipo de vehículo
  cooldown: number   // segundos hasta poder volver a cambiar de carril
  blinker: -1 | 0 | 1
  siren: number      // fase de la sirena (emergencias)
  chasing: number    // id del corredor perseguido (patrullas) · 0 = ninguno
  pullover: number   // >0: orillándose a la derecha (control policial)
  ahead: boolean     // iba por delante del jugador (para contar adelantamientos)
  yielding: number   // >0: cede el paso al jugador (frena y se aparta)
  intent: -1 | 0 | 1 // maniobra señalizada y aún no ejecutada (-1 izq · 1 der)
  intentT: number    // segundos de señalización previa que faltan
  pressure: number   // segundos que el jugador lleva pidiéndole paso detrás
  checkT: number     // cuenta atrás hasta la próxima decisión de cortesía
  evade: number      // >0: intención de apartarse del paso del jugador
  evadeDir: -1 | 0 | 1
  nudge: number      // velocidad lateral residual del empujón (se amortigua)
  boost: number      // >0: acelera para abrir hueco longitudinal
  relax: number      // >0: afloja para deshacer una barrera rodante
  cargo: number      // 0..1 carga del camión (más carga, menos brío)
  mood: number       // 0..1 prisa ACTUAL — varía durante el viaje
  moodT: number      // cuenta atrás para replantearse la prisa
  ovPhase: 0 | 1 | 2 // maniobra de adelantamiento: 0 no · 1 pasando · 2 volviendo
  ovTarget: number   // id del vehículo al que está adelantando
  ovT: number        // tiempo máximo permitido en la maniobra (anti-bloqueo)
  honk: number       // >0 tocando la bocina (ambulancias)
  abreast: number    // segundos rodando en paralelo con otro (anti-pelotón)
  makeWay: number    // >0: orden explícita de despejar el corredor del jugador
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

  /* ---- CONDUCCIÓN RESPONSABLE (capa de simulador) ---- */
  /* Canales de clima independientes y suavizados: permiten mezclar el final
   * de un frente con el principio del siguiente sin saltos. */
  weather: WeatherKind = 'seco'
  rain = 0              // lluvia   → agarre −30 %, visibilidad −25 %
  snow = 0              // nieve    → agarre −50 %, visibilidad −40 %
  dust = 0              // polvo    → agarre −18 %, visibilidad −45 %
  mist = 0              // niebla   → no afecta al agarre, visibilidad −75 %
  wx = 0                // intensidad del fenómeno activo
  visibility = 1        // 1 despejado … 0 ciego
  revLimit = 0          // 0..1 tocando el limitador del motor
  grip = 1              // adherencia combinada

  /* ---- FÍSICA DEL FIRME (simulación) ----
   * El agarre no es un número único: un neumático tiene un círculo de
   * fricción que se reparte entre FRENAR y GIRAR. Con el firme deslizante
   * cada eje se degrada de forma distinta, y aparecen fenómenos propios. */
  slide = 0             // 0..1 el coche está perdiendo adherencia AHORA
  understeer = 0        // 0..1 subviraje: giras y el coche sigue recto
  crossWind = 0         // viento lateral (desierto/patagonia) en u/s
  aquaplane = 0         // 0..1 aquaplaning sobre lámina de agua
  limit = 120           // límite legal del tramo actual (km/h)
  speeding = false      // circulando por encima del límite + margen
  blinker: -1 | 0 | 1 = 0   // intermitente del jugador (-1 izq · 1 der)
  blinkerT = 0          // apagado automático
  blindSpot: -1 | 0 | 1 = 0 // vehículo en ángulo muerto
  braking = false       // pedal de freno pisado (enciende las luces traseras)
  contact = 0           // >0 durante y justo después de un roce
  wobble = 0            // descontrol lateral tras el roce (el volante se va)
  nudgeSelf = 0         // rebote lateral propio del golpe (amortiguado)
  barrierT = 0          // cuenta atrás de la verificación de huecos
  blockedAll = false    // true si los 3 carriles están cortados por delante
  hornCue = 0           // 1 cuando suena una bocina cerca (lo consume la vista)
  blockT = 0            // segundos seguidos sin corredor libre (escalada)
  private unclumpAcc = 0   // acumulador del throttle anti-pelotón
  zona = ''             // nombre del paisaje actual (lo escribe el render)

  /* ---- BIFURCACIÓN RUTA ↔ SUPER ---- */
  superMode = false     // ¿vamos por la super carretera?
  junctionZ = 0         // posición absoluta del próximo desvío
  junctionSide: -1 | 1 = 1   // 1 = sale por la derecha · -1 = por la izquierda
  forkFlash = 0         // destello al incorporarse
  takenCue = ''         // texto que la vista muestra al cambiar de vía
  private roadWTarget = RUTA_W

  /** Metros hasta el próximo desvío (negativo = ya pasó). */
  get forkDist() { return (this.junctionZ - this.pz) / 100 }
  /** ¿Estamos colocados en el carril por el que sale el desvío? */
  get onForkLane() {
    return this.junctionSide > 0 ? this.x > 0.34 : this.x < -0.34
  }

  /** Programa el siguiente desvío 4–7 km más adelante. */
  private scheduleJunction() {
    this.junctionZ = this.pz + 400000 + Math.random() * 300000
    this.junctionSide = Math.random() < 0.5 ? -1 : 1
  }

  /** Cambia de calzada y recoloca el tráfico para el nuevo número de carriles. */
  private switchRoad(toSuper: boolean) {
    this.superMode = toSuper
    setLanes(toSuper ? SUPER_LANES : RUTA_LANES)
    this.roadWTarget = toSuper ? SUPER_W : RUTA_W
    this.forkFlash = 1
    this.takenCue = toSuper ? 'SUPER CARRETERA' : 'RUTA'
    // el jugador entra por el carril del lado por el que tomó el desvío
    this.x = this.junctionSide > 0 ? 0.72 : -0.72
    // reparte el tráfico por la nueva calzada, escalonado para no crear muros
    this.cars.forEach((c, i) => {
      c.lane = Math.min(LANES - 1, Math.floor(Math.random() * LANES))
      if (c.kind === 'camion') c.lane = Math.min(c.lane, this.maxLaneFor(c))
      c.x = laneCenter(c.lane)
      c.z = this.pz + 6000 + i * (2600 + Math.random() * 2200)
      c.ahead = true
      c.ovPhase = 0; c.intent = 0; c.blinker = 0; c.abreast = 0; c.makeWay = 0
    })
    this.scheduleJunction()
  }

  /** Lógica del desvío: se evalúa al cruzar el punto de bifurcación. */
  private updateJunction(dt: number) {
    this.forkFlash = Math.max(0, this.forkFlash - dt * 1.6)
    if (this.junctionZ === 0) { this.scheduleJunction(); return }
    if (this.pz >= this.junctionZ) {
      // al cruzarlo: si vas en el carril del ramal, te incorporas
      if (this.onForkLane) this.switchRoad(!this.superMode)
      else this.scheduleJunction()
    }
  }

  /** Distancia absoluta de un vehículo al coche del jugador. */
  pzDist(c: TrafficCar) { return Math.abs(c.z - this.pz) }
  score = 100           // puntuación de conducción 0..100
  lastSignal = 0        // dirección señalizada en los últimos segundos
  signalAge = 99
  private prevLane = 1
  private prevSpeed = 0
  private prevGear = 1
  private nextId = 1
  private spawnAcc = 0

  constructor() { this.seedTraffic() }

  get km() { return toKm(this.dist) }
  get speedPct() { return this.speed / MAX_SPEED }
  /** Posición LONGITUDINAL REAL del coche (centro del volumen), no de la
   *  cámara. Todo lo que compare distancias con el tráfico debe usar esto. */
  get pz() { return this.z + PLAYER_Z }
  /** Curvatura justo bajo el coche (para la fuerza centrífuga y el HUD). */
  get curve() { return curveAt(Math.floor(this.z / SEG)) }

  /* ------------------------------ TRÁFICO -------------------------------- */
  private seedTraffic() {
    for (let i = 0; i < 16; i++) this.spawn(4000 + Math.random() * DRAW * SEG)
  }

  /** Sortea una personalidad con la mezcla típica de una autopista. */
  private rollKind(): Kind {
    const r = Math.random()
    if (r < 0.015) return 'ambulancia'
    if (r < 0.055) return 'patrulla'
    if (r < 0.20) return 'corredor'
    if (r < 0.34) return 'camion'
    if (r < 0.66) return 'conprisa'
    return 'sinprisa'
  }

  /** Velocidad deseada: personalidad × límite del tramo × HUMOR actual.
   *  `mood` (0..1) es la prisa del momento y cambia durante el viaje, así que
   *  un mismo coche acelera o se relaja según el tramo y su estado de ánimo. */
  private paceFor(kind: Kind, limitKmh: number, mood = 0.5, cargo = 0): number {
    const lim = limitKmh / 0.036
    switch (kind) {
      // 10–20 km/h por debajo; con algo de prisa se acerca al límite
      case 'sinprisa':  return lim * (0.74 + mood * 0.17)
      // en el límite, con margen según su humor
      case 'conprisa':  return lim * (0.92 + mood * 0.13)
      // IGNORA el límite: su techo es el del propio vehículo
      case 'corredor':  return Math.min(MAX_SPEED * 0.96, lim * (1.12 + mood * 0.55))
      // la carga pesa: un camión lleno pierde hasta un 16 % de ritmo
      case 'camion':    return lim * (0.74 + mood * 0.12) * (1 - cargo * 0.16)
      case 'ambulancia': return Math.min(MAX_SPEED * 0.92, lim * 1.38)
      // patrulla: de ronda tranquila o con prisa, según humor
      case 'patrulla':  return mood > 0.62 ? lim * (1.02 + mood * 0.2) : lim * (0.88 + mood * 0.12)
    }
  }

  /** Carril preferido por personalidad, PROPORCIONAL al ancho de la vía:
   *  en la RUTA (3) los lentos van al 0 y los rápidos al 2; en la SUPER (8)
   *  el tráfico se reparte por franjas, como en una interestatal real. */
  private homeLane(kind: Kind, mood = 0.5): number {
    const top = LANES - 1
    const franja = (f: number) => Math.round(top * f)
    if (kind === 'camion') return Math.min(franja(0.1), 1)
    if (kind === 'sinprisa') return franja(mood > 0.8 ? 0.18 : 0)
    if (kind === 'conprisa') return franja(0.28 + mood * 0.3)
    if (kind === 'patrulla') return franja(mood > 0.62 ? 0.5 : 0.15)
    return top                                        // corredores y ambulancias
  }

  /* ---- ADAPTACIÓN DE LA IA AL CLIMA ------------------------------------
   * Un conductor normal levanta el pie con nieve o niebla. Pero no todos
   * reaccionan igual: el corredor apenas se inmuta (excepción deliberada,
   * es el que acaba teniendo sustos), la emergencia tiene que llegar, y el
   * camión cargado es el más prudente de todos. */
  private weatherPace(c: TrafficCar): number {
    const malo = this.rain * 0.18 + this.snow * 0.45 + this.mist * 0.3 + this.dust * 0.12
    const cautela = c.kind === 'corredor' ? 0.3
      : esEmergencia(c.kind) ? 0.55
      : c.kind === 'camion' ? 1.2 + c.cargo * 0.3
      : c.kind === 'sinprisa' ? 1.15
      : 1
    return Math.max(0.42, 1 - malo * cautela)
  }

  /** Carril máximo permitido: los camiones nunca pisan los carriles rápidos. */
  private maxLaneFor(c: TrafficCar) {
    return c.kind === 'camion' ? Math.min(2, Math.max(1, Math.floor((LANES - 1) * 0.3))) : LANES - 1
  }

  private spawn(relZ: number) {
    const z = this.z + relZ
    const limKmh = limitAt(Math.floor(z / SEG))
    const kind = this.rollKind()
    const truck = kind === 'camion'
    const cargo = truck ? Math.random() : 0
    // humor inicial: sesgado según la personalidad
    const mood = kind === 'corredor' ? 0.6 + Math.random() * 0.4
      : kind === 'sinprisa' ? Math.random() * 0.5
      : Math.random()
    const lane = this.homeLane(kind, mood)
    const desired = this.paceFor(kind, limKmh, mood, cargo)
    const car: TrafficCar = {
      id: this.nextId++,
      z,
      x: laneCenter(lane),
      lane,
      speed: desired,
      desired,
      color: kind === 'ambulancia' ? 7 : kind === 'patrulla' ? 8 : Math.floor(Math.random() * 7),
      length: truck ? 1500 : esEmergencia(kind) ? 760 : 620,
      width: truck ? 480 : esEmergencia(kind) ? 420 : 380,
      truck,
      kind,
      cooldown: Math.random() * 4,
      blinker: 0,
      siren: 0,
      chasing: 0,
      pullover: 0,
      ahead: relZ > 0,
      yielding: 0,
      intent: 0,
      intentT: 0,
      pressure: 0,
      checkT: 3 + Math.random() * 4,
      evade: 0,
      evadeDir: 0,
      nudge: 0,
      boost: 0,
      relax: 0,
      cargo,
      mood,
      moodT: 8 + Math.random() * 22,
      ovPhase: 0,
      ovTarget: 0,
      ovT: 0,
      honk: 0,
      abreast: 0,
      makeWay: 0,
    }
    this.cars.push(car)
  }

  /** Vehículo líder real (objeto, no solo datos) para la maniobra de adelantar. */
  private leaderCar(c: TrafficCar, lane: number): TrafficCar | null {
    let best: TrafficCar | null = null
    for (const o of this.cars) {
      if (o.id === c.id || o.lane !== lane) continue
      const d = o.z - c.z
      if (d > 0 && d < 9000 && (!best || o.z < best.z)) best = o
    }
    return best
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
      const d = this.pz - from
      if (d > 0 && d < 9000 && (!best || this.pz < best.z)) best = { z: this.pz, speed: this.speed }
    }
    return best
  }

  /** Velocidad realmente sostenible en `lane`: si hay alguien lento delante,
   *  es su velocidad. Sirve para no cambiarse de carril sin ganar nada. */
  private lanePace(c: TrafficCar, lane: number) {
    const lead = this.leader(c.z, lane, c.id)
    if (!lead) return c.desired
    const gap = lead.z - c.z - c.length
    if (gap > c.speed * 2.4 + 1300) return c.desired
    return Math.min(c.desired, lead.speed)
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
      const d = this.pz - z
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
      c.yielding = Math.max(0, c.yielding - dt)
      c.honk = Math.max(0, c.honk - dt)

      /* --- HUMOR CAMBIANTE: cada 8–30 s el conductor se replantea su prisa.
       * El valor deriva desde el anterior (nadie pasa de plácido a temerario
       * de golpe) y se recalcula la velocidad deseada con el límite del tramo
       * en el que esté. Esto hace que el tráfico respire: unos aprietan en la
       * recta y otros se descuelgan. */
      c.moodT -= dt
      if (c.moodT <= 0) {
        c.moodT = 8 + Math.random() * 22
        const deriva = (Math.random() - 0.5) * 0.55
        c.mood = Math.max(0, Math.min(1, c.mood + deriva))
        // un conprisa muy acelerado puede volverse corredor, y al revés
        if (esCivil(c.kind)) {
          if (c.kind === 'conprisa' && c.mood > 0.93) c.kind = 'corredor'
          else if (c.kind === 'corredor' && c.mood < 0.22) c.kind = 'conprisa'
          else if (c.kind === 'sinprisa' && c.mood > 0.88) c.kind = 'conprisa'
          else if (c.kind === 'conprisa' && c.mood < 0.12) c.kind = 'sinprisa'
        }
      }
      /* el ritmo se reevalúa continuamente: límite del tramo × humor × clima.
       * Con nieve o niebla el tráfico entero se compacta y rueda más lento,
       * igual que en una carretera real. */
      c.desired = this.paceFor(c.kind, limitAt(Math.floor(c.z / SEG)), c.mood, c.cargo)
        * this.weatherPace(c)

      /* --- ¿EL JUGADOR PIDE PASO? ----------------------------------------
       * Si lo llevamos pegado detrás, en su mismo carril y yendo nosotros más
       * rápido de lo que él puede ir, acumula "presión". Cada 4–7 s evalúa si
       * nos cede el paso (más probable cuanto más tiempo llevemos insistiendo).
       * Es exactamente lo que hace un buen conductor por el retrovisor. */
      const gapJ = c.z - this.pz
      const mismoCarril = Math.abs(c.x - this.x) < 0.3
      const pegado = gapJ > 0 && gapJ < 3200 + this.speed * 0.6
      if (mismoCarril && pegado && this.speed > c.speed - 120) {
        c.pressure += dt
      } else {
        c.pressure = Math.max(0, c.pressure - dt * 0.7)
      }

      c.checkT -= dt
      if (c.checkT <= 0) {
        c.checkT = 4 + Math.random() * 3                 // próxima consulta
        // a más presión acumulada, más probabilidad de apartarse
        if (c.pressure > 2.5 && c.intent === 0 && Math.random() < Math.min(0.9, c.pressure / 7)) {
          const der = c.lane - 1
          if (der >= 0 && this.laneFree(c.z, der, c.id)) {
            c.intent = 1                                  // se aparta a la derecha
            c.intentT = 0.5 + Math.random() * 0.4
          } else {
            // no puede apartarse: al menos levanta el pie para que le pasemos
            c.yielding = 2.5
            c.blinker = 1
          }
          c.pressure = 0
        }
      }

      // --- control longitudinal: mantener distancia de seguridad ---
      const lead = this.leader(c.z, c.lane, c.id)
      // los NPC SÍ respetan la señalización del tramo (ambientación viva)
      const limU = limitAt(Math.floor(c.z / SEG)) / 0.036
      let target = Math.min(c.desired, limU)
      /* BUG HISTÓRICO: aquí `yielding` hacía FRENAR al NPC. Si el jugador venía
       * por detrás pidiendo paso, el otro reducía — provocando el contacto y el
       * "enganche" eterno. Ceder el paso es APARTARSE, nunca frenar delante de
       * quien te empuja. Al evadir incluso acelera un poco para despejar antes. */
      if (c.evade > 0) target = Math.max(target, this.speed * 1.04)
      /* abrir hueco: acelera por encima del jugador para despegarse (con tope
       * razonable) · aflojar: se descuelga para romper la formación en muro */
      if (c.boost > 0) { c.boost -= dt; target = Math.max(target, Math.min(this.speed * 1.1, c.desired * 1.3)) }
      if (c.relax > 0) { c.relax -= dt; target = Math.min(target, c.desired * 0.82) }
      /* orden de despejar el corredor del jugador: aprieta de verdad */
      if (c.makeWay > 0) {
        c.makeWay -= dt
        target = Math.max(target, this.speed * 1.15, c.desired * 1.1)
      }

      /* --- PERSONALIDAD: los corredores y emergencias ignoran el límite --- */
      if (c.kind === 'corredor' || esEmergencia(c.kind)) target = c.desired
      /* --- emergencias y persecución --- */
      if (esEmergencia(c.kind)) {
        c.siren += dt
        if (c.kind === 'patrulla' && c.chasing) {
          const presa = this.cars.find((x) => x.id === c.chasing)
          if (!presa) { c.chasing = 0 }
          else if (c.pullover > 0) {
            // control en marcha: ambos se orillan a la derecha y frenan
            c.pullover -= dt
            presa.pullover = Math.max(presa.pullover, c.pullover)
            target = Math.min(target, 900)
            presa.lane = 0; c.lane = 0
            presa.blinker = 1; c.blinker = 1
            if (c.pullover <= 0) {
              // el corredor "aprende": sale del control con humor calmado
              presa.kind = 'conprisa'; presa.mood = 0.25; presa.moodT = 25
              presa.desired = this.paceFor('conprisa', limitAt(Math.floor(presa.z / SEG)), 0.25)
              c.chasing = 0; c.mood = 0.4
            }
          } else {
            // alcanzarlo: acelera hasta ponerse a su altura
            target = presa.speed * 1.25
            if (Math.abs(presa.z - c.z) < 1800) { c.pullover = 7; presa.pullover = 7 }
          }
        }
      }
      /* orillarse: el que está bajo control policial se va al arcén */
      if (c.pullover > 0 && !esEmergencia(c.kind)) {
        c.pullover -= dt
        c.lane = 0
        target = Math.min(target, 900)
        c.x += (1.12 - c.x) * Math.min(1, dt * 1.2)   // pisa el arcén derecho
      }

      /* --- CEDER EL PASO A EMERGENCIAS -----------------------------------
       * Si viene una sirena por detrás en nuestro carril nos apartamos. La
       * ambulancia TOCA LA BOCINA; si pese a ello seguimos estorbando (sin
       * hueco libre), nos EMBISTE lateralmente para abrirse paso. */
      if (!esEmergencia(c.kind) && c.pullover <= 0) {
        for (const e of this.cars) {
          if (!esEmergencia(e.kind) || (e.kind === 'patrulla' && !e.chasing)) continue
          const d = c.z - e.z
          if (d > 0 && d < 7000 && Math.abs(e.x - c.x) < 0.75) {
            const cerca = d < 2600
            if (cerca && e.kind === 'ambulancia') {
              e.honk = 0.9
              if (this.pzDist(e) < 14000) this.hornCue = 1     // se oye desde el coche
            }
            if (c.lane > 0 && c.intent === 0 && this.laneFree(c.z, c.lane - 1, c.id)) {
              c.intent = 1; c.intentT = 0.3
              c.ovPhase = 0                                     // aborta lo que hiciera
            }
            // se arrima dentro del carril; si está pegada, embestida lateral
            c.x += (laneCenter(c.lane) + 0.16 - c.x) * Math.min(1, dt * 1.8)
            if (cerca && d < 1500) c.nudge += 0.5 * dt
            target = Math.min(target, c.desired * 0.88)
            break
          }
        }
      }
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

      /* --- DECISIONES DE CARRIL -------------------------------------------
       * Secuencia realista: 1) detecta que le estorban · 2) comprueba que el
       * otro carril DE VERDAD le hace ganar velocidad · 3) señaliza ~0,8 s
       * antes · 4) solo entonces se desplaza. Si durante la señalización el
       * hueco se cierra, cancela y apaga el intermitente.
       * El paso 2 es clave: antes se cambiaban por cambiarse y acababan en
       * fila de a tres bloqueando la autopista. */
      const enCarril = Math.abs(c.x - laneCenter(c.lane)) < 0.05
      const maxLane = this.maxLaneFor(c)        // los camiones no pisan el carril rápido

      if (c.intent !== 0) {
        c.blinker = c.intent                    // sigue avisando mientras espera
        c.intentT -= dt
        const destino = c.lane + (c.intent < 0 ? 1 : -1)
        if (destino < 0 || destino > maxLane || !this.laneFree(c.z, destino, c.id)) {
          c.intent = 0; c.blinker = 0; c.cooldown = 1.5     // se cerró el hueco
        } else if (c.intentT <= 0) {
          c.lane = destino
          c.cooldown = c.intent < 0 ? 4 : 6.5
          c.intent = 0
        }
      } else if (c.ovPhase !== 0) {
        /* ============ MANIOBRA DE ADELANTAMIENTO EN CURSO =================
         * Fase 1: ya está en el carril de la izquierda y acelera para rebasar.
         * Fase 2: ha pasado con margen suficiente → se reincorpora delante.
         * `ovT` es un tiempo máximo: si la maniobra se eterniza, se cancela y
         * vuelve a la derecha (evita quedarse viviendo en el carril rápido). */
        c.ovT -= dt
        const presa = this.cars.find((x) => x.id === c.ovTarget) ?? null
        const margen = c.length + 900 + c.speed * 0.45

        if (c.ovPhase === 1) {
          // empuje para rebasar de verdad, nunca quedarse en paralelo
          target = Math.max(target, Math.min(c.desired * 1.12, (presa?.speed ?? c.desired) * 1.16))
          if (!presa || c.z > presa.z + margen || c.ovT <= 0) {
            c.ovPhase = 2
            c.blinker = 1                          // avisa que se reincorpora
          }
        } else {
          // fase 2: volver a la derecha en cuanto haya hueco real
          const der = c.lane - 1
          if (der >= 0 && this.laneFree(c.z, der, c.id)) {
            c.intent = 1
            c.intentT = 0.5 + Math.random() * 0.4
            c.ovPhase = 0; c.ovTarget = 0
          } else if (c.ovT <= -6) {
            c.ovPhase = 0; c.ovTarget = 0; c.blinker = 0
          }
        }
      } else if (c.cooldown <= 0 && enCarril && c.yielding <= 0 && c.pullover <= 0) {
        /* ============ ¿INICIAR UN ADELANTAMIENTO? =========================
         * Umbrales según personalidad: el corredor se cambia por cualquier
         * ganancia marginal y tolera huecos pequeños; el sinprisa y el camión
         * casi nunca abandonan la derecha; el conprisa adelanta si compensa. */
        const agresivo = c.kind === 'corredor' || esEmergencia(c.kind)
        const umbralEstorbo = agresivo ? 0.99 : c.kind === 'conprisa' ? 0.94 : 0.85
        const umbralGanancia = agresivo ? 1.02 : 1.07
        const prisaVuelta = agresivo ? 1.4 : c.kind === 'conprisa' ? 0.97 : 0.9

        const ritmoActual = this.lanePace(c, c.lane)
        const izq = c.lane + 1, der = c.lane - 1
        const estorbado = ritmoActual < c.desired * umbralEstorbo
        const casa = this.homeLane(c.kind, c.mood)

        if (estorbado && izq <= maxLane && this.laneFree(c.z, izq, c.id)
            && this.lanePace(c, izq) > ritmoActual * umbralGanancia) {
          // engancha la maniobra completa: señaliza, sale, pasa y se reincorpora
          const presa = this.leaderCar(c, c.lane)
          c.intent = -1
          c.intentT = agresivo ? 0.18 + Math.random() * 0.2 : 0.6 + Math.random() * 0.45
          if (presa) { c.ovTarget = presa.id; c.ovPhase = 1; c.ovT = 9 }
        } else if (der >= 0 && c.lane > casa && this.laneFree(c.z, der, c.id)
            && this.lanePace(c, der) >= c.desired * prisaVuelta) {
          // mantenerse a la derecha: vuelve a su carril natural
          c.intent = 1; c.intentT = 0.9 + Math.random() * 0.6
        } else if (estorbado && agresivo && c.lane === maxLane && Math.abs(c.x) < 1.0) {
          // temerario: si no hay carril libre, bordea el límite de la calzada
          c.x -= 0.22 * dt
        }
      }

      /* --- EVASIÓN: apartarse conduciendo (sin saltos de carril) --- */
      if (c.evade > 0) {
        c.evade -= dt
        const destino = c.lane + (c.evadeDir > 0 ? -1 : 1)
        if (destino >= 0 && destino <= maxLane && this.laneFree(c.z, destino, c.id)) {
          c.lane = destino
          c.cooldown = 2.5
        }
        if (c.evade <= 0) c.evadeDir = 0
      }

      /* --- empujón residual del golpe: desplaza poco y se disipa --- */
      if (c.nudge !== 0) {
        c.x += c.nudge * dt
        c.nudge *= Math.max(0, 1 - dt * 4.5)
        if (Math.abs(c.nudge) < 0.004) c.nudge = 0
      }

      const tx = laneCenter(c.lane)
      // el muelle de carril lo devuelve a su sitio tras el empujón
      c.x += (tx - c.x) * Math.min(1, (c.evade > 0 ? 3.4 : 2.4) * dt)
      // tope: jamás se va fuera de la calzada por un golpe
      c.x = Math.max(-1.08, Math.min(1.08, c.x))
      // el intermitente se apaga al completar el desplazamiento, no antes
      if (c.intent === 0 && Math.abs(tx - c.x) < 0.02 && c.yielding <= 0) c.blinker = 0
    }

    // --- reciclado: fuera de la ventana de interés ---
    const back = this.z - 9000
    const front = this.z + DRAW * SEG * 1.15
    for (const c of this.cars) {
      if (c.z < back || c.z > front) {
        // reaparece delante (o detrás si es un coche rápido que nos alcanzará)
        const detras = Math.random() < 0.3
        const kind = this.rollKind()
        const truck = kind === 'camion'
        const cargo = truck ? Math.random() : 0
        const mood = kind === 'corredor' ? 0.6 + Math.random() * 0.4
          : kind === 'sinprisa' ? Math.random() * 0.5
          : Math.random()
        const lane = detras && !truck ? LANES - 1 : this.homeLane(kind, mood)
        c.kind = kind
        c.truck = truck
        c.cargo = cargo
        c.mood = mood
        c.moodT = 8 + Math.random() * 22
        c.lane = lane
        c.x = laneCenter(lane)
        c.z = detras ? this.z - 7000 - Math.random() * 4000 : this.z + DRAW * SEG * (0.75 + Math.random() * 0.35)
        c.length = truck ? 1500 : esEmergencia(kind) ? 760 : 620
        c.width = truck ? 480 : esEmergencia(kind) ? 420 : 380
        c.desired = this.paceFor(kind, limitAt(Math.floor(c.z / SEG)), mood, cargo)
        c.speed = c.desired
        c.color = kind === 'ambulancia' ? 7 : kind === 'patrulla' ? 8 : Math.floor(Math.random() * 7)
        c.siren = 0
        c.chasing = 0
        c.pullover = 0
        c.ahead = c.z > this.z
        c.blinker = 0
        c.intent = 0
        c.intentT = 0
        c.yielding = 0
        c.cooldown = Math.random() * 3
        c.nudge = 0
        c.boost = 0
        c.relax = 0
        c.evade = 0
        c.pressure = 0
        c.ovPhase = 0
        c.ovTarget = 0
        c.ovT = 0
        c.honk = 0
        c.abreast = 0
        c.makeWay = 0
        /* ESCALONADO AL REAPARECER: si cae a la altura de otro coche en un
         * carril contiguo, lo separamos medio largo. Evita que el tráfico
         * nazca ya formando una barrera. */
        for (const o of this.cars) {
          if (o.id === c.id || Math.abs(o.lane - c.lane) > 1) continue
          if (Math.abs(o.z - c.z) < 2200) { c.z += 2600 + Math.random() * 1800; break }
        }
      }
    }

    /* --- las patrullas buscan corredores cerca y los persiguen --- */
    for (const p of this.cars) {
      if (p.kind !== 'patrulla' || p.chasing || p.pullover > 0) continue
      const presa = this.cars.find((x) =>
        x.kind === 'corredor' && x.pullover <= 0 &&
        Math.abs(x.z - p.z) < 12000)
      // solo las patrullas con prisa salen a perseguir; las de ronda, no
      if (presa && p.mood > 0.5) { p.chasing = presa.id; p.mood = 1 }
    }

    // densidad viva: de vez en cuando entra alguien nuevo si hay poco tráfico
    this.spawnAcc += dt
    // la super carretera mueve mucho más tráfico que la ruta
    const aforo = this.superMode ? 38 : 20
    if (this.spawnAcc > (this.superMode ? 1.2 : 3) && this.cars.length < aforo) {
      this.spawnAcc = 0
      if (Math.random() < 0.7) this.spawn(DRAW * SEG * 0.9)
    }
  }

  /* ----------------------------- ACTUALIZACIÓN ---------------------------- */
  update(dt: number, input: Input) {
    this.time += dt
    this.braking = input.brake

    /* --- volante: sigue al dedo y vuelve solo al centro al soltar --- */
    const objetivo = input.steering ? input.steer : 0
    const k = input.steering ? STEER_ATTACK : RETURN_RATE
    this.steer += (objetivo - this.steer) * Math.min(1, k * dt)
    if (!input.steering && Math.abs(this.steer) < 0.004) this.steer = 0

    /* ---- METEOROLOGÍA: cada fenómeno afecta de una forma distinta -------
     * lluvia → frenadas largas · nieve → poquísimo agarre · polvo → agarre
     * algo menor y aire turbio · niebla → no toca el agarre pero ciega. */
    const w = weatherAt(this.km)
    this.weather = w.kind
    const obj = (k: WeatherKind) => (w.kind === k ? w.power : 0)
    const suave = (cur: number, o: number) => cur + (o - cur) * Math.min(1, dt * 0.35)
    this.rain = suave(this.rain, obj('lluvia'))
    this.snow = suave(this.snow, obj('nieve'))
    this.dust = suave(this.dust, obj('tierra'))
    this.mist = suave(this.mist, obj('niebla'))
    this.wx = Math.max(this.rain, this.snow, this.dust, this.mist)
    this.grip = Math.max(0.58, 1 - (this.rain * 0.22 + this.snow * 0.36 + this.dust * 0.12))
    this.visibility = Math.max(0.18,
      1 - (this.mist * 0.75 + this.snow * 0.4 + this.dust * 0.45 + this.rain * 0.25))

    /* AQUAPLANING: la lámina de agua levanta las ruedas del asfalto a partir
     * de cierta velocidad. Por debajo de ~110 km/h no ocurre; por encima
     * crece rápido y el coche deja de responder al volante. */
    const vKmh = kmh(this.speed)
    this.aquaplane = this.rain > 0.5
      ? clamp01((vKmh - 140) / 70) * clamp01((this.rain - 0.5) / 0.4) * 0.7
      : 0

    /* VIENTO LATERAL: racha lenta que empuja el coche de costado. Amplitud
     * moderada — se corrige con un toque de volante, no te saca del carril. */
    const rachaObj = (this.dust * 0.22 + this.mist * 0.05)
      * Math.sin(this.time * 0.37) * Math.sin(this.time * 0.11 + 1.3)
    this.crossWind += (rachaObj - this.crossWind) * Math.min(1, dt * 0.8)

    /* ---- FRENADA Y TRACCIÓN SOBRE FIRME DESLIZANTE ----------------------
     * Frenar: la distancia se alarga de verdad. Con nieve el freno entrega
     * poco más de la mitad, y sobre lámina de agua (aquaplaning) las ruedas
     * casi no muerden. Además el ABS "pulsa" cuando pides más de lo que el
     * neumático puede dar: se nota en el pedal como una vibración.
     * Acelerar: patinan las ruedas motrices, así que la salida es lenta. */
    const firme = this.grip * (1 - this.aquaplane * 0.45)
    if (input.brake) {
      this.speed -= BRAKE * firme * dt
      if (firme < 0.8 && this.speed > 500) {
        this.slide = Math.min(1, this.slide + dt * 1.8)
        // pulso del ABS: micro-vibración discreta al límite de adherencia
        this.shake = Math.min(0.32, this.shake + (1 - firme) * dt * 1.1)
      }
    } else if (input.throttle) {
      // patinaje de salida: a baja velocidad el firme malo roba algo de tracción
      const patina = 1 - (1 - firme) * (1 - Math.min(1, this.speedPct * 2.5)) * 0.45
      this.speed += ACCEL * (1 - 0.62 * this.speedPct) * (0.82 + 0.18 * firme) * patina * dt
      if (firme < 0.72 && this.speedPct < 0.22) this.slide = Math.min(1, this.slide + dt * 1.1)
    } else {
      this.speed -= DRAG * dt
    }
    this.slide = Math.max(0, this.slide - dt * 1.4)

    /* ---- LIMITADOR DEL MOTOR -------------------------------------------
     * Solo señaliza que el coche llegó a su techo (lo lee la barra de
     * revoluciones del HUD). Sin temblor ni cortes bruscos: la velocidad ya
     * se estanca sola por la resistencia aerodinámica. */
    this.revLimit = input.throttle && this.speedPct > 0.96
      ? Math.min(1, this.revLimit + dt * 6)
      : Math.max(0, this.revLimit - dt * 3)

    /* --- banquina: se puede pisar, pero frena y vibra (sin castigo real) --- */
    const fuera = Math.abs(this.x) > 1
    if (fuera) {
      if (this.speed > OFFROAD_MAX) this.speed -= OFFROAD_DECEL * dt
      this.shake = Math.min(1, this.shake + dt * 4)
    } else {
      this.shake = Math.max(0, this.shake - dt * 3)
    }
    this.speed = Math.max(0, Math.min(MAX_SPEED, this.speed))

    /* --- DIRECCIÓN ------------------------------------------------------
     * Un coche no se traslada de lado: las ruedas giran, pero el coche solo
     * cambia de trayectoria SI AVANZA. El desplazamiento lateral es
     * proporcional a la velocidad hasta ~43 km/h y a partir de ahí se
     * estabiliza (de lo contrario a 200 km/h sería incontrolable).
     * Antes el factor tenía un suelo de 0,55 y se podía desplazar el coche
     * parado girando el volante — impropio de un simulador. */
    const pct = this.speedPct
    const rodando = Math.min(1, this.speed / 1200)      // 0 parado · 1 ≳43 km/h

    /* ---- SUBVIRAJE: el tren delantero deja de morder -------------------
     * Con firme deslizante, cuanto MÁS volante pides, menos te hace caso el
     * coche. Es la sensación clásica de la nieve: giras y sigues recto.
     * Sobre lámina de agua la dirección se queda casi sin efecto. */
    const exigencia = Math.abs(this.steer) * (0.35 + 0.65 * pct)
    const objUnder = clamp01((1 - firme) * 0.85 * exigencia + this.aquaplane * 0.5)
    this.understeer += (objUnder - this.understeer) * Math.min(1, dt * 3.5)
    /* La autoridad nunca baja del 62 %: se nota que el coche va "flojo" y
     * hay que anticipar, pero SIEMPRE se puede cambiar de carril. Un
     * simulador se siente exigente, no bloqueado. */
    const autoridad = 1 - this.understeer * 0.38

    this.x += this.steer * STEER_RATE * (0.45 + 0.55 * Math.min(1, pct * 2.4))
      * rodando * autoridad * dt

    /* ---- VIENTO LATERAL: hay que corregir constantemente --------------- */
    if (this.crossWind !== 0) this.x += this.crossWind * (0.25 + pct * 0.75) * dt

    // al perder adherencia el coche se descoloca un poco: obliga a corregir,
    // pero con una amplitud contenida para que no sea errático
    if (this.understeer > 0.4 && pct > 0.35) {
      this.slide = Math.max(this.slide, this.understeer * 0.6)
      this.wobble += (Math.random() - 0.5) * this.understeer * 0.4 * dt
    }
    /* --- fuerza centrífuga: hay que apoyar el volante en las curvas ---
     *     con asfalto mojado empuja más hacia fuera (menos agarre) --- */
    this.x -= this.curve * pct * pct * CENTRIFUGAL * (1 + (1 - this.grip) * 0.6) * dt
    /* descontrol residual del roce: empuja el coche y se amortigua solo.
     * También depende de que el coche esté rodando (si está parado no derrapa). */
    if (this.wobble !== 0) {
      this.x += this.wobble * rodando * dt
      this.wobble *= Math.max(0, 1 - dt * 2.4)
      if (Math.abs(this.wobble) < 0.002) this.wobble = 0
    }
    /* rebote del golpe: desplaza poco y se disipa en ~0,4 s */
    if (this.nudgeSelf !== 0) {
      this.x += this.nudgeSelf * dt
      this.nudgeSelf *= Math.max(0, 1 - dt * 5)
      if (Math.abs(this.nudgeSelf) < 0.002) this.nudgeSelf = 0
    }
    this.x = Math.max(-1.32, Math.min(1.32, this.x))

    /* --- CONTACTO: nunca hay choque destructivo, y SOBRE TODO nunca un
     * "enganche eterno". Si al cambiar de carril tocamos a alguien por detrás,
     * ese conductor levanta el pie (`yielding`), señaliza y se aparta, mientras
     * nosotros frenamos solo lo justo. Resultado: se abre hueco en ~1 s y la
     * situación se resuelve sola, como en el tránsito real. --- */
    /* --- COLISIÓN SÓLIDA -------------------------------------------------
     * Los vehículos son CUERPOS IMPENETRABLES: no se atraviesan nunca. Se
     * resuelve como en un motor de física 2D — se mide la penetración en cada
     * eje y se corrige por el EJE DE MENOR PENETRACIÓN:
     *   · eje Z (vamos detrás/delante) → reposicionamiento duro + igualar
     *     velocidad (parachoques contra parachoques, sin traspaso).
     *   · eje X (estamos a la par)     → separación lateral hasta despegarse.
     * Sigue sin haber daños ni derrota: es un contacto de tráfico urbano.
     * ------------------------------------------------------------------- */
    /* --- CONTACTO SIN FÍSICA RÍGIDA --------------------------------------
     * Nada de reposicionar posiciones (eso causaba el "enganche": el jugador
     * quedaba clavado contra un coche que además frenaba). El roce ahora es un
     * EVENTO DE CONDUCCIÓN:
     *   · pierdes el control → temblor y el volante se va solo (`wobble`)
     *   · pierdes velocidad progresivamente (rozamiento)
     *   · el NPC ejecuta una EVASIÓN: se aparta del carril y acelera para
     *     despejar, así que el bloqueo siempre se resuelve.
     * ------------------------------------------------------------------- */
    this.courtesy = Math.max(0, this.courtesy - dt)
    this.contact = Math.max(0, this.contact - dt)
    for (const c of this.cars) {
      /* --- SOLAPE EN LOS DOS EJES (caja orientada: LARGO × ANCHO) --------
       * `dz` se mide entre CENTROS de volumen, usando la posición real del
       * coche (`pz`), no la de la cámara. Si los dos semilargos se solapan
       * Y los dos semianchos también, hay contacto. */
      const dz = c.z - this.pz
      const halfZ = (c.length + PLAYER_L) / 2
      if (Math.abs(dz) >= halfZ) continue
      const lat = c.x - this.x
      const halfX = (c.width + PLAYER_W) / ROAD_W
      if (Math.abs(lat) >= halfX) continue

      const solapeX = 1 - Math.abs(lat) / halfX          // 0 rozando · 1 encajados
      const solapeZ = 1 - Math.abs(dz) / halfZ
      const dir = (Math.sign(lat) || 1) as -1 | 1
      const frontal = dz > 0                              // lo tenemos delante
      this.contact = 0.8
      this.courtesy = 0.6
      this.score = Math.max(0, this.score - 9 * dt)

      /* --- pérdida de control: vibración + desvío del volante --- */
      this.shake = Math.min(1, this.shake + dt * 5)
      this.wobble += (Math.random() - 0.5) * 3.2 * dt

      /* --- EMPUJÓN CONTENIDO -------------------------------------------
       * El golpe transmite un impulso lateral pequeño (`nudge`), amortiguado
       * y limitado: el otro coche "se mueve un poco", se tambalea y vuelve a
       * su carril. Nada de salir disparado ni teletransportarse. */
      const impulso = Math.min(0.55, 0.18 + solapeX * 0.5)
      c.nudge += dir * impulso * Math.min(1, dt * 9)
      this.nudgeSelf -= dir * impulso * 0.45 * Math.min(1, dt * 9)

      if (solapeX > 0.45) {
        /* ======= IMPACTO LONGITUDINAL (alineados en el mismo carril) ===== */
        if (frontal) {
          // alcanzamos al de delante: frenamos contra su parachoques
          const objetivo = c.speed * 0.92
          if (this.speed > objetivo) {
            this.speed -= (this.speed - objetivo) * Math.min(1, (2.2 + solapeZ * 5) * dt)
          }
          c.pressure += dt * 2.5                 // entiende que le pedimos paso
        } else {
          // nos alcanzan por detrás: él levanta, nosotros ganamos impulso
          c.speed = Math.min(c.speed, this.speed * 0.93)
          this.speed += 300 * solapeZ * dt
        }
      } else {
        /* ============ ROCE LATERAL (costado con costado) ================= */
        this.speed -= this.speed * (0.45 + solapeX * 0.9) * dt
      }

      /* --- el NPC reacciona, pero CONDUCIENDO: no salta de carril ---
       * Se apunta la intención y se adelanta su próxima evaluación de
       * cortesía, de modo que se aparte con intermitente y de forma legible. */
      c.evadeDir = dir
      c.pressure = Math.max(c.pressure, 4)
      c.checkT = Math.min(c.checkT, 0.35)
      this.barrierT = Math.min(this.barrierT, 0.2)   // revisar huecos ya mismo
    }

    this.z += this.speed * dt
    this.dist += this.speed * dt

    /* --- adelantamientos: contamos a quién dejamos atrás --- */
    for (const c of this.cars) {
      if (c.ahead && c.z < this.pz) { this.overtakes++; c.ahead = false }
      else if (!c.ahead && c.z > this.pz + 600) c.ahead = true
    }

    /* --- ritmo: premia ir suave y lejos de la banquina --- */
    const conduceSuave = !input.brake && !fuera && this.courtesy === 0
    this.flow += ((conduceSuave ? 1 : 0.25) - this.flow) * Math.min(1, dt * 0.6)

    /* el ancho de calzada se interpola: la vía "se abre" al incorporarse */
    if (Math.abs(ROAD_W - this.roadWTarget) > 1) {
      setRoadWidth(ROAD_W + (this.roadWTarget - ROAD_W) * Math.min(1, dt * 1.6))
    }

    this.updateJunction(dt)
    this.updateDynamics(dt)
    this.updateCompliance(dt, fuera)
    this.relieveBarrier(dt)
    this.updateTraffic(dt)
    this.updateGear()
  }

  /** Hueco libre por delante del jugador en cada carril (unidades de mundo). */
  private laneGaps(): number[] {
    const gaps = new Array<number>(LANES).fill(Infinity)
    for (const c of this.cars) {
      if (c.lane < 0 || c.lane >= LANES) continue
      const d = c.z - this.pz
      if (d > -600 && d < gaps[c.lane]) gaps[c.lane] = Math.max(0, d)
    }
    return gaps
  }

  /* ----------------- REGLA ANTI-PELOTÓN (prevención) ---------------------
   * El 90 % de los bloqueos nacen de coches rodando EN PARALELO a la misma
   * velocidad. En lugar de esperar al muro, los detectamos en cuanto se
   * emparejan: si dos vehículos llevan más de ~2,5 s costado con costado, el
   * que tiene menos prisa afloja un poco y el que tiene más aprieta, de modo
   * que se escalonan solos. Es lo que hace el tráfico real sin pensarlo.
   * --------------------------------------------------------------------- */
  private unclump(dt: number) {
    for (let i = 0; i < this.cars.length; i++) {
      const a = this.cars[i]
      if (a.pullover > 0 || esEmergencia(a.kind)) continue
      for (let j = i + 1; j < this.cars.length; j++) {
        const b = this.cars[j]
        if (b.pullover > 0 || esEmergencia(b.kind)) continue
        if (Math.abs(a.lane - b.lane) !== 1) continue
        // ¿se solapan longitudinalmente? (van a la par)
        if (Math.abs(a.z - b.z) > (a.length + b.length) * 0.75) continue
        // ¿a ritmo casi idéntico? entonces nunca se separarán solos
        if (Math.abs(a.speed - b.speed) > 220) continue

        a.abreast += dt
        b.abreast += dt
        if (a.abreast > 2.5) {
          // el de menos prisa cede el ritmo; el de más prisa aprieta
          const lento = a.desired <= b.desired ? a : b
          const rapido = lento === a ? b : a
          lento.relax = Math.max(lento.relax, 1.6)
          rapido.boost = Math.max(rapido.boost, 1.6)
          a.abreast = 0
          b.abreast = 0
        }
      }
    }
    // el contador decae si dejan de ir emparejados
    for (const c of this.cars) c.abreast = Math.max(0, c.abreast - dt * 0.35)
  }

  /* ------------------- VERIFICACIÓN DE HUECOS (anti-barrera) -------------
   * Problema clásico del tráfico simulado: tres coches a velocidad parecida
   * acaban en línea ocupando los tres carriles y forman un muro rodante que
   * tapona al jugador indefinidamente.
   * Cada 1,2 s comprobamos si existe ALGÚN carril con hueco suficiente para
   * pasar. Si no lo hay, deshacemos la formación de manera natural: el coche
   * del carril más rápido acelera para despegarse y el del más lento afloja,
   * de modo que se escalonan y se abre una diagonal por la que colarse.
   * --------------------------------------------------------------------- */
  private relieveBarrier(dt: number) {
    /* `unclump` es O(n²) y con 38 coches son ~700 comparaciones: no hace falta
     * cada frame. Se ejecuta 5 veces por segundo, suficiente para detectar
     * emparejamientos de 2,5 s sin costar apenas CPU. */
    this.unclumpAcc += dt
    if (this.unclumpAcc > 0.2) {
      this.unclump(this.unclumpAcc)
      this.unclumpAcc = 0
    }

    /* ---- GARANTÍA DE CORREDOR (corrección con escalada) -----------------
     * Regla de oro del juego: SIEMPRE debe existir un camino por delante.
     * Medimos el hueco de cada carril cada frame; si el mejor no alcanza
     * para pasar, sube `blockT`. Cuanto más tiempo lleve el jugador sin ruta,
     * más enérgica es la intervención sobre el carril más prometedor:
     *   >1,5 s  aviso suave: el tapón acelera un poco
     *   >3,0 s  orden de despejar: cambia de carril señalizando
     *   >5,0 s  prioridad total: se aparta sí o sí y los demás le abren
     * Es invisible para el jugador: solo nota que el tráfico "se abre". */
    const gaps = this.laneGaps()
    const necesario = PLAYER_L + 1100 + this.speed * 1.0
    let mejor = 0, mejorGap = -1
    for (let l = 0; l < LANES; l++) if (gaps[l] > mejorGap) { mejorGap = gaps[l]; mejor = l }
    this.blockedAll = mejorGap < necesario

    if (this.blockedAll) {
      this.blockT += dt
      // el carril objetivo: el que más hueco tiene (el más fácil de abrir)
      const tapon = this.cars.find((c) =>
        c.lane === mejor && c.z - this.pz > -600 && c.z - this.pz <= mejorGap + 400)
      if (tapon && this.blockT > 1.5) {
        tapon.makeWay = Math.max(tapon.makeWay, 1.2)
        tapon.boost = Math.max(tapon.boost, 1.2)
        tapon.abreast = 0
        if (this.blockT > 3) {
          // que se quite: busca cualquier carril contiguo con sitio
          const opciones = [tapon.lane - 1, tapon.lane + 1]
            .filter((l) => l >= 0 && l <= this.maxLaneFor(tapon))
          const destino = opciones.find((l) => this.laneFree(tapon.z, l, tapon.id))
          if (destino !== undefined && tapon.intent === 0) {
            tapon.intent = destino < tapon.lane ? 1 : -1
            tapon.intentT = 0.25
            tapon.ovPhase = 0
          }
        }
        if (this.blockT > 5 && tapon.intent === 0) {
          // última instancia: se desplaza aunque el carril no esté perfecto,
          // y sus vecinos le hacen sitio (efecto cremallera)
          const dir = tapon.lane > 0 ? -1 : 1
          const destino = tapon.lane + dir
          for (const o of this.cars) {
            if (o.lane === destino && Math.abs(o.z - tapon.z) < 3500) {
              o.relax = Math.max(o.relax, 1.5)
              o.nudge += (dir > 0 ? 0.28 : -0.28) * dt
            }
          }
          tapon.lane = Math.max(0, Math.min(this.maxLaneFor(tapon), destino))
          tapon.blinker = dir > 0 ? -1 : 1
          tapon.cooldown = 3
          this.blockT = 2                 // damos margen a que la maniobra cuaje
        }
      }
    } else {
      this.blockT = Math.max(0, this.blockT - dt * 2)
    }

    this.barrierT -= dt
    if (this.barrierT > 0) return
    this.barrierT = 1.2

    // hueco necesario: el coche + distancia de seguridad a la velocidad actual
    const necesarioTramo = PLAYER_L + 900 + this.speed * 0.9
    const ventana = 4200 + this.speed * 1.2

    let huecoMax = 0
    const tapones: (TrafficCar | null)[] = []
    for (let l = 0; l < LANES; l++) {
      let gap = Infinity
      let quien: TrafficCar | null = null
      for (const c of this.cars) {
        if (c.lane !== l) continue
        const d = c.z - this.pz
        if (d > 0 && d < gap) { gap = d; quien = c }
      }
      // solo cuenta como tapón si está cerca Y va más lento que nosotros
      const tapona = quien !== null && gap < ventana && quien.speed < this.speed - 90
      tapones[l] = tapona ? quien : null
      if (!tapona) huecoMax = Math.max(huecoMax, gap === Infinity ? 1e9 : gap)
      else huecoMax = Math.max(huecoMax, gap)
    }

    const cerrados = tapones.filter(Boolean).length

    // ¿hay por dónde pasar? entonces no tocamos nada: que el jugador maniobre
    if (huecoMax >= necesarioTramo) return
    if (cerrados < LANES) return

    /* ---- MURO DETECTADO: desalojo ordenado por personalidad -------------
     * Como en la vida real, el orden lo marca quién tiene más prisa:
     *   1. Los CORREDORES tiran primero por la izquierda (boost largo).
     *   2. Los CONPRISA los siguen, escalonados medio segundo después.
     *   3. Los SINPRISA se repliegan a la derecha, que es su sitio, y aflojan
     *      para abrir la diagonal.
     * Así la formación se deshace en abanico en lugar de a la vez. */
    const bloqueantes = tapones.filter((c): c is TrafficCar => c !== null)
    const prioridad = (c: TrafficCar) =>
      esEmergencia(c.kind) ? 0 : c.kind === 'corredor' ? 1 : c.kind === 'conprisa' ? 2 : 3
    bloqueantes.sort((a, b) => prioridad(a) - prioridad(b) || b.lane - a.lane)

    bloqueantes.forEach((c, orden) => {
      const p = prioridad(c)
      if (p <= 2) {
        // tienen prisa: que tiren hacia delante y despejen, escalonados
        c.boost = 2.8 + orden * 0.5
        c.pressure = Math.max(c.pressure, 5)
        if (c.lane < LANES - 1 && this.laneFree(c.z, c.lane + 1, c.id) && c.intent === 0) {
          c.intent = -1
          c.intentT = 0.25 + orden * 0.3
        }
      } else {
        // sin prisa: su sitio es la derecha, que se repliegue y afloje
        c.relax = 2.6
        if (c.lane > 0 && this.laneFree(c.z, c.lane - 1, c.id) && c.intent === 0) {
          c.intent = 1
          c.intentT = 0.4
        }
      }
    })
  }

  /* ------------------- CONDUCCIÓN RESPONSABLE Y EVALUACIÓN ---------------- */
  private updateCompliance(dt: number, fuera: boolean) {
    const i = Math.floor(this.z / SEG)
    this.limit = limitAt(i)
    // informativo para el HUD (sin consecuencias: no hay multas ni castigo)
    this.speeding = kmh(this.speed) > this.limit + 6

    /* intermitente: se apaga solo pasados unos segundos */
    if (this.blinker !== 0) {
      this.blinkerT -= dt
      this.lastSignal = this.blinker
      this.signalAge = 0
      if (this.blinkerT <= 0) this.blinker = 0
    } else {
      this.signalAge += dt
    }

    /* ángulo muerto: vehículo a la par, en carril contiguo */
    this.blindSpot = 0
    for (const c of this.cars) {
      const dz = c.z - this.pz
      if (dz > -1500 && dz < 900) {
        const lat = c.x - this.x
        if (Math.abs(lat) > 0.18 && Math.abs(lat) < 0.95) {
          this.blindSpot = lat < 0 ? -1 : 1
          break
        }
      }
    }

    /* cambio de carril: ¿lo señalizó antes? */
    const lane = this.playerLane()
    if (lane >= 0 && lane !== this.prevLane) {
      const dir = lane > this.prevLane ? -1 : 1   // sube de índice = izquierda
      const avisado = this.lastSignal === dir && this.signalAge < 3.5
      this.score += avisado ? 2.5 : -6
      this.prevLane = lane
    }

    /* Evaluación continua. NOTA DE DISEÑO: el límite de velocidad es
     * AMBIENTACIÓN — lo respetan los NPC, pero el jugador es libre de ir a su
     * ritmo y NO se le penaliza por ello. Solo se valora la convivencia:
     * señalizar, mantenerse en calzada y no pegarse al de delante. */
    let delta = 1.1                                    // recuperación base
    if (fuera) delta -= 4
    if (this.courtesy > 0) delta -= 2.5
    this.score = Math.max(0, Math.min(100, this.score + delta * dt))
  }

  /** Activa el intermitente (o lo cancela si se vuelve a pulsar). */
  setBlinker(dir: -1 | 1) {
    this.blinker = this.blinker === dir ? 0 : dir
    this.blinkerT = 6
  }

  /** Vehículos por detrás, ordenados de lejos a cerca → retrovisor. */
  behind(maxDist = 16000) {
    return this.cars
      .filter((c) => c.z < this.pz && this.pz - c.z < maxDist)
      .sort((a, b) => a.z - b.z)
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

  /** Bocina de ambulancia: dos tonos en quinta, como un claxon real. */
  horn() {
    const a = this.ctx
    if (!a || this.muted) return
    const t = a.currentTime
    for (const f of [440, 660]) {
      const o = a.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f
      const lp = a.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1800
      const g = a.createGain()
      g.gain.setValueAtTime(0.0001, t)
      g.gain.exponentialRampToValueAtTime(0.05, t + 0.02)
      g.gain.setValueAtTime(0.05, t + 0.42)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.55)
      o.connect(lp); lp.connect(g); g.connect(a.destination)
      o.start(t); o.stop(t + 0.6)
    }
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
  update(
    rpm: number, speedPct: number, throttle: boolean,
    lateralG = 0, offroad = 0, revLimit = 0, weather = 0,
  ) {
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
      /* chirrido de neumáticos + rodadura mojada: con lluvia o nieve el
       * ruido de las ruedas sobre el agua es constante y delata el firme. */
      const carga = Math.max(0, lateralG - 0.38) * speedPct
      const agua = weather * speedPct * 0.05
      this.tireGain.gain.setTargetAtTime(
        vol * (carga * 0.11 + offroad * 0.05 * speedPct + agua), t, 0.1)
    }
    /* El limitador NO altera el sonido: el motor suena natural a tope de
     * vueltas, que resulta mucho más creíble que un corte sintético. */
    void revLimit
  }

  stop() {
    if (!this.ctx || !this.gain || !this.windGain) return
    const t = this.ctx.currentTime
    this.gain.gain.setTargetAtTime(0, t, 0.1)
    this.windGain.gain.setTargetAtTime(0, t, 0.1)
  }
}
