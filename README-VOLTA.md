# VOLTA · Autoescuela Digital — Documentación técnica

Plataforma dual (portal de alumno + backoffice de empleado) construida como
**esquema funcional**: la UI opera íntegramente contra una capa de servicios
(`src/lib/api.ts`) que conmuta entre datos demo y API real mediante un flag de
entorno. Sin backend en este repositorio.

## Stack

| Capa | Tecnología |
|---|---|
| Framework | React 19 + TypeScript (strict) |
| Bundler | Vite 7 + `vite-plugin-singlefile` (JS/CSS inyectados en `dist/index.html`) |
| Estilos | Tailwind CSS 4 (tokens en `@theme`, sin archivos de config) |
| Animación | framer-motion (transiciones de vista, reveals, progresos) |
| Iconos | lucide-react |
| Fuentes | Archivo (display) · Inter (texto) · JetBrains Mono (etiquetas/números) |
| Alias | `@/*` → `src/*` (vite + tsconfig) |

Notas de toolchain: `noUnusedLocals` y `noUnusedParameters` activos; target
ES2020 (evitar `String.replaceAll`, usar `replace(/…/g, …)`).

## Estructura

```
├── index.html                 # lang es · metas · favicon SVG inline
├── src/
│   ├── App.tsx                # orquestador de 3 vistas (estado + AnimatePresence)
│   ├── main.tsx
│   ├── index.css              # tema: paleta asfalto/voltio, dash-anim, marquee, .card/.input
│   ├── lib/
│   │   ├── data.ts            # CONTRATO DE DATOS: 15 interfaces + mocks demo
│   │   └── api.ts             # CAPA DE SERVICIOS: única puerta de datos de la UI
│   ├── components/
│   │   └── ui.tsx             # Logo, Btn, Pill, Kicker, ProgressRing, HBar,
│   │                          # CountUp, AvatarTxt, Field, useToasts/Toasts, SectionHead
│   ├── utils/cn.ts            # clsx + tailwind-merge
│   └── views/
│       ├── Landing.tsx        # pública: hero SVG animado, gates de rol, cursos, método
│       ├── Portal.tsx         # alumno: panel, material, clases, documentos, pagos
│       └── Admin.tsx          # empleado: KPIs, CRM, agenda, envíos, facturación, integraciones
├── docs/GUIA_BACKEND.md       # DDL completo, endpoints, snippets por stack, checklist
└── .env.example
```

## Contrato de datos (src/lib/data.ts)

Convenciones que el backend debe respetar (la UI serializa exactamente así):

- **IDs**: strings opacos (`st-001`, `FAC-2026-0119`, `tpl-01`).
- **Fechas**: ISO-8601 (`2026-02-12T17:30:00+01:00`); fechas-día `YYYY-MM-DD`.
- **Dinero**: enteros en **céntimos** (`35000` = 350,00 €). Formateo `Intl` es-ES en cliente.
- **Enums cerrados**:
  - `EstadoAlumno`: `activo | pendiente-docs | pendiente-pago | examen | inactivo`
  - `Lesson.estado`: `confirmada | pendiente | reservable`
  - `Payment.estado`: `pagado | pendiente | vencido`
  - `Invoice.sap`: `sincronizado | pendiente | error`
- **Entidades**: `Student`, `MaterialItem`, `Lesson`, `DocFile`, `Payment`,
  `Invoice`, `DocTemplate`, `SendLog`, `Integration`, más agregados de panel
  (`KPIS`, `SIGNUPS_BY_MONTH`, `FLEET_USAGE`, `ADMIN_ALERTS`).
- Relaciones backend: `students.sap_card_code ↔ SAP OCRD.CardCode`;
  `invoices.sap_doc_entry ↔ SAP Invoices.DocEntry`.

## Capa de servicios (src/lib/api.ts)

Única puerta de datos; los componentes nunca hacen `fetch` ni importan mocks.

```ts
const API_URL  = import.meta.env.VITE_API_URL ?? 'http://localhost:8000/api'
const USE_MOCK = import.meta.env.VITE_USE_MOCK !== 'false'
```

- `request<T>(path, init)`: wrapper único — base URL, `Content-Type: application/json`,
  `Authorization: Bearer <localStorage.volta_token>`, errores normalizados
  (`ApiError(status, message)` desde `{ "message": string }`), `204 → undefined`.
- `mock<T>(data, ms)`: latencia simulada + `structuredClone` para aislar mutaciones.
- Subidas: `uploadStudentDocument(file)` usa `FormData` **sin** `Content-Type`
  manual (boundary del navegador) y cabecera solo con el Bearer.
- Descargas: `exportStudentsExcel()` — demo genera CSV+BOM en cliente (`sep=;`);
  la rama real hace `GET /exports/students.xlsx` con `Accept` xlsx y descarga el blob.
- Todas las funciones documentadas en JSDoc con la ruta exacta y el snippet
  equivalente (Laravel / FastAPI / Express / Spring).

## Vistas y mapeo a rutas reales

| Vista | Ruta futura | Guardia |
|---|---|---|
| `Landing` | `/` | pública |
| `Portal` | `/portal` | JWT + rol `alumno` (solo consume `/api/me/*`) |
| `Admin` | `/admin` | JWT + rol `empleado` (consume `/api/students`, `/api/admin/*`) |

Migración a router: `react-router-dom` + `<RequireAuth rol>` que valide el JWT
con `GET /me` y redirija a `/login`. El estado actual de `App.tsx` se sustituye
1:1. Seguridad efectiva solo en servidor; el front orienta navegación.

## Auth (especificado en api.ts)

`POST /auth/login {email,password} → {token, user:{id,nombre,rol}}`.
Token en `localStorage.volta_token` (demo; producción recomendada: cookie
httpOnly + CSRF). `logout()` limpia. Middleware servidor: firma + expiración +
rol por endpoint. El alumno nunca envía su id: se deduce del JWT (`/me/*`).

## Endpoints que espera el front (resumen)

Alumno: `GET /me`, `GET /me/materiales`, `GET /me/clases`,
`POST /clases/reservar`, `GET|POST /me/documentos`, `GET /me/pagos`,
`POST /materiales/:id/archivo` (URL firmada), `POST /pagos/checkout`.

Empleado: `GET/POST/PATCH/DELETE /students(.:id)` (baja lógica),
`GET /exports/students.xlsx`, `GET /admin/dashboard`, `GET /admin/agenda`,
`GET /documentos/plantillas|envios`, `POST /documentos/enviar` (202 + worker),
`GET /invoices`, `POST /invoices/:id/sincronizar-sap`, `POST /invoices/sincronizar-sap`,
`GET /api/admin/integraciones`.

Errores: `{message}` + status semántico (`401/403/409 solape/422 validación`).
Detalle completo y DDL en `docs/GUIA_BACKEND.md`.

## Decisiones de arquitectura implícitas

- **Colas = todo lo asíncrono**: envíos de documentos (PDF→S3→SMTP/WhatsApp) y
  altas/sincronización SAP responden `202` inmediato; estado final vía webhook/polling.
- **Documentos privados fuera de `public/`**: S3 + URLs firmadas temporales.
- **Baja lógica** (`deleted_at`) en `students`/`invoices` para histórico contable.
- **Anti-solape de clases en DB** (exclusion constraint PostgreSQL), no en UI.
- **Agregación en SQL** para KPIs (el front nunca suma tablas crudas).
- **Secretos solo en el `.env` del servidor**: el front solo recibe estados de
  integración (`GET /admin/integraciones`).

## Sistema de diseño (index.css)

Tokens `@theme`: `ink #07080A · coal #0C0E12 · panel #11141B · edge #212944 ·
volt #C8F542 · ambers #FFB224 · fog #99A1AE · paper #EEF1F3` + fuentes display/
sans/mono. Utilidades custom: `.card`, `.input`, `.txt-outline(-volt)`,
`.bg-grain`, `.dash-slow/.dash-fast` (líneas de carretera SVG), marquee 32 s,
scrollbar themada. Radios: tarjetas `rounded-2xl`, chips `rounded-full`;

## Build

`npm run build` → `dist/index.html` único (~490 KB, gzip ~146 KB) con JS/CSS
inyectados; las imágenes de `public/img/*` (hero + gates, JPG generados) se
copian como assets externos. Sin SSR ni code-splitting por diseño.

## Checklist técnico demo → producción

1. `VITE_API_URL` + `VITE_USE_MOCK=false`; servidor con CORS acotado.
2. Implementar `request()` compatible con refresh-token si aplica.
3. Sustituir el switch de vistas por rutas + `RequireAuth`.
4. Validar enums del contrato contra los del ORM elegido.
5. Cola (Horizon/Celery/BullMQ) para `documentos/enviar` y jobs SAP.
6. SAP B1 Service Layer: login con cookie de sesión (~30 min), reintentos con
   backoff, guardar `DocEntry` en `invoices`.
7. Excel server-side (Laravel-Excel / openpyxl / exceljs / POI); el front ya
   descarga el blob.
8. WhatsApp Cloud API: plantilla aprobada + webhook de estados → `doc_sends`.
9. Pasarela (Stripe/Redsys): webhook de confirmación marca `payments`.
