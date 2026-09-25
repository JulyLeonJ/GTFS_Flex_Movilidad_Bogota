# Orquestador multiagente de movilidad — Bogotá

Prototipo de un orquestador multiagente que produce **una única recomendación de
ruta híbrida**: mezcla las rutas **oficiales** (SITP / TransMilenio /
TransMiCable) con las **informales** (colectivos veredales modelados con
GTFS-Flex), ponderando estas últimas por una **confianza C(t)** que decae en el
tiempo según los reportes de la comunidad (WhatsApp, texto o voz).

## Modelo híbrido (un solo flujo, no dos)

No hay dos productos separados. Cada consulta produce **una sola lista ordenada
de opciones**, donde cada opción lleva dos atributos:

- `fuente`: `oficial` (red GTFS del SITP), `informal` (colectivo GTFS-Flex) o
  `comunitaria` (conocimiento comunitario histórico, último recurso vía LLM).
- `confianza`: `1.0` para lo oficial; para lo informal, el valor `C(t)` del
  motor de decaimiento temporal; para lo comunitario, `0.25` fijo (no verificado
  en tiempo real).

El **puntaje** de cada opción combina tiempo estimado y confianza:

```
oficial:     puntaje = 1000/(1+tiempo) + 40 (si es directa)     · confianza = 1
informal:    puntaje = 1000/(1+tiempo) · C(t)                   · confianza = C(t)
comunitaria: puntaje = 1000/(1+tiempo) · 0.25                   · confianza = 0.25
```

Así, una ruta informal rápida pero con baja confianza (p. ej. un corredor que
acaba de reportar bloqueo) queda penalizada frente a una oficial más lenta pero
fiable. La recomendación final —oficial o informal— es una sola, ordenada por
ese puntaje.

La lógica de **cálculo es determinista** (sin LLM): RAPTOR para lo oficial y el
motor de confianza para lo informal. El LLM (**opencode**) solo se usa en los
**extremos**: interpretar la consulta en lenguaje natural y redactar la
explicación final. La transcripción de notas de voz usa **Groq (Whisper)**.
Sin `OPENCODE_API_KEY` o `GROQ_API_KEY`, todo degrada a fallbacks deterministas.

**Horarios**: la consulta acepta una hora de salida (`--hora HH:MM`, o "a las
HH:MM" en texto libre). El RAPTOR respeta la ventana de servicio del GTFS
(`frequencies.txt` + `stop_times.txt`): si la hora cae fuera del horario del SITP
(p. ej. madrugada), las rutas oficiales quedan descartadas y la recomendación
cae al transporte informal o al conocimiento comunitario.

## Fuentes de datos

| Fuente | Tipo | Se usa para |
|---|---|---|
| Bogotá Abierta (`datosabiertos.bogota.gov.co`) | CKAN | catálogo (contexto) |
| datos.gov.co (`www.datos.gov.co`) | Socrata | catálogo (contexto) |
| IDECA (Nomenclátor de nombres geográficos) | ArcGIS REST | geocodificación |
| Feed GTFS oficial del SITP | zip (66 MB) | rutas oficiales (RAPTOR) |
| Feed GTFS-Flex (colectivos) | GeoJSON + txt | rutas informales + confianza |
| WhatsApp (texto / notas de voz) | ingesta | reportes → decaimiento temporal |
| Moovit / Google Maps Transit | GTFS como estándar | interoperabilidad (referencia) |

> **IDECA** es la fuente oficial de georreferenciación; si un nombre no está en
> su nomenclátor, cae automáticamente a Nominatim (OSM).
>
> **Moovit/Google** no exponen API pública; la interoperabilidad es el estándar
> **GTFS** que ambos consumen.

## Arquitectura

```
Consulta (origen, destino, tiempo)
        │
        ▼
┌───────────────────────────────────────────────────────────────┐
│ Orchestrator (etapas, blackboard = ctx.state)                  │
│                                                               │
│  Etapa 1  nlu          ──► consulta normalizada               │
│  Etapa 2  geocoder ─┐                                          │
│           ckan     ─┼─► en paralelo (coords + catálogos)       │
│           socrata  ─┘                                          │
│  Etapa 3  transito    ──► opciones OFICIALES (RAPTOR)          │
│  Etapa 4  informal    ──► + opciones INFORMALES (C(t))         │
│  Etapa 5  conocimiento_comunitario ──► si no hay nada: LLM     │
│  Etapa 6  sintesis    ──► recomendación única (+ LLM opcional) │
└───────────────────────────────────────────────────────────────┘
        ▲
        │  reportes (texto/voz)
┌───────┴────────────────────────────────────────────────────────┐
│ Subsistema informal (vivo entre consultas):                    │
│   WhatsApp → TranscripcionAgent → IngestionAgent               │
│            → SegmentBus → SegmentAgent (dueño de C(t))         │
└────────────────────────────────────────────────────────────────┘
```

El **subsistema informal es de larga vida**: los `SegmentAgent` mantienen su
`C(t)` entre consultas (reloj interno de decaimiento). El pipeline de consulta
(etapa 4) le pregunta su confianza actual y mezcla sus opciones con las
oficiales. Es el mismo modelo, no dos sistemas independientes.

## Agentes

- **nlu** — normaliza la consulta; extrae el tiempo aunque venga pegado al destino.
- **geocoder** — coordenadas (IDECA oficial, fallback OSM).
- **catalogo_bogota_abierta / catalogo_datos_gov_co** — catálogos CKAN/Socrata,
  filtrados a Bogotá (`relevancia.ts` descarta Bucaramanga, Medellín, etc.).
- **transito** — enruta lo oficial con **RAPTOR** (multi-transbordo + k
  alternativas), sobre el GTFS del SITP recortado al bbox de Ciudad Bolívar.
- **informal** — consulta el transporte informal y mezcla sus opciones (con
  `confianza = C(t)`) en la misma lista.
- **conocimiento_comunitario** — último recurso: si no hay opciones oficiales ni
  informales, usa el LLM para rastrear **conocimiento comunitario histórico**
  (juntas de acción comunal, grupos de Facebook, publicaciones de vecinos) y lo
  convierte en una recomendación `fuente: "comunitaria"` de **baja confianza**
  (0.25) pero útil. Sin `OPENCODE_API_KEY` devuelve `null` con gracia.
- **sintesis** — ordena y redacta la explicación, distinguiendo
  oficial/informal/comunitaria y mostrando la confianza.

Agentes del **subsistema informal** (asíncronos, `src/segmentos.ts` y
`src/agents/`):

- **SegmentAgent** — micro-agente dueño de `C(t)` de un tramo; reloj interno que
  aplica el decaimiento.
- **IngestionAgent** — traduce mensajes de WhatsApp y "grita" el reporte al tramo.
- **TranscripcionAgent** — transcribe notas de voz (Groq/Whisper, `src/stt.ts`) y
  entrega el texto a la ingesta.
- **QueryAgent** — consolida confianza y arma la petición a OpenTripPlanner 2
  con `reluctance` por tramo (dry-run).

## Confianza con decaimiento temporal (transporte informal)

El GTFS convencional asume paradas rígidas y rutas inflexibles; el transporte
veredal no. Por eso se modela con **GTFS-Flex**:

- **Paradas continuas** (`locations.geojson` con `LineString`): corredor vial
  donde se aborda en cualquier punto.
- **Agrupaciones espaciales** (`Polygon` + `location_groups.txt`): zonas de
  cobertura barrial sin trazado estricto.

El motor de confianza (`src/confianza.ts`) por tramo:

```
C(t) = clamp( C_base + Σ_i w_i · V_i · e^(-λ (t - t_i)), 0, 1 )
```

- `C_base`: confiabilidad estructural (p. ej. 0.4).
- `V_i`: polaridad (+1 fluido, −1.5 demora, −2 bloqueo).
- `w_i`: reputación de la fuente (anónimo 0.2 … conductor red 1.0).
- `λ`: decaimiento; vida media = `ln(2)/λ`.
- Decaimiento espacial `e^(-β·d)` propaga el impacto a tramos adyacentes.

Un bloqueo hunde `C(t)` hacia 0 y, sin reportes nuevos, el término exponencial
disipa su influencia: el tramo "sana" solo. Esa `C(t)` es exactamente la
`confianza` que pondera la opción informal en la recomendación.

**Incidentes en la red oficial**: un reporte negativo sobre una vía oficial
(p. ej. "accidente en Casalinda" → Avenida Villavicencio) se geolocaliza contra
una **zona oficial** (`src/incidentes.ts`) y penaliza los viajes del SITP cuyas
paradas caen cerca. El RAPTOR suma esa penalización al tiempo de los viajes
afectados y reduce su `confianza`, de modo que **desvía** hacia corredores
alternativos (p. ej. Avenida Boyacá) **sin inventar colectivos informales**. El
motivo del desvío (accidente/tráfico y la vía afectada) se comunica al usuario
en la recomendación final.

**Último recurso — conocimiento comunitario**: si una consulta no tiene rutas
oficiales ni informales recientes, el agente `conocimiento_comunitario` pide al
LLM que busque registros históricos de transporte informal en la zona (grupos
comunitarios, juntas de acción comunal, publicaciones de residentes) y lo
convierte en una recomendación de **baja confianza** (0.25), útil como pista
para quien viaja a zonas con poca cobertura.

## Requisitos

- Node.js ≥ 18 (usa `fetch` nativo).
- (Opcional) `OPENCODE_API_KEY` para NLU, síntesis y conocimiento comunitario.
- (Opcional) `GROQ_API_KEY` para transcripción de voz (STT, Whisper).
- (Opcional) `TELEGRAM_BOT_TOKEN` para atender consultas por chat de Telegram.

## Instalación y ejecución

```bash
npm install
cp .env.example .env       # crea .env a partir de la plantilla
# edita .env y pega tu OPENCODE_API_KEY y GROQ_API_KEY (NO las dejes en .env.example)

# Demo oficial (TransMiCable en Ciudad Bolívar)
npm run demo

# Demo híbrida: donde el SITP no llega, el colectivo informal sí (con confianza)
npm run demo:hibrido

# Texto libre (usa opencode si hay clave; si no, regex)
npm start -- --texto "de Quiba Bajo a Mochuelo Alto en 30 min"

# Con hora de salida (HH:MM): descarta rutas oficiales fuera de servicio.
npm start -- --origen "Centro Comercial El Ensueño" --destino "Mochuelo" --hora 14:00
npm start -- --origen "Centro Comercial El Ensueño" --destino "Mochuelo" --hora 00:30  # madrugada: sin SITP

# Descargar el GTFS oficial del SITP a la caché (se usa automáticamente)
npm run gtfs:sync

# Demo del subsistema informal (decaimiento temporal de un bloqueo)
npm run flex:demo

# Transcribir una nota de voz real (con GROQ_API_KEY)
npx tsx src/flex-demo.ts --audio data/audio/mi-nota.ogg

# Atender consultas por chat de Telegram (texto o nota de voz)
npm run telegram

# Verificar tipos
npm run typecheck
```

En Telegram, cada mensaje (texto o nota de voz transcrita) se clasifica
automáticamente (`src/telegram.ts` → `manejarTexto`):

1. Incidente grave (bloqueo/accidente/derrumbe/…) → **reporte**.
2. Estructura de ruta (`de X a Y`) → **consulta** de ruta.
3. Señal de estado (demora, lento, fluido, todo bien, …) → **reporte**.
4. En otro caso → se intenta como **consulta** (si no es una ruta válida, el NLU
   devuelve un mensaje claro sin ejecutar el resto del pipeline).

Los reportes se ingieren al subsistema informal/oficial y se apendan a
`data/reportes.csv`; si el lugar aún no está mapeado a un tramo o zona, se
guarda igualmente con `segmento` vacío. También puede forzarse un reporte con
`/reporte <descripción>`.

> **Importante**: `.env.example` es solo la plantilla (se versiona); los valores
> reales van en `.env` (ignorado por git), que carga `cargarDotenv()`
> (`src/dotenv.ts`).

## Área de búsqueda (bbox) y TransMiCable

Por defecto el grafo oficial se recorta a **Ciudad Bolívar** (límites IDECA,
`GTFS_BBOX`), pasando de ~6.5k paradas / 105k viajes a **~832 / 33k**. El
**TransMiCable** se detecta como cable (`route_type=6`) con viajes frecuentes
(headway 60 s) y se etiqueta `TransmiCable (cable)`.

El GTFS oficial (66 MB) se descubre desde el hub de TransMilenio y se cachea con
`npm run gtfs:sync`; `stop_times.txt` se lee en streaming. Si no hay feed oficial
ni caché, se usa `data/sample_gtfs/` (muestra).

## Base de conocimiento (CSV)

Cada consulta se apenda a `data/consultas.csv` (`src/consulta-log.ts`) como
registro plano: origen/destino/tiempo, coordenadas geocodificadas, número de
opciones, la mejor opción (tipo, fuente, confianza, puntaje) y el JSON completo
de opciones/datasets, junto con los modelos de LLM y STT usados. Es la base
para integrar un motor de base de datos más adelante (análisis, histórico,
reentrenamiento del modelo de confianza). La ruta se configura con
`CONSULTAS_CSV`.

Los **reportes de transporte informal** que llegan por Telegram (comando
`/reporte <descripción>`) se apendan a `data/reportes.csv`
(`src/reporte-log.ts`) con su `nivel` (`informal`/`oficial`) y `fiabilidad`
(0..1). Los reportes de canales informales (Telegram, peso `0.2`) tienen **menor
fiabilidad** que los validados/oficiales (`validador_comunitario` 0.7,
`conductor_red` 1.0), por lo que pesan menos en el cálculo de `C(t)`. La ruta se
configura con `REPORTES_CSV`.

Los reportes se **rehidratan al arrancar** (`src/recomendador.ts` →
`rehidratar()`): se lee `data/reportes.csv` y se re-ingieren los reportes
recientes (`REPORTES_TTL_HORAS`, por defecto 24 h) para que sigan afectando el
enrutamiento tras un reinicio. Si un reporte negativo no cae en un tramo ni en
una zona predefinida, se intenta **geolocalizar** (`src/ingesta-reportes.ts`,
IDECA/Nominatim + LLM opcional) y se registra como incidente puntual. Antes de la
síntesis, el agente `reportes_verificacion` cruza la ruta contra los reportes
activos y refleja los motivos en la explicación.

## Extender

- **Otro proveedor de geocodificación**: agrega una función en `src/geocode.ts`.
- **Nuevo agente**: implementa `Agent` y añádelo a una etapa en `src/index.ts`.
- **Más transbordos / alternativas**: RAPTOR con `MAX_TRANSBORDOS` (3) y
  `MAX_ALTERNATIVAS` (5) en `src/agents/transit.ts`.
- **Más fuentes GTFS**: `gtfs-source.ts` abstrae descubrimiento/descarga.
- **Más segmentos informales**: edita `data/sample_flex/locations.geojson`.

## Estructura

```
src/
  agent.ts          # runtime de agentes + orquestador (pipeline)
  llm.ts            # adaptador opencode (SDK OpenAI) + fallback
  stt.ts            # transcripción de voz (Groq/Whisper)
  geocode.ts        # geocodificación (IDECA oficial + fallback OSM)
  gtfs.ts           # cargador GTFS compacto (CSV/zip, feeds grandes)
  gtfs-source.ts    # descubrimiento y descarga del GTFS oficial
  gtfs-sync.ts      # CLI `npm run gtfs:sync`
  dotenv.ts         # carga de variables de entorno desde .env
  consulta-log.ts   # persistencia de consultas en CSV (base de conocimiento)
  relevancia.ts     # filtro de relevancia Bogotá (catálogos)
  confianza.ts      # decaimiento temporal/espatial (GTFS-Flex)
  incidentes.ts     # incidentes sobre la red oficial (zonas + penalización)
  flex.ts           # parser GTFS-Flex (paradas continuas, grupos)
  segmentos.ts      # SegmentAgent + bus asíncrono
  informal.ts       # InformalService (puente informal ↔ pipeline)
  flex-demo.ts      # CLI `npm run flex:demo`
  util.ts           # haversine, fetch, formato
  types.ts          # contratos compartidos
  index.ts          # CLI y orquestación (híbrida)
  agents/
    nlu.ts          # normalizar consulta
    geocoder.ts     # agente de geocodificación
    ckan.ts         # Bogotá Abierta (CKAN)
    socrata.ts      # datos.gov.co (Socrata)
    transit.ts      # enrutador oficial (RAPTOR multi-transbordo)
    informal.ts     # integra opciones informales (C(t))
    conocimiento-comunitario.ts # último recurso: rutas históricas (LLM)
    synth.ts        # síntesis / recomendación
    ingesta.ts      # ingesta WhatsApp → reportes
    transcripcion.ts # nota de voz → texto → ingesta
    consulta-otp.ts # consolidar confianza + OTP2 reluctance
data/sample_gtfs/   # feed GTFS de muestra (oficial)
data/sample_flex/   # feed GTFS-Flex de muestra (informal)
data/gtfs_cache/    # GTFS oficial descargado (git-ignored)
```
