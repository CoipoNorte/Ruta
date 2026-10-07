# [RUTA · Autopista infinita — Documentación técnica](https://coiponorte.github.io/Ruta/)

Juego de conducción para **móvil en vertical**, de una sola vista y sin
backend. Filosofía: **no hay choques, muertes ni derrota** — el objetivo es
integrarse al tránsito, adelantar con calma y acumular kilómetros. Toda la
simulación, el render pseudo-3D y el audio corren en el navegador.

## Stack

| Capa | Tecnología |
|---|---|
| Framework | React 19 + TypeScript (strict) |
| Bundler | Vite 7 + `vite-plugin-singlefile` |
| Render | Canvas 2D (pseudo-3D por proyección de segmentos) |
| UI/HUD | Tailwind CSS 4 + framer-motion + lucide-react |
| Audio | WebAudio — motor, viento y neumáticos sintetizados, sin archivos |
| Alias | `@/*` → `src/*` |

## Configuración de despliegue

```ts
// vite.config.ts
base: "/Ruta/"            // nombre EXACTO del repo (GitHub Pages sirve en subruta)
plugins: [react(), tailwindcss(), viteSingleFile()]
```

```jsonc
// package.json
"scripts": {
  "predeploy": "npm run build",
  "deploy": "gh-pages -d dist"
}
```

`npm run deploy` → publica `dist/` en la rama `gh-pages`.
Con *singlefile* no hay assets externos, así que `base` actúa solo como red de
seguridad; mantenerlo es correcto y necesario si algún día se añade `public/`.

## Estructura

```
├── index.html               # viewport sin zoom · viewport-fit=cover · favicon SVG
├── src/
│   ├── App.tsx              # monta la vista única
│   ├── index.css            # tema HUD + bloqueo de scroll/zoom táctil
│   ├── game/
│   │   ├── engine.ts        # simulación pura (sin DOM): carretera, física, chasis, IA, audio
│   │   └── render.ts        # proyección pseudo-3D, paletas día/noche, sprites, cámara
│   └── views/Drive.tsx      # bucle rAF, controles táctiles, HUD, overlays
├── .gitignore
└── README.md
```

## Carretera procedural (memoria constante)

No existe array de carretera. La geometría es **función pura del índice de
segmento**, así que la autopista es infinita, determinista y de coste O(1):

```ts
curveAt(i) // capas de senos + zona muerta (|x|-0.42) → aparecen rectas reales
hillAt(i)  // dos senos de baja frecuencia → colinas suaves
hash(i)    // fract(sin(i*12.9898)*43758.5453) → mobiliario sin estado
```

Escala: `SEG = 300` u (3 m), `ROAD_W = 2000` u (semiancho 10 m), 3 carriles,
`DRAW = 260` segmentos visibles (~780 m), `CAM_H = 1500`.
**100 u = 1 m**, velocidades en u/s, `km/h = u/s · 0.036`, `MAX_SPEED = 5600` (≈200 km/h).

## Render pseudo-3D (`render.ts`)

Proyección clásica por segmento con cámara que sigue las colinas:

```
scale   = camDepth / (z − camZ)
screenX = W/2 + scale · (xMundo − camX) · W/2
screenY = H/2 − scale · (yMundo − camY) · H/2
```

- Pasada 1 (cerca→lejos): acumula `x += dx; dx += curveAt(i)`, dibuja césped,
  arcenes, calzada, líneas y niebla, con **recorte por `maxY`** (painter con oclusión).
- Pasada 2 (lejos→cerca): sprites ordenados por `z` — tráfico, árboles, farolas
  y **carteles kilométricos** (cada 333 segmentos ≈ 1 km, sincronizados con el odómetro).
- **El coche propio usa la MISMA proyección que el tráfico** (no un porcentaje
  fijo de pantalla, que era lo que rompía la escala): sprite a `PLAYER_Z = 1750` u
  con ancho físico `PLAYER_W = 380` u, idéntico al de un turismo IA. Tamaño y
  posición salen de la perspectiva, y su `x` se proyecta sobre la calzada real,
  por lo que **se desplaza dentro del encuadre** al maniobrar.
- **Ciclo día/noche** cada 26 km: 4 paletas (amanecer/día/atardecer/noche)
  interpoladas por canal; con `dark > 0.3` se encienden faros, farolas y pilotos.
- Efectos: niebla exponencial al horizonte, viñeta, líneas de velocidad,
  destello de banquina y aviso ámbar de cortesía.

## Física del jugador (`engine.ts`)

- Caja **automática** de 6 marchas (solo informativa + tono del motor):
  `updateGear()` mapea km/h → marcha y calcula `rpm` normalizado; al cambiar
  emite `gearChanged` y `shiftFlash` para sonido y HUD.
- Aceleración con caída aerodinámica: `ACCEL(560) · (1 − 0.62·speedPct)`
  → 0–100 km/h en ~6 s; frenada `BRAKE(1250)`, retención `DRAG(180)` al soltar.
- Dirección: `x += steer · STEER_RATE(1.7) · (0.55 + 0.45·min(1, 2.4·speedPct)) · dt`.
  El suelo del factor (0,55) evita la sensación de volante "muerto" a baja velocidad.
- Volante: sigue al dedo con `STEER_ATTACK = 22`/s y se auto-centra a
  `RETURN_RATE = 10`/s al soltar.
- **Fuerza centrífuga**: `x -= curve · speedPct² · CENTRIFUGAL(0.085) · dt`.
- Banquina (`|x| > 1`): límite de velocidad y vibración, **sin penalización dura**.
- **Sin colisiones destructivas**: al acercarte demasiado, el coche se acopla a
  la velocidad del de delante (crucero adaptativo) + separación lateral suave y
  aviso ámbar en pantalla (`courtesy`).

## Dinámica de chasis y cámara (sensación de simulador)

Capa de presentación en `updateDynamics()`: muelles amortiguados alimentados
por la física real del frame. **No altera la trayectoria**, solo cómo se siente.

| Variable | Origen | Efecto visible |
|---|---|---|
| `camLag` | persigue a `x` con `k = 3.4 + 4.2·speedPct` | Cámara con inercia → el coche se mueve **dentro** del encuadre |
| `pitch` | derivada real de la velocidad (`Δv/dt / 1500`) | Cabeceo: morro **se hunde al frenar**, se eleva al acelerar; mueve el horizonte |
| `roll` | carga lateral `steer·speedPct − curve·speedPct²·0.4` | Balanceo de toda la escena (±0,030 rad) y contrabalanceo de carrocería |
| `susp` / `suspV` | muelle (k=170, c=15) excitado por la 2ª derivada del relieve + `hash(i)` como textura de asfalto | Baches y vibración de cámara sobre el terreno |
| `slip` | `steer·(0.3 + 0.7·speedPct)` | El morro **apunta al giro** antes que la trayectoria |
| `lateralG` | `min(1, \|lat\|·1.7)` | Chirrido de neumáticos proporcional al apoyo |

El **FOV se abre con la velocidad** (`camDepth = CAM_DEPTH · (1 − 0.11·speedPct)`):
truco clásico para que 180 km/h se *sientan* rápidos. La escena se dibuja dentro
de un `save/restore` con `scale(1.08)` para que la rotación de balanceo no
descubra las esquinas del lienzo; los efectos de pantalla (viñeta, avisos) van
fuera de esa transformación.

**Audio reactivo**: tono del motor ligado a `rpm` (la caída de vueltas al cambiar
sale sola del mapeo marcha↔velocidad), `shift()` con clunk de transmisión, viento
cuadrático con la velocidad y chirrido de neumáticos por banda estrecha cuando
`lateralG > 0.38`. **Háptica**: `navigator.vibrate(18)` limitado a un pulso cada
320 ms al pisar la banquina.

## IA de tráfico

Cada coche (`TrafficCar`) conduce "bien":

- **Control longitudinal** por distancia de seguridad (~1,5 s de headway):
  frena hacia la velocidad del líder cuando el hueco baja del umbral.
- **Cambios de carril**: adelanta por la izquierda si está bloqueado y el carril
  está libre; **vuelve a la derecha** cuando ya no lo necesita (cortesía), con
  `cooldown` entre maniobras e **intermitente** (`blinker`) mientras se desplaza.
- **El jugador es tráfico para la IA**: `leader()` y `laneFree()` lo incluyen,
  así que los demás frenan y respetan tu hueco.
- Velocidades por carril: derecho 85–95 km/h (camiones 83), centro ~106,
  izquierdo ~124. Reciclado fuera de la ventana `[z−9000, z+DRAW·SEG·1.15]`,
  con un 25 % reapareciendo **por detrás** para que te adelanten.

## Controles (una sola mano)

| Control | Implementación |
|---|---|
| **Volante = toda la pantalla** | Capa a pantalla completa (z-10) bajo HUD/pedales. El punto donde apoyas el dedo se vuelve el centro del volante virtual: `pointerdown` fija `x0` y el arrastre da `steer = curva((x−x0)/drag)` con `curva(d) = sign(d)·\|d\|^1.35` (preciso al centro, rápido en los extremos) |
| Recorrido adaptativo | `drag = clamp(ancho·0.22, 62, 110)` px → mismo gesto en móvil pequeño o tablet |
| Multitáctil | Solo el **primer** puntero dirige; los demás quedan libres para los pedales, que están por encima en z-index y reciben sus propios eventos → se puede acelerar y girar a la vez, con una o dos manos |
| Anillo guía | Aparece en el punto de agarre con una perilla que sigue al dedo (animada por rAF leyendo `game.steer`) |
| Auto-centrado | Al soltar, `steering = false` y el motor interpola `steer → 0` a `RETURN_RATE = 10`/s (muelle en la simulación, no en la UI) |
| Acelerador / freno | Botones `pointerdown/up` con `setPointerCapture` en la columna derecha |
| **Traba** | Mantiene el acelerador pisado (crucero) → se conduce solo con el dedo que dirige |
| Indicador inferior | `pointer-events-none`: es **solo lectura**, el control real es la superficie completa |
| Teclado | Flechas/WASD, `ESPACIO` traba, `ESC` pausa (pruebas en escritorio) |

`touch-action: none`, `overscroll-behavior: none` y `user-scalable=no` evitan
scroll, zoom y pull-to-refresh durante el juego.

## HUD

- **Velocímetro al 20 % de altura** (head-up display): no tapa la calzada ni los
  pedales y queda en la línea de visión natural.
- Barra de **revoluciones** (blanca → ámbar → roja según `rpm`/`speedPct`) e
  indicador de **marcha** que destella en coral con `shiftFlash`.
- Superior: odómetro (2 decimales), tiempo, adelantamientos, mute y pausa.
- Barra de **ritmo**: sube conduciendo suave, lejos de la banquina y sin frenadas.

## Bucle y rendimiento

- `requestAnimationFrame` con `dt` real acotado a 50 ms (evita saltos al volver
  de segundo plano); `visibilitychange` pausa automáticamente.
- El canvas se escala por `devicePixelRatio` **capado a 2**.
- React **no** se re-renderiza por frame: el HUD se actualiza a ~12 Hz vía
  `setHud`, y la perilla del volante se anima con `rAF` escribiendo
  `style.transform` directamente.
- Estado del juego en `useRef` (`Game`), nunca en estado de React.

## Build

`npm run build` → `dist/index.html` único (~409 KB, gzip ~130 KB); sin assets
externos (todo el arte es canvas/SVG inline). `.gitignore` excluye `dist/`,
`node_modules/`, `.env*`, cachés de gh-pages y archivos de SO.

## Checklist técnico (extensión futura)

1. **Persistencia**: guardar récord de km/tiempo en `localStorage` (clave `ruta-record`).
2. **PWA**: `vite-plugin-pwa` + manifest para instalar y jugar offline.
3. **Clima**: lluvia (partículas + menor adherencia) reutilizando `hash(i)`.
4. **Radio**: pistas generativas o `<audio>` con selector de emisoras.
5. **Tramos**: túneles y peajes como variación de paleta por rango de `i`.
6. **Densidad de tráfico** configurable (número de coches y mezcla de camiones).
7. **Retrovisor**: mini-canvas con los coches de `z < playerZ` proyectados en espejo.
8. **Asistencias**: mantenimiento de carril opcional y limitador de velocidad.
