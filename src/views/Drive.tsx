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
  Milestone, Navigation, Timer as TimerIcon, Car,
} from 'lucide-react'
import { Game, EngineAudio, kmh, MAX_SPEED } from '@/game/engine'
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
  const [hud, setHud] = useState({ km: 0, vel: 0, gear: 1, time: 0, ovt: 0, flow: 1, rpm: 0, shift: 0 })

  const lockRef = useRef(lock); lockRef.current = lock
  const steerTouch = useRef<{ id: number; x0: number } | null>(null)
  const lastBuzz = useRef(0)
  const dragRef = useRef(84)
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
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
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
        const i = inputRef.current
        g.update(dt, {
          steer: i.steer,
          steering: i.steering,
          throttle: (i.throttle || lockRef.current) && !i.brake,
          brake: i.brake,
        })
        audioRef.current.update(
          g.rpm, g.speedPct, i.throttle || lockRef.current,
          g.lateralG, g.shake,
        )
        // eventos de chasis → sonido y háptica
        if (g.gearChanged !== 0) audioRef.current.shift()
        if (g.shake > 0.5 && now - lastBuzz.current > 320) {
          lastBuzz.current = now
          navigator.vibrate?.(18)   // vibra solo al pisar la banquina
        }
      }

      render(ctx, g, W, H)

      hudAcc += dt
      if (hudAcc > 0.08) {
        hudAcc = 0
        setHud({ km: g.km, vel: Math.round(kmh(g.speed)), gear: g.gear, time: g.time, ovt: g.overtakes, flow: g.flow, rpm: g.rpm, shift: g.shiftFlash })
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
    inputRef.current.steering = false
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
  const onWheelDown = (e: React.PointerEvent) => {
    if (faseRef.current !== 'corriendo') return
    if (steerTouch.current) return                 // ya hay un dedo dirigiendo
    e.currentTarget.setPointerCapture(e.pointerId)
    steerTouch.current = { id: e.pointerId, x0: e.clientX }
    inputRef.current.steering = true
    inputRef.current.steer = 0
    setGrab({ on: true, x: e.clientX, y: e.clientY })
  }
  const onWheelMove = (e: React.PointerEvent) => {
    const t = steerTouch.current
    if (!t || t.id !== e.pointerId) return
    inputRef.current.steer = steerCurve((e.clientX - t.x0) / dragRef.current)
  }
  const onWheelUp = (e: React.PointerEvent) => {
    const t = steerTouch.current
    if (!t || t.id !== e.pointerId) return
    steerTouch.current = null
    inputRef.current.steering = false   // el motor lo devuelve al centro solo
    inputRef.current.steer = 0
    setGrab((g) => ({ ...g, on: false }))
  }

  const hold = (campo: 'throttle' | 'brake') => ({
    onPointerDown: (e: React.PointerEvent) => {
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      inputRef.current[campo] = true
      if (campo === 'throttle' && faseRef.current === 'intro') arrancar()
    },
    onPointerUp: () => { inputRef.current[campo] = false },
    onPointerCancel: () => { inputRef.current[campo] = false },
    onPointerLeave: () => { inputRef.current[campo] = false },
  })

  /* teclado (pruebas en escritorio) */
  useEffect(() => {
    const dn = (e: KeyboardEvent) => {
      if (e.repeat) return
      const i = inputRef.current
      if (e.code === 'ArrowLeft' || e.code === 'KeyA') { i.steering = true; i.steer = -1 }
      if (e.code === 'ArrowRight' || e.code === 'KeyD') { i.steering = true; i.steer = 1 }
      if (e.code === 'ArrowUp' || e.code === 'KeyW') { i.throttle = true; if (faseRef.current === 'intro') arrancar() }
      if (e.code === 'ArrowDown' || e.code === 'KeyS') i.brake = true
      if (e.code === 'Space') { e.preventDefault(); setLock((l) => !l) }
      if (e.code === 'Escape') faseRef.current === 'corriendo' ? pausar() : reanudar()
    }
    const up = (e: KeyboardEvent) => {
      const i = inputRef.current
      if (e.code === 'ArrowLeft' || e.code === 'KeyA' || e.code === 'ArrowRight' || e.code === 'KeyD') { i.steering = false; i.steer = 0 }
      if (e.code === 'ArrowUp' || e.code === 'KeyW') i.throttle = false
      if (e.code === 'ArrowDown' || e.code === 'KeyS') i.brake = false
    }
    window.addEventListener('keydown', dn)
    window.addEventListener('keyup', up)
    return () => { window.removeEventListener('keydown', dn); window.removeEventListener('keyup', up) }
  }, [arrancar, pausar, reanudar])

  /* pausa automática al cambiar de pestaña */
  useEffect(() => {
    const vis = () => { if (document.hidden && faseRef.current === 'corriendo') pausar() }
    document.addEventListener('visibilitychange', vis)
    return () => document.removeEventListener('visibilitychange', vis)
  }, [pausar])

  useEffect(() => { audioRef.current.muted = muted }, [muted])

  /* -------------------------------- HUD UI -------------------------------- */
  const velPct = Math.min(1, hud.vel / kmh(MAX_SPEED))

  return (
    <div className="relative h-[100dvh] w-full touch-none overflow-hidden bg-ink text-cream select-none">
      <canvas ref={canvasRef} className="absolute inset-0 size-full" />

      {/* ============================== HUD SUPERIOR ========================= */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 p-3">
        <div className="flex items-start justify-between gap-2">
          {/* odómetro */}
          <div className="rounded-xl border border-white/10 bg-black/45 px-3 py-2 backdrop-blur-sm">
            <p className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.22em] text-white/50">
              <Milestone className="size-3" /> recorrido
            </p>
            <p className="font-mono text-2xl font-semibold leading-none tabular-nums">
              {hud.km.toFixed(2)}<span className="ml-1 text-xs text-white/60">km</span>
            </p>
          </div>

          <div className="flex items-center gap-2">
            <div className="rounded-xl border border-white/10 bg-black/45 px-2.5 py-2 text-center backdrop-blur-sm">
              <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-white/50">tiempo</p>
              <p className="font-mono text-sm font-semibold tabular-nums">{fmtTime(hud.time)}</p>
            </div>
            <div className="rounded-xl border border-white/10 bg-black/45 px-2.5 py-2 text-center backdrop-blur-sm">
              <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-white/50">adelant.</p>
              <p className="font-mono text-sm font-semibold tabular-nums">{hud.ovt}</p>
            </div>
            <button
              onClick={() => setMuted((m) => !m)}
              className="pointer-events-auto grid size-9 place-items-center rounded-xl border border-white/10 bg-black/45 text-white/70 backdrop-blur-sm active:scale-95"
              aria-label="Sonido"
            >
              {muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
            </button>
            <button
              onClick={() => (fase === 'corriendo' ? pausar() : reanudar())}
              className="pointer-events-auto grid size-9 place-items-center rounded-xl border border-white/10 bg-black/45 text-white/70 backdrop-blur-sm active:scale-95"
              aria-label="Pausa"
            >
              {fase === 'corriendo' ? <Pause className="size-4" /> : <Play className="size-4" />}
            </button>
          </div>
        </div>

        {/* barra de ritmo: sube conduciendo suave y lejos de la banquina */}
        <div className="mt-2 flex items-center gap-2">
          <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-white/45">ritmo</span>
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/10">
            <div className="h-full rounded-full bg-emerald-400/80 transition-[width] duration-500" style={{ width: `${hud.flow * 100}%` }} />
          </div>
        </div>
      </div>

      {/* ============================== VELOCÍMETRO ==========================
          Reubicado al tercio superior: no tapa la calzada ni los pedales y
          queda en la línea de visión natural, como un head-up display. */}
      <div className="pointer-events-none absolute left-1/2 top-[20%] z-20 -translate-x-1/2 text-center">
        <div className="flex items-end justify-center gap-2">
          <p className="font-mono text-[4.2rem] font-bold leading-[0.85] tabular-nums drop-shadow-[0_2px_16px_rgba(0,0,0,0.9)]">
            {hud.vel}
          </p>
          <span className="mb-2 font-mono text-[11px] uppercase tracking-[0.2em] text-white/55">km/h</span>
        </div>
        {/* barra de revoluciones + marcha actual */}
        <div className="mx-auto mt-2 flex items-center gap-2">
          <div className="h-1.5 w-32 overflow-hidden rounded-full bg-black/40 ring-1 ring-white/10">
            <div
              className={cn('h-full rounded-full transition-[width] duration-100', hud.rpm > 0.88 ? 'bg-red-400' : velPct > 0.82 ? 'bg-amber-300' : 'bg-white/85')}
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

      {/* Anillo guía en el punto de agarre: feedback de que el dedo manda */}
      {grab.on && (
        <div
          className="pointer-events-none absolute z-20"
          style={{ left: grab.x, top: grab.y, transform: 'translate(-50%,-50%)' }}
        >
          <div className="relative grid size-24 place-items-center rounded-full border border-white/20 bg-white/5 backdrop-blur-[2px]">
            <div className="h-px w-16 bg-white/20" />
            <GrabKnob gameRef={gameRef} />
          </div>
        </div>
      )}

      {/* ========================= INDICADOR DE VOLANTE ======================
          Solo informativo (pointer-events-none): el control real es la pantalla. */}
      <div className="pointer-events-none absolute bottom-6 left-4 z-20 w-[52%] max-w-64">
        <div className="rounded-2xl border border-white/10 bg-black/35 p-3 backdrop-blur-sm">
          <div className="flex items-center justify-between font-mono text-[9px] uppercase tracking-[0.2em] text-white/45">
            <span className="flex items-center gap-1"><Navigation className="size-3" /> volante</span>
            <span>vuelve solo</span>
          </div>
          <div className="relative mt-2 h-9 rounded-full border border-white/10 bg-black/40">
            <div className="absolute left-1/2 top-1/2 h-5 w-px -translate-x-1/2 -translate-y-1/2 bg-white/20" />
            <SteerKnob inputRef={inputRef} gameRef={gameRef} />
          </div>
          <p className="mt-1.5 text-center font-mono text-[9px] uppercase tracking-[0.18em] text-white/35">
            desliza en cualquier parte
          </p>
        </div>
      </div>

      {/* ================================ PEDALES ============================ */}
      <div className="absolute bottom-6 right-4 z-20 flex flex-col items-center gap-2">
        <button
          onClick={() => setLock((l) => !l)}
          className={cn(
            'flex items-center gap-1.5 rounded-full border px-3 py-1.5 font-mono text-[9px] font-bold uppercase tracking-[0.18em] backdrop-blur-sm active:scale-95',
            lock ? 'border-emerald-400/60 bg-emerald-400/20 text-emerald-300' : 'border-white/15 bg-black/45 text-white/60',
          )}
        >
          {lock ? <Lock className="size-3" /> : <LockOpen className="size-3" />} traba
        </button>

        <button
          {...hold('throttle')}
          className="grid size-20 touch-none place-items-center rounded-full border-2 border-emerald-400/50 bg-emerald-400/15 text-emerald-300 backdrop-blur-sm transition-transform active:scale-95 active:bg-emerald-400/30"
          aria-label="Acelerar"
        >
          <ChevronUp className="size-8" />
        </button>
        <button
          {...hold('brake')}
          className="grid size-16 touch-none place-items-center rounded-full border-2 border-red-400/50 bg-red-400/15 text-red-300 backdrop-blur-sm transition-transform active:scale-95 active:bg-red-400/30"
          aria-label="Frenar"
        >
          <ChevronDown className="size-7" />
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
                  <div className="mt-5 grid grid-cols-3 gap-2">
                    {[
                      { v: hud.km.toFixed(2), l: 'km' },
                      { v: fmtTime(hud.time), l: 'tiempo' },
                      { v: String(hud.ovt), l: 'adelant.' },
                    ].map((s) => (
                      <div key={s.l} className="rounded-xl border border-white/10 p-3">
                        <p className="font-mono text-lg font-semibold tabular-nums">{s.v}</p>
                        <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-white/45">{s.l}</p>
                      </div>
                    ))}
                  </div>
                  <button
                    onClick={reanudar}
                    className="mt-6 w-full rounded-xl bg-signal py-3.5 font-mono text-[12px] font-bold uppercase tracking-[0.28em] text-ink active:scale-[0.98]"
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
      if (el) el.style.transform = `translate(calc(-50% + ${gameRef.current.steer * 34}px), -50%)`
    }
    id = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(id)
  }, [gameRef])
  return (
    <div
      ref={ref}
      className="absolute left-1/2 top-1/2 size-9 rounded-full border-2 border-white/60 bg-white/25 shadow-lg"
    />
  )
}

/* -------------------------------------------------------------------------
 * Perilla del indicador inferior: se anima leyendo el estado real del motor
 * (incluido el auto-centrado), fuera del ciclo de render de React.
 * ------------------------------------------------------------------------*/
function SteerKnob({ inputRef, gameRef }: {
  inputRef: React.RefObject<{ steer: number; steering: boolean; throttle: boolean; brake: boolean }>
  gameRef: React.RefObject<Game>
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let id = 0
    const tick = () => {
      id = requestAnimationFrame(tick)
      const el = ref.current
      if (!el) return
      const s = gameRef.current.steer
      el.style.transform = `translate(calc(-50% + ${s * 42}%), -50%)`
      el.style.opacity = inputRef.current.steering ? '1' : '0.65'
    }
    id = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(id)
  }, [inputRef, gameRef])
  return (
    <div
      ref={ref}
      className="absolute left-1/2 top-1/2 h-7 w-16 rounded-full border border-white/25 bg-white/85 shadow-lg transition-opacity"
    />
  )
}
