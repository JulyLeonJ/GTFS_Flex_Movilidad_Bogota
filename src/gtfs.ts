import { readFileSync, existsSync, statSync, createReadStream } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import AdmZip from "adm-zip";
import { haversine } from "./util.js";
import type { Coord, Punto, Subsistema } from "./types.js";

// Modelo y cargador GTFS optimizado para feeds grandes (SITP real, ~5.7M filas).
// - Filtrado espacial por bbox (para acotar la búsqueda a una localidad).
// - Viajes basados en frecuencias (TransMiCable).
// - Lectura en streaming de stop_times.txt (no carga el archivo completo en RAM).

export interface GtfsStop {
  id: string;
  name: string;
  lat: number;
  lon: number;
}

export interface GtfsRoute {
  id: string;
  shortName: string;
  longName: string;
  routeType: number;
  color?: string;
  agencyId?: string;
  subsistema?: Subsistema;
}

export interface Bbox {
  sur: number;
  oeste: number;
  norte: number;
  este: number;
}

export interface Frecuencia {
  start: number; // inicio del servicio en segundos desde medianoche
  end: number; // fin del servicio en segundos desde medianoche
  headway: number; // intervalo en segundos
}

export interface Gtfs {
  stops: GtfsStop[];
  routes: GtfsRoute[];
  routeById: Map<string, GtfsRoute>;
  stopById: Map<string, GtfsStop>;
  stopIndex: Map<string, number>;
  tripRoute: string[]; // trip -> route_id
  tripStart: number[]; // trip -> offset inicial (longitud nTrips+1)
  seqStop: number[];
  seqArr: number[];
  seqDep: number[];
  boardings: Map<number, number[]>; // stopIdx -> [trip, pos, ...]
  freq: Map<number, Frecuencia>; // trip -> frecuencia (si aplica)
  tripsCount: number;
  tripShape: string[]; // trip -> shape_id ("" si no tiene)
  shapes: Map<string, number[]>; // shape_id -> [lon0, lat0, lon1, lat1, …]
}

type Log = (msg: string) => void;

// ---- Bbox por defecto: Ciudad Bolívar (límites oficiales de IDECA) ----
export const BBOX_CIUDAD_BOLIVAR: Bbox = {
  sur: 4.383662,
  oeste: -74.21308,
  norte: 4.599759,
  este: -74.120422,
};

export function bboxPorDefecto(): Bbox | undefined {
  const raw = process.env.GTFS_BBOX?.trim();
  if (!raw) return BBOX_CIUDAD_BOLIVAR;
  if (/^(none|off|false|0)$/i.test(raw)) return undefined;
  const [sur, oeste, norte, este] = raw.split(",").map(Number);
  if ([sur, oeste, norte, este].some((x) => !Number.isFinite(x))) {
    throw new Error(`GTFS_BBOX inválido: ${raw}`);
  }
  return { sur, oeste, norte, este };
}

function enBbox(bbox: Bbox | undefined, lat: number, lon: number): boolean {
  if (!bbox) return true;
  return lat >= bbox.sur && lat <= bbox.norte && lon >= bbox.oeste && lon <= bbox.este;
}

// Área del MVP (Ciudad Bolívar). Es el mismo bbox que filtra el GTFS, para que
// "lo que conoce el sistema" y "lo que se acepta en una consulta" coincidan.
// undefined = sin restricción (GTFS_BBOX=none, solo desarrollo).
export function areaMvp(): { nombre: string; bbox: Bbox } | undefined {
  const bbox = bboxPorDefecto();
  // ponytail: nombre fijo; MVP de una sola localidad.
  return bbox ? { nombre: "Ciudad Bolívar", bbox } : undefined;
}

export function enArea(p: { lat: number; lon: number }): boolean {
  return enBbox(bboxPorDefecto(), p.lat, p.lon);
}

function subsistemaDe(agencyName: string, routeType: number): Subsistema | undefined {
  const n = agencyName.toLowerCase();
  if (routeType === 6 || n.includes("cable")) return "cable";
  if (n.includes("troncal")) return "troncal";
  if (n.includes("alimentador")) return "alimentador";
  if (n.includes("dual")) return "dual";
  if (n.includes("zonal")) return "zonal";
  return undefined;
}

// Recorta un shape entre la parada de abordaje (a) y la de bajada (b).
// Busca el vértice más cercano a `a` y luego el más cercano a `b` SOLO hacia
// adelante (los shapes de ida y vuelta/circulares pasan dos veces cerca de la
// misma parada). Devuelve null si alguna parada queda a más de TOLERANCIA_SHAPE_M
// del shape (shape y paradas no corresponden): el llamador cae a "paradas".
const TOLERANCIA_SHAPE_M = 150;
export function cortarShape(shape: number[], a: Punto, b: Punto): Coord[] | null {
  const n = shape.length / 2;
  const vertice = (i: number): Punto => ({ lat: shape[i * 2 + 1], lon: shape[i * 2] });

  let ia = 0;
  let dA = Infinity;
  for (let i = 0; i < n; i++) {
    const d = haversine(a, vertice(i));
    if (d < dA) { dA = d; ia = i; }
  }
  if (dA > TOLERANCIA_SHAPE_M) return null;

  let ib = ia;
  let dB = Infinity;
  for (let i = ia; i < n; i++) {
    const d = haversine(b, vertice(i));
    if (d < dB) { dB = d; ib = i; }
  }
  if (dB > TOLERANCIA_SHAPE_M || ib <= ia) return null;

  const coords: Coord[] = [[a.lon, a.lat]];
  for (let i = ia; i <= ib; i++) coords.push([shape[i * 2], shape[i * 2 + 1]]);
  coords.push([b.lon, b.lat]);
  return coords;
}

// ---- CSV genérico (solo archivos pequeños) ----
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 0 && !(r.length === 1 && r[0] === ""));
}

function toRecords(rows: string[][]): Record<string, string>[] {
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const rec: Record<string, string> = {};
    header.forEach((h, i) => {
      rec[h] = r[i] ?? "";
    });
    return rec;
  });
}

function timeToSec(t: string): number {
  const p = t.split(":");
  return (+p[0]) * 3600 + (+p[1]) * 60 + (+p[2]);
}

async function forEachLine(path: string, cb: (line: string) => void): Promise<void> {
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) cb(line);
}

interface FuenteGtfs {
  readText(name: string): string;
  readLines(name: string, cb: (line: string) => void): Promise<void>;
}

// ---- Cargadores ----
export async function loadGtfsFromDir(
  dir: string,
  log: Log = () => {},
  bbox?: Bbox,
): Promise<Gtfs> {
  const readText = (f: string) => {
    const p = join(dir, f);
    return existsSync(p) ? readFileSync(p, "utf-8") : "";
  };
  const readLines = async (name: string, cb: (line: string) => void) => {
    const p = join(dir, name);
    if (!existsSync(p)) return;
    await forEachLine(p, cb);
  };
  return buildGtfs({ readText, readLines }, log, bbox);
}

export async function loadGtfsFromZip(
  zipPath: string,
  log: Log = () => {},
  bbox?: Bbox,
): Promise<Gtfs> {
  const zip = new AdmZip(zipPath);
  const readText = (f: string) => {
    const entry = findEntry(zip, f);
    return entry ? entry.getData().toString("utf-8") : "";
  };
  const readLines = async (name: string, cb: (line: string) => void) => {
    const entry = findEntry(zip, name);
    if (!entry) return;
    const tmp = mkdtempSync(join(tmpdir(), "gtfs-"));
    zip.extractEntryTo(entry, tmp, false, true, false, name);
    await forEachLine(join(tmp, name), cb);
  };
  return buildGtfs({ readText, readLines }, log, bbox);
}

function findEntry(zip: AdmZip, filename: string) {
  const lower = filename.toLowerCase();
  for (const entry of zip.getEntries()) {
    const name = entry.entryName.toLowerCase();
    if (name === lower || name.endsWith("/" + lower)) return entry;
  }
  return undefined;
}

async function buildGtfs(
  fuente: FuenteGtfs,
  log: Log,
  bbox?: Bbox,
): Promise<Gtfs> {
  // stops: filtrados por bbox
  const stops = toRecords(parseCsv(fuente.readText("stops.txt")))
    .map((r) => ({
      id: r.stop_id,
      name: r.stop_name,
      lat: Number(r.stop_lat),
      lon: Number(r.stop_lon),
    }))
    .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon))
    .filter((s) => enBbox(bbox, s.lat, s.lon));
  if (stops.length === 0) throw new Error("Feed GTFS sin stops (¿bbox muy pequeño?)");

  const stopIndex = new Map<string, number>();
  stops.forEach((s, i) => stopIndex.set(s.id, i));

  const agencyNombrePorId = new Map<string, string>();
  for (const a of toRecords(parseCsv(fuente.readText("agency.txt")))) {
    agencyNombrePorId.set(a.agency_id, a.agency_name);
  }

  const routes = toRecords(parseCsv(fuente.readText("routes.txt"))).map((r) => {
    const agencyId = r.agency_id || undefined;
    const agencyName = agencyId ? agencyNombrePorId.get(agencyId) ?? "" : "";
    const routeType = Number(r.route_type ?? 3);
    return {
      id: r.route_id,
      shortName: r.route_short_name,
      longName: r.route_long_name,
      routeType,
      color: r.route_color || undefined,
      agencyId,
      subsistema: subsistemaDe(agencyName, routeType),
    };
  });

  // trips: trip_id -> route_id / shape_id
  const routePorTrip = new Map<string, string>();
  const shapePorTrip = new Map<string, string>();
  for (const t of toRecords(parseCsv(fuente.readText("trips.txt")))) {
    routePorTrip.set(t.trip_id, t.route_id);
    shapePorTrip.set(t.trip_id, t.shape_id ?? "");
  }
  if (routePorTrip.size === 0) throw new Error("Feed GTFS sin trips.txt");

  // frecuencias: trip_id -> { end, headway }
  const freqPorTripId = new Map<string, Frecuencia>();
  for (const f of toRecords(parseCsv(fuente.readText("frequencies.txt")))) {
    freqPorTripId.set(f.trip_id, {
      start: timeToSec(f.start_time || "00:00:00"),
      end: timeToSec(f.end_time),
      headway: Number(f.headway_secs) || 0,
    });
  }

  // stop_times (streaming) con índice de viajes asignado bajo demanda.
  const tripIndexById = new Map<string, number>();
  const tripRoute: string[] = [];
  const tripShape: string[] = [];
  const freq: Map<number, Frecuencia> = new Map();
  const perTrip: number[][] = [];

  let esCabecera = true;
  await fuente.readLines("stop_times.txt", (line) => {
    if (esCabecera) {
      esCabecera = false;
      return;
    }
    const parts = line.split(",");
    const tripId = parts[0];
    const stopId = parts[3];
    if (!tripId || !stopId) return;

    const si = stopIndex.get(stopId);
    if (si === undefined) return;
    const routeId = routePorTrip.get(tripId);
    if (routeId === undefined) return;

    let ti = tripIndexById.get(tripId);
    if (ti === undefined) {
      ti = tripRoute.length;
      tripIndexById.set(tripId, ti);
      tripRoute.push(routeId);
      tripShape.push(shapePorTrip.get(tripId) ?? "");
      const f = freqPorTripId.get(tripId);
      if (f) freq.set(ti, f);
      perTrip.push([]);
    }

    perTrip[ti].push(Number(parts[4]), si, timeToSec(parts[1]), timeToSec(parts[2]));
  });
  if (tripRoute.length === 0) throw new Error("Feed GTFS sin stop_times.txt (o bbox sin cobertura)");

  const nTrips = tripRoute.length;
  const tripStart: number[] = new Array(nTrips + 1);
  const seqStop: number[] = [];
  const seqArr: number[] = [];
  const seqDep: number[] = [];
  const boardings = new Map<number, number[]>();
  for (let t = 0; t < nTrips; t++) {
    tripStart[t] = seqStop.length;
    const row = perTrip[t];
    // El feed oficial no agrupa stop_times por viaje: el orden real es stop_sequence.
    const orden = Array.from({ length: row.length / 4 }, (_, k) => k * 4).sort((a, b) => row[a] - row[b]);
    orden.forEach((i, pos) => {
      seqStop.push(row[i + 1]);
      seqArr.push(row[i + 2]);
      seqDep.push(row[i + 3]);
      const list = boardings.get(row[i + 1]);
      if (list) list.push(t, pos);
      else boardings.set(row[i + 1], [t, pos]);
    });
    perTrip[t] = [];
  }
  tripStart[nTrips] = seqStop.length;

  // shapes.txt: solo los referenciados por viajes que sobrevivieron al bbox.
  const usados = new Set(tripShape.filter(Boolean));
  const shapes = new Map<string, number[]>();
  if (usados.size > 0) {
    const tmp = new Map<string, [number, number, number][]>(); // id -> [seq, lon, lat]
    let idx: Record<string, number> | null = null;
    await fuente.readLines("shapes.txt", (line) => {
      const p = line.split(",");
      if (!idx) {
        idx = Object.fromEntries(p.map((h, i) => [h.trim(), i]));
        return;
      }
      const id = p[idx.shape_id];
      if (!usados.has(id)) return;
      const arr = tmp.get(id) ?? [];
      arr.push([Number(p[idx.shape_pt_sequence]), Number(p[idx.shape_pt_lon]), Number(p[idx.shape_pt_lat])]);
      tmp.set(id, arr);
    });
    for (const [id, pts] of tmp) {
      pts.sort((a, b) => a[0] - b[0]);
      shapes.set(id, pts.flatMap(([, lon, lat]) => [lon, lat]));
    }
  }

  log(
    `GTFS: ${stops.length} paradas, ${routes.length} rutas, ${nTrips} viajes, ${seqStop.length} paradas-viaje, ${shapes.size} shapes` +
      (bbox ? " (bbox aplicado)" : ""),
  );

  return {
    stops,
    routes,
    routeById: new Map(routes.map((r) => [r.id, r])),
    stopById: new Map(stops.map((s) => [s.id, s])),
    stopIndex,
    tripRoute,
    tripStart,
    seqStop,
    seqArr,
    seqDep,
    boardings,
    freq,
    tripsCount: nTrips,
    tripShape,
    shapes,
  };
}

export async function detectGtfsSource(
  path: string,
  log: Log = () => {},
  bbox?: Bbox,
): Promise<Gtfs> {
  if (!existsSync(path)) throw new Error(`No existe la fuente GTFS: ${path}`);
  if (statSync(path).isDirectory()) return loadGtfsFromDir(path, log, bbox);
  return loadGtfsFromZip(path, log, bbox);
}
