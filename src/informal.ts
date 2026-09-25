import { parseFlex, calcularVecinos, type SegmentoInformal, type Vecino } from "./flex.js";
import { SegmentBus, SegmentAgent } from "./segmentos.js";
import { IngestionAgent } from "./agents/ingesta.js";
import { TranscripcionAgent } from "./agents/transcripcion.js";
import { QueryAgent } from "./agents/consulta-otp.js";
import type { AudioInput } from "./stt.js";
import type { Reporte } from "./confianza.js";
import { haversine } from "./util.js";
import { enArea } from "./gtfs.js";
import type { Coord, OpcionRuta, Punto, TramoGeo } from "./types.js";

// Servicio de transporte informal (GTFS-Flex): posee los Agentes de Tramo y su
// confianza C(t) por decaimiento, y expone opciones de ruta informales para que
// el pipeline las mezcle con las oficiales. Es el puente entre los dos mundos.

const RADIO_INFORMAL_M = 700; // un punto está "servido" por un segmento si está dentro de este radio
const VELOCIDAD_MS = 5; // ~18 km/h, velocidad promedio de un colectivo veredal

export class InformalService {
  private bus: SegmentBus;
  private agentes: SegmentAgent[];
  private ingesta: IngestionAgent;
  private transcripcion: TranscripcionAgent;
  private query: QueryAgent;
  private vecinos: Map<string, Vecino[]>;

  constructor(flexDir: string) {
    const todos = parseFlex(flexDir);
    const segmentos = todos.filter((s) => enArea(s.centroide));
    if (segmentos.length < todos.length) {
      const descartados = todos.filter((s) => !enArea(s.centroide));
      console.warn(
        `${descartados.length} segmento(s) Flex fuera del área MVP descartados: ${descartados.map((s) => s.id).join(", ")}`,
      );
    }
    this.vecinos = calcularVecinos(segmentos);
    this.bus = new SegmentBus();
    this.agentes = segmentos.map((s) => {
      const a = new SegmentAgent(s, this.bus);
      a.setVecinos(this.vecinos.get(s.id) ?? []);
      this.bus.registrar(a);
      return a;
    });
    this.ingesta = new IngestionAgent(
      this.bus,
      segmentos.map((s) => ({ id: s.id, nombre: s.nombre })),
    );
    this.transcripcion = new TranscripcionAgent(this.ingesta);
    this.query = new QueryAgent(this.agentes);
  }

  segmentos(): SegmentoInformal[] {
    return this.agentes.map((a) => a.segmento);
  }

  ingestaDeTexto(texto: string, fuente: string, timestamp?: number): Reporte | null {
    return this.ingesta.procesarMensaje(texto, fuente, timestamp);
  }

  // Clasifica (sin efectos secundarios) si el texto es un reporte de un tramo
  // informal (estado de vía) y no una consulta de ruta.
  esReporte(texto: string): boolean {
    return this.ingesta.esReporte(texto);
  }

  // Incidente grave (bloqueo/accidente/…) que gana sobre la estructura de ruta.
  esIncidenteFuerte(texto: string): boolean {
    return this.ingesta.esIncidenteFuerte(texto);
  }

  // Polaridad del texto (+1 fluido, -1.5 demora, -2 bloqueo, 0.5 por defecto).
  polaridad(texto: string): number {
    return this.ingesta.polaridad(texto);
  }

  ingestaDeVoz(audio: AudioInput, fuente: string, timestamp?: number): Promise<Reporte | null> {
    return this.transcripcion.recibirNotaDeVoz(audio, fuente, timestamp);
  }

  c(id: string, t: number = Date.now()): number {
    return this.agentes.find((a) => a.segmento.id === id)?.c(t) ?? 0;
  }

  reportesDe(id: string, t?: number): readonly Reporte[] {
    return this.agentes.find((a) => a.segmento.id === id)?.confianza.activos(t) ?? [];
  }

  consolidar(ids: string[], t: number = Date.now()) {
    return this.query.consolidar(ids, t);
  }

  // Opciones informales relevantes para un par origen/destino (con su C(t)).
  opciones(origen?: Punto, destino?: Punto, t: number = Date.now()): OpcionRuta[] {
    if (!origen || !destino) return [];
    const opts: OpcionRuta[] = [];
    const claves = new Set<string>();

    for (const a of this.agentes) {
      const seg = a.segmento;
      const dO = distanciaPuntoASegmento(origen, seg);
      const dD = distanciaPuntoASegmento(destino, seg);

      // Directa: un mismo corredor/zona sirve origen y destino.
      if (dO <= RADIO_INFORMAL_M && dD <= RADIO_INFORMAL_M) {
        this.agregarDirecta(seg, a.c(t), dO, dD, origen, destino, opts, claves);
      }

      // Transbordo informal: segmento cerca del origen → vecino cerca del destino.
      if (dO <= RADIO_INFORMAL_M) {
        for (const v of this.vecinos.get(seg.id) ?? []) {
          const vecino = this.agentes.find((x) => x.segmento.id === v.id);
          if (!vecino) continue;
          const dD2 = distanciaPuntoASegmento(destino, vecino.segmento);
          if (dD2 <= RADIO_INFORMAL_M) {
            this.agregarTransbordo(
              seg, a.c(t), vecino.segmento, vecino.c(t), dO, dD2,
              origen, destino, opts, claves,
            );
          }
        }
      }
    }

    opts.sort((x, y) => y.puntaje - x.puntaje);
    return opts.slice(0, 5);
  }

  private agregarDirecta(
    seg: SegmentoInformal,
    c: number,
    dO: number,
    dD: number,
    origen: Punto,
    destino: Punto,
    out: OpcionRuta[],
    claves: Set<string>,
  ): void {
    const resumen = `Colectivo ${seg.nombre} (informal)`;
    if (claves.has(resumen)) return;
    claves.add(resumen);
    const caminataM = Math.round(dO + dD);
    const recorridoM = haversine(origen, destino);
    const tiempo = caminataM / 1.3 / 60 + recorridoM / VELOCIDAD_MS / 60;

    const r = recorrido(seg, origen, destino);
    const inicio: Punto = { lon: r[0][0], lat: r[0][1] };
    const fin: Punto = { lon: r[r.length - 1][0], lat: r[r.length - 1][1] };
    const tramos: TramoGeo[] = [];
    const c1 = caminataTramo(origen, inicio);
    if (c1) tramos.push(c1);
    tramos.push({
      modo: "informal",
      etiqueta: `Colectivo ${seg.nombre}`,
      coords: r,
      geometria: seg.geometria.type === "LineString" ? "flex" : "recta",
    });
    const c2 = caminataTramo(fin, destino);
    if (c2) tramos.push(c2);

    out.push({
      tipo: "directa",
      resumen,
      paradaOrigen: seg.nombre,
      paradaDestino: seg.nombre,
      pasos: [
        `Acercarse al corredor ${seg.nombre} (~${Math.round(dO)} m)`,
        `Abordar el colectivo ${seg.nombre}`,
        `Descender cerca del destino (~${Math.round(dD)} m)`,
      ],
      rutasUsadas: [seg.nombre],
      tiempoEstimadoMin: Math.max(1, Math.round(tiempo)),
      caminataMts: caminataM,
      puntaje: (1000 / (1 + tiempo)) * c,
      fuente: "informal",
      confianza: c,
      tramos,
    });
  }

  private agregarTransbordo(
    a: SegmentoInformal,
    cA: number,
    b: SegmentoInformal,
    cB: number,
    dO: number,
    dD: number,
    origen: Punto,
    destino: Punto,
    out: OpcionRuta[],
    claves: Set<string>,
  ): void {
    const resumen = `Colectivo ${a.nombre} → ${b.nombre} (informal)`;
    if (claves.has(resumen)) return;
    claves.add(resumen);
    const c = Math.min(cA, cB);
    const caminataM = Math.round(dO + dD);
    const recorridoM = haversine(a.centroide, b.centroide) + haversine(origen, destino);
    const tiempo = caminataM / 1.3 / 60 + recorridoM / VELOCIDAD_MS / 60;

    const r1 = recorrido(a, origen, b.centroide);
    const fin1: Punto = { lon: r1[r1.length - 1][0], lat: r1[r1.length - 1][1] };
    const r2 = recorrido(b, fin1, destino);
    const inicio1: Punto = { lon: r1[0][0], lat: r1[0][1] };
    const fin2: Punto = { lon: r2[r2.length - 1][0], lat: r2[r2.length - 1][1] };
    const tramos: TramoGeo[] = [];
    const c1 = caminataTramo(origen, inicio1);
    if (c1) tramos.push(c1);
    tramos.push({
      modo: "informal",
      etiqueta: `Colectivo ${a.nombre}`,
      coords: r1,
      geometria: a.geometria.type === "LineString" ? "flex" : "recta",
    });
    tramos.push({
      modo: "informal",
      etiqueta: `Colectivo ${b.nombre}`,
      coords: r2,
      geometria: b.geometria.type === "LineString" ? "flex" : "recta",
    });
    const c2 = caminataTramo(fin2, destino);
    if (c2) tramos.push(c2);

    out.push({
      tipo: "transbordo",
      resumen,
      paradaOrigen: a.nombre,
      paradaDestino: b.nombre,
      pasos: [
        `Acercarse al corredor ${a.nombre} (~${Math.round(dO)} m)`,
        `Abordar el colectivo ${a.nombre}`,
        `Transbordar al colectivo ${b.nombre}`,
        `Descender cerca del destino (~${Math.round(dD)} m)`,
      ],
      rutasUsadas: [a.nombre, b.nombre],
      tiempoEstimadoMin: Math.max(1, Math.round(tiempo)),
      caminataMts: caminataM,
      puntaje: (1000 / (1 + tiempo)) * c,
      fuente: "informal",
      confianza: c,
      tramos,
    });
  }

  detener(): void {
    for (const a of this.agentes) a.detener();
  }
}

// ---- geometría: distancia de un punto a un segmento flex ----
export function distanciaPuntoASegmento(p: Punto, seg: SegmentoInformal): number {
  if (seg.geometria.type === "LineString") {
    return distanciaPuntoALinea(p, seg.geometria.coordinates);
  }
  return haversine(p, seg.centroide);
}

function caminataTramo(desde: Punto, hasta: Punto): TramoGeo | null {
  if (haversine(desde, hasta) < 10) return null;
  return {
    modo: "caminata",
    etiqueta: "Caminar",
    geometria: "recta",
    coords: [[desde.lon, desde.lat], [hasta.lon, hasta.lat]],
  };
}

// Recorrido informal dibujable entre `desde` y `hasta` sobre un segmento Flex:
// corredor (LineString) → sub-línea entre los vértices más cercanos (invertida
// si hace falta); zona (Polygon/Point) → recta por el centroide.
function recorrido(seg: SegmentoInformal, desde: Punto, hasta: Punto): Coord[] {
  if (seg.geometria.type !== "LineString") {
    return [[desde.lon, desde.lat], [seg.centroide.lon, seg.centroide.lat], [hasta.lon, hasta.lat]];
  }
  const coords = seg.geometria.coordinates;
  let ia = 0;
  let dA = Infinity;
  let ib = 0;
  let dB = Infinity;
  coords.forEach((v, i) => {
    const p = { lat: v[1], lon: v[0] };
    const da = haversine(desde, p);
    if (da < dA) { dA = da; ia = i; }
    const db = haversine(hasta, p);
    if (db < dB) { dB = db; ib = i; }
  });
  if (Math.abs(ib - ia) < 1) return [[desde.lon, desde.lat], [hasta.lon, hasta.lat]];
  const min = Math.min(ia, ib);
  const max = Math.max(ia, ib);
  const slice: Coord[] = coords.slice(min, max + 1);
  return ia > ib ? slice.slice().reverse() : slice;
}

function distanciaPuntoALinea(p: Punto, coords: [number, number][]): number {
  let min = Infinity;
  for (let i = 0; i < coords.length - 1; i++) {
    const d = distanciaPuntoAEdge(p, coords[i], coords[i + 1]);
    if (d < min) min = d;
  }
  return min;
}

function distanciaPuntoAEdge(
  p: Punto,
  a: [number, number],
  b: [number, number],
): number {
  const latRef = (p.lat + a[1] + b[1]) / 3;
  const k = Math.cos((latRef * Math.PI) / 180);
  const px = p.lon * k;
  const py = p.lat;
  const ax = a[0] * k;
  const ay = a[1];
  const bx = b[0] * k;
  const by = b[1];
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return haversine(p, { lat: cy, lon: cx / k });
}
