/* ============================================================================
 * render.ts — RENDER PSEUDO-3D EN CANVAS 2D
 * ----------------------------------------------------------------------------
 * Técnica clásica de proyección por segmentos (estilo arcade de carretera):
 *   scale = camDepth / (z - camZ) · pantalla = centro + scale * mundo
 * Se dibuja de cerca a lejos con recorte por `maxY` (painter con oclusión) y
 * después los sprites de lejos a cerca. Ciclo día/noche según el kilometraje.
 * ==========================================================================*/
import {
  SEG, ROAD_W, DRAW, CAM_H, CAM_DEPTH, PLAYER_W, PLAYER_Z,
  Game, curveAt, hillAt, hash, kmh,
} from './engine'

/* ------------------------------- PALETAS ---------------------------------- */
interface Pal {
  skyTop: string; skyBot: string; sun: string; hillFar: string; hillNear: string
  grass1: string; grass2: string; road1: string; road2: string
  rumble1: string; rumble2: string; lane: string; fog: string
  dark: number // 0 día … 1 noche (controla faros y luces)
}
const P_AMANECER: Pal = { skyTop: '#2B3A6B', skyBot: '#F2A65A', sun: '#FFD9A0', hillFar: '#4A4A72', hillNear: '#33344F', grass1: '#3C5A4A', grass2: '#365243', road1: '#3A3A42', road2: '#36363E', rumble1: '#C8503C', rumble2: '#EDE6DA', lane: '#E8E2D6', fog: '#7E6B74', dark: 0.35 }
const P_DIA: Pal      = { skyTop: '#2E7FD4', skyBot: '#A8D8F0', sun: '#FFF6D8', hillFar: '#6E96A8', hillNear: '#4C7A63', grass1: '#4E8257', grass2: '#467A50', road1: '#45454E', road2: '#41414A', rumble1: '#D8604A', rumble2: '#F2EDE4', lane: '#F2EDE4', fog: '#B8D6E6', dark: 0 }
const P_ATARDECER: Pal= { skyTop: '#1F2A52', skyBot: '#E4653C', sun: '#FFC27A', hillFar: '#55466A', hillNear: '#3A3350', grass1: '#3F5346', grass2: '#394C40', road1: '#3C3A44', road2: '#38363F', rumble1: '#C4503A', rumble2: '#E8E0D4', lane: '#E4DCCE', fog: '#9A6A5E', dark: 0.45 }
const P_NOCHE: Pal    = { skyTop: '#060A18', skyBot: '#131E38', sun: '#DCE6F5', hillFar: '#141C30', hillNear: '#101627', grass1: '#16261F', grass2: '#13211B', road1: '#232329', road2: '#1F1F25', rumble1: '#7A3326', rumble2: '#9A948A', lane: '#B9B2A4', fog: '#0C1424', dark: 1 }

const CICLO_KM = 26
const KEYS: Pal[] = [P_AMANECER, P_DIA, P_ATARDECER, P_NOCHE]

const hex = (c: string) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]
const mix = (a: string, b: string, t: number) => {
  const A = hex(a), B = hex(b)
  return `rgb(${Math.round(A[0] + (B[0] - A[0]) * t)},${Math.round(A[1] + (B[1] - A[1]) * t)},${Math.round(A[2] + (B[2] - A[2]) * t)})`
}

export function palette(km: number): Pal {
  const t = ((km / CICLO_KM) % 1 + 1) % 1
  const f = t * KEYS.length
  const i = Math.floor(f) % KEYS.length
  const j = (i + 1) % KEYS.length
  const k = f - Math.floor(f)
  const A = KEYS[i], B = KEYS[j]
  return {
    skyTop: mix(A.skyTop, B.skyTop, k), skyBot: mix(A.skyBot, B.skyBot, k),
    sun: mix(A.sun, B.sun, k), hillFar: mix(A.hillFar, B.hillFar, k), hillNear: mix(A.hillNear, B.hillNear, k),
    grass1: mix(A.grass1, B.grass1, k), grass2: mix(A.grass2, B.grass2, k),
    road1: mix(A.road1, B.road1, k), road2: mix(A.road2, B.road2, k),
    rumble1: mix(A.rumble1, B.rumble1, k), rumble2: mix(A.rumble2, B.rumble2, k),
    lane: mix(A.lane, B.lane, k), fog: mix(A.fog, B.fog, k),
    dark: A.dark + (B.dark - A.dark) * k,
  }
}

const CAR_COLORS = ['#D94F3D', '#E8E4DC', '#2F6FB5', '#2B2E34', '#C9A227', '#4B8C6A', '#8A5BB5']

/* ------------------------------- UTILIDADES ------------------------------- */
function quad(ctx: CanvasRenderingContext2D, x1: number, y1: number, w1: number, x2: number, y2: number, w2: number, color: string) {
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.moveTo(x1 - w1, y1); ctx.lineTo(x2 - w2, y2); ctx.lineTo(x2 + w2, y2); ctx.lineTo(x1 + w1, y1)
  ctx.closePath(); ctx.fill()
}

/** Coche visto desde atrás: carrocería, luna, luces y sombra. */
function drawCar(
  ctx: CanvasRenderingContext2D, cx: number, baseY: number, w: number,
  color: string, dark: number, truck: boolean, brake: boolean, blinker: number, t: number,
) {
  if (w < 1.2) return
  const h = w * (truck ? 1.18 : 0.74)
  const y = baseY - h
  ctx.save()
  // sombra
  ctx.fillStyle = 'rgba(0,0,0,0.33)'
  ctx.beginPath(); ctx.ellipse(cx, baseY, w * 0.62, Math.max(1, h * 0.14), 0, 0, Math.PI * 2); ctx.fill()
  // carrocería
  ctx.fillStyle = color
  const r = Math.min(w * 0.16, h * 0.3)
  ctx.beginPath()
  if (ctx.roundRect) ctx.roundRect(cx - w / 2, y, w, h, r)
  else ctx.rect(cx - w / 2, y, w, h)
  ctx.fill()
  if (w > 10) {
    // luna trasera / caja del camión
    ctx.fillStyle = truck ? 'rgba(0,0,0,0.22)' : `rgba(18,22,30,${0.55 + dark * 0.3})`
    ctx.fillRect(cx - w * 0.36, y + h * (truck ? 0.14 : 0.12), w * 0.72, h * (truck ? 0.5 : 0.34))
    // techo / franja
    ctx.fillStyle = 'rgba(255,255,255,0.08)'
    ctx.fillRect(cx - w * 0.5, y, w, Math.max(1, h * 0.07))
  }
  // pilotos traseros
  const lw = Math.max(1.1, w * 0.13), lh = Math.max(1, h * 0.12)
  const ly = y + h * (truck ? 0.74 : 0.62)
  ctx.fillStyle = brake ? '#FF3B2F' : `rgba(200,42,30,${0.55 + dark * 0.45})`
  ctx.fillRect(cx - w * 0.44, ly, lw, lh)
  ctx.fillRect(cx + w * 0.44 - lw, ly, lw, lh)
  if ((brake || dark > 0.3) && w > 6) {
    ctx.globalCompositeOperation = 'lighter'
    ctx.fillStyle = brake ? 'rgba(255,60,40,0.42)' : `rgba(220,50,30,${0.16 + dark * 0.22})`
    ctx.beginPath(); ctx.ellipse(cx - w * 0.39, ly + lh / 2, w * 0.3, h * 0.2, 0, 0, Math.PI * 2); ctx.fill()
    ctx.beginPath(); ctx.ellipse(cx + w * 0.39, ly + lh / 2, w * 0.3, h * 0.2, 0, 0, Math.PI * 2); ctx.fill()
    ctx.globalCompositeOperation = 'source-over'
  }
  // intermitente
  if (blinker !== 0 && Math.floor(t * 2.6) % 2 === 0 && w > 5) {
    ctx.fillStyle = '#FFB224'
    const bx = blinker < 0 ? cx - w * 0.5 : cx + w * 0.5 - lw
    ctx.fillRect(bx, ly - lh * 1.3, lw, lh)
  }
  ctx.restore()
}

/* ================================ RENDER ================================== */
export function render(ctx: CanvasRenderingContext2D, g: Game, W: number, H: number) {
  const pal = palette(g.km)
  const base = Math.floor(g.z / SEG)
  const pct = (g.z % SEG) / SEG
  /* CÁMARA DINÁMICA
   * · camLag: persigue al coche con inercia → el coche se desplaza DENTRO del
   *   encuadre al maniobrar (clave de la sensación de simulador).
   * · susp: la suspensión mueve la cámara verticalmente sobre el relieve.
   * · camDepth: el FOV se abre con la velocidad → sensación de rapidez. */
  const camX = g.camLag * ROAD_W
  const camY = CAM_H + hillAt(base) + (hillAt(base + 1) - hillAt(base)) * pct + g.susp * 7
  const camZ = g.z
  const camDepth = CAM_DEPTH * (1 - 0.11 * g.speedPct)
  const horizonBias = (hillAt(base) - hillAt(base + 24)) * 0.00002

  /* Cabeceo y balanceo aplicados a TODA la escena (como una cámara real
   * montada en el chasis). Se escala un 8 % para que la rotación no descubra
   * las esquinas del lienzo. */
  ctx.save()
  ctx.translate(W / 2, H / 2)
  ctx.rotate(-g.roll * 0.030)
  ctx.scale(1.08, 1.08)
  ctx.translate(-W / 2, -H / 2 + g.pitch * H * 0.026 - g.susp * 0.9)

  /* ------------------------------- CIELO -------------------------------- */
  const sky = ctx.createLinearGradient(0, 0, 0, H * 0.62)
  sky.addColorStop(0, pal.skyTop); sky.addColorStop(1, pal.skyBot)
  ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H)

  // estrellas de noche
  if (pal.dark > 0.45) {
    ctx.globalAlpha = (pal.dark - 0.45) / 0.55
    ctx.fillStyle = '#FFFFFF'
    for (let i = 0; i < 46; i++) {
      const sx = hash(i * 3.3) * W
      const sy = hash(i * 7.7) * H * 0.4
      const s = hash(i * 11.1) * 1.4 + 0.4
      ctx.globalAlpha *= 1
      ctx.fillRect(sx, sy, s, s)
    }
    ctx.globalAlpha = 1
  }

  // sol / luna (parallax lateral con la curva acumulada)
  const horizon = H * 0.42 + horizonBias * H
  const sunX = W * 0.5 - g.x * W * 0.08 - (curveAt(base + 60) * W * 0.05)
  const sunY = horizon - H * 0.1
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  const sunG = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, W * 0.42)
  sunG.addColorStop(0, pal.sun); sunG.addColorStop(0.08, pal.sun)
  sunG.addColorStop(0.3, 'rgba(255,200,120,0.12)'); sunG.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = sunG; ctx.beginPath(); ctx.arc(sunX, sunY, W * 0.42, 0, Math.PI * 2); ctx.fill()
  ctx.restore()

  /* ------------------------------ COLINAS -------------------------------- */
  const drawHills = (amp: number, yBase: number, color: string, off: number, fq: number) => {
    ctx.fillStyle = color
    ctx.beginPath(); ctx.moveTo(0, H)
    for (let sx = 0; sx <= W; sx += 14) {
      const u = (sx + off) * fq
      const y = yBase - (Math.sin(u) * 0.6 + Math.sin(u * 2.3 + 1.2) * 0.4) * amp
      ctx.lineTo(sx, y)
    }
    ctx.lineTo(W, H); ctx.closePath(); ctx.fill()
  }
  const par = -g.z * 0.0022 - g.x * 60
  drawHills(H * 0.055, horizon + 2, pal.hillFar, par * 0.5, 0.0075)
  drawHills(H * 0.035, horizon + 10, pal.hillNear, par, 0.012)

  /* ------------------------------ CARRETERA ------------------------------ */
  const xw = new Float64Array(DRAW + 2)   // x mundo del centro de calzada
  const yw = new Float64Array(DRAW + 2)   // altura
  let x = 0
  let dx = -curveAt(base) * pct
  let maxY = H
  const scaleOf = (z: number) => camDepth / Math.max(z - camZ, 1)

  for (let n = 0; n <= DRAW; n++) {
    const i = base + n
    xw[n] = x; yw[n] = hillAt(i)
    x += dx; dx += curveAt(i)
  }

  for (let n = 0; n < DRAW; n++) {
    const i = base + n
    const z1 = i * SEG, z2 = z1 + SEG
    const s1 = scaleOf(z1), s2 = scaleOf(z2)
    const X1 = W / 2 + s1 * (xw[n] - camX) * W / 2
    const Y1 = H / 2 - s1 * (yw[n] - camY) * H / 2
    const W1 = s1 * ROAD_W * W / 2
    const X2 = W / 2 + s2 * (xw[n + 1] - camX) * W / 2
    const Y2 = H / 2 - s2 * (yw[n + 1] - camY) * H / 2
    const W2 = s2 * ROAD_W * W / 2
    if (Y1 < Y2 || Y2 >= maxY) continue
    maxY = Y2

    const alt = Math.floor(i / 3) % 2 === 0
    // césped a los lados
    ctx.fillStyle = alt ? pal.grass1 : pal.grass2
    ctx.fillRect(0, Y2, W, Y1 - Y2 + 1)
    // arcenes
    quad(ctx, X1, Y1, W1 * 1.14, X2, Y2, W2 * 1.14, alt ? pal.rumble1 : pal.rumble2)
    // calzada
    quad(ctx, X1, Y1, W1, X2, Y2, W2, alt ? pal.road1 : pal.road2)
    // líneas de carril discontinuas
    if (alt) {
      for (let l = 1; l < 3; l++) {
        const o = (-1 + (2 * l) / 3)
        quad(ctx, X1 + W1 * o, Y1, W1 * 0.012, X2 + W2 * o, Y2, W2 * 0.012, pal.lane)
      }
    }
    // línea continua del borde
    quad(ctx, X1 - W1 * 0.95, Y1, W1 * 0.016, X2 - W2 * 0.95, Y2, W2 * 0.016, pal.lane)
    quad(ctx, X1 + W1 * 0.95, Y1, W1 * 0.016, X2 + W2 * 0.95, Y2, W2 * 0.016, pal.lane)

    // niebla atmosférica hacia el horizonte
    const fog = 1 - Math.exp(-((n / DRAW) ** 3.2) * 5)
    if (fog > 0.012) {
      ctx.globalAlpha = Math.min(1, fog)
      ctx.fillStyle = pal.fog
      ctx.fillRect(0, Y2, W, Y1 - Y2 + 1)
      ctx.globalAlpha = 1
    }
  }

  /* ----------------- SPRITES: mobiliario + tráfico (lejos→cerca) ---------- */
  interface S { n: number; z: number; draw: () => void }
  const sprites: S[] = []

  // postes, árboles y carteles kilométricos (deterministas por índice)
  for (let n = DRAW - 1; n >= 4; n--) {
    const i = base + n
    const h1 = hash(i)
    const esKm = i % 333 === 0
    if (!esKm && h1 > 0.085) continue
    const lado = esKm ? 1 : hash(i + 7) < 0.5 ? -1 : 1
    const off = (1.35 + hash(i + 3) * 0.9) * lado
    const s = scaleOf(i * SEG)
    const sx = W / 2 + s * (xw[n] + off * ROAD_W - camX) * W / 2
    const sy = H / 2 - s * (yw[n] - camY) * H / 2
    const sc = s * W / 2
    if (sx < -W || sx > W * 2) continue
    sprites.push({
      n, z: i * SEG,
      draw: () => {
        if (esKm) {
          // cartel kilométrico: engancha con el odómetro del HUD
          const w = 260 * sc, h = 180 * sc
          if (w < 1) return
          ctx.fillStyle = '#2B2E34'; ctx.fillRect(sx - w * 0.06, sy - h * 2.2, w * 0.12, h * 2.2)
          ctx.fillStyle = '#1F6B3A'; ctx.fillRect(sx - w / 2, sy - h * 3.1, w, h)
          ctx.fillStyle = '#EDE9E0'
          ctx.font = `700 ${Math.max(4, h * 0.52)}px 'JetBrains Mono', monospace`
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
          ctx.fillText(String(Math.round((i * SEG) / 100000)), sx, sy - h * 2.58)
        } else {
          const tipo = hash(i * 3.1)
          if (tipo < 0.5) {
            // árbol
            const h = (900 + hash(i * 5) * 700) * sc
            if (h < 1) return
            ctx.fillStyle = `rgba(40,30,22,${0.9 - pal.dark * 0.3})`
            ctx.fillRect(sx - h * 0.045, sy - h * 0.34, h * 0.09, h * 0.34)
            ctx.fillStyle = mix(pal.hillNear, pal.grass1, 0.5)
            ctx.beginPath(); ctx.ellipse(sx, sy - h * 0.55, h * 0.26, h * 0.3, 0, 0, Math.PI * 2); ctx.fill()
          } else {
            // farola
            const h = 1500 * sc
            if (h < 1) return
            ctx.fillStyle = '#4A4A52'
            ctx.fillRect(sx - h * 0.018, sy - h, h * 0.036, h)
            ctx.fillRect(sx - (lado > 0 ? h * 0.22 : 0), sy - h, h * 0.22, h * 0.03)
            if (pal.dark > 0.3) {
              ctx.save(); ctx.globalCompositeOperation = 'lighter'
              const lx = sx - lado * h * 0.2
              const gr = ctx.createRadialGradient(lx, sy - h, 0, lx, sy - h, h * 0.55)
              gr.addColorStop(0, `rgba(255,214,140,${0.5 * pal.dark})`); gr.addColorStop(1, 'rgba(0,0,0,0)')
              ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(lx, sy - h, h * 0.55, 0, Math.PI * 2); ctx.fill()
              ctx.restore()
            }
          }
        }
      },
    })
  }

  // tráfico
  for (const c of g.cars) {
    const rel = c.z - camZ
    if (rel < 0 || rel > DRAW * SEG) continue
    const fi = c.z / SEG
    const n = Math.floor(fi) - base
    if (n < 0 || n >= DRAW) continue
    const fp = fi - Math.floor(fi)
    const s = scaleOf(c.z)
    const cxw = xw[n] + (xw[n + 1] - xw[n]) * fp
    const cyw = yw[n] + (yw[n + 1] - yw[n]) * fp
    const sx = W / 2 + s * (cxw + c.x * ROAD_W - camX) * W / 2
    const sy = H / 2 - s * (cyw - camY) * H / 2
    const sw = s * c.width * 2.1 * W / 2
    const frena = c.speed < c.desired * 0.82
    sprites.push({ n, z: c.z, draw: () => drawCar(ctx, sx, sy, sw, CAR_COLORS[c.color], pal.dark, c.truck, frena, c.blinker, g.time) })
  }

  sprites.sort((a, b) => b.z - a.z)
  for (const s of sprites) s.draw()

  /* ------------------------------ COCHE PROPIO ----------------------------
   * MISMA proyección que el tráfico: el coche es un sprite situado a PLAYER_Z
   * de la cámara, por lo que su tamaño en pantalla sale de la perspectiva y
   * no de un porcentaje fijo. Así la escala con los demás vehículos es exacta.
   *   escala  = CAM_DEPTH / PLAYER_Z
   *   ancho   = escala · PLAYER_W · 2.1 · W/2      (idéntico a drawCar del tráfico)
   *   baseY   = H/2 + escala · CAM_H · H/2         (el suelo bajo la cámara)
   * ----------------------------------------------------------------------*/
  const sP = camDepth / PLAYER_Z
  const pw = sP * PLAYER_W * 2.1 * W / 2
  // posición real del coche sobre la calzada a PLAYER_Z por delante de la cámara
  const fnP = PLAYER_Z / SEG
  const nP = Math.floor(fnP), frP = fnP - nP
  const roadXP = xw[nP] + (xw[nP + 1] - xw[nP]) * frP
  const roadYP = yw[nP] + (yw[nP + 1] - yw[nP]) * frP
  const bob = Math.sin(g.time * 7) * (0.3 + g.speedPct * 0.7) + (g.shake > 0 ? Math.sin(g.time * 47) * g.shake * 3.4 : 0)
  const px = W / 2 + sP * (roadXP + g.x * ROAD_W - camX) * W / 2 + (g.shake > 0 ? Math.sin(g.time * 39) * g.shake * 4 : 0)
  const py = H / 2 - sP * (roadYP - camY) * H / 2 + bob

  // faros encendidos de noche
  if (pal.dark > 0.25) {
    ctx.save(); ctx.globalCompositeOperation = 'lighter'
    const hg = ctx.createLinearGradient(0, py, 0, horizon)
    hg.addColorStop(0, `rgba(255,232,180,${0.22 * pal.dark})`); hg.addColorStop(1, 'rgba(255,232,180,0)')
    ctx.fillStyle = hg
    ctx.beginPath()
    ctx.moveTo(px - pw * 0.42, py); ctx.lineTo(px - pw * 1.5, horizon + H * 0.1)
    ctx.lineTo(px + pw * 1.5, horizon + H * 0.1); ctx.lineTo(px + pw * 0.42, py)
    ctx.closePath(); ctx.fill(); ctx.restore()
  }

  ctx.save()
  ctx.translate(px, py)
  // deriva (el morro apunta al giro) + contrabalanceo de carrocería
  ctx.rotate(g.slip * 0.10 - g.roll * 0.05)
  // squat/dive: se comprime al frenar, se estira al acelerar
  ctx.scale(1, 1 - g.pitch * 0.07)
  drawCar(ctx, 0, 0, pw, '#E04A2F', pal.dark, false, g.courtesy > 0, 0, g.time)
  ctx.restore()

  /* -------------------------- EFECTOS DE VELOCIDAD ------------------------ */
  const sp = g.speedPct
  if (sp > 0.45) {
    ctx.save(); ctx.globalAlpha = (sp - 0.45) * 0.5
    ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = 1.2
    for (let i = 0; i < 9; i++) {
      const a = hash(i * 9.1 + Math.floor(g.time * 14)) * Math.PI * 2
      const r0 = W * (0.42 + hash(i * 3.7) * 0.2)
      ctx.beginPath()
      ctx.moveTo(W / 2 + Math.cos(a) * r0, horizon + Math.sin(a) * r0 * 0.8)
      ctx.lineTo(W / 2 + Math.cos(a) * (r0 + 60 * sp), horizon + Math.sin(a) * (r0 + 60 * sp) * 0.8)
      ctx.stroke()
    }
    ctx.restore()
  }

  /* Fin de la cámara del chasis: los efectos de pantalla van sin transformar */
  ctx.restore()

  // viñeta + aviso de cortesía (nunca hay choque, solo aviso amable)
  const vg = ctx.createRadialGradient(W / 2, H * 0.55, H * 0.28, W / 2, H * 0.55, H * 0.85)
  vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, `rgba(0,0,0,${0.3 + pal.dark * 0.22})`)
  ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H)

  if (g.courtesy > 0) {
    ctx.globalAlpha = Math.min(1, g.courtesy * 1.6) * 0.5
    ctx.fillStyle = '#FFB224'
    ctx.fillRect(0, 0, W, 4); ctx.fillRect(0, H - 4, W, 4)
    ctx.globalAlpha = 1
  }
  if (g.shake > 0.05) {
    ctx.globalAlpha = g.shake * 0.25
    ctx.fillStyle = '#C8A36A'; ctx.fillRect(0, 0, W, H)
    ctx.globalAlpha = 1
  }
}

/** Velocímetro textual para el HUD (evita recalcular en React). */
export const hudSpeed = (g: Game) => Math.round(kmh(g.speed))
