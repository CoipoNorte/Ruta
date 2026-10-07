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
  Game, curveAt, hillAt, hash, kmh, limitAt,
} from './engine'

/* ------------------------------- PALETAS ---------------------------------- */
interface Pal {
  skyTop: string; skyBot: string; sun: string; hillFar: string; hillNear: string
  grass1: string; grass2: string; road1: string; road2: string
  rumble1: string; rumble2: string; lane: string; fog: string
  dark: number // 0 día … 1 noche (controla faros y luces)
  phase?: number // 0..1 posición dentro del ciclo diario (sol/luna)
}
const P_AMANECER: Pal = { skyTop: '#2B3A6B', skyBot: '#F2A65A', sun: '#FFD9A0', hillFar: '#4A4A72', hillNear: '#33344F', grass1: '#3C5A4A', grass2: '#365243', road1: '#3A3A42', road2: '#36363E', rumble1: '#C8503C', rumble2: '#EDE6DA', lane: '#E8E2D6', fog: '#7E6B74', dark: 0.35 }
const P_DIA: Pal      = { skyTop: '#2E7FD4', skyBot: '#A8D8F0', sun: '#FFF6D8', hillFar: '#6E96A8', hillNear: '#4C7A63', grass1: '#4E8257', grass2: '#467A50', road1: '#45454E', road2: '#41414A', rumble1: '#D8604A', rumble2: '#F2EDE4', lane: '#F2EDE4', fog: '#B8D6E6', dark: 0 }
const P_ATARDECER: Pal= { skyTop: '#1F2A52', skyBot: '#E4653C', sun: '#FFC27A', hillFar: '#55466A', hillNear: '#3A3350', grass1: '#3F5346', grass2: '#394C40', road1: '#3C3A44', road2: '#38363F', rumble1: '#C4503A', rumble2: '#E8E0D4', lane: '#E4DCCE', fog: '#9A6A5E', dark: 0.45 }
const P_NOCHE: Pal    = { skyTop: '#060A18', skyBot: '#131E38', sun: '#DCE6F5', hillFar: '#141C30', hillNear: '#101627', grass1: '#16261F', grass2: '#13211B', road1: '#232329', road2: '#1F1F25', rumble1: '#7A3326', rumble2: '#9A948A', lane: '#B9B2A4', fog: '#0C1424', dark: 1 }

/* Ciclo diario con fases de DURACIÓN DESIGUAL (antes los 4 estados duraban lo
 * mismo y la noche se hacía eterna). Ahora: día largo, crepúsculos breves e
 * intensos y noche contenida. `t` es la fracción del ciclo. */
const CICLO_KM = 34
const FASES: { t: number; pal: Pal }[] = [
  { t: 0.00, pal: P_NOCHE },
  { t: 0.07, pal: P_NOCHE },
  { t: 0.15, pal: P_AMANECER },
  { t: 0.26, pal: P_DIA },
  { t: 0.56, pal: P_DIA },
  { t: 0.68, pal: P_ATARDECER },
  { t: 0.80, pal: P_NOCHE },
  { t: 1.00, pal: P_NOCHE },
]

/* Lee un color en hex (#RRGGBB) O en rgb(r,g,b). IMPRESCINDIBLE: palette()
 * ya devuelve rgb(...), así que las mezclas encadenadas (lluvia, retrovisor)
 * reciben ese formato. Si no se contempla, sale NaN y `addColorStop` lanza
 * una excepción que mata el render entero. */
const hex = (c: string): [number, number, number] => {
  if (c[0] === '#') {
    return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]
  }
  const m = c.match(/-?\d+(\.\d+)?/g)
  return m ? [Number(m[0]) || 0, Number(m[1]) || 0, Number(m[2]) || 0] : [0, 0, 0]
}
const mix = (a: string, b: string, t: number) => {
  const A = hex(a), B = hex(b)
  return `rgb(${Math.round(A[0] + (B[0] - A[0]) * t)},${Math.round(A[1] + (B[1] - A[1]) * t)},${Math.round(A[2] + (B[2] - A[2]) * t)})`
}

export function palette(km: number): Pal {
  const t = ((km / CICLO_KM) % 1 + 1) % 1
  let s = 0
  while (s < FASES.length - 2 && t >= FASES[s + 1].t) s++
  const A = FASES[s].pal, B = FASES[s + 1].pal
  const span = FASES[s + 1].t - FASES[s].t
  const kk = span > 0 ? (t - FASES[s].t) / span : 0
  // suavizado coseno: los amaneceres entran y salen sin cortes visibles
  const k = 0.5 - 0.5 * Math.cos(Math.min(1, Math.max(0, kk)) * Math.PI)
  return {
    phase: t,
    skyTop: mix(A.skyTop, B.skyTop, k), skyBot: mix(A.skyBot, B.skyBot, k),
    sun: mix(A.sun, B.sun, k), hillFar: mix(A.hillFar, B.hillFar, k), hillNear: mix(A.hillNear, B.hillNear, k),
    grass1: mix(A.grass1, B.grass1, k), grass2: mix(A.grass2, B.grass2, k),
    road1: mix(A.road1, B.road1, k), road2: mix(A.road2, B.road2, k),
    rumble1: mix(A.rumble1, B.rumble1, k), rumble2: mix(A.rumble2, B.rumble2, k),
    lane: mix(A.lane, B.lane, k), fog: mix(A.fog, B.fog, k),
    dark: A.dark + (B.dark - A.dark) * k,
  }
}

const CAR_COLORS = [
  '#D94F3D', '#E8E4DC', '#2F6FB5', '#2B2E34', '#C9A227', '#4B8C6A', '#8A5BB5',
  '#F2F4F6',  // 7 · ambulancia (blanco)
  '#1C2E55',  // 8 · patrulla (azul policía)
]

/** Barra de luces de emergencia + halo pulsante (ambulancia / patrulla). */
function drawSiren(
  ctx: CanvasRenderingContext2D, cx: number, topY: number, w: number, h: number,
  fase: number, azulRojo: boolean,
) {
  if (w < 4) return
  const bw = w * 0.56, bh = Math.max(1.2, h * 0.07)
  const bx = cx - bw / 2, by = topY - bh * 0.9
  ctx.fillStyle = '#1A1C21'
  rr(ctx, bx, by, bw, bh, bh * 0.35); ctx.fill()
  const t = Math.floor(fase * 7) % 2 === 0
  const c1 = azulRojo ? (t ? '#2E6BFF' : '#12204A') : (t ? '#FF3B2F' : '#4A1512')
  const c2 = azulRojo ? (t ? '#13224E' : '#2E6BFF') : (t ? '#4A1512' : '#FF3B2F')
  ctx.fillStyle = c1; ctx.fillRect(bx + bw * 0.04, by + bh * 0.14, bw * 0.42, bh * 0.72)
  ctx.fillStyle = c2; ctx.fillRect(bx + bw * 0.54, by + bh * 0.14, bw * 0.42, bh * 0.72)
  // halo proyectado
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  const lado = t ? bx + bw * 0.25 : bx + bw * 0.75
  const g = ctx.createRadialGradient(lado, by, 0, lado, by, w * 1.1)
  g.addColorStop(0, azulRojo ? 'rgba(60,110,255,0.5)' : 'rgba(255,60,45,0.5)')
  g.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = g
  ctx.beginPath(); ctx.arc(lado, by, w * 1.1, 0, Math.PI * 2); ctx.fill()
  ctx.restore()
}

/* ------------------------------- UTILIDADES ------------------------------- */
function quad(ctx: CanvasRenderingContext2D, x1: number, y1: number, w1: number, x2: number, y2: number, w2: number, color: string) {
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.moveTo(x1 - w1, y1); ctx.lineTo(x2 - w2, y2); ctx.lineTo(x2 + w2, y2); ctx.lineTo(x1 + w1, y1)
  ctx.closePath(); ctx.fill()
}

/** Oscurece/aclara un color para sombreados de carrocería. */
const shade = (c: string, k: number) => {
  const [r, g, b] = hex(c)
  const f = (v: number) => Math.round(Math.max(0, Math.min(255, k < 0 ? v * (1 + k) : v + (255 - v) * k)))
  return `rgb(${f(r)},${f(g)},${f(b)})`
}

/** Rectángulo redondeado compatible (roundRect no existe en navegadores viejos). */
function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r)
  else ctx.rect(x, y, w, h)
}

/** Vehículo visto desde atrás, con silueta y sombreado tipo simulador clásico:
 *  pasos de rueda abombados, invernadero más estrecho que la carrocería,
 *  luneta inclinada con reflejo, paragolpes oscuro, difusor y escape.
 *  LOD en 3 niveles según el tamaño en pantalla. */
function drawCar(
  ctx: CanvasRenderingContext2D, cx: number, baseY: number, w: number,
  color: string, dark: number, truck: boolean, brake: boolean, blinker: number, t: number,
) {
  if (w < 1.2) return
  const h = w * (truck ? 1.3 : 0.8)
  const y = baseY - h
  const alto = w > 26      // detalle completo
  const medio = w > 12     // detalle intermedio
  const luz = 1 - dark     // 1 de día, 0 de noche
  ctx.save()

  /* ---------------------------- sombra de contacto ---------------------- */
  const sg = ctx.createRadialGradient(cx, baseY, 0, cx, baseY, w * 0.62)
  sg.addColorStop(0, `rgba(0,0,0,${0.45 + dark * 0.2})`)
  sg.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = sg
  ctx.beginPath(); ctx.ellipse(cx, baseY, w * 0.62, Math.max(1, h * 0.12), 0, 0, Math.PI * 2); ctx.fill()

  /* -------------------------------- ruedas ------------------------------ */
  if (medio) {
    const rw = w * (truck ? 0.15 : 0.19), rh = h * (truck ? 0.14 : 0.21)
    ctx.fillStyle = '#121317'
    rr(ctx, cx - w * 0.5, baseY - rh, rw, rh, rw * 0.22); ctx.fill()
    rr(ctx, cx + w * 0.5 - rw, baseY - rh, rw, rh, rw * 0.22); ctx.fill()
    if (alto) {       // llanta insinuada
      ctx.fillStyle = 'rgba(190,196,205,0.5)'
      ctx.fillRect(cx - w * 0.5 + rw * 0.26, baseY - rh * 0.62, rw * 0.48, rh * 0.3)
      ctx.fillRect(cx + w * 0.5 - rw + rw * 0.26, baseY - rh * 0.62, rw * 0.48, rh * 0.3)
    }
  }

  if (truck) {
    /* ============================== CAMIÓN ============================== */
    const bw = w
    ctx.fillStyle = shade(color, -0.1)
    rr(ctx, cx - bw / 2, y, bw, h * 0.86, w * 0.03); ctx.fill()
    if (medio) {
      // portones con bisagras y franja reflectante inferior
      ctx.strokeStyle = `rgba(0,0,0,${0.34})`; ctx.lineWidth = Math.max(0.6, w * 0.014)
      ctx.beginPath()
      ctx.moveTo(cx, y + h * 0.04); ctx.lineTo(cx, y + h * 0.78); ctx.stroke()
      ctx.strokeRect(cx - bw * 0.45, y + h * 0.05, bw * 0.9, h * 0.74)
      ctx.fillStyle = `rgba(245,196,60,${0.75})`
      for (let i = 0; i < 5; i++) ctx.fillRect(cx - bw * 0.45 + i * bw * 0.19, y + h * 0.82, bw * 0.1, h * 0.03)
      // luces de gálibo en el techo
      ctx.fillStyle = `rgba(255,186,70,${0.5 + dark * 0.5})`
      for (const o of [-0.4, -0.13, 0.13, 0.4]) ctx.fillRect(cx + bw * o, y - h * 0.018, bw * 0.05, h * 0.02)
    }
    // sombreado de volumen
    const vg = ctx.createLinearGradient(cx - bw / 2, 0, cx + bw / 2, 0)
    vg.addColorStop(0, `rgba(0,0,0,${0.34})`); vg.addColorStop(0.35, 'rgba(255,255,255,0.04)')
    vg.addColorStop(1, `rgba(0,0,0,${0.38})`)
    ctx.fillStyle = vg
    rr(ctx, cx - bw / 2, y, bw, h * 0.86, w * 0.03); ctx.fill()
  } else {
    /* ======================= TURISMO (hatchback tipo Demio) ==============
     * Silueta de utilitario compacto visto desde atrás: una sola carrocería
     * continua, techo redondeado y estrecho que cae en hombros anchos, luneta
     * grande con spoiler, y pilotos envolventes altos en las esquinas.
     * Se dibuja de una pasada para que SIEMPRE se lea como un coche. */
    const bw = w                 // hombros = ancho total
    const tw = w * 0.60          // ancho del techo
    const roofY = y
    const beltY = y + h * 0.40   // base de las ventanas
    const sillY = baseY - h * 0.1

    // --- silueta completa: techo abovedado + costados con hombro ---
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.moveTo(cx - tw / 2, roofY + h * 0.06)
    ctx.quadraticCurveTo(cx - tw / 2, roofY, cx - tw * 0.36, roofY)   // esquina techo izq
    ctx.lineTo(cx + tw * 0.36, roofY)
    ctx.quadraticCurveTo(cx + tw / 2, roofY, cx + tw / 2, roofY + h * 0.06)
    ctx.quadraticCurveTo(cx + bw * 0.5, beltY, cx + bw * 0.5, beltY + h * 0.14) // hombro der
    ctx.lineTo(cx + bw * 0.5, sillY)
    ctx.quadraticCurveTo(cx + bw * 0.5, baseY, cx + bw * 0.4, baseY)  // paso de rueda
    ctx.lineTo(cx - bw * 0.4, baseY)
    ctx.quadraticCurveTo(cx - bw * 0.5, baseY, cx - bw * 0.5, sillY)
    ctx.lineTo(cx - bw * 0.5, beltY + h * 0.14)
    ctx.quadraticCurveTo(cx - bw * 0.5, beltY, cx - tw / 2, roofY + h * 0.06)
    ctx.closePath(); ctx.fill()

    // --- sombreado de chapa (volumen redondeado) ---
    const bg = ctx.createLinearGradient(cx - bw / 2, 0, cx + bw / 2, 0)
    bg.addColorStop(0, `rgba(0,0,0,${0.38 - dark * 0.12})`)
    bg.addColorStop(0.24, `rgba(255,255,255,${0.06 + luz * 0.07})`)
    bg.addColorStop(0.6, 'rgba(0,0,0,0.02)')
    bg.addColorStop(1, `rgba(0,0,0,${0.42 - dark * 0.12})`)
    ctx.fillStyle = bg
    ctx.fillRect(cx - bw / 2, roofY, bw, h)

    // --- luneta trasera grande e inclinada ---
    if (w > 7) {
      const gTop = roofY + h * 0.07, gBot = beltY
      ctx.fillStyle = `rgba(15,20,28,${0.7 + dark * 0.22})`
      ctx.beginPath()
      ctx.moveTo(cx - tw * 0.42, gTop)
      ctx.lineTo(cx + tw * 0.42, gTop)
      ctx.lineTo(cx + tw * 0.56, gBot)
      ctx.lineTo(cx - tw * 0.56, gBot)
      ctx.closePath(); ctx.fill()
      if (medio) {
        // reflejo del cielo
        ctx.fillStyle = `rgba(178,208,238,${0.09 + luz * 0.14})`
        ctx.beginPath()
        ctx.moveTo(cx - tw * 0.5, gBot)
        ctx.lineTo(cx - tw * 0.06, gTop)
        ctx.lineTo(cx + tw * 0.1, gTop)
        ctx.lineTo(cx - tw * 0.26, gBot)
        ctx.closePath(); ctx.fill()
        // spoiler sobre la luneta (muy característico del hatchback)
        ctx.fillStyle = shade(color, -0.3)
        rr(ctx, cx - tw * 0.46, roofY - h * 0.012, tw * 0.92, h * 0.045, h * 0.018); ctx.fill()
      }
      if (alto) {
        // limpialuneta y tercera luz
        ctx.strokeStyle = 'rgba(18,20,24,0.75)'; ctx.lineWidth = Math.max(0.6, w * 0.014)
        ctx.beginPath()
        ctx.moveTo(cx - tw * 0.26, gBot - h * 0.02); ctx.lineTo(cx + tw * 0.14, gTop + h * 0.1); ctx.stroke()
      }
    }

    if (medio) {
      // brillo de la línea de cintura y portón
      ctx.fillStyle = `rgba(255,255,255,${0.09 + luz * 0.12})`
      ctx.fillRect(cx - bw * 0.46, beltY + h * 0.015, bw * 0.92, Math.max(0.7, h * 0.014))
      ctx.strokeStyle = `rgba(0,0,0,${0.22})`; ctx.lineWidth = Math.max(0.5, w * 0.008)
      ctx.beginPath()
      ctx.moveTo(cx - bw * 0.42, beltY + h * 0.05); ctx.lineTo(cx - bw * 0.42, baseY - h * 0.2)
      ctx.moveTo(cx + bw * 0.42, beltY + h * 0.05); ctx.lineTo(cx + bw * 0.42, baseY - h * 0.2)
      ctx.stroke()
      // paragolpes
      ctx.fillStyle = `rgba(26,28,33,${0.5})`
      rr(ctx, cx - bw * 0.48, baseY - h * 0.17, bw * 0.96, h * 0.15, h * 0.035); ctx.fill()
    }
    if (alto) {
      ctx.fillStyle = 'rgba(150,155,165,0.6)'
      ctx.fillRect(cx + bw * 0.24, baseY - h * 0.055, bw * 0.09, h * 0.026)
      ctx.fillStyle = shade(color, -0.34)
      ctx.fillRect(cx - bw / 2 - w * 0.045, beltY - h * 0.07, w * 0.05, h * 0.05)
      ctx.fillRect(cx + bw / 2 - w * 0.005, beltY - h * 0.07, w * 0.05, h * 0.05)
    }
  }

  /* --------------------------- grupo óptico trasero --------------------- */
  const bodyW = truck ? w : w
  // en el hatchback los pilotos son verticales y envolventes, pegados al hombro
  const lw = Math.max(1.1, bodyW * (truck ? 0.13 : 0.15))
  const lh = Math.max(1, h * (truck ? 0.07 : 0.15))
  const ly = truck ? y + h * 0.79 : y + h * 0.43
  const lx1 = cx - bodyW * 0.46, lx2 = cx + bodyW * 0.46 - lw
  for (const lx of [lx1, lx2]) {
    // carcasa
    if (medio) {
      ctx.fillStyle = 'rgba(28,20,20,0.5)'
      rr(ctx, lx - lw * 0.08, ly - lh * 0.12, lw * 1.16, lh * 1.24, lh * 0.3); ctx.fill()
    }
    ctx.fillStyle = brake ? '#FF4132' : `rgba(176,34,26,${0.55 + dark * 0.45})`
    rr(ctx, lx, ly, lw, lh, lh * 0.32); ctx.fill()
    if (alto) {  // franja interior clara (reversa / intermitente integrado)
      ctx.fillStyle = `rgba(250,236,220,${0.28})`
      ctx.fillRect(lx + lw * 0.12, ly + lh * 0.62, lw * 0.52, lh * 0.22)
    }
  }
  // tercera luz de freno (bajo el spoiler)
  if (brake && medio && !truck) {
    ctx.fillStyle = '#FF5A48'
    ctx.fillRect(cx - bodyW * 0.15, y + h * 0.055, bodyW * 0.3, Math.max(0.8, h * 0.022))
  }
  // halo luminoso
  if ((brake || dark > 0.3) && w > 5) {
    ctx.globalCompositeOperation = 'lighter'
    ctx.fillStyle = brake ? 'rgba(255,66,46,0.5)' : `rgba(220,50,30,${0.13 + dark * 0.2})`
    for (const lx of [lx1 + lw / 2, lx2 + lw / 2]) {
      ctx.beginPath(); ctx.ellipse(lx, ly + lh / 2, w * 0.27, h * 0.16, 0, 0, Math.PI * 2); ctx.fill()
    }
    ctx.globalCompositeOperation = 'source-over'
  }

  /* -------------------------------- matrícula --------------------------- */
  if (medio) {
    const pw2 = bodyW * 0.26, py2 = truck ? ly + lh * 1.5 : baseY - h * 0.145
    ctx.fillStyle = `rgba(238,234,224,${0.72 - dark * 0.22})`
    rr(ctx, cx - pw2 / 2, py2, pw2, Math.max(1, h * 0.052), h * 0.01); ctx.fill()
    if (alto) {
      ctx.fillStyle = 'rgba(40,60,130,0.75)'
      ctx.fillRect(cx - pw2 / 2, py2, pw2 * 0.14, Math.max(1, h * 0.052))
    }
  }

  /* ------------------- intermitente (relé real ≈ 1,3 Hz) ---------------- */
  if (blinker !== 0 && Math.floor(t * 2.6) % 2 === 0 && w > 4) {
    const bx = blinker < 0 ? lx1 : lx2
    ctx.fillStyle = '#FFB224'
    rr(ctx, bx, ly - lh * 1.3, lw, lh * 0.92, lh * 0.3); ctx.fill()
    ctx.globalCompositeOperation = 'lighter'
    ctx.fillStyle = 'rgba(255,178,36,0.45)'
    ctx.beginPath(); ctx.ellipse(bx + lw / 2, ly - lh * 0.84, w * 0.26, h * 0.15, 0, 0, Math.PI * 2); ctx.fill()
    ctx.globalCompositeOperation = 'source-over'
  }
  ctx.restore()
}

/* ================================ RENDER ================================== */
export function render(ctx: CanvasRenderingContext2D, g: Game, W: number, H: number) {
  const pal = palette(g.km)
  /* Lluvia: oscurece cielo y asfalto, apaga el césped y cierra la visibilidad.
   * Se aplica sobre la paleta del ciclo diario para que ambos se combinen. */
  if (g.rain > 0.02) {
    const r = g.rain
    pal.skyTop = mix(pal.skyTop, '#2C3139', r * 0.72)
    pal.skyBot = mix(pal.skyBot, '#525A63', r * 0.7)
    pal.road1 = mix(pal.road1, '#14161B', r * 0.55)
    pal.road2 = mix(pal.road2, '#101217', r * 0.55)
    pal.grass1 = mix(pal.grass1, '#27332B', r * 0.5)
    pal.grass2 = mix(pal.grass2, '#222D26', r * 0.5)
    pal.fog = mix(pal.fog, '#6E757D', r * 0.6)
    pal.hillFar = mix(pal.hillFar, '#3A4048', r * 0.65)
    pal.dark = Math.min(1, pal.dark + r * 0.3)
  }
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

  /* Sol / luna: recorre el cielo de este a oeste según la fase del ciclo y se
   * eleva en un arco (seno), en vez de estar siempre clavado en el mismo sitio. */
  const horizon = H * 0.42 + horizonBias * H
  const ph = pal.phase ?? 0
  const arco = ((ph - 0.12) / 0.72 + 1) % 1          // 0 al amanecer, 1 al ocaso
  const sunX = W * (0.12 + arco * 0.76) - g.x * W * 0.08 - curveAt(base + 60) * W * 0.05
  const sunY = horizon - H * (0.03 + Math.sin(Math.min(1, Math.max(0, arco)) * Math.PI) * 0.26)
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

    /* --- PROFUNDIDAD AMBIENTAL (estilo GT) ---------------------------------
     * Elementos que acompañan a la calzada en toda su longitud y dan lectura
     * de velocidad y volumen: talud lateral, guardarraíl metálico con postes
     * y, de noche, captafaros reflectantes. Solo en los segmentos cercanos. */
    if (n < 150 && W1 > 1.5) {
      // talud: franja de tierra entre la calzada y el césped
      quad(ctx, X1, Y1, W1 * 1.3, X2, Y2, W2 * 1.3, mix(pal.grass2, '#5B4A38', 0.45))
      quad(ctx, X1, Y1, W1 * 1.14, X2, Y2, W2 * 1.14, alt ? pal.rumble1 : pal.rumble2)
      quad(ctx, X1, Y1, W1, X2, Y2, W2, alt ? pal.road1 : pal.road2)

      // guardarraíl: biga continua + poste cada 3 segmentos
      const gH1 = W1 * 0.1, gH2 = W2 * 0.1
      for (const sgn of [-1, 1]) {
        const gx1 = X1 + sgn * W1 * 1.22, gx2 = X2 + sgn * W2 * 1.22
        ctx.fillStyle = mix('#9AA2AC', pal.fog, 0.35)
        ctx.beginPath()
        ctx.moveTo(gx1, Y1 - gH1); ctx.lineTo(gx2, Y2 - gH2)
        ctx.lineTo(gx2, Y2 - gH2 * 0.35); ctx.lineTo(gx1, Y1 - gH1 * 0.35)
        ctx.closePath(); ctx.fill()
        if (i % 3 === 0) {
          ctx.fillStyle = mix('#5C636D', pal.fog, 0.3)
          ctx.fillRect(gx1 - W1 * 0.012, Y1 - gH1, Math.max(0.6, W1 * 0.024), gH1)
        }
        if (pal.dark > 0.35 && i % 6 === 0) {       // captafaros
          ctx.fillStyle = `rgba(255,190,90,${0.35 * pal.dark})`
          ctx.fillRect(gx1 - W1 * 0.014, Y1 - gH1 * 1.05, Math.max(0.7, W1 * 0.028), Math.max(0.7, gH1 * 0.22))
        }
      }
    }

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
    const esLimite = i % 900 === 0
    if (!esKm && !esLimite && h1 > 0.085) continue
    const lado = esKm || esLimite ? 1 : hash(i + 7) < 0.5 ? -1 : 1
    const off = (1.35 + hash(i + 3) * 0.9) * lado
    const s = scaleOf(i * SEG)
    const sx = W / 2 + s * (xw[n] + off * ROAD_W - camX) * W / 2
    const sy = H / 2 - s * (yw[n] - camY) * H / 2
    const sc = s * W / 2
    if (sx < -W || sx > W * 2) continue
    sprites.push({
      n, z: i * SEG,
      draw: () => {
        if (esLimite) {
          // señal circular de límite de velocidad (inicio de tramo)
          const rad = 150 * sc
          if (rad < 1.2) return
          const cy = sy - rad * 3.1
          ctx.fillStyle = '#3A3D44'
          ctx.fillRect(sx - rad * 0.09, cy, rad * 0.18, rad * 3.1)
          ctx.beginPath(); ctx.arc(sx, cy, rad, 0, Math.PI * 2)
          ctx.fillStyle = '#F2EFE8'; ctx.fill()
          ctx.lineWidth = Math.max(0.8, rad * 0.17)
          ctx.strokeStyle = '#D33A2C'; ctx.stroke()
          if (rad > 5) {
            ctx.fillStyle = '#17181C'
            ctx.font = `700 ${rad * 0.98}px 'JetBrains Mono', monospace`
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
            ctx.fillText(String(limitAt(i)), sx, cy + rad * 0.04)
          }
        } else if (esKm) {
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
    const emerg = c.kind === 'ambulancia' || c.kind === 'patrulla'
    sprites.push({
      n, z: c.z,
      draw: () => {
        drawCar(ctx, sx, sy, sw, CAR_COLORS[c.color], pal.dark, c.truck, frena, c.blinker, g.time)
        if (emerg) {
          const ch = sw * 0.8
          // franjas de identificación en el costado
          if (sw > 16) {
            ctx.fillStyle = c.kind === 'ambulancia' ? 'rgba(220,60,48,0.85)' : 'rgba(236,240,245,0.9)'
            ctx.fillRect(sx - sw * 0.48, sy - ch * 0.46, sw * 0.96, Math.max(1, ch * 0.1))
          }
          drawSiren(ctx, sx, sy - ch, sw, ch, c.siren, c.kind === 'patrulla')
        }
      },
    })
  }

  /* ------------------------------ COCHE PROPIO ----------------------------
   * MISMA proyección que el tráfico: el coche es un sprite situado a PLAYER_Z
   * de la cámara, por lo que su tamaño sale de la perspectiva.
   * IMPORTANTE: se inserta en la MISMA lista de sprites con su `z` real
   * (`g.pz`), de modo que el algoritmo del pintor lo ordena con el tráfico.
   * Así, un coche que está entre la cámara y nosotros se dibuja POR DELANTE
   * (antes el jugador se pintaba siempre al final y parecía atravesarlos).
   * ----------------------------------------------------------------------*/
  const sP = camDepth / PLAYER_Z
  const pw = sP * PLAYER_W * 2.1 * W / 2
  const fnP = PLAYER_Z / SEG
  const nP = Math.floor(fnP), frP = fnP - nP
  const roadXP = xw[nP] + (xw[nP + 1] - xw[nP]) * frP
  const roadYP = yw[nP] + (yw[nP + 1] - yw[nP]) * frP
  const bob = Math.sin(g.time * 7) * (0.3 + g.speedPct * 0.7) + (g.shake > 0 ? Math.sin(g.time * 47) * g.shake * 3.4 : 0)
  const px = W / 2 + sP * (roadXP + g.x * ROAD_W - camX) * W / 2 + (g.shake > 0 ? Math.sin(g.time * 39) * g.shake * 4 : 0)
  const py = H / 2 - sP * (roadYP - camY) * H / 2 + bob

  // faros: van bajo todos los sprites (es luz proyectada sobre el asfalto)
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

  sprites.push({
    n: 0, z: g.pz,
    draw: () => {
      ctx.save()
      ctx.translate(px, py)
      ctx.rotate(g.slip * 0.10 - g.roll * 0.05)   // deriva + contrabalanceo
      ctx.scale(1, 1 - g.pitch * 0.07)            // squat / dive
      drawCar(ctx, 0, 0, pw, '#E04A2F', pal.dark, false, g.braking || g.courtesy > 0, g.blinker, g.time)
      ctx.restore()
    },
  })

  sprites.sort((a, b) => b.z - a.z)
  for (const s of sprites) s.draw()

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

  /* roce: destello rojo perimetral — "estás haciendo algo mal", sin derrota */
  if (g.contact > 0) {
    const a = Math.min(1, g.contact * 1.4)
    const cg = ctx.createRadialGradient(W / 2, H * 0.55, H * 0.2, W / 2, H * 0.55, H * 0.8)
    cg.addColorStop(0, 'rgba(0,0,0,0)')
    cg.addColorStop(1, `rgba(220,52,38,${a * 0.42})`)
    ctx.fillStyle = cg; ctx.fillRect(0, 0, W, H)
  }
  if (g.shake > 0.05) {
    ctx.globalAlpha = g.shake * 0.25
    ctx.fillStyle = '#C8A36A'; ctx.fillRect(0, 0, W, H)
    ctx.globalAlpha = 1
  }

  /* --------------------------------- LLUVIA -------------------------------
   * Gotas en el parabrisas: la inclinación depende de la velocidad (viento
   * relativo) y la densidad de la intensidad meteorológica. */
  if (g.rain > 0.03) {
    const n = Math.floor(g.rain * 110)
    const inc = 0.18 + g.speedPct * 0.5     // más velocidad = más diagonal
    const largo = 14 + g.speedPct * 46
    ctx.save()
    ctx.strokeStyle = `rgba(200,220,255,${0.18 + g.rain * 0.22})`
    ctx.lineWidth = 1.1
    ctx.beginPath()
    for (let i = 0; i < n; i++) {
      const t = (g.time * (1.6 + hash(i) * 1.4) + hash(i * 2.3)) % 1
      const rx = hash(i * 7.1) * W * 1.2 - W * 0.1
      const ry = t * (H + largo) - largo
      ctx.moveTo(rx, ry)
      ctx.lineTo(rx - largo * inc, ry + largo)
    }
    ctx.stroke()
    ctx.restore()
  }

  /* ------------------------------ RETROVISOR ------------------------------
   * Inset en el canvas (no un segundo lienzo): proyecta los coches que vienen
   * por detrás con la misma matemática, mirando hacia atrás. En un espejo
   * retrovisor la izquierda sigue siendo la izquierda, así que no se invierte. */
  drawMirror(ctx, g, W, H, pal)
}

function drawMirror(ctx: CanvasRenderingContext2D, g: Game, W: number, H: number, pal: Pal) {
  const mw = Math.min(W * 0.58, 290)
  const mh = Math.max(44, Math.min(H * 0.072, 62))
  const mx = (W - mw) / 2
  const my = H * 0.105

  ctx.save()
  // marco y cristal
  ctx.beginPath()
  if (ctx.roundRect) ctx.roundRect(mx, my, mw, mh, 8)
  else ctx.rect(mx, my, mw, mh)
  ctx.fillStyle = mix(pal.road2, '#0B0D11', 0.45)
  ctx.fill()
  ctx.clip()

  // suelo del espejo con perspectiva invertida
  const grad = ctx.createLinearGradient(0, my, 0, my + mh)
  grad.addColorStop(0, mix(pal.skyBot, '#1A1E25', 0.5))
  grad.addColorStop(0.42, mix(pal.road1, '#15181D', 0.3))
  grad.addColorStop(1, mix(pal.road2, '#0D0F13', 0.2))
  ctx.fillStyle = grad
  ctx.fillRect(mx, my, mw, mh)

  // líneas de carril fugando hacia el horizonte del espejo
  const hx = mx + mw / 2, hy = my + mh * 0.38
  ctx.strokeStyle = `rgba(240,236,226,${0.18 + pal.dark * 0.1})`
  ctx.lineWidth = 1
  for (const o of [-0.33, 0.33]) {
    ctx.beginPath()
    ctx.moveTo(hx + o * mw * 0.18, hy)
    ctx.lineTo(hx + o * mw * 1.5, my + mh)
    ctx.stroke()
  }

  // coches que se acercan por detrás (lejos → cerca)
  for (const c of g.behind(16000)) {
    const d = g.z - c.z
    const s = Math.max(0.05, 1 - d / 16000)
    const esc = Math.pow(s, 2.1)
    const cw = Math.max(1.5, esc * mw * 0.3)
    const cy = hy + esc * mh * 0.72
    const cx = hx + (c.x - g.x) * mw * 0.42 * (0.25 + esc * 0.9)
    if (cx < mx - cw || cx > mx + mw + cw) continue
    drawCar(ctx, cx, cy, cw, CAR_COLORS[c.color], pal.dark, c.truck, false, c.blinker, g.time)
  }
  ctx.restore()

  // marco exterior + aviso de ángulo muerto
  ctx.save()
  ctx.beginPath()
  if (ctx.roundRect) ctx.roundRect(mx, my, mw, mh, 8)
  else ctx.rect(mx, my, mw, mh)
  ctx.strokeStyle = 'rgba(255,255,255,0.22)'
  ctx.lineWidth = 1.5
  ctx.stroke()

  if (g.blindSpot !== 0 && Math.floor(g.time * 3) % 2 === 0) {
    const bx = g.blindSpot < 0 ? mx + 7 : mx + mw - 21
    ctx.fillStyle = '#FFB224'
    ctx.beginPath()
    ctx.moveTo(bx + 7, my + 6); ctx.lineTo(bx + 14, my + 18); ctx.lineTo(bx, my + 18)
    ctx.closePath(); ctx.fill()
  }
  ctx.restore()
}

/** Velocímetro textual para el HUD (evita recalcular en React). */
export const hudSpeed = (g: Game) => Math.round(kmh(g.speed))
