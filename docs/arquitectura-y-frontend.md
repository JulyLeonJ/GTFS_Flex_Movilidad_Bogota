# Estado actual de la aplicación y propuesta de frontend con mapa

Este documento resume cómo está construido hoy el orquestador de movilidad y
cómo podría integrarse un frontend web con mapa.

---

## 1. Cómo está construida la aplicación actualmente

### 1.1 Propósito

Recomendar **una única ruta híbrida** de transporte en Bogotá, mezclando:

- Red **oficial** (SITP / TransMilenio / TransMiCable) calculada con **RAPTOR**
  (multi-transbordo) sobre el feed GTFS del SITP.
- Transporte **informal** (colectivos veredales) modelado con **GTFS-Flex** y
  ponderado por una **confianza C(t)** que decae en el tiempo.
- **Conocimiento comunitario** histórico (último recurso, vía LLM).

Cada opción lleva `fuente` (`oficial` | `informal` | `comunitaria`) y
`confianza` (0..1). El ranking es determinista por `puntaje`; el LLM solo se usa
en los extremos (interpretar texto libre y redactar la explicación).

### 1.2 Stack

- **Node.js ≥ 18**, TypeScript (ESM, `tsconfig` con `NodeNext`), `tsx` para correr.
- Sin framework web: hoy es **CLI** + **bot de Telegram**.
- SDKs: `openai` (apuntando a OpenCode Zen para el LLM y a Groq para STT),
  `grammy` (Telegram), `adm-zip` (GTFS).
- Variables de entorno cargadas por `src/dotenv.ts` desde `.env`
  (`OPENCODE_API_KEY`, `GROQ_API_KEY`, `TELEGRAM_BOT_TOKEN`, `GTFS_*`, etc.).

### 1.3 Arquitectura (pipeline multiagente con blackboard)

```
Entrada (CLI / Telegram: texto o nota de voz)
        │
        ▼
 Recomendador (src/recomendador.ts)  ← mantiene vivos InformalService + IncidentesService
        │
        ▼
 Orchestrator (src/agent.ts)  — etapas secuenciales, agentes en paralelo, pizarra ctx.state
        │
   1. nlu            → ConsultaNormalizada (origen/destino/tiempo + puntos)
   2. geocoder ─┐    → coordenadas IDECA (fallback OSM)
      ckan     ─┼──► catálogos Bogotá Abierta / datos.gov.co (contexto)
      socrata  ─┘
   3. transito       → opciones OFICIALES (RAPTOR)
   4. informal       → + opciones INFORMALES (confianza C(t))
   5. conocimiento_comunitario → si no hay nada, LLM (confianza 0.25)
   6. sintesis       → ResultadoRecomendacion (explicación + opciones ordenadas)
        │
        ▼
 formatearResultado() (CLI)  |  ctx.reply(explicacion) (Telegram)
 registrarConsulta() → data/consultas.csv (base de conocimiento)
```

**Archivos clave** (`src/`):

| Archivo | Rol |
|---|---|
| `recomendador.ts` | Núcleo reutilizable: construye y ejecuta el pipeline, formatea y persiste. |
| `agent.ts` | Runtime de agentes + `Orchestrator` (etapas/blackboard). |
| `index.ts` | CLI (`--texto`, `--origen/--destino`, `--audio` como reporte). |
| `telegram.ts` | Bot de Telegram: `message:text` y `message:voice`, responde con `ctx.reply`. |
| `llm.ts` / `stt.ts` | Adaptadores LLM (OpenCode Zen) y STT (Groq/Whisper) con fallback. |
| `gtfs.ts` / `gtfs-source.ts` | Carga GTFS (bbox, streaming) + descubrimiento/descarga oficial. |
| `flex.ts` / `informal.ts` / `confianza.ts` / `segmentos.ts` | Subsistema informal (GTFS-Flex + decaimiento C(t)). |
| `incidentes.ts` | Incidentes sobre la red oficial (penalización por vía). |
| `vocabulario.ts` | Vocabulario compartido (incidentes/afectación/fluidez) para clasificar reportes. |
| `ingesta-reportes.ts` | Ingesta de reportes con geolocalización (tramo → zona → punto). |
| `geocode.ts` | IDECA (oficial) + Nominatim (respaldo). |
| `consulta-log.ts` | Persistencia CSV de consultas (`data/consultas.csv`). |
| `reporte-log.ts` | Persistencia/lectura CSV de reportes (`data/reportes.csv`, con nivel y fiabilidad). |
| `agents/verificacion-reportes.ts` | Cruza la ruta contra reportes activos y refleja motivos en la explicación. |
| `types.ts` | Contratos compartidos. |

### 1.4 Contratos de datos relevantes (`src/types.ts`)

- `ConsultaNormalizada` → `origenTexto`, `destinoTexto`, `tiempoMin`,
  `origenPunto`/`destinoPunto` (`{lat, lon}`), `salidaSeg?`.
- `OpcionRuta` → `tipo` (directa/transbordo), `resumen`, `paradaOrigen`,
  `paradaDestino` (nombres), `pasos[]` (texto), `rutasUsadas[]`,
  `tiempoEstimadoMin`, `caminataMts`, `puntaje`, `fuente?`, `confianza?`.
- `ResultadoRecomendacion` → `consulta`, `opciones[]`, `datasets[]`,
  `explicacion`.
- `GtfsStop` → `{id, name, lat, lon}`; `GtfsRoute` → `{id, shortName, longName,
  routeType, color?}`.
- `SegmentoInformal` (flex) → `{id, nombre, tipo, geometria (LineString | Polygon
  | Point), cBase, vidaMediaSeg, centroide}`.

### 1.5 Lo que hoy **no** existe (brechas para el frontend)

- **No hay servidor HTTP**: no se puede consumir desde un navegador todavía.
- **Sin geometría de ruta en `OpcionRuta`**: solo nombres de paradas y pasos en
  texto. El GTFS tiene coordenadas de paradas (`GtfsStop.lat/lon`) y el flex
  tiene `LineString`/`Polygon`, pero **`shapes.txt` no se carga** (no hay
  polilíneas de las rutas oficiales).
- `OpcionRuta` no incluye coordenadas de las paradas ni del trazado; habría que
  enriquecerlo o exponer los índices internos (`trip`, `boardStop`) del RAPTOR.

---

## 2. Integración de un frontend con mapa

### 2.1 Estrategia recomendada

Convertir el `Recomendador` en un servicio accesible por **HTTP/REST**, sin tocar
la lógica de enrutamiento. Los frontends (web, Telegram ya funciona) consumirían
esa API; el mapa se dibuja con los datos geo que ya existen (paradas, geometrías
flex) más las polilíneas que se agreguen.

```
Frontend web (mapa) ──► API REST (nueva, ej. src/server.ts) ──► Recomendador
                          GET /recomendar?texto=...  o  POST /recomendar {texto|audio}
```

### 2.2 API propuesta (mínima)

- `POST /recomendar` — body `{ texto?: string, audioBase64?: string }`, responde
  el `ResultadoRecomendacion` enriquecido con geometría.
- `GET /salud` — estado (modelos LLM/STT activos, GTFS cargado, incidentes).
- (Opcional) `WS /incidentes` — push en tiempo real cuando entra un reporte de
  vía (para actualizar el mapa sin recargar).

Framework sugerido: **Fastify** o **Express** (ligero, ESM-friendly). Alternativa
cero-dependencia: el módulo `node:http` nativo.

### 2.3 Enriquecer el contrato para el mapa

Agregar a `OpcionRuta` (o a un `geometry` paralelo) coordenadas listas para
dibujar:

- **Paradas**: `paradaOrigen`/`paradaDestino` con `{lat, lon}` (ya en
  `GtfsStop`).
- **Tramos oficiales**: cargar `shapes.txt` en `gtfs.ts` y asociar `shape_id` a
  cada `trip`; exponer la polilínea de cada tramo. Mientras tanto se puede
  dibujar una línea recta entre paradas como aproximación.
- **Tramos informales**: usar `SegmentoInformal.geometria` (`LineString` para el
  corredor, `Polygon` para la zona de cobertura).
- **Origen/destino**: `ConsultaNormalizada.origenPunto/destinoPunto`.

Esto permite dibujar: marcadores de origen/destino, la ruta recomendada resaltada,
las alternativas atenuadas y las zonas de cobertura informal.

### 2.4 Librerías de mapa sugeridas

- **MapLibre GL JS** o **Leaflet** (ambas open source, sin claves).
- Tiles base de OSM (o **IDECA** como fuente oficial de cartografía de Bogotá).
- Superponer capas GeoJSON: paradas GTFS, trazado de ruta, segmentos flex,
  incidentes (puntos con radio de afección).

### 2.5 Pasos incrementales

1. **Exponer la API**: nuevo `src/server.ts` que envuelva `Recomendador`
   (HTTP GET/POST → JSON). El `Recomendador` ya es reutilizable y de larga vida.
2. **Geometría mínima**: devolver `origenPunto`/`destinoPunto` + coordenadas de
   paradas de cada opción (resolver `paradaOrigen`/`paradaDestino` contra
   `GtfsStop`).
3. **Trazado oficial**: parsear `shapes.txt` y asociar `shape_id` a los trips
   para devolver polilíneas reales.
4. **Frontend**: SPA (Vite + React/Vue) con MapLibre/Leaflet; entrada de texto
   (y audio opcional vía `MediaRecorder` + STT en el backend).
5. **Tiempo real**: `WS /incidentes` para reflejar reportes de vía en el mapa.

### 2.6 Consideraciones

- Mantener la lógica determinista en el backend (RAPTOR/C(t)); el frontend solo
  renderiza. No duplicar reglas de negocio.
- Reusar `Recomendador` entre CLI, Telegram y HTTP garantiza una sola fuente de
  verdad.
- Si el mapa necesita todo el grafo (todas las paradas/rutas), exponer un
  endpoint `GET /gtfs` acotado al bbox para no enviar el feed completo al cliente.
