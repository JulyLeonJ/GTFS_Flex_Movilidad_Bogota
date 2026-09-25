import { haversine } from "./util.js";
import { IncidentesService, ZONAS_OFICIALES, VIDA_MEDIA_SEG } from "./incidentes.js";
import { InformalService, distanciaPuntoASegmento } from "./informal.js";
import { lambdaDelSegmento, type SegmentoInformal } from "./flex.js";
import type { Coord, OpcionRuta, Punto } from "./types.js";

// Nivel de trancamiento por zona (noisy-OR sobre los reportes negativos, con
// alivio por reportes de fluidez). Es la misma señal para dos usos: pintar el
// mapa (aGeoJson) y la exclusión "dura" de rutas que la cruzan (CongestionAgent);
// el desvío "suave" por severidad ya ocurre dentro del RAPTOR (impactoDeRutaEn).

export interface ZonaCongestion {
  id: string;
  nombre: string;
  tipo: "zona_oficial" | "punto" | "tramo_informal";
  nivel: number; // 0..1
  reportes: number;
  verificados: number;
  motivos: string[];
  geometria: { type: "Polygon"; coordinates: Coord[][] } | { type: "LineString"; coordinates: Coord[] };
  // Para el cruce con opciones (no se serializa):
  centro: Punto;
  radioM?: number; // zonas oficiales y puntos
  segmento?: SegmentoInformal; // tramos informales
}

export const NIVEL_MIN_VISIBLE = 0.05;
const P_MIN = 0.01; // contribución mínima para contar un reporte como activo
const PESO_VERIFICADO = 0.7; // validador_comunitario / conductor_red
const RADIO_TRAMO_M = 100; // distancia a un corredor/zona Flex para "cruzarlo"

export function umbralCongestion(): number {
  const v = Number(process.env.CONGESTION_UMBRAL);
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.5;
}

export function circulo(c: Punto, radioM: number, n = 48): Coord[] {
  const dLat = radioM / 111_320;
  const dLon = dLat / Math.cos((c.lat * Math.PI) / 180);
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = (2 * Math.PI * (i % n)) / n; // i = n cierra el anillo en el punto 0
    return [c.lon + dLon * Math.cos(a), c.lat + dLat * Math.sin(a)] as Coord;
  });
}

export function calcularCongestion(
  incidentes: IncidentesService,
  informal: InformalService,
  ahora: number = Date.now(),
): ZonaCongestion[] {
  const zonas = new Map<string, ZonaCongestion>();

  const porZona = new Map<string, { motivo: string; lat: number; lon: number; radioM: number; severidad: number; peso: number; timestamp: number }[]>();
  for (const inc of incidentes.activos(ahora)) {
    const arr = porZona.get(inc.zonaId) ?? [];
    arr.push(inc);
    porZona.set(inc.zonaId, arr);
  }
  for (const [zonaId, incs] of porZona) {
    let libre = 1;
    let reportes = 0;
    let verificados = 0;
    const motivos = new Set<string>();
    for (const inc of incs) {
      const edadSeg = (ahora - inc.timestamp) / 1000;
      const p = inc.severidad * inc.peso * Math.exp(-(Math.LN2 / VIDA_MEDIA_SEG) * edadSeg);
      if (p < P_MIN) continue;
      libre *= 1 - p;
      reportes++;
      if (inc.peso >= PESO_VERIFICADO) verificados++;
      if (motivos.size < 5) motivos.add(inc.motivo);
    }
    if (reportes === 0) continue;
    const primero = incs[0];
    const esPunto = zonaId.startsWith("punto:");
    const centro: Punto = { lat: primero.lat, lon: primero.lon };
    zonas.set(zonaId, {
      id: zonaId,
      nombre: esPunto ? zonaId.slice(6) : ZONAS_OFICIALES.find((z) => z.id === zonaId)?.nombre ?? zonaId,
      tipo: esPunto ? "punto" : "zona_oficial",
      nivel: Math.round((1 - libre) * 100) / 100,
      reportes,
      verificados,
      motivos: [...motivos],
      geometria: { type: "Polygon", coordinates: [circulo(centro, primero.radioM)] },
      centro,
      radioM: primero.radioM,
    });
  }

  for (const seg of informal.segmentos()) {
    const lambda = lambdaDelSegmento(seg);
    let libre = 1;
    let alivio = 1;
    let reportes = 0;
    let verificados = 0;
    const motivos = new Set<string>();
    for (const r of informal.reportesDe(seg.id, ahora)) {
      const decay = Math.exp(-lambda * ((ahora - r.timestamp) / 1000));
      if (r.valor < 0) {
        const p = Math.min(1, Math.abs(r.valor) / 2) * r.peso * decay;
        if (p < P_MIN) continue;
        libre *= 1 - p;
        reportes++;
        if (r.peso >= PESO_VERIFICADO) verificados++;
        if (r.texto && motivos.size < 5) motivos.add(r.texto.slice(0, 80));
      } else if (r.valor > 0) {
        alivio *= 1 - 0.5 * r.peso * decay;
      }
    }
    if (reportes === 0) continue;
    const geometria =
      seg.geometria.type === "LineString"
        ? { type: "LineString" as const, coordinates: seg.geometria.coordinates as Coord[] }
        : seg.geometria.type === "Polygon"
          ? { type: "Polygon" as const, coordinates: seg.geometria.coordinates as Coord[][] }
          : { type: "Polygon" as const, coordinates: [circulo(seg.centroide, 150)] };
    zonas.set(`flex:${seg.id}`, {
      id: `flex:${seg.id}`,
      nombre: seg.nombre,
      tipo: "tramo_informal",
      nivel: Math.round((1 - libre) * alivio * 100) / 100,
      reportes,
      verificados,
      motivos: [...motivos],
      geometria,
      centro: seg.centroide,
      segmento: seg,
    });
  }

  return [...zonas.values()].filter((z) => z.nivel >= NIVEL_MIN_VISIBLE).sort((a, b) => b.nivel - a.nivel);
}

function densificar(coords: Coord[]): Coord[] {
  const out: Coord[] = [];
  for (let i = 0; i < coords.length; i++) {
    out.push(coords[i]);
    if (i === coords.length - 1) break;
    const [lonA, latA] = coords[i];
    const [lonB, latB] = coords[i + 1];
    const pasos = Math.floor(haversine({ lat: latA, lon: lonA }, { lat: latB, lon: lonB }) / 100);
    for (let s = 1; s <= pasos; s++) {
      const t = s / (pasos + 1);
      out.push([lonA + (lonB - lonA) * t, latA + (latB - latA) * t]);
    }
  }
  return out;
}

export function congestionDeOpcion(
  o: OpcionRuta,
  zonas: ZonaCongestion[],
): { nivel: number; zonas: ZonaCongestion[] } {
  if (!o.tramos || o.tramos.length === 0) return { nivel: 0, zonas: [] };

  const puntos: Coord[] = [];
  for (const tr of o.tramos) {
    if (tr.modo === "caminata") continue;
    puntos.push(...densificar(tr.coords));
  }

  const cruzadas = new Map<string, ZonaCongestion>();
  for (const [lon, lat] of puntos) {
    const punto: Punto = { lat, lon };
    for (const z of zonas) {
      if (cruzadas.has(z.id)) continue;
      const cruza =
        z.radioM !== undefined
          ? haversine(punto, z.centro) <= z.radioM
          : z.segmento !== undefined && distanciaPuntoASegmento(punto, z.segmento) <= RADIO_TRAMO_M;
      if (cruza) cruzadas.set(z.id, z);
    }
  }

  const cruzadasArr = [...cruzadas.values()];
  return { nivel: cruzadasArr.reduce((m, z) => Math.max(m, z.nivel), 0), zonas: cruzadasArr };
}

export function aGeoJson(zonas: ZonaCongestion[]) {
  return {
    type: "FeatureCollection" as const,
    features: zonas.map((z) => ({
      type: "Feature" as const,
      properties: {
        id: z.id,
        nombre: z.nombre,
        tipo: z.tipo,
        nivel: z.nivel,
        reportes: z.reportes,
        verificados: z.verificados,
        motivos: z.motivos,
      },
      geometry: z.geometria,
    })),
  };
}
