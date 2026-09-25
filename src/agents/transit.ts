import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Agent, AgentContext } from "../agent.js";
import {
  bboxPorDefecto,
  detectGtfsSource,
  type Gtfs,
  type GtfsRoute,
  type GtfsStop,
} from "../gtfs.js";
import {
  cacheZip,
  descargarGtfs,
  descubrirGtfsOficial,
  escribirMeta,
  leerMeta,
} from "../gtfs-source.js";
import { haversine, segAHora } from "../util.js";
import { IncidentesService } from "../incidentes.js";
import type { ConsultaNormalizada, OpcionRuta } from "../types.js";

const WALK_SPEED_MS = 1.3;
const MAX_WALK_M = 800;
const MAX_CANDIDATES = 3;
const MAX_TRANSBORDOS = 3; // máximo de transbordos (hasta 4 viajes)
const MAX_DURACION_SEC = 4 * 3600; // poda de rutas absurdamente largas
const MAX_ALTERNATIVAS = 5; // etiquetas por parada / rutas alternativas
const PENALIZACION_MAX_SEG = 30 * 60; // penalización de un viaje 100% afectado
const PENALIZACION_TRANSBORDO_MIN = 12; // costo de un transbordo expresado en minutos

interface Candidata {
  stop: GtfsStop;
  idx: number;
  dist: number;
  rutas: string[];
}

interface Label {
  arr: number; // hora de llegada (segundos)
  trip: number; // viaje que llegó aquí (-1 si es origen)
  boardStop: number; // parada de abordaje (-1 si es origen)
  parent: Label | null; // etiqueta en boardStop que alimentó este abordaje
}

interface RaptorResult {
  startSec: number;
  labels: Map<number, Label[]>; // stopIdx -> etiquetas ordenadas por arr
}

interface Tramo {
  from: number; // índice de parada de abordaje
  to: number; // índice de parada de bajada
  trip: number; // índice de viaje
}

function routeLabel(r: GtfsRoute | undefined, id: string): string {
  if (!r) return id;
  if (r.routeType === 6) return "TransmiCable (cable)";
  return r.shortName || r.longName || id;
}

// Agente de tránsito: carga el feed GTFS (oficial si está disponible) y calcula
// rutas deterministas multi-transbordo (RAPTOR) entre las paradas más cercanas
// al origen y al destino. Sin LLM.
export class TransitAgent implements Agent {
  readonly name = "transito";

  private gtfs!: Gtfs;
  private tripImpacto: number[] = []; // viaje -> impacto agregado 0..1 (confianza)
  private tripImpactoRuta: number[] = []; // viaje -> impacto de ruta (severidad, desvío)
  private viajesEscaneados = new Set<number>(); // viajes alcanzados por RAPTOR en la consulta

  constructor(private incidentes: IncidentesService = new IncidentesService()) {}

  async run(ctx: AgentContext): Promise<void> {
    const consulta = ctx.state.consulta as ConsultaNormalizada;
    await this.cargar(ctx);
    this.viajesEscaneados.clear();
    this.calcularImpactoPorViaje();

    const salidaSeg = consulta.salidaSeg;
    if (salidaSeg !== undefined) {
      const sv = this.servicioGlobal();
      if (salidaSeg < sv.start || salidaSeg > sv.end) {
        ctx.state.opciones = [];
        ctx.log(
          `sin servicio oficial a las ${segAHora(salidaSeg)} (horario SITP: ~${segAHora(sv.start)}–${segAHora(sv.end)}${sv.end >= 86400 ? " del día siguiente" : ""})`,
        );
        return;
      }
    }

    const origen = this.candidatas(consulta, true);
    const destino = this.candidatas(consulta, false);

    if (origen.length === 0 || destino.length === 0) {
      ctx.state.opciones = [];
      ctx.log("sin paradas cercanas al origen/destino; no hay opciones de ruta");
      return;
    }

    const opciones = this.enrutar(origen, destino, salidaSeg);
    ctx.state.opciones = opciones;
    ctx.state.incidentesEnRuta = this.motivosDeRuta();
    ctx.log(`${opciones.length} opción(es) de ruta calculadas`);
  }

  // ---- resolución de la fuente GTFS ----
  private async cargar(ctx: AgentContext): Promise<void> {
    let fuente: string;

    const bbox = bboxPorDefecto();
    const fromEnv = process.env.GTFS_PATH?.trim();
    if (fromEnv) {
      if (/^https?:\/\//.test(fromEnv)) {
        ctx.log("GTFS_PATH es una URL; descargando…");
        await descargarGtfs(fromEnv, cacheZip(), ctx.log);
        this.gtfs = await detectGtfsSource(cacheZip(), ctx.log, bbox);
        fuente = `URL ${fromEnv}`;
      } else {
        this.gtfs = await detectGtfsSource(fromEnv, ctx.log, bbox);
        fuente = `GTFS_PATH=${fromEnv}`;
      }
    } else if (existsSync(cacheZip())) {
      this.gtfs = await detectGtfsSource(cacheZip(), ctx.log, bbox);
      const meta = leerMeta();
      fuente = `GTFS oficial (${meta.titulo ?? "caché"})`;
    } else if (["1", "true", "yes", "on"].includes((process.env.GTFS_AUTO_DOWNLOAD ?? "").toLowerCase())) {
      const oficial = await descubrirGtfsOficial(ctx.log);
      if (!oficial) throw new Error("No se pudo descubrir el GTFS oficial");
      await descargarGtfs(oficial.url, cacheZip(), ctx.log);
      escribirMeta({ url: oficial.url, titulo: oficial.titulo });
      this.gtfs = await detectGtfsSource(cacheZip(), ctx.log, bbox);
      fuente = `GTFS oficial (${oficial.titulo})`;
    } else {
      this.gtfs = await detectGtfsSource(this.sampleDir(), ctx.log, bbox);
      fuente = "muestra local (data/sample_gtfs)";
    }

    ctx.state.gtfsFuente = fuente;
    ctx.log(
      `GTFS listo: ${this.gtfs.stops.length} paradas, ${this.gtfs.routes.length} rutas (${fuente})`,
    );
  }

  private sampleDir(): string {
    return fileURLToPath(new URL("../../data/sample_gtfs", import.meta.url));
  }

  private rutasDeStop(idx: number): string[] {
    const boardings = this.gtfs.boardings.get(idx) ?? [];
    const rutas = new Set<string>();
    for (let b = 0; b < boardings.length; b += 2) {
      rutas.add(this.gtfs.tripRoute[boardings[b]]);
    }
    return [...rutas];
  }

  // ---- selección de paradas candidatas ----
  private candidatas(consulta: ConsultaNormalizada, origen: boolean): Candidata[] {
    const punto = origen ? consulta.origenPunto : consulta.destinoPunto;
    const texto = origen ? consulta.origenTexto : consulta.destinoTexto;

    if (!punto) {
      const byName = this.gtfs.stops
        .map((s, i) => ({ s, i }))
        .filter(({ s }) => s.name.toLowerCase().includes(texto.toLowerCase()));
      return byName.map(({ s, i }) => ({
        stop: s,
        idx: i,
        dist: 0,
        rutas: this.rutasDeStop(i),
      }));
    }

    return this.gtfs.stops
      .map((s, i) => ({ s, i, dist: haversine(punto, { lat: s.lat, lon: s.lon }) }))
      .filter((x) => x.dist <= MAX_WALK_M)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, MAX_CANDIDATES)
      .map((x) => ({ stop: x.s, idx: x.i, dist: x.dist, rutas: this.rutasDeStop(x.i) }));
  }

  // ---- enrutamiento (RAPTOR multi-transbordo + k alternativas) ----
  private enrutar(
    origen: Candidata[],
    destino: Candidata[],
    salidaSeg?: number,
  ): OpcionRuta[] {
    const r = this.raptor(origen, destino, salidaSeg);
    const origenByIdx = new Map(origen.map((o) => [o.idx, o]));

    const opciones: OpcionRuta[] = [];
    const claves = new Set<string>();
    for (const d of destino) {
      const labels = r.labels.get(d.idx);
      if (!labels) continue;
      for (const L of labels) {
        const camino = this.reconstruir(d.idx, L);
        if (!camino) continue;
        const o = origenByIdx.get(camino.origenIdx);
        if (!o) continue;
        this.agregarOpcion(r.startSec, L.arr, camino.tramos, o, d, opciones, claves);
      }
    }

    opciones.sort((a, b) => b.puntaje - a.puntaje);
    // Filtro de calidad: descarta rutas mucho peores que la mejor.
    const mejor = opciones[0];
    if (mejor) {
      const techo = mejor.tiempoEstimadoMin * 2 + 30;
      return opciones.filter((x) => x.tiempoEstimadoMin <= techo).slice(0, MAX_ALTERNATIVAS);
    }
    return opciones.slice(0, MAX_ALTERNATIVAS);
  }

  private raptor(
    origen: Candidata[],
    destino: Candidata[],
    salidaSeg?: number,
  ): RaptorResult {
    // Sin hora de salida: se asume "lo antes posible" (primer servicio del día).
    const startSec =
      salidaSeg !== undefined ? salidaSeg : this.tiempoSalida(origen);
    const labels = new Map<number, Label[]>();
    for (const o of origen) {
      labels.set(o.idx, [{ arr: startSec, trip: -1, boardStop: -1, parent: null }]);
    }

    const tope = startSec + MAX_DURACION_SEC;
    let frontier = new Set(origen.map((o) => o.idx));
    const maxViajes = MAX_TRANSBORDOS + 1;

    for (let ronda = 0; ronda < maxViajes; ronda++) {
      if (frontier.size === 0) break;
      const trips = new Set<number>();
      for (const s of frontier) {
        const b = this.gtfs.boardings.get(s);
        if (!b) continue;
        for (let i = 0; i < b.length; i += 2) trips.add(b[i]);
      }
      const nextFrontier = new Set<number>();
      for (const t of trips) {
        this.escaneoViaje(t, labels, nextFrontier, tope);
      }
      frontier = nextFrontier;
    }

    return { startSec, labels };
  }

  // Primer momento en el que se puede abordar un vehículo en las paradas origen.
  private tiempoSalida(origen: Candidata[]): number {
    let t = Infinity;
    for (const o of origen) {
      const b = this.gtfs.boardings.get(o.idx) ?? [];
      for (let i = 0; i < b.length; i += 2) {
        const dep = this.gtfs.seqDep[this.gtfs.tripStart[b[i]] + b[i + 1]];
        if (dep < t) t = dep;
      }
    }
    return t === Infinity ? 0 : t;
  }

  // Ventana global de servicio del feed: desde el primer viaje hasta el último.
  private servicioGlobal(): { start: number; end: number } {
    let start = Infinity;
    let end = -Infinity;
    for (let t = 0; t < this.gtfs.tripsCount; t++) {
      const f = this.gtfs.freq.get(t);
      const base = this.gtfs.tripStart[t];
      const len = this.gtfs.tripStart[t + 1] - base;
      if (len === 0) continue;
      const s = f ? f.start : this.gtfs.seqDep[base];
      const e = f ? f.end : this.gtfs.seqArr[base + len - 1];
      if (s < start) start = s;
      if (e > end) end = e;
    }
    return {
      start: start === Infinity ? 0 : start,
      end: end === -Infinity ? 0 : end,
    };
  }

  // Impacto de los incidentes oficiales por viaje: un viaje está afectado si
  // alguna de sus paradas cae dentro del radio de un incidente activo. Se
  // calculan dos impactos: uno para el desvío (severidad, sin fiabilidad) y otro
  // para la confianza (severidad * fiabilidad).
  private calcularImpactoPorViaje(): void {
    const n = this.gtfs.tripsCount;
    this.tripImpacto = new Array(n).fill(0);
    this.tripImpactoRuta = new Array(n).fill(0);
    if (this.incidentes.activos().length === 0) return;

    const stopImpacto = new Array(this.gtfs.stops.length).fill(0);
    const stopImpactoRuta = new Array(this.gtfs.stops.length).fill(0);
    for (let s = 0; s < this.gtfs.stops.length; s++) {
      const st = this.gtfs.stops[s];
      stopImpacto[s] = this.incidentes.impactoEn(st.lat, st.lon);
      stopImpactoRuta[s] = this.incidentes.impactoDeRutaEn(st.lat, st.lon);
    }
    for (let t = 0; t < n; t++) {
      let m = 0;
      let mr = 0;
      for (let p = this.gtfs.tripStart[t]; p < this.gtfs.tripStart[t + 1]; p++) {
        const si = this.gtfs.seqStop[p];
        if (stopImpacto[si] > m) m = stopImpacto[si];
        if (stopImpactoRuta[si] > mr) mr = stopImpactoRuta[si];
      }
      this.tripImpacto[t] = m;
      this.tripImpactoRuta[t] = mr;
    }
  }

  // Motivos de los incidentes que efectivamente afectaron la búsqueda de esta
  // consulta: un incidente "afecta" si su radio cubre alguna parada de un viaje
  // alcanzable desde el origen. Así, aunque la ruta ganadora desvíe y ya no
  // pase por el corredor afectado, la explicación final puede atribuir la
  // demora/desvío al reporte.
  private motivosDeRuta(): string[] {
    const incidentes = this.incidentes.activos();
    if (incidentes.length === 0 || this.viajesEscaneados.size === 0) return [];
    const motivos: string[] = [];
    for (const inc of incidentes) {
      let afecta = false;
      outer: for (const t of this.viajesEscaneados) {
        for (let p = this.gtfs.tripStart[t]; p < this.gtfs.tripStart[t + 1]; p++) {
          const st = this.gtfs.stops[this.gtfs.seqStop[p]];
          if (haversine({ lat: st.lat, lon: st.lon }, { lat: inc.lat, lon: inc.lon }) <= inc.radioM) {
            afecta = true;
            break outer;
          }
        }
      }
      if (afecta) motivos.push(inc.motivo);
    }
    return motivos;
  }

  // Escaneo de un viaje (núcleo de RAPTOR): recorre las paradas del viaje y
  // relaja la llegada a cada parada posterior al punto de abordaje, agregando
  // una etiqueta por cada ruta distinta que sirve la parada.
  private escaneoViaje(
    t: number,
    labels: Map<number, Label[]>,
    nextFrontier: Set<number>,
    tope: number,
  ): void {
    const base = this.gtfs.tripStart[t];
    const len = this.gtfs.tripStart[t + 1] - base;
    const f = this.gtfs.freq.get(t);
    const routeId = this.gtfs.tripRoute[t];

    this.viajesEscaneados.add(t);

    let bestArr = Infinity;
    let bestBoardStop = -1;
    let bestParent: Label | null = null;
    let bestBoardPos = -1;

    for (let p = 0; p < len; p++) {
      const s = this.gtfs.seqStop[base + p];
      const ls = labels.get(s);
      if (ls) {
        for (const L of ls) {
          let bt: number;
          if (f) {
            const abordaje = Math.max(L.arr, f.start);
            bt = abordaje <= f.end ? abordaje + f.headway / 2 : Infinity;
          } else {
            bt = L.arr <= this.gtfs.seqDep[base + p] ? L.arr : Infinity;
          }
          if (bt < bestArr) {
            bestArr = bt;
            bestBoardStop = s;
            bestParent = L;
            bestBoardPos = p;
          }
        }
      }

      if (bestArr === Infinity) continue;
      const penalidad = (this.tripImpactoRuta[t] ?? 0) * PENALIZACION_MAX_SEG;
      const arr =
        (f
          ? bestArr + (this.gtfs.seqArr[base + p] - this.gtfs.seqDep[base + bestBoardPos])
          : this.gtfs.seqArr[base + p]) + penalidad;
      if (arr > tope) continue;

      const label: Label = { arr, trip: t, boardStop: bestBoardStop, parent: bestParent };
      if (this.upsert(s, label, labels, routeId)) {
        nextFrontier.add(s);
      }
    }
  }

  private upsert(
    stop: number,
    L: Label,
    labels: Map<number, Label[]>,
    routeId: string,
  ): boolean {
    let list = labels.get(stop);
    if (!list) {
      labels.set(stop, [L]);
      return true;
    }
    // dedup por ruta: conserva la mejor llegada de cada ruta en la parada.
    const idx = list.findIndex((x) => this.routeDe(x) === routeId);
    if (idx >= 0) {
      if (L.arr < list[idx].arr) {
        list[idx] = L;
        list.sort((a, b) => a.arr - b.arr);
        return true;
      }
      return false;
    }
    if (list.length < MAX_ALTERNATIVAS) {
      list.push(L);
      list.sort((a, b) => a.arr - b.arr);
      return true;
    }
    if (L.arr < list[list.length - 1].arr) {
      list[list.length - 1] = L;
      list.sort((a, b) => a.arr - b.arr);
      return true;
    }
    return false;
  }

  private routeDe(L: Label): string {
    return L.trip === -1 ? "__origen__" : this.gtfs.tripRoute[L.trip];
  }

  private reconstruir(
    dIdx: number,
    label: Label,
  ): { origenIdx: number; tramos: Tramo[] } | undefined {
    const tramos: Tramo[] = [];
    let cur = dIdx;
    let L: Label | null = label;
    for (let i = 0; i <= MAX_TRANSBORDOS + 1 && L; i++) {
      if (L.trip === -1) break;
      tramos.unshift({ from: L.boardStop, to: cur, trip: L.trip });
      cur = L.boardStop;
      L = L.parent;
    }
    if (tramos.length === 0) return undefined;
    return { origenIdx: cur, tramos };
  }

  private agregarOpcion(
    startSec: number,
    arrSec: number,
    tramos: Tramo[],
    o: Candidata,
    d: Candidata,
    out: OpcionRuta[],
    claves: Set<string>,
  ): void {
    // Descarta rutas que re-abordan el mismo recorrido (artefacto de RAPTOR),
    // usando el nombre corto porque las direcciones de una ruta son route_id
    // distintos pero el usuario las ve como la misma ruta.
    const identidades = tramos.map((tr) => {
      const rid = this.gtfs.tripRoute[tr.trip];
      return this.gtfs.routeById.get(rid)?.shortName || rid;
    });
    if (new Set(identidades).size !== identidades.length) return;

    const etiquetas = tramos.map((tr) => {
      const rid = this.gtfs.tripRoute[tr.trip];
      return routeLabel(this.gtfs.routeById.get(rid), rid);
    });
    const transbordos = tramos.slice(0, -1).map((tr) => this.gtfs.stops[tr.to].name);
    const tipo = tramos.length === 1 ? "directa" : "transbordo";
    const resumen =
      tipo === "directa"
        ? `Directo ${etiquetas[0]} de ${o.stop.name} a ${d.stop.name}`
        : `${etiquetas.join(" → ")} (transbordo${transbordos.length > 1 ? "s" : ""} en ${transbordos.join(", ")})`;
    if (claves.has(resumen)) return;
    claves.add(resumen);

    const viajeMin = (arrSec - startSec) / 60;
    const caminata = Math.round(o.dist + d.dist);
    const tiempoTotal = viajeMin + caminata / WALK_SPEED_MS / 60;
    // Tiempo efectivo: se penaliza cada transbordo en minutos (sin bonus fijo),
    // de modo que una ruta directa muy lenta no desplace a una más rápida con
    // un solo transbordo.
    const tiempoEfectivo = tiempoTotal + (tramos.length - 1) * PENALIZACION_TRANSBORDO_MIN;

    const pasos: string[] = [`Caminar a ${o.stop.name} (~${Math.round(o.dist)} m)`];
    tramos.forEach((tr, i) => {
      const rid = this.gtfs.tripRoute[tr.trip];
      const etq = routeLabel(this.gtfs.routeById.get(rid), rid);
      const toName = this.gtfs.stops[tr.to].name;
      pasos.push(`Tomar ${etq} hasta ${toName}`);
      if (i < tramos.length - 1) pasos.push(`Transbordar en ${toName}`);
    });
    pasos.push(`Bajar en ${d.stop.name} y caminar ~${Math.round(d.dist)} m`);

    let maxImpacto = 0;
    for (const tr of tramos) {
      const imp = this.tripImpacto[tr.trip] ?? 0;
      if (imp > maxImpacto) maxImpacto = imp;
    }
    const confianza = maxImpacto > 0 ? Math.max(0, 1 - maxImpacto) : 1;

    out.push({
      tipo,
      resumen,
      paradaOrigen: o.stop.name,
      paradaDestino: d.stop.name,
      pasos,
      rutasUsadas: etiquetas,
      tiempoEstimadoMin: Math.max(1, Math.round(tiempoTotal)),
      caminataMts: caminata,
      puntaje: (1000 / (1 + tiempoEfectivo)) * confianza,
      fuente: "oficial",
      confianza,
    });
  }
}
