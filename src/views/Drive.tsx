/* ============================================================================
 * Drive.tsx — CAPA DE JUEGO (canvas + controles táctiles + HUD)
 * ----------------------------------------------------------------------------
 * Diseñado para móvil EN VERTICAL y, sobre todo, para una sola mano:
 *   · VOLANTE  → arrastrar el dedo en la zona inferior izquierda; al soltar
 *     vuelve solo al centro (muelle en el motor, no en la UI).
 *   · PEDALES  → columna derecha. La TRABA (cruise) mantiene el acelerador
 *     pisado para poder conducir solo con el pulgar del volante.
 *   · Caja automática: no hay embrague ni marchas que tocar.
 * El bucle usa dt real acotado; React solo pinta HUD a ~12 fps (el canvas va
 * a 60) para no re-renderizar el árbol en cada frame.
 * ==========================================================================*/
import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Gauge, Volume2, VolumeX, Pause, Play, Lock, LockOpen, ChevronUp, ChevronDown,
  Milestone, Navigation, Timer as TimerIcon, Car, ChevronLeft, ChevronRight,
  CloudRain, ShieldCheck, Users, Hand, Snowflake, CloudFog, Wind, TriangleAlert,
} from 'lucide-react'
import { Game, EngineAudio, kmh, MAX_SPEED, WEATHER_LABEL } from '@/game/engine'
import type { WeatherKind } from '@/game/engine'
import { render } from '@/game/render'
import { cn } from '@/utils/cn'

type Fase = 'intro' | 'corriendo' | 'pausa'
/* Recorrido del dedo hasta el tope de giro. Se adapta al ancho real de la
 * pantalla (≈22 %, acotado) para que el gesto sea igual de cómodo en un móvil
 * pequeño que en una tablet. Corto = reacción inmediata; la curva de respuesta
 * devuelve la precisión cerca del centro. */
const dragFor = (w: number) => Math.max(62, Math.min(110, w * 0.22))

/** Curva de respuesta del volante: suave al inicio (correcciones finas de
 *  carril) y lineal al final (maniobras rápidas). |x|^1.35 conserva el signo. */
const steerCurve = (d: number) => {
  const c = Math.max(-1, Math.min(1, d))
  return Math.sign(c) * Math.pow(Math.abs(c), 1.35)
}

const fmtTime = (s: number) => {
  const m = Math.floor(s / 60)
  return `${String(m).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`
}

export default function Drive() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const gameRef = useRef<Game>(new Game())
  const audioRef = useRef<EngineAudio>(new EngineAudio())
  const inputRef = useRef({ steer: 0, steering: false, throttle: false, brake: false })
  const faseRef = useRef<Fase>('intro')
  const rafRef = useRef(0)

  const [fase, setFase] = useState<Fase>('intro')
  const [lock, setLock] = useState(false)       // traba del acelerador (crucero)
  const [muted, setMuted] = useState(false)
  /** Lado de los pedales: 'der' (diestro) · 'izq' (zurdo). Se recuerda. */
  const [lado, setLado] = useState<'izq' | 'der'>(() => {
    try { return localStorage.getItem('ruta-lado') === 'izq' ? 'izq' : 'der' } catch { return 'der' }
  })
  const [hud, setHud] = useState({
    km: 0, vel: 0, gear: 1, time: 0, ovt: 0, flow: 1, rpm: 0, shift: 0,
    limit: 120, speeding: false, rain: 0, score: 100, blinker: 0 as -1 | 0 | 1,
    blocked: false, zona: '',
    fork: 9999, forkSide: 1 as -1 | 1, onFork: false,
    superMode: false, flash: 0, cue: '',
    weather: 'seco' as WeatherKind, wx: 0, grip: 1, revLimit: 0,
    slide: 0, aqua: 0,
  })

  const lockRef = useRef(lock); lockRef.current = lock
  const steerTouch = useRef<{ id: number; x0: number } | null>(null)
  const lastBuzz = useRef(0)
  const dragRef = useRef(84)

  /* ---- ENTRADAS INDEPENDIENTES -----------------------------------------
   * Teclado y puntero se guardan por separado y se fusionan en el bucle.
   * Antes compartían `inputRef`, así que un puntero mal soltado dejaba
   * `steering = true` y pisaba el volante del teclado en cada movimiento. */
  const pointerSteer = useRef<number | null>(null)   // null = sin dedo/ratón
  const keySteer = useRef<number | null>(null)       // null = sin tecla
  const keyThrottle = useRef(false)
  const keyBrake = useRef(false)
  /** Punto donde el jugador agarró el volante virtual (para el anillo guía). */
  const [grab, setGrab] = useState({ on: false, x: 0, y: 0 })

  /* ---------------------------- bucle principal --------------------------- */
  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    const ctx = cv.getContext('2d', { alpha: false })
    if (!ctx) return

    let W = 0, H = 0
    const resize = () => {
      // Canvas 2D a DPR 2 en un móvil moderno puede superar 5 millones de
      // píxeles por frame. 1.25 en táctil y 1.5 en escritorio conservan una
      // imagen limpia y reducen el fill-rate entre 45 % y 65 %.
      const touch = window.matchMedia('(pointer: coarse)').matches
      const cap = touch ? 1.25 : 1.5
      const dpr = Math.min(window.devicePixelRatio || 1, cap)
      W = cv.clientWidth; H = cv.clientHeight
      cv.width = Math.floor(W * dpr); cv.height = Math.floor(H * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      dragRef.current = dragFor(W)
    }
    resize()
    window.addEventListener('resize', resize)
    window.addEventListener('orientationchange', resize)

    let last = performance.now()
    let hudAcc = 0
    const loop = (now: number) => {
      rafRef.current = requestAnimationFrame(loop)
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const g = gameRef.current

      if (faseRef.current === 'corriendo') {
        /* FUSIÓN DE ENTRADAS: el teclado manda sobre el puntero mientras haya
         * una tecla pulsada; si no, dirige el dedo. Cualquiera de las dos
         * fuentes puede fallar sin bloquear a la otra. */
        const kS = keySteer.current
        const pS = pointerSteer.current
        const steer = kS !== null ? kS : pS !== null ? pS : 0
        const steering = kS !== null || pS !== null
        const throttle = keyThrottle.current || inputRef.current.throttle || lockRef.current
        const brake = keyBrake.current || inputRef.current.brake
        g.update(dt, { steer, steering, throttle: throttle && !brake, brake })
        audioRef.current.update(
          g.rpm, g.speedPct, throttle,
          // el derrape suena como carga lateral: chirrido de neumáticos
          Math.max(g.lateralG, g.slide * 0.9), g.shake,
          g.revLimit, Math.max(g.rain, g.snow),
        )
        // eventos de chasis → sonido y háptica
        if (g.gearChanged !== 0) audioRef.current.shift()
        if (g.hornCue) { g.hornCue = 0; audioRef.current.horn() }   // bocina cercana
        if (g.shake > 0.5 && now - lastBuzz.current > 320) {
          lastBuzz.current = now
          navigator.vibrate?.(18)   // vibra solo al pisar la banquina
        }
      }

      render(ctx, g, W, H)

      hudAcc += dt
      if (hudAcc > 0.08) {
        hudAcc = 0
        setHud({
          km: g.km, vel: Math.round(kmh(g.speed)), gear: g.gear, time: g.time,
          ovt: g.overtakes, flow: g.flow, rpm: g.rpm, shift: g.shiftFlash,
          limit: g.limit, speeding: g.speeding, rain: g.rain,
          score: Math.round(g.score), blinker: g.blinker, blocked: g.blockedAll,
          zona: g.zona,
          fork: g.forkDist, forkSide: g.junctionSide, onFork: g.onForkLane,
          superMode: g.superMode, flash: g.forkFlash, cue: g.takenCue,
          weather: g.weather, wx: g.wx, grip: g.grip, revLimit: g.revLimit,
          slide: g.slide, aqua: g.aquaplane,
        })
      }
    }
    rafRef.current = requestAnimationFrame(loop)
    return () => {
      cancelAnimationFrame(rafRef.current)
      window.removeEventListener('resize', resize)
      window.removeEventListener('orientationchange', resize)
    }
  }, [])

  /* ------------------------------- controles ------------------------------ */
  const setFaseBoth = useCallback((f: Fase) => { faseRef.current = f; setFase(f) }, [])

  const arrancar = useCallback(() => {
    audioRef.current.start()
    audioRef.current.muted = muted
    setFaseBoth('corriendo')
  }, [muted, setFaseBoth])

  const pausar = useCallback(() => {
    inputRef.current.throttle = false
    inputRef.current.brake = false
    keyThrottle.current = false
    keyBrake.current = false
    keySteer.current = null
    pointerSteer.current = null
    steerTouch.current = null
    audioRef.current.stop()
    setFaseBoth('pausa')
  }, [setFaseBoth])

  const reanudar = useCallback(() => { audioRef.current.start(); setFaseBoth('corriendo') }, [setFaseBoth])

  /* ------------------------------- VOLANTE --------------------------------
   * TODA la pantalla es superficie de dirección: se agarra donde se quiera
   * (izquierda, derecha, centro) y con cualquier mano. El punto donde apoyas
   * el dedo se convierte en el "centro" del volante virtual, así que no hay
   * que buscar ninguna zona concreta ni mirar la pantalla.
   *
   * Multitáctil: solo el PRIMER puntero que aterriza dirige; los siguientes
   * se ignoran aquí y quedan libres para los pedales (que están por encima
   * en z-index y reciben sus propios eventos).
   * ----------------------------------------------------------------------*/
  /** Suelta el volante. Si se indica `id`, SOLO libera cuando ese puntero es
   *  justamente el que estaba dirigiendo — así el dedo de los pedales nunca
   *  cancela la dirección (era la causa de que el volante se reiniciara al
   *  acelerar con el otro pulgar). */
  const soltarVolante = useCallback((id?: number) => {
    const t = steerTouch.current
    if (!t) return
    if (id !== undefined && id !== t.id) return
    steerTouch.current = null
    pointerSteer.current = null
    setGrab((g) => (g.on ? { ...g, on: false } : g))
  }, [])

  const onWheelDown = (e: React.PointerEvent) => {
    if (faseRef.current !== 'corriendo') return
    if (steerTouch.current) return                 // ya hay un dedo dirigiendo
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* no crítico */ }
    steerTouch.current = { id: e.pointerId, x0: e.clientX }
    pointerSteer.current = 0
    setGrab({ on: true, x: e.clientX, y: e.clientY })
  }
  const onWheelMove = (e: React.PointerEvent) => {
    let t = steerTouch.current
    /* RE-ENGANCHE: si el sistema canceló el puntero del volante (gesto, aviso
     * del SO…) pero el dedo sigue apoyado, lo recuperamos tomando la posición
     * actual como nuevo centro. Así nunca hay que levantar y volver a pulsar.
     * En ratón `buttons` es 0 sin botón pulsado, de modo que no se re-engancha
     * por un simple movimiento del cursor. */
    if (!t && e.buttons > 0 && faseRef.current === 'corriendo') {
      t = { id: e.pointerId, x0: e.clientX }
      steerTouch.current = t
      pointerSteer.current = 0
      setGrab({ on: true, x: e.clientX, y: e.clientY })
      return
    }
    if (!t || t.id !== e.pointerId) return
    // SEGURO ANTI-ATASCO: con ratón, si ya no hay botón pulsado es que se
    // perdió el `pointerup` (se soltó fuera de la ventana). Antes esto dejaba
    // el puntero "pegado" y machacaba el valor del teclado en cada movimiento.
    if (e.pointerType === 'mouse' && e.buttons === 0) { soltarVolante(); return }
    pointerSteer.current = steerCurve((e.clientX - t.x0) / dragRef.current)
  }
  const onWheelUp = (e: React.PointerEvent) => {
    soltarVolante(e.pointerId)      // el motor lo devuelve al centro solo
  }

  /* Pedales. Mantener pulsado en móvil dispara el menú contextual del sistema
   * (long-press ≈ clic derecho) y la selección de texto; hay que cancelar
   * explícitamente `contextmenu`, `selectstart` y `dragstart`. */
  const hold = (campo: 'throttle' | 'brake') => ({
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return   // ignora botón derecho
      e.preventDefault()
      e.stopPropagation()
      try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* no crítico */ }
      inputRef.current[campo] = true
      if (campo === 'throttle' && faseRef.current !== 'corriendo') arrancar()
    },
    onPointerUp: () => { inputRef.current[campo] = false },
    onPointerCancel: () => { inputRef.current[campo] = false },
    onPointerLeave: () => { inputRef.current[campo] = false },
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
    onDragStart: (e: React.DragEvent) => e.preventDefault(),
  })

  /* ------------------------------- TECLADO --------------------------------
   * Se registra UNA sola vez (deps vacías) leyendo las acciones por ref, para
   * que no se desenganche nunca al recrearse los callbacks. Se escucha en
   * fase de captura sobre `window` y se cancela el comportamiento por defecto
   * de las teclas de juego (evita el scroll con flechas/espacio).
   * ----------------------------------------------------------------------*/
  const accionesRef = useRef({ arrancar, pausar, reanudar })
  accionesRef.current = { arrancar, pausar, reanudar }

  useEffect(() => {
    const IZQ = ['ArrowLeft', 'KeyA'], DER = ['ArrowRight', 'KeyD']
    const ACE = ['ArrowUp', 'KeyW'], FRE = ['ArrowDown', 'KeyS']
    const JUEGO = [...IZQ, ...DER, ...ACE, ...FRE, 'Space', 'KeyQ', 'KeyE']

    const dn = (e: KeyboardEvent) => {
      // no robar teclas si el foco está en un control de formulario
      const t = e.target as HTMLElement | null
      if (t?.closest?.('input, textarea, select, [contenteditable="true"]')) return
      if (JUEGO.includes(e.code)) e.preventDefault()
      if (e.repeat) return

      if (IZQ.includes(e.code)) keySteer.current = -1
      else if (DER.includes(e.code)) keySteer.current = 1
      else if (ACE.includes(e.code)) {
        keyThrottle.current = true
        if (faseRef.current !== 'corriendo') accionesRef.current.arrancar()
      }
      else if (FRE.includes(e.code)) keyBrake.current = true
      else if (e.code === 'KeyQ') gameRef.current.setBlinker(-1)
      else if (e.code === 'KeyE') gameRef.current.setBlinker(1)
      else if (e.code === 'Space') setLock((l) => !l)
      else if (e.code === 'Escape') {
        if (faseRef.current === 'corriendo') accionesRef.current.pausar()
        else accionesRef.current.reanudar()
      }
    }

    const up = (e: KeyboardEvent) => {
      if (IZQ.includes(e.code) && keySteer.current === -1) keySteer.current = null
      else if (DER.includes(e.code) && keySteer.current === 1) keySteer.current = null
      else if (ACE.includes(e.code)) keyThrottle.current = false
      else if (FRE.includes(e.code)) keyBrake.current = false
    }

    // al perder el foco de la ventana se sueltan todas las teclas
    const reset = () => {
      keySteer.current = null
      keyThrottle.current = false
      keyBrake.current = false
    }

    window.addEventListener('keydown', dn, { capture: true })
    window.addEventListener('keyup', up, { capture: true })
    window.addEventListener('blur', reset)
    return () => {
      window.removeEventListener('keydown', dn, { capture: true })
      window.removeEventListener('keyup', up, { capture: true })
      window.removeEventListener('blur', reset)
    }
  }, [])

  /* Red de seguridad global del puntero: si el `pointerup` del volante se
   * pierde (soltar fuera de la ventana, gesto del sistema), lo liberamos para
   * que no quede "pegado".
   * CLAVE MULTITÁCTIL: se compara el `pointerId`. Antes liberaba con CUALQUIER
   * dedo, así que levantar el pulgar del acelerador reiniciaba la dirección. */
  useEffect(() => {
    const libera = (e: PointerEvent) => soltarVolante(e.pointerId)
    const liberaTodo = () => soltarVolante()
    window.addEventListener('pointerup', libera)
    window.addEventListener('pointercancel', libera)
    window.addEventListener('blur', liberaTodo)
    return () => {
      window.removeEventListener('pointerup', libera)
      window.removeEventListener('pointercancel', libera)
      window.removeEventListener('blur', liberaTodo)
    }
  }, [soltarVolante])

  /* Bloqueo global del menú contextual y de la selección: en móvil, mantener
   * el dedo sobre un botón equivale a un clic derecho y abre el menú del
   * sistema, que interrumpe la partida. */
  useEffect(() => {
    const noMenu = (e: Event) => e.preventDefault()
    document.addEventListener('contextmenu', noMenu)
    document.addEventListener('selectstart', noMenu)
    return () => {
      document.removeEventListener('contextmenu', noMenu)
      document.removeEventListener('selectstart', noMenu)
    }
  }, [])

  /* pausa automática al cambiar de pestaña */
  useEffect(() => {
    const vis = () => { if (document.hidden && faseRef.current === 'corriendo') pausar() }
    document.addEventListener('visibilitychange', vis)
    return () => document.removeEventListener('visibilitychange', vis)
  }, [pausar])

  useEffect(() => { audioRef.current.muted = muted }, [muted])
  useEffect(() => { try { localStorage.setItem('ruta-lado', lado) } catch { /* sin storage */ } }, [lado])

  /* -------------------------------- HUD UI -------------------------------- */
  const velPct = Math.min(1, hud.vel / kmh(MAX_SPEED))

  return (
    <div className="relative h-[100dvh] w-full touch-none overflow-hidden bg-ink text-cream select-none">
      <canvas ref={canvasRef} className="absolute inset-0 size-full" />

      {/* ============================== HUD SUPERIOR ========================= */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 p-3">
        <div className="flex items-start justify-between gap-2">
          {/* odómetro */}
          <div className="rounded-lg border border-white/[0.07] bg-black/25 px-2.5 py-1.5 backdrop-blur-sm">
            <p className="flex items-center gap-1 font-mono text-[8px] uppercase tracking-[0.2em] text-white/40">
              <Milestone className="size-2.5" /> {hud.zona || 'recorrido'}
            </p>
            <p className="font-mono text-xl font-semibold leading-none tabular-nums">
              {hud.km.toFixed(2)}<span className="ml-1 text-[10px] text-white/50">km</span>
            </p>
          </div>

          <div className="flex items-center gap-1.5">
            <div className="rounded-lg border border-white/[0.07] bg-black/25 px-2 py-1.5 text-center backdrop-blur-sm">
              <p className="font-mono text-[8px] uppercase tracking-[0.16em] text-white/40">tiempo</p>
              <p className="font-mono text-xs font-semibold tabular-nums">{fmtTime(hud.time)}</p>
            </div>
            <div className="rounded-lg border border-white/[0.07] bg-black/25 px-2 py-1.5 text-center backdrop-blur-sm">
            <p className="font-mono text-[8px] uppercase tracking-[0.16em] text-white/40">adelant.</p>
              <p className="font-mono text-xs font-semibold tabular-nums">{hud.ovt}</p>
            </div>
            <button
              onClick={() => setMuted((m) => !m)}
              className="pointer-events-auto grid size-8 place-items-center rounded-lg border border-white/[0.07] bg-black/25 text-white/55 backdrop-blur-sm active:scale-90"
              aria-label="Sonido"
            >
              {muted ? <VolumeX className="size-3.5" /> : <Volume2 className="size-3.5" />}
            </button>
            <button
              onClick={() => (fase === 'corriendo' ? pausar() : reanudar())}
              className="pointer-events-auto grid size-8 place-items-center rounded-lg border border-white/[0.07] bg-black/25 text-white/55 backdrop-blur-sm active:scale-90"
              aria-label="Pausa"
            >
              {fase === 'corriendo' ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
            </button>
          </div>
        </div>

        {/* puntuación de conducción: respeta límites, señaliza y ve suave */}
        <div className="mt-2 flex items-center gap-2">
          <span className="flex items-center gap-1 font-mono text-[9px] uppercase tracking-[0.2em] text-white/45">
            <ShieldCheck className="size-3" /> conducción
          </span>
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/10">
            <div
              className={cn(
                'h-full rounded-full transition-[width,background-color] duration-500',
                hud.score > 75 ? 'bg-emerald-400/85' : hud.score > 45 ? 'bg-amber-300/85' : 'bg-red-400/85',
              )}
              style={{ width: `${hud.score}%` }}
            />
          </div>
          <span className="w-7 text-right font-mono text-[10px] tabular-nums text-white/70">{hud.score}</span>
          {/* Clima activo: icono y color propios de cada fenómeno. El agarre
              perdido se muestra como porcentaje para que se entienda por qué
              el coche frena peor. */}
          {hud.wx > 0.15 && hud.weather !== 'seco' && (() => {
            const estilo = {
              lluvia: { c: 'border-sky-300/30 bg-sky-300/10 text-sky-200', I: CloudRain },
              nieve: { c: 'border-slate-200/30 bg-slate-200/10 text-slate-100', I: Snowflake },
              niebla: { c: 'border-zinc-300/25 bg-zinc-300/10 text-zinc-200', I: CloudFog },
              tierra: { c: 'border-amber-500/30 bg-amber-500/10 text-amber-200', I: Wind },
              seco: { c: '', I: CloudRain },
            }[hud.weather]
            return (
              <span className={cn('flex items-center gap-1 rounded-full border px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wider', estilo.c)}>
                <estilo.I className="size-2.5" />
                {WEATHER_LABEL[hud.weather]}{hud.wx > 0.65 ? ' fuerte' : ''}
                {hud.grip < 0.92 && <span className="opacity-70">· {Math.round(hud.grip * 100)}%</span>}
              </span>
            )
          })()}
          {hud.blocked && (
            <span className="flex items-center gap-1 rounded-full border border-amber-300/30 bg-amber-300/10 px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wider text-amber-200">
              <Users className="size-2.5" /> retención
            </span>
          )}
        </div>

        {/* Testigo de adherencia: JUSTO DEBAJO del chip de clima, alineado a
            la derecha. Fuera de la zona central de visión, no estorba. */}
        {(hud.slide > 0.12 || hud.aqua > 0.1) && (
          <div className="mt-1.5 flex justify-end">
            <span
              className={cn(
                'flex animate-pulse items-center gap-1 rounded-full border px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase tracking-wider',
                hud.aqua > 0.1
                  ? 'border-red-400/50 bg-red-500/15 text-red-200'
                  : 'border-amber-300/40 bg-amber-400/10 text-amber-200',
              )}
            >
              <TriangleAlert className="size-2.5" />
              {hud.aqua > 0.1 ? 'aquaplaning' : 'poca adherencia'}
            </span>
          </div>
        )}
      </div>

      {/* ============================== VELOCÍMETRO ==========================
          Reubicado al tercio superior: no tapa la calzada ni los pedales y
          queda en la línea de visión natural, como un head-up display. */}
      <div className="pointer-events-none absolute left-1/2 top-[22%] z-20 -translate-x-1/2 text-center">
        <div className="flex items-end justify-center gap-3">
          <p className="font-mono text-[4.2rem] font-bold leading-[0.85] tabular-nums drop-shadow-[0_2px_16px_rgba(0,0,0,0.9)]">
            {hud.vel}
          </p>
          <span className="mb-2 font-mono text-[11px] uppercase tracking-[0.2em] text-white/55">km/h</span>
          {/* Disco del tramo: SOLO informativo/ambiental. El jugador puede ir a
              su ritmo; quienes lo respetan son los coches de la IA. */}
          <span
            className={cn(
              'mb-1 grid size-10 place-items-center rounded-full border-[3px] border-[#D33A2C] bg-[#F2EFE8] font-mono text-[13px] font-bold text-[#17181C] transition-opacity',
              hud.speeding ? 'opacity-100' : 'opacity-70',
            )}
          >
            {hud.limit}
          </span>
        </div>
        {/* barra de revoluciones + marcha actual */}
        <div className="mx-auto mt-2 flex items-center gap-2">
          <div className={cn(
            'h-1.5 w-32 overflow-hidden rounded-full bg-black/40 ring-1 transition-shadow',
            hud.revLimit > 0.2 ? 'ring-red-400/80 shadow-[0_0_10px_rgba(248,113,113,0.6)]' : 'ring-white/10',
          )}>
            <div
              className={cn(
                'h-full rounded-full transition-[width] duration-100',
                hud.revLimit > 0.2 ? 'animate-pulse bg-red-400'
                  : hud.rpm > 0.88 ? 'bg-red-400' : velPct > 0.82 ? 'bg-amber-300' : 'bg-white/85',
              )}
              style={{ width: `${hud.rpm * 100}%` }}
            />
          </div>
          <span
            className={cn(
              'grid size-7 place-items-center rounded-md border font-mono text-xs font-bold transition-all duration-200',
              hud.shift > 0.1 ? 'scale-110 border-signal bg-signal text-ink' : 'border-white/20 bg-black/40 text-white/80',
            )}
          >
            {hud.gear}
          </span>
        </div>
      </div>

      {/* ======================= AVISO DE BIFURCACIÓN ========================
          Aparece a 600 m del desvío. Se ilumina cuando ya vas colocado en el
          carril correcto: así sabes que al cruzarlo te incorporarás. */}
      {hud.fork > 0 && hud.fork < 600 && (
        <div className="pointer-events-none absolute left-1/2 top-[30%] z-20 -translate-x-1/2">
          <div
            className={cn(
              'flex items-center gap-2 rounded-lg border px-3 py-1.5 backdrop-blur-sm transition-colors',
              hud.onFork
                ? 'border-emerald-400/70 bg-emerald-400/20 text-emerald-200'
                : 'border-white/15 bg-black/35 text-white/70',
            )}
          >
            {hud.forkSide < 0 && <ChevronLeft className="size-4" />}
            <span className="font-mono text-[11px] font-bold uppercase tracking-[0.2em]">
              {hud.superMode ? 'Ruta' : 'Super'} · {Math.round(hud.fork)} m
            </span>
            {hud.forkSide > 0 && <ChevronRight className="size-4" />}
          </div>
          <p className="mt-1 text-center font-mono text-[8px] uppercase tracking-[0.18em] text-white/40">
            {hud.onFork ? 'listo para tomarlo' : `mantente a la ${hud.forkSide > 0 ? 'derecha' : 'izquierda'}`}
          </p>
        </div>
      )}

      {/* Confirmación al incorporarse a la otra calzada */}
      {hud.flash > 0.05 && (
        <div
          className="pointer-events-none absolute left-1/2 top-[42%] z-30 -translate-x-1/2 text-center"
          style={{ opacity: Math.min(1, hud.flash) }}
        >
          <p className="font-display text-3xl font-black uppercase tracking-tight drop-shadow-[0_2px_16px_rgba(0,0,0,0.9)]">
            {hud.cue}
          </p>
        </div>
      )}

      {/* ===================== SUPERFICIE DE DIRECCIÓN =======================
          Capa a pantalla completa (z-10): queda POR DEBAJO del HUD, los pedales
          y los overlays, así que esos siguen recibiendo sus propios toques.
          Agarra donde quieras, con la mano que quieras. */}
      <div
        onPointerDown={onWheelDown}
        onPointerMove={onWheelMove}
        onPointerUp={onWheelUp}
        onPointerCancel={onWheelUp}
        className="absolute inset-0 z-10 touch-none"
      />

      {/* Anillo guía en el punto de agarre: discreto, solo un rastro del dedo */}
      {grab.on && (
        <div
          className="pointer-events-none absolute z-20"
          style={{ left: grab.x, top: grab.y, transform: 'translate(-50%,-50%)' }}
        >
          <div className="relative grid size-14 place-items-center rounded-full border border-white/15 bg-white/[0.04]">
            <GrabKnob gameRef={gameRef} />
          </div>
        </div>
      )}

      {/* ====================== CONTROLES INFERIORES ========================
          Rediseño para vertical: todo pegado a los bordes y translúcido para
          no tapar el coche, que vive en el centro-bajo de la pantalla.
          · Volante  → barra FINA al borde inferior (solo indicador).
          · Pedales  → columna derecha, compactos.
          · Flechas  → mínimas, junto a los pedales.
          ==================================================================== */}

      {/* --- barra de volante: indicador plano, sin caja ni etiquetas --- */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 px-5 pb-3">
        <div className="relative mx-auto h-1.5 max-w-sm rounded-full bg-white/10">
          {/* marca de centro */}
          <span className="absolute left-1/2 top-1/2 h-2.5 w-px -translate-x-1/2 -translate-y-1/2 bg-white/25" />
          <SteerKnob gameRef={gameRef} />
        </div>
      </div>

      {/* --- pedales + accesorios: columna compacta, lado configurable --- */}
      <div
        className={cn(
          'absolute bottom-7 z-30 flex flex-col items-center gap-2.5',
          lado === 'der' ? 'right-3' : 'left-3',
        )}
      >
        {/* intermitentes: pequeños, en fila sobre los pedales */}
        <div className="flex gap-1.5">
          {([-1, 1] as const).map((dir) => {
            const on = hud.blinker === dir
            return (
              <button
                key={dir}
                onClick={() => gameRef.current.setBlinker(dir)}
                className={cn(
                  'grid size-8 place-items-center rounded-lg border transition-all active:scale-90',
                  on
                    ? 'animate-pulse border-amber-300/70 bg-amber-300/20 text-amber-200'
                    : 'border-white/10 bg-black/25 text-white/40',
                )}
                aria-label={dir < 0 ? 'Intermitente izquierdo' : 'Intermitente derecho'}
              >
                {dir < 0 ? <ChevronLeft className="size-4" /> : <ChevronRight className="size-4" />}
              </button>
            )
          })}
        </div>

        {/* traba del acelerador */}
        <button
          onClick={() => setLock((l) => !l)}
          className={cn(
            'grid size-8 place-items-center rounded-lg border transition-all active:scale-90',
            lock
              ? 'border-emerald-400/60 bg-emerald-400/20 text-emerald-300'
              : 'border-white/10 bg-black/25 text-white/40',
          )}
          aria-label="Traba del acelerador"
        >
          {lock ? <Lock className="size-3.5" /> : <LockOpen className="size-3.5" />}
        </button>

        <button
          {...hold('throttle')}
          className="grid size-16 touch-none place-items-center rounded-full border border-emerald-400/35 bg-emerald-400/10 text-emerald-300/80 transition-all active:scale-95 active:border-emerald-400/70 active:bg-emerald-400/25 active:text-emerald-200"
          aria-label="Acelerar"
        >
          <ChevronUp className="size-7" />
        </button>
        <button
          {...hold('brake')}
          className="grid size-[3.25rem] touch-none place-items-center rounded-full border border-red-400/35 bg-red-400/10 text-red-300/80 transition-all active:scale-95 active:border-red-400/70 active:bg-red-400/25 active:text-red-200"
          aria-label="Frenar"
        >
          <ChevronDown className="size-6" />
        </button>
      </div>

      {/* =============================== OVERLAYS ============================ */}
      <AnimatePresence>
        {fase !== 'corriendo' && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="absolute inset-0 z-30 grid place-items-center bg-ink/70 p-6 backdrop-blur-sm"
          >
            <motion.div
              initial={{ y: 18, scale: 0.97 }} animate={{ y: 0, scale: 1 }}
              transition={{ type: 'spring', stiffness: 240, damping: 22 }}
              className="w-full max-w-sm rounded-2xl border border-white/10 bg-panel/95 p-6 text-center"
            >
              {fase === 'intro' ? (
                <>
                  <Car className="mx-auto size-9 text-signal" />
                  <h1 className="mt-3 font-display text-4xl font-black uppercase tracking-tight">Ruta</h1>
                  <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.26em] text-white/45">autopista infinita</p>
                  <p className="mt-4 text-sm leading-relaxed text-white/70">
                    Sin choques ni partidas perdidas. Solo integrarte al tránsito,
                    adelantar con calma y ver subir los kilómetros.
                  </p>
                  <ul className="mt-5 space-y-2 text-left font-mono text-[11px] text-white/60">
                    <li className="flex gap-2"><Navigation className="mt-px size-3.5 shrink-0 text-signal" /> Desliza el dedo <strong className="text-white/80">en cualquier parte</strong> de la pantalla: es el volante. Al soltar vuelve solo al centro.</li>
                    <li className="flex gap-2"><Gauge className="mt-px size-3.5 shrink-0 text-signal" /> Caja automática: solo acelerar y frenar.</li>
                    <li className="flex gap-2"><Lock className="mt-px size-3.5 shrink-0 text-signal" /> TRABA mantiene el acelerador: conduce con una mano.</li>
                    <li className="flex gap-2"><ShieldCheck className="mt-px size-3.5 shrink-0 text-signal" /> Mira el retrovisor, señaliza antes de cambiar de carril y respeta el límite: suma puntos.</li>
                  </ul>
                  <button
                    onClick={arrancar}
                    className="mt-6 w-full rounded-xl bg-signal py-3.5 font-mono text-[12px] font-bold uppercase tracking-[0.28em] text-ink active:scale-[0.98]"
                  >
                    Salir a la ruta
                  </button>
                </>
              ) : (
                <>
                  <TimerIcon className="mx-auto size-8 text-signal" />
                  <h2 className="mt-3 font-display text-3xl font-black uppercase tracking-tight">En el arcén</h2>
                  <div className="mt-5 grid grid-cols-2 gap-2">
                    {[
                      { v: hud.km.toFixed(2), l: 'km' },
                      { v: fmtTime(hud.time), l: 'tiempo' },
                      { v: String(hud.ovt), l: 'adelant.' },
                      { v: `${hud.score}`, l: 'conducción' },
                    ].map((s) => (
                      <div key={s.l} className="rounded-xl border border-white/10 p-3">
                        <p className="font-mono text-lg font-semibold tabular-nums">{s.v}</p>
                        <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-white/45">{s.l}</p>
                      </div>
                    ))}
                  </div>
                  {/* --- distribución de los controles (diestro / zurdo) --- */}
                  <div className="mt-5 rounded-xl border border-white/10 p-3">
                    <p className="mb-2 flex items-center justify-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.2em] text-white/45">
                      <Hand className="size-3" /> pedales
                    </p>
                    <div className="grid grid-cols-2 gap-2">
                      {([
                        { id: 'izq' as const, txt: 'Izquierda', Icon: ChevronLeft },
                        { id: 'der' as const, txt: 'Derecha', Icon: ChevronRight },
                      ]).map(({ id, txt, Icon }) => (
                        <button
                          key={id}
                          onClick={() => setLado(id)}
                          className={cn(
                            'flex items-center justify-center gap-1.5 rounded-lg border py-2.5 font-mono text-[10px] uppercase tracking-[0.14em] transition-all active:scale-95',
                            lado === id
                              ? 'border-signal/70 bg-signal/15 text-signal'
                              : 'border-white/10 bg-black/25 text-white/50',
                          )}
                        >
                          <Icon className="size-3.5" /> {txt}
                        </button>
                      ))}
                    </div>
                    <p className="mt-2 font-mono text-[9px] leading-relaxed text-white/35">
                      El volante sigue siendo toda la pantalla
                    </p>
                  </div>

                  <button
                    onClick={reanudar}
                    className="mt-4 w-full rounded-xl bg-signal py-3.5 font-mono text-[12px] font-bold uppercase tracking-[0.28em] text-ink active:scale-[0.98]"
                  >
                    Continuar
                  </button>
                </>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/* -------------------------------------------------------------------------
 * Perilla dentro del anillo de agarre: sigue al dedo en el punto donde se
 * apoyó. Se anima por rAF leyendo el motor, sin re-render de React.
 * ------------------------------------------------------------------------*/
function GrabKnob({ gameRef }: { gameRef: React.RefObject<Game> }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let id = 0
    const tick = () => {
      id = requestAnimationFrame(tick)
      const el = ref.current
      if (el) el.style.transform = `translate(calc(-50% + ${gameRef.current.steer * 17}px), -50%)`
    }
    id = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(id)
  }, [gameRef])
  return (
    <div
      ref={ref}
      className="absolute left-1/2 top-1/2 size-6 rounded-full border border-white/50 bg-white/20"
    />
  )
}

/* -------------------------------------------------------------------------
 * Perilla del indicador inferior: se anima leyendo el estado real del motor
 * (incluido el auto-centrado), fuera del ciclo de render de React.
 * ------------------------------------------------------------------------*/
function SteerKnob({ gameRef }: { gameRef: React.RefObject<Game> }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let id = 0
    const tick = () => {
      id = requestAnimationFrame(tick)
      const el = ref.current
      if (!el) return
      // se lee del motor: refleja por igual el teclado y el dedo
      const s = gameRef.current.steer
      // `left` en % del riel: la perilla recorre toda la barra
      el.style.left = `${50 + s * 44}%`
      el.style.opacity = Math.abs(s) > 0.02 ? '0.95' : '0.5'
    }
    id = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(id)
  }, [gameRef])
  return (
    <div
      ref={ref}
      className="absolute top-1/2 h-1.5 w-12 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/90"
      style={{ left: '50%' }}
    />
  )
}
