# [RUTA · Autopista infinita — Documentación técnica](https://coiponorte.github.io/Ruta/)

Juego de conducción para **móvil en vertical**, de una sola vista y sin
backend. Filosofía: **no hay choques, muertes ni derrota** — el objetivo es
integrarse al tránsito, adelantar con calma y acumular kilómetros. Toda la
simulación, el render pseudo-3D y el audio corren en el navegador.

## Stack

> **Diseño de vehículos**: silueta de utilitario compacto tipo hatchback
> (referencia Mazda Demio) dibujada en una sola pasada — techo estrecho y
> abovedado que cae en hombros anchos, luneta grande con spoiler, pilotos
> verticales envolventes en las esquinas y paragolpes oscuro. LOD en 3 niveles.
>
> **Coche del jugador** (`drawPlayerCar`): silueta propia de **deportivo**,
> claramente distinta del tráfico civil. Proporción más baja (`h = w · 0.66`
> frente a `0.8`), cabina de cupé estrecha, **vía ensanchada** con ruedas que
> sobresalen de la carrocería, **difusor con aletas** y **doble escape
> central**. Pintado en el naranja del tema (`PLAYER_PAINT = #FF6A3D`, el mismo
> `--color-signal` del HUD) con franjas de competición que continúan sobre el
> alerón y bajan por el portón. La paleta civil se ajustó (el rojo pasó a
> `#B5443A`) para que ningún NPC compita con ese naranja.
>
> **Anatomía de la vista trasera** — una sola carrocería continua, sin piezas
> superpuestas:
>
> | Altura | Elemento |
> |---|---|
> | 0,09 h | Techo de la cabina |
> | 0,14 h | Luneta con reflejo (lo más lejano del coche) |
> | 0,46 h | Línea de cintura |
> | 0,47 h | **Alerón apoyado sobre el portón, debajo de la luneta** |
> | 0,52 h | Pilotos traseros y tercera luz de freno |
> | 0,72 h | Matrícula |
> | 0,80 h | Paragolpes, difusor y escapes |
>
> **Corrección definitiva del deportivo.** La versión anterior superponía dos
> carrocerías y llevaba los puntos del supuesto maletero hasta `0,70 w`, fuera
> del ancho físico máximo `0,50 w`; por eso la silueta se deformaba. Además el
> alerón estaba arriba del techo, posición que en una vista trasera se lee como
> el frente. Ahora hay una sola silueta simétrica dentro de `±0,50 w`, y el
> alerón cruza el portón a la altura `beltY + 0,015 h`, justo debajo de la
> luneta, con montantes hacia abajo. Esa es inequívocamente la parte trasera.

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
- **El jugador entra en la misma lista de sprites** con su `z` real (`g.pz`), así
  que el algoritmo del pintor lo ordena junto al tráfico: un coche situado entre
  la cámara y nosotros se dibuja **por delante**. Antes el jugador se pintaba
  siempre el último y parecía atravesar a los demás. Los faros, en cambio, se
  pintan antes que los sprites (son luz proyectada sobre el asfalto).
- **Biomas** (`biomeAt`): cada **7,5 km** cambia el paisaje, con transición
  suavizada por coseno en el último 30 % del tramo. Ocho terrenos inspirados en
  recorrer un país largo y estrecho de norte a sur:

  | Bioma | Terreno | Decoración |
  |---|---|---|
  | Desierto | ocre | cactus columnares con brazos |
  | Valle | verde cálido | árboles de hoja ancha |
  | Ciudad | gris | edificios con **ventanas que se encienden de noche** |
  | Bosque | verde profundo | coníferas de copa triangular en dos pisos |
  | Sierra | pardo | peñascos con cara iluminada |
  | Cordillera | gris azulado | pinos nevados, manto blanco al 75 % |
  | Patagonia | estepa seca | matorrales bajos |
  | Austral | blanco | hielo, manto al 100 % |

  Cada bioma tiñe césped, colinas, niebla y cielo (este último **solo de día**,
  ponderado por `1 − dark`), ajusta la **densidad** de vegetación y puede
  aplicar **manto de nieve** que aclara terreno y arcenes. Las tres capas
  —bioma, ciclo diario y lluvia— se combinan: un bosque nevado de noche bajo
  la lluvia se ve coherente. El nombre del paisaje aparece en el odómetro.

- **Ciclo día/noche** cada 34 km con **fases de duración desigual** (día largo,
  crepúsculos breves, noche contenida) definidas en `FASES[]` por fracción `t`
  e interpoladas con suavizado coseno para que no haya cortes. El **sol/luna
  recorre el cielo en arco** de este a oeste según la fase; con `dark > 0.3` se
  encienden faros, farolas y pilotos.
- **Profundidad ambiental (estilo GT)** en los 150 segmentos cercanos: talud de
  tierra entre calzada y césped, **guardarraíl metálico** con biga continua
  proyectada en perspectiva, postes cada 3 segmentos y **captafaros
  reflectantes** de noche. Dan lectura de velocidad y volumen al corredor.
- **Huellas de rodadura**: dos bandas pulidas por carril (`shade(road, −0.07)`),
  calculadas sobre `LANES`, que añaden textura y lectura de velocidad.
- **Bloom de luz**: el sol/luna combina halo amplio + núcleo denso y un
  **destello anamórfico horizontal** (atenuado por `1 − dark`), todo en modo
  `lighter`.
- **Asfalto mojado**: con `rain > 0.12` una sola pasada en `lighter` añade el
  reflejo especular del cielo desde el horizonte hacia la cámara.

- **Arbolado monumental (GT4)**: coníferas de **cuatro pisos** con tronco
  visible, sombreado de media copa y nieve acumulada en el borde superior;
  frondosos con tronco bifurcado, ramas y **copa compuesta de tres masas** con
  luz cenital y base en sombra. Altura base de 2600–6000 u (antes 900–1600),
  con variación ×1–×3 entre ejemplares para dar escala al bosque.

> **Bug corregido — rayas horizontales de colores sobre el asfalto.** La causa
> definitiva era el **culling subpíxel**: a partir de cierta distancia cada
> segmento mide menos de un píxel de alto, y pintarlo igualmente producía medio
> píxel de césped y medio de asfalto, con el anti-aliasing mezclando ambos →
> **una banda horizontal de color arbitrario por segmento**. Con 260 segmentos
> eso es, literalmente, un patrón de rayas. Se suma la alternancia de arcén y
> hierba cada 3 segmentos, que en la lejanía también caía en subpíxeles.
>
> Solución:
> - **No se dibuja ningún segmento de menos de 0,75 px** de alto; esa zona la
>   cubre la niebla, que es un degradado continuo y por construcción no puede
>   generar bandas.
> - **LOD de detalle**: más allá del segmento 110 la hierba y el arcén se
>   pintan en color plano, sin alternancia. Las marcas de carril desaparecen.
> - **Firme de un solo tono** en calzada, repintado, huellas y ramal.
> - Niebla en **un único degradado vertical** con 6 paradas de alfa, opaco en
>   el horizonte para tapar la zona culled.
> - Césped a **píxeles enteros** y sangrado de 1,15 px (`BLEED`) por si acaso.

> Notas históricas del mismo bug (parches previos que no bastaron):
> 1. El césped se rellenaba hasta `Y1 + 1`; como los segmentos se pintan de
>    cerca a lejos, ese píxel sobrante caía sobre el asfalto ya dibujado.
> 2. **Costuras de anti-aliasing**: los bordes de cada polígono caen en
>    coordenadas fraccionarias y el canvas los suaviza mezclándolos con el
>    fondo, dejando una línea por unión.
> 3. **La niebla se pintaba por segmento** con un alfa distinto cada uno, así
>    que el propio degradado producía escalones horizontales en la lejanía.
> 4. **La causa principal**: el asfalto **alternaba entre `road1` y `road2`
>    cada 3 segmentos**. Era deliberado (truco arcade para dar sensación de
>    velocidad), pero en una calzada ancha se lee como un fallo de render.
>
> Solución definitiva:
> - **Firme de un solo color** (`pal.road1`) en la calzada, el repintado
>   cercano, las huellas de rodadura y el ramal del desvío. Al compartir tono,
>   las uniones entre segmentos dejan de ser visibles por completo.
> - Bandas de césped ajustadas a **píxeles enteros** (`floor`/`ceil` + 1 px) y
>   con diferencia entre franjas reducida a `shade(−0.035)`: lectura de
>   velocidad sin parecer rayas.
> - **Sangrado de 1,15 px** (`BLEED` en `quad(..., bleed)`) hacia la cámara en
>   todas las franjas de calzada, arcén, talud y huellas.
> - **Niebla en un único degradado vertical** sobre toda la vía, construido
>   con `hex(pal.fog)` y cinco paradas de alfa: transición perfecta y una sola
>   operación de dibujo.
>
> La sensación de velocidad la aportan ahora los arcenes (que sí alternan
> rojo/blanco, como un bordillo real) y las líneas discontinuas.
- **Vehículos de emergencia**: barra de luces en el techo con alternancia
  azul/rojo a 3,5 Hz, halo proyectado por composición `lighter` y franjas de
  identificación en el costado.
- Efectos: niebla exponencial al horizonte, viñeta, líneas de velocidad,
  destello de banquina y aviso ámbar de cortesía.

## Física del jugador (`engine.ts`)

- Caja **automática** de 6 marchas (solo informativa + tono del motor):
  `updateGear()` mapea km/h → marcha y calcula `rpm` normalizado; al cambiar
  emite `gearChanged` y `shiftFlash` para sonido y HUD.
- Aceleración con caída aerodinámica: `ACCEL(560) · (1 − 0.62·speedPct)`
  → 0–100 km/h en ~6 s; frenada `BRAKE(1250)`, retención `DRAG(180)` al soltar.
- Dirección **con tracción real**:
  `x += steer · STEER_RATE(1.7) · (0.45 + 0.55·min(1, 2.4·speedPct)) · rodando · dt`
  donde `rodando = min(1, speed/1200)`. Un coche **no se traslada de lado**: las
  ruedas giran, pero la trayectoria solo cambia si avanza. Con el coche parado
  el volante se mueve y no pasa nada (antes había un suelo de 0,55 que permitía
  desplazarlo lateralmente a velocidad cero, impropio de un simulador).
- Volante: sigue al dedo con `STEER_ATTACK = 22`/s y se auto-centra a
  `RETURN_RATE = 10`/s al soltar.
- **Fuerza centrífuga**: `x -= curve · speedPct² · CENTRIFUGAL(0.085) · dt`.
- Banquina (`|x| > 1`): límite de velocidad y vibración, **sin penalización dura**.
- **Volumen 3D en un render 2D.** Cada vehículo es una caja con **ANCHO**
  (`PLAYER_W = 380`), **LARGO** (`PLAYER_L = 820`) y **ALTO** (`PLAYER_H`, solo
  para el sprite). Hay contacto cuando se solapan los dos semiejes del plano:
  `|dz| < (c.length + PLAYER_L)/2` **y** `|dx| < (c.width + PLAYER_W)/ROAD_W`.
  La proporción `solapeX` decide si es un **impacto longitudinal** (alineados,
  >0,45 → frenada contra el de delante o empujón si te alcanzan) o un **roce
  lateral** (costado con costado).

  > **Bug corregido (crítico):** la colisión se evaluaba en `this.z`, que es la
  > **cámara**, no el coche — y la cámara va 17,5 m por detrás. Chocabas con
  > vehículos que visualmente ya habías dejado atrás. Ahora existe el getter
  > `pz = z + PLAYER_Z` (posición real del volumen) y **todas** las
  > comparaciones con el tráfico lo usan: `leader()`, `laneFree()`, presión,
  > adelantamientos, ángulo muerto, retrovisor y colisión.

- **Contacto sin física rígida** (nunca "enganches"). Se descartó la resolución
  por penetración: reposicionar el eje Z clavaba al jugador contra un coche que
  además frenaba, dejando a ambos bloqueados. Ahora el roce es un **evento de
  conducción** con **empujón contenido**:
  1. **Impulso lateral amortiguado**, no desplazamiento directo: el golpe suma
     `nudge ≤ 0.55` al NPC (y un 45 % de reacción al jugador vía `nudgeSelf`),
     que decae con `nudge *= 1 − dt·4.5` mientras el muelle de carril lo
     devuelve a su sitio. El coche **se mueve un poco y se recoloca**: no sale
     disparado ni se va de la calzada (tope duro en `|x| ≤ 1.08`).
  2. **Pérdida de control** del jugador: `shake` + `wobble` (desvío aleatorio
     amortiguado), y −9/s de puntuación.
  3. **Penalización de velocidad**: frenada contra el parachoques si alcanzas
     al de delante, empujón si te alcanzan por detrás, fricción si es lateral.
  4. **El NPC reacciona conduciendo**, no saltando: se le sube la `pressure` a
     4 y se adelanta su evaluación de cortesía (`checkT = 0.35 s`), de modo que
     se aparta **con intermitente** y solo si el carril está libre.
  5. Destello rojo perimetral mientras dura el contacto. Sin daños ni derrota.

### Garantía de corredor (siempre hay camino)
Regla de oro del juego: **nunca debe faltar una ruta por delante**. Se ataca en
dos frentes, prevención y corrección.

**1. Prevención — regla anti-pelotón (`unclump`)**
El 90 % de los bloqueos nacen de coches rodando **en paralelo a la misma
velocidad**: nunca se separan solos. Se detectan en cuanto se emparejan
(carriles contiguos, solape longitudinal, diferencia de ritmo <220 u/s) y, si
llevan **más de 2,5 s** así, el de menos prisa recibe `relax` y el de más prisa
`boost`. Se escalonan igual que en el tráfico real.
Además, al reciclarse un vehículo se **escalona en el spawn**: si aparece a la
altura de otro en un carril contiguo, se le suman 26–44 m. El tráfico ya no
nace formando barreras.

**2. Corrección — escalada por tiempo sin ruta**
Cada frame se mide el hueco libre de cada carril (`laneGaps`) y se compara con
lo necesario para pasar (`PLAYER_L + 1100 + speed`). Si el mejor no alcanza,
sube `blockT` y la intervención se intensifica sobre el **carril más
prometedor** (el que ya tiene más hueco):

| Tiempo sin ruta | Intervención |
|---|---|
| > 1,5 s | `makeWay`: el tapón acelera a `max(jugador·1.15, desired·1.1)` |
| > 3,0 s | Orden de despejar: cambia de carril señalizando, abortando lo que hiciera |
| > 5,0 s | Prioridad total: se desplaza aunque el carril no esté perfecto y **sus vecinos le hacen sitio** (efecto cremallera con `relax` + `nudge`) |

El jugador no ve nada de esto: solo percibe que el tráfico **se abre**.

### Verificación de huecos (anti-barrera rodante)
Problema clásico del tráfico simulado: tres coches a velocidad parecida acaban
en línea ocupando los tres carriles y taponan al jugador indefinidamente.

`relieveBarrier()` se ejecuta **cada 1,2 s** (y de inmediato tras un contacto):

1. Para cada carril localiza el primer vehículo por delante de `pz` y lo marca
   como *tapón* si está dentro de la ventana (`4200 + speed·1.2`) **y** va más
   lento que el jugador.
2. Calcula si existe algún hueco `≥ PLAYER_L + 900 + speed·0.9`. Si lo hay,
   **no interviene**: que el jugador maniobre.
3. Si los `LANES` carriles están cortados (`blockedAll`), deshace la formación
   de manera natural, **escalonándola**:
   - el del carril izquierdo (rápido) recibe `boost = 3.2 s` → acelera hasta
     `speed_jugador · 1.1` y se despega;
   - el del derecho (lento) recibe `relax = 2.6 s` → afloja a `desired · 0.82`;
   - el del centro intenta apartarse a la derecha con intermitente, o afloja
     si no tiene hueco.

   Se abre así una diagonal por la que colarse. El HUD muestra el aviso
   **«retención»** mientras dura el muro.

  > Bug corregido: `yielding` hacía **frenar** al NPC cuando el jugador venía
  > por detrás pidiendo paso — justo lo contrario de ceder. Ceder el paso es
  > apartarse, nunca frenar delante de quien te empuja.

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

## Capa de simulador: normas, clima y evaluación

### Límites de velocidad por tramo (ambientación, no obligación)
`limitAt(i)` es función pura del segmento: zonas de ~2,7 km (900 segmentos)
que devuelven 80 / 100 / 120 km/h según `hash(zona)`. Se señalizan en el mundo
con **discos circulares estilo europeo** y en el HUD con un disco junto al
velocímetro.

**Decisión de diseño**: el límite es ambientación. **Los NPC sí lo respetan**
(su objetivo real es `min(desired, limitAt(z)/0.036)`, así que el tráfico se
densifica y frena en las zonas de 80), pero **el jugador es libre**: no hay
multas, ni alarma, ni penalización en la puntuación. El disco solo gana opacidad
cuando vas por encima, como referencia.

### Meteorología
`weatherAt(km)` (dos senos desfasados, recortados) genera frentes de lluvia
deterministas a lo largo del recorrido; `Game.rain` la suaviza con `k = 0.35`.
Efectos encadenados:

- **Adherencia**: `grip = 1 − rain·0.3` → frenadas más largas, menos empuje de
  aceleración y **más fuerza centrífuga** (`CENTRIFUGAL · (2 − grip)`).
- **Paleta**: cielo, asfalto, césped y niebla se mezclan hacia tonos fríos y
  `dark` sube (los faros se encienden aunque sea de día).
- **Gotas en el parabrisas**: la inclinación de las estelas depende de
  `speedPct` (viento relativo) y la densidad de la intensidad.

### Retrovisor
Situado en `max(H·0.135, 94)` px para quedar **por debajo del HUD superior**
(odómetro + barra de conducción) también en pantallas de móvil pequeñas.
`Game.behind(maxDist)` devuelve el tráfico que llega por detrás; `drawMirror()`
lo pinta como **inset dentro del mismo canvas** (sin segundo lienzo) con líneas
de fuga, escala `pow(1 − d/16000, 2.1)` y la convención real del espejo
(izquierda sigue siendo izquierda). Incluye **aviso de ángulo muerto**:
triángulo ámbar parpadeante cuando hay un vehículo a la par en carril contiguo
(`|dz| ∈ (−1500, 900)` y separación lateral 0,18–0,95).

### Intermitentes y puntuación
Dos botones (o `Q` / `E`) activan el intermitente, que **se apaga solo a los 6 s**.
`updateCompliance()` evalúa de forma continua `score ∈ [0, 100]`:

| Acción | Efecto |
|---|---|
| Cambio de carril **señalizado** (`signalAge < 3.5 s`) | +2,5 |
| Cambio de carril sin avisar | −6 |
| Pisar la banquina | −4/s |
| Contacto / pegarse al de delante | −2,5/s |
| Conducción correcta | +1,1/s de recuperación |

Solo se valora la **convivencia** (señalizar, mantenerse en calzada, respetar el
espacio ajeno). La velocidad en sí nunca penaliza.

La barra superior cambia de verde a ámbar y rojo, y la puntuación aparece en el
resumen de pausa junto a km, tiempo y adelantamientos.

## IA de tráfico

**Convención de carriles** (fuente de bugs si se invierte): `x` crece hacia la
derecha de la pantalla, por lo que `laneCenter(l) = 1 − (2l+1)/LANES`. El
**carril 0 es el derecho/lento** (camiones, `maxLane = 1`) y adelantar es ir
hacia `−x`, es decir `lane++`. Tenerlo espejado hacía que los NPC señalizaran
al lado contrario y pareciera que "se devolvían".

## Dos calzadas: RUTA ↔ SUPER

No son dos modos de juego separados, sino **una bifurcación dentro del mismo
viaje**: cada 4–7 km aparece un desvío señalizado que conecta las dos vías.

| | RUTA | SUPER |
|---|---|---|
| Carriles (`LANES`) | 3 | **8** |
| Semiancho (`ROAD_W`) | 2000 u (20 m) | **5000 u (50 m)** |
| Aforo de tráfico | 20 vehículos | **38** |
| Frecuencia de spawn | 3 s | 1,2 s |

**Cómo se toma el desvío**
1. `scheduleJunction()` coloca la bifurcación 4–7 km adelante y sortea el lado.
2. Al aproximarse, un **carril de incorporación se abre progresivamente**
   (`ext = t²·1.25`) hacia el lado señalizado, con cebreado y borde propio.
3. Pórticos verdes a **500 / 200 / 100 / 50 m** anuncian el destino contrario
   al que circulas (`SUPER →` desde la ruta, `← RUTA` desde la super).
4. Al cruzar el punto, si vas **en el carril del ramal** (`onForkLane`,
   `|x| > 0.34` hacia ese lado) te incorporas; si no, sigues y se programa el
   siguiente desvío.
5. `switchRoad()` cambia `LANES`, **interpola `ROAD_W`** (la calzada se abre,
   no salta), te coloca en el carril de entrada y **redistribuye el tráfico**
   escalonado para la nueva anchura.

`ROAD_W` y `LANES` son `export let` — los *live bindings* de ES Modules hacen
que render y engine vean el valor nuevo sin pasar parámetros. El HUD muestra el
aviso de distancia, que **se ilumina en verde** cuando ya estás colocado.

Los carriles preferidos son **proporcionales** (`homeLane` usa franjas de
`LANES - 1`), así que en la super el tráfico se reparte como en una
interestatal en vez de amontonarse a la derecha. Los camiones nunca pasan del
30 % izquierdo de la calzada.

### Personalidades de conductor (`Kind`)
El tráfico no es homogéneo: cada vehículo tiene una forma de entender la
carretera, y de ella dependen su velocidad objetivo, su carril natural y su
agresividad al adelantar.

| Tipo | Mezcla | Velocidad objetivo | Carril natural | Comportamiento |
|---|---|---|---|---|
| `sinprisa` | ~34 % | **0,74–0,91 × límite** | derecho (0) | Disfruta el viaje, casi nunca abandona la derecha (umbral de estorbo 0,85) |
| `conprisa` | ~32 % | 0,92–1,05 × límite | derecho, o centro si tiene prisa | Respeta las normas, adelanta **solo si gana ≥7 %** y vuelve a la derecha |
| `corredor` | ~15 % | **hasta `MAX_SPEED · 0.96`** | izquierdo | **Ignora el límite por completo**: su techo es el del propio vehículo. Se cambia por cualquier ganancia (≥2 %), señaliza 0,2 s y **bordea el borde de la calzada** si no hay carril libre |
| `camion` | ~14 % | `(0,74–0,86) × límite × (1 − carga·0,16)` | derecho, **nunca el rápido** (`maxLane = 1`) | Lleva `cargo ∈ [0,1]`: a más carga, menos brío. La carga se ve sobre la caja |
| `ambulancia` | 1,5 % | hasta `MAX_SPEED · 0.92` | izquierdo | Prioridad absoluta: **toca la bocina** y, si no le abren hueco, **embiste lateralmente** |
| `patrulla` | 4 % | de ronda (0,88×) o con prisa (1,02–1,22×) | según humor | Solo las patrullas **con prisa** (`mood > 0.5`) salen a perseguir corredores |

**Humor dinámico** (`mood ∈ [0,1]`): cada **8–30 s** el conductor se replantea su
prisa con una deriva suave (±0,27), y su velocidad deseada se recalcula
**continuamente** contra el límite del tramo en el que esté. Además los civiles
pueden **cambiar de rol** con el tiempo: un `conprisa` muy acelerado (`mood > 0.93`)
se convierte en `corredor`, y un `corredor` que se calma (`mood < 0.22`) vuelve a
`conprisa`. El tráfico respira: unos aprietan en la recta, otros se descuelgan.

**Límites por tramo**: `limitAt()` sortea cinco categorías cada ~2,7 km —
60 (obras), 80 (travesía), 100, 120 (autopista) y 130 (tramo rápido). Los NPC
ajustan su ritmo al cruzar cada zona, así que el tráfico se comprime y se estira
solo. El jugador sigue libre de ir a su ritmo.

### Maniobra de adelantamiento en tres fases
Antes un NPC solo "cambiaba de carril"; ahora ejecuta un adelantamiento real
con máquina de estados (`ovPhase`):

1. **Salida** — detecta al líder que le estorba, guarda su id en `ovTarget`,
   señaliza a la izquierda y se desplaza.
2. **Paso** (`ovPhase = 1`) — acelera hasta `min(desired·1.12, presa·1.16)`
   para **rebasar de verdad**, nunca quedarse en paralelo.
3. **Reincorporación** (`ovPhase = 2`) — cuando ha dejado al otro atrás con
   margen (`largo + 900 + speed·0.45`), señaliza a la derecha y **se coloca
   delante** en cuanto el carril está libre.

`ovT` limita la maniobra a 9 s: si se eterniza, se cancela y vuelve a la
derecha, de modo que nadie se queda a vivir en el carril rápido.

### Emergencias y control policial
- **Cesión de paso**: si una sirena activa se acerca por detrás a menos de 70 m
  y en línea con un vehículo, este señaliza a la derecha, se desplaza `+0.16`
  dentro de su carril, aborta cualquier adelantamiento y afloja al 88 %.
- **Bocina y embestida**: a menos de 26 m la ambulancia **toca la bocina**
  (claxon de dos tonos en quinta, sintetizado; suena si está a menos de 140 m
  del jugador, con ondas visibles sobre el techo). Si a menos de 15 m el
  vehículo sigue estorbando porque no tiene hueco, la ambulancia **lo embiste**
  lateralmente (`nudge += 0.5·dt`) para abrirse paso.
- **Persecución**: una patrulla libre busca un `corredor` a menos de 120 m, le
  asigna `chasing` y eleva su objetivo a velocidad de ambulancia. Al ponerse a
  su altura (<18 m) activa `pullover = 7 s` en **ambos**: los dos se van al
  carril 0, encienden el intermitente derecho, frenan a ~32 km/h y **se orillan
  pisando el arcén** (`x → 1.12`). Al terminar, el corredor "aprende": pasa a
  `conprisa` con su velocidad recalculada.

### Resolución de atascos por jerarquía
Cuando `relieveBarrier()` detecta los `LANES` carriles cortados, el desalojo ya
no es simétrico: se ordenan los bloqueantes por prioridad
(`emergencia → corredor → conprisa → sinprisa`) y se despliegan **en abanico**:

1. Los **corredores** tiran primero (`boost = 2.8 s`) y piden carril izquierdo
   con `intentT = 0.25 s`.
2. Los **conprisa** los siguen escalonados (+0,3 s por posición en la cola).
3. Los **sinprisa** se repliegan a la derecha —su sitio— y aflojan
   (`relax = 2.6 s`), abriendo la diagonal.

Cada coche (`TrafficCar`) conduce "bien":

- **Control longitudinal** por distancia de seguridad (~1,5 s de headway):
  frena hacia la velocidad del líder cuando el hueco baja del umbral. Además
  respeta `limitAt(z)` del tramo.
- **Cambios de carril en 4 pasos** (antes se cambiaban por cambiarse y acababan
  en fila de a tres bloqueando la autopista):
  1. Detecta que le estorban: `lanePace(carril) < desired · 0.93`.
  2. Comprueba que el otro carril **de verdad le hace ganar**:
     `lanePace(izq) > actual · 1.07` para adelantar, o
     `lanePace(der) ≥ desired · 0.97` para volver a la derecha.
  3. **Señaliza 0,7–1,5 s antes** (`intent` / `intentT`) sin moverse todavía.
  4. Ejecuta. Si el hueco se cierra durante la espera, **cancela y apaga el
     intermitente** (`cooldown = 1.5 s`).
- El intermitente se apaga al **completar** el desplazamiento, no al iniciarlo.
- **Te ven por el retrovisor**: si circulas pegado detrás, en su carril y a más
  ritmo del que ellos llevan, acumulan `pressure += dt`. Cada **4–7 s** (timer
  `checkT`, aleatorio por coche) evalúan cederte el paso con probabilidad
  `min(0.9, pressure/7)` — cuanto más insistes, más probable. Si tienen hueco
  a la derecha se apartan señalizando; si no, levantan el pie (`yielding`) para
  que los rebases. La presión decae sola al dejar de perseguirlos.
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
| Multitáctil | Cada puntero se identifica por `pointerId`: el **primero** dirige y los demás quedan libres para los pedales. Se puede **mantener el giro con un pulgar mientras el otro acelera y frena** sin que la dirección se interrumpa |
| Re-enganche | Si el sistema cancela el puntero del volante (gesto del SO, notificación) y el dedo sigue apoyado, el siguiente `pointermove` **lo recupera** tomando la posición actual como nuevo centro. No hay que levantar y volver a pulsar |
| Anillo guía | Aparece en el punto de agarre con una perilla que sigue al dedo (animada por rAF leyendo `game.steer`) |
| Auto-centrado | Al soltar, `steering = false` y el motor interpola `steer → 0` a `RETURN_RATE = 10`/s (muelle en la simulación, no en la UI) |
| Acelerador / freno | Botones `pointerdown/up` con `setPointerCapture` en la columna derecha |
| **Traba** | Mantiene el acelerador pisado (crucero) → se conduce solo con el dedo que dirige |
| Indicador inferior | Barra de 6 px pegada al borde inferior con marca de centro y perilla que recorre el riel (`left = 50 + steer·44 %`). `pointer-events-none`: es **solo lectura**, el control real es la superficie completa |
| Intermitentes | Dos botones de 32 px sobre los pedales, o `Q` / `E`; auto-apagado a los 6 s. **Se ven encendidos en el propio coche**, igual que las luces de freno al pisar el pedal |
| **Modo zurdo** | Selector en el menú de pausa que mueve toda la columna de pedales a la izquierda. Se guarda en `localStorage['ruta-lado']`. El volante sigue siendo la pantalla completa, así que no cambia |
| Teclado | Flechas/WASD, `ESPACIO` traba, `Q`/`E` intermitentes, `ESC` pausa (pruebas en escritorio) |

> **Multitáctil y `pointerId`**: la red de seguridad que libera el volante
> escuchaba `pointerup` en `window` **sin comprobar qué dedo se levantaba**, de
> modo que soltar el acelerador cancelaba la dirección y había que re-apoyar el
> pulgar. Ahora `soltarVolante(id?)` solo libera si el `pointerId` coincide con
> el del puntero que dirige. No era una limitación del navegador.

> **Long-press = clic derecho**: mantener el dedo sobre un pedal disparaba el
> menú contextual del sistema e interrumpía la partida. Se corrige en tres
> capas: `-webkit-touch-callout: none` + `touch-action: none` en CSS,
> `preventDefault()` en `onContextMenu`/`onDragStart` de cada pedal, y
> listeners globales de `contextmenu` y `selectstart` en `document`. Además
> los pedales ignoran el botón derecho real del ratón (`e.button !== 0`).

`touch-action: none`, `overscroll-behavior: none` y `user-scalable=no` evitan
scroll, zoom y pull-to-refresh durante el juego.

## HUD

> **Criterio de diseño en vertical**: el coche ocupa el centro-bajo de la
> pantalla, así que **ningún control se dibuja ahí**. Todo vive pegado a los
> bordes, en tamaños mínimos y con fondos muy translúcidos (`bg-black/25`,
> bordes `white/[0.07]`), para no tapar la acción:
> - **Volante** → barra plana de 6 px en el borde inferior, sin caja ni texto.
> - **Pedales** → columna derecha compacta (64 px acelerador, 52 px freno),
>   translúcidos en reposo y sólo iluminados al pulsarlos (`active:`).
> - **Intermitentes y traba** → botones de 32 px apilados sobre los pedales.
> - **Anillo de agarre** → 56 px, sin desenfoque ni sombra.

- **Velocímetro al 20 % de altura** (head-up display): no tapa la calzada ni los
  pedales y queda en la línea de visión natural.
- Barra de **revoluciones** (blanca → ámbar → roja según `rpm`/`speedPct`) e
  indicador de **marcha** que destella en coral con `shiftFlash`.
- Superior: odómetro (2 decimales), tiempo, adelantamientos, mute y pausa.
- Barra de **ritmo**: sube conduciendo suave, lejos de la banquina y sin frenadas.

## Rendimiento (60 FPS)

> **Microcongelones — causa y solución.** El render llamaba a `mix()`/`hex()`
> (regex + `parseInt` + asignación de un string nuevo) **39 veces**, varias de
> ellas dentro del bucle de 260 segmentos y de los árboles. Eso son **miles de
> cadenas alocadas por frame**: presión constante sobre el recolector de
> basura, que se manifiesta como pausas de unos milisegundos exactamente cada
> pocas decenas de frames.

Medidas aplicadas:

- **Carretera como cinta continua**: el asfalto ya no se dibuja con 180–260
  trapecios independientes. Primero se proyectan los puntos visibles y luego
  `roadRibbon()` construye un único `Path2D` lógico para terreno, talud, arcén
  y firme. Al no existir uniones internas, las rayas horizontales quedan
  eliminadas por construcción, no ocultadas con parches.
- **Distancia de dibujo**: 260 → **180 segmentos** (~540 m); el horizonte
  restante lo resuelve la niebla continua.
- **Resolución interna adaptada al dispositivo**: DPR máximo 1,25 en pantallas
  táctiles y 1,5 en escritorio (antes 2). Reduce el fill-rate entre 45 % y
  65 % en móviles de alta densidad.
- **Buffers permanentes de proyección** (`roadX`, `roadY`, `slicePool`): no se
  crean `Float64Array` ni cientos de objetos `RoadSlice` en cada frame.
- **Estilos CSS del firme cacheados una vez por frame** (`C`): no se formatean
  colores dentro de los bucles de marcas y guardarraíles.

- **Paleta resuelta a tuplas RGB una vez por frame** (`P`) con caché de parseo
  (`toRGB` + `Map`). Dentro de los bucles no se toca ni una cadena de color:
  `mixRGB`/`shadeRGB` operan sobre números y `css()` solo formatea al asignar
  el `fillStyle`.
- **`unclump` con throttle**: es O(n²) (~700 comparaciones con 38 coches). Se
  ejecuta 5 veces por segundo en lugar de 60; basta para detectar
  emparejamientos de 2,5 s.
- **LOD espacial**: el volumen ambiental (talud, huellas, guardarraíl,
  captafaros) se dibuja solo en los **90 segmentos más cercanos** (antes 150) y
  exige `W1 > 2`. Las marcas de carril desaparecen más allá del segmento 110.
- **Culling temprano de árboles** (`h < 3`) y colores de follaje cacheados por
  frame en lugar de recomputarse por ejemplar.
- `requestAnimationFrame` con `dt` real acotado a 50 ms; `visibilitychange`
  pausa automáticamente.
- Canvas escalado por `devicePixelRatio` **capado a 2**.
- React **no** se re-renderiza por frame: HUD a ~12 Hz vía `setHud`, perilla
  del volante animada con `rAF` escribiendo `style.transform`.
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
