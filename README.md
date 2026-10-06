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
| Audio | WebAudio — motor y viento sintetizados, sin archivos |
| Alias | `@/*` → `src/*` |

## Estructura

```
├── index.html               # viewport sin zoom · viewport-fit=cover · favicon SVG
├── src/
│   ├── App.tsx              # monta la vista única
│   ├── index.css            # tema HUD + bloqueo de scroll/zoom táctil
│   ├── game/
│   │   ├── engine.ts        # simulación pura (sin DOM): carretera, física, IA, audio
│   │   └── render.ts        # proyección pseudo-3D, paletas día/noche, sprites
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
`DRAW = 260` segmentos visibles (~780 m). **100 u = 1 m**, velocidades en u/s,
`km/h = u/s · 0.036`.

## Render pseudo-3D (`render.ts`)

Proyección clásica por segmento con cámara que sigue las colinas:

```
scale = CAM_DEPTH / (z − camZ)
screenX = W/2 + scale · (xMundo − camX) · W/2
screenY = H/2 − scale · (yMundo − camY) · H/2
```

- Pasada 1 (cerca→lejos): acumula `x += dx; dx += curveAt(i)`, dibuja césped,
  arcenes, calzada, líneas y niebla, con **recorte por `maxY`** (painter con oclusión).
- Pasada 2 (lejos→cerca): sprites ordenados por `z` — tráfico, árboles, farolas
  y **carteles kilométricos** (cada 333 segmentos ≈ 1 km, sincronizados con el odómetro).
- **Ciclo día/noche** cada 26 km: 4 paletas (amanecer/día/atardecer/noche)
  interpoladas por canal; con `dark > 0.3` se encienden faros, farolas y pilotos.
- Efectos: niebla exponencial al horizonte, viñeta, líneas de velocidad,
  balanceo de carrocería y vibración si pisas la banquina.

## Física del jugador (`engine.ts`)

- Caja **automática** de 6 marchas (solo informativa + tono del motor):
  `updateGear()` mapea km/h a marcha y calcula `rpm` normalizado.
- Aceleración con caída aerodinámica: `ACCEL · (1 − 0.62·speedPct)`;
  frenada `BRAKE`, retención `DRAG` al soltar.
- Dirección proporcional a la velocidad: `x += steer · STEER_RATE · (0.32 + 0.68·min(1, 2.2·speedPct)) · dt`.
- **Fuerza centrífuga**: `x -= curve · speedPct² · CENTRIFUGAL · dt` (hay que
  apoyar el volante en curva).
- Banquina (`|x| > 1`): límite de velocidad y vibración, **sin penalización dura**.
- **Sin colisiones destructivas**: al acercarte demasiado, el coche se acopla a
  la velocidad del de delante (crucero adaptativo) + separación lateral suave y
  aviso ámbar en pantalla (`courtesy`).

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
| Volante | Zona inferior izquierda; `pointerdown` fija `x0` y el arrastre da `steer = (x−x0)/110` acotado a ±1 |
| Auto-centrado | Al soltar, `steering = false` y el motor interpola `steer → 0` a `RETURN_RATE = 9`/s (muelle en la simulación, no en la UI) |
| Acelerador / freno | Botones `pointerdown/up` con `setPointerCapture` en la columna derecha |
| **Traba** | Mantiene el acelerador pisado (crucero) → se conduce solo con el pulgar del volante |
| Teclado | Flechas/WASD, `ESPACIO` traba, `ESC` pausa (pruebas en escritorio) |

`touch-action: none`, `overscroll-behavior: none` y `user-scalable=no` evitan
scroll, zoom y pull-to-refresh durante el juego.

## Bucle y rendimiento

- `requestAnimationFrame` con `dt` real acotado a 50 ms (evita saltos al volver
  de segundo plano); `visibilitychange` pausa automáticamente.
- El canvas se escala por `devicePixelRatio` **capado a 2**.
- React **no** se re-renderiza por frame: el HUD se actualiza a ~12 Hz vía
  `setHud`, y la perilla del volante se anima con `rAF` escribiendo
  `style.transform` directamente.
- Estado del juego en `useRef` (`Game`), nunca en estado de React.

## Build

`npm run build` → `dist/index.html` único (~405 KB, gzip ~128 KB); sin assets
externos (todo el arte es canvas/SVG inline). `gh-pages` instalado;
`.gitignore` excluye `dist/`, `node_modules/`, `.env*`, cachés y archivos de SO.

## Checklist técnico (extensión futura)

1. **Persistencia**: guardar récord de km/tiempo en `localStorage` (clave `ruta-record`).
2. **PWA**: `vite-plugin-pwa` + manifest para instalar y jugar offline.
3. **Clima**: lluvia (partículas + menor adherencia) reutilizando `hash(i)`.
4. **Radio**: pistas generativas o `<audio>` con selector de emisoras.
5. **Tramos**: túneles y peajes como variación de paleta por rango de `i`.
6. **Háptica**: `navigator.vibrate()` al pisar banquina (ya existe `shake`).
7. **Densidad de tráfico** configurable (número de coches y mezcla de camiones).
8. **Retrovisor**: mini-canvas con los coches de `z < playerZ` proyectados en espejo.
