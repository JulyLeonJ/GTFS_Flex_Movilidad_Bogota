import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { haversine } from "./util.js";
import { lambdaDesdeVidaMedia } from "./confianza.js";

// Soporte GTFS-Flex: modela paradas continuas (corredores viales permeables) y
// agrupaciones espaciales (zonas poligonales) para transporte informal/veredal.
// Fuentes: locations.geojson (geometrías) y location_groups.txt (pertenencia).

export type TipoSegmento = "continua" | "grupo";

type Pos = [number, number]; // [lon, lat]

type Geometry =
  | { type: "LineString"; coordinates: Pos[] }
  | { type: "Polygon"; coordinates: Pos[][] }
  | { type: "Point"; coordinates: Pos };

interface FlexFeature {
  type: string;
  id?: string;
  properties?: Record<string, unknown>;
  geometry: Geometry;
}

interface FlexCollection {
  type: string;
  features: FlexFeature[];
}

export interface SegmentoInformal {
  id: string;
  nombre: string;
  tipo: TipoSegmento;
  geometria: Geometry;
  cBase: number;
  vidaMediaSeg: number;
  centroide: { lat: number; lon: number };
}

export interface Vecino {
  id: string;
  distanciaMts: number;
}

const VIDA_MEDIA_DEFECTO_SEG = 15 * 60; // 15 minutos
const C_BASE_DEFECTO = 0.4;
const RADIO_VECINOS_M = 900;

export function parseFlex(dir: string): SegmentoInformal[] {
  const geoPath = join(dir, "locations.geojson");
  if (!existsSync(geoPath)) {
    throw new Error(`No existe locations.geojson en ${dir}`);
  }
  const geo = JSON.parse(readFileSync(geoPath, "utf-8")) as FlexCollection;

  const segmentos: SegmentoInformal[] = geo.features
    .filter((f) => f.geometry && (f.geometry.type === "LineString" || f.geometry.type === "Polygon" || f.geometry.type === "Point"))
    .map((f) => {
      const props = f.properties ?? {};
      const tipo: TipoSegmento =
        props.location_type === "location_group"
          ? "grupo"
          : props.location_type === "continuous_stop"
            ? "continua"
            : "continua";
      const vidaMediaSeg =
        typeof props.vida_media_min === "number"
          ? props.vida_media_min * 60
          : VIDA_MEDIA_DEFECTO_SEG;
      const cBase = typeof props.c_base === "number" ? props.c_base : C_BASE_DEFECTO;
      const centroide = calcularCentroide(f.geometry);
      return {
        id: f.id ?? String(props.id ?? props.name),
        nombre: String(props.name ?? f.id ?? "segmento"),
        tipo,
        geometria: f.geometry,
        cBase,
        vidaMediaSeg,
        centroide,
      };
    });

  return segmentos;
}

export function calcularVecinos(
  segmentos: SegmentoInformal[],
  radioMts: number = RADIO_VECINOS_M,
): Map<string, Vecino[]> {
  const out = new Map<string, Vecino[]>();
  for (const a of segmentos) {
    const vecinos: Vecino[] = [];
    for (const b of segmentos) {
      if (a.id === b.id) continue;
      const d = haversine(a.centroide, b.centroide);
      if (d <= radioMts) vecinos.push({ id: b.id, distanciaMts: d });
    }
    vecinos.sort((x, y) => x.distanciaMts - y.distanciaMts);
    out.set(a.id, vecinos);
  }
  return out;
}

export function lambdaDelSegmento(s: SegmentoInformal): number {
  return lambdaDesdeVidaMedia(s.vidaMediaSeg);
}

function calcularCentroide(g: Geometry): { lat: number; lon: number } {
  if (g.type === "Point") {
    return { lon: g.coordinates[0], lat: g.coordinates[1] };
  }
  const pts: Pos[] =
    g.type === "LineString"
      ? g.coordinates
      : g.coordinates[0]; // Polygon: anillo exterior
  const lon = pts.reduce((a, p) => a + p[0], 0) / pts.length;
  const lat = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  return { lon, lat };
}

export function cargarGrupos(dir: string): Map<string, string[]> {
  // location_groups.txt: location_group_id, stop_id[, nombre]
  const p = join(dir, "location_groups.txt");
  const map = new Map<string, string[]>();
  if (!existsSync(p)) return map;
  const lineas = readFileSync(p, "utf-8").split("\n").slice(1);
  for (const l of lineas) {
    const cols = l.split(",");
    if (cols.length < 2) continue;
    const grupo = cols[0].trim();
    const stop = cols[1].trim();
    if (!grupo || !stop) continue;
    const arr = map.get(grupo) ?? [];
    arr.push(stop);
    map.set(grupo, arr);
  }
  return map;
}
