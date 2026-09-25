import { haversine } from "./util.js";
import { normalizar } from "./relevancia.js";
import { REPUTACIONES_DEFECTO } from "./agents/ingesta.js";

// Incidentes sobre la red OFICIAL (SITP/TransMilenio). Un reporte negativo de
// vía ("accidente en Casalinda", "bloqueo en la Boyacá") se geolocaliza contra
// una zona oficial y penaliza los viajes que circulan cerca, para que el RAPTOR
// desvíe hacia corredores alternativos. A diferencia del transporte informal,
// aquí no se inventan colectivos: el incidente afecta las rutas oficiales reales.

export interface ZonaOficial {
  id: string;
  nombre: string;
  alias: string[]; // nombres normalizados que identifican la zona
  lat: number;
  lon: number;
  radioM: number;
}

export const ZONAS_OFICIALES: ZonaOficial[] = [
  {
    id: "av-villavicencio",
    nombre: "Avenida Villavicencio",
    alias: [
      "av villavicencio",
      "avenida villavicencio",
      "villavicencio",
      "casalinda",
      "casa linda",
      "calle 68 sur",
      "av v/cio",
      "v/cio",
    ],
    lat: 4.5696,
    lon: -74.1437,
    radioM: 1000,
  },
  {
    id: "av-boyaca",
    nombre: "Avenida Boyacá",
    alias: ["av boyaca", "avenida boyaca", "boyaca"],
    lat: 4.574,
    lon: -74.179,
    radioM: 800,
  },
];

export interface IncidenteOficial {
  zonaId: string;
  motivo: string; // "accidente en Avenida Villavicencio"
  lat: number;
  lon: number;
  radioM: number;
  severidad: number; // 0..1
  peso: number; // reputación de la fuente 0..1
  timestamp: number;
}

const VIDA_MEDIA_SEG = 30 * 60; // el incidente "sana" a los ~30 min sin reportes

const NEGATIVO_FUERTE = [
  "bloqueo",
  "accidente",
  "cerrado",
  "cierre",
  "derrumb",
  "caida de arbol",
  "arbol caido",
  "derrumbado",
];
const NEGATIVO = [
  "trancon",
  "demora",
  "demorado",
  "lento",
  "parado",
  "no pasa",
  "desvio",
  "restringido",
];

export function identificarZona(texto: string): ZonaOficial | null {
  const t = normalizar(texto);
  for (const z of ZONAS_OFICIALES) {
    if (z.alias.some((a) => t.includes(normalizar(a)))) return z;
  }
  return null;
}

// Descripción corta del tipo de incidente a partir del reporte.
function descripcion(texto: string): string {
  const t = normalizar(texto);
  if (/accidente/.test(t)) return "accidente";
  if (/bloqueo/.test(t)) return "bloqueo";
  if (/derrumb|caida de arbol|arbol caido/.test(t)) return "derrumbe";
  if (/cierre|cerrado/.test(t)) return "cierre";
  if (/trancon|demora|lento|parado/.test(t)) return "tráfico lento";
  return "incidente de vía";
}

export class IncidentesService {
  private incidentes: IncidenteOficial[] = [];

  registrar(inc: IncidenteOficial): void {
    this.incidentes.push(inc);
  }

  // Si el texto es un reporte negativo sobre una zona oficial, registra el
  // incidente y lo devuelve; si no, devuelve null.
  registrarDeReporte(
    texto: string,
    fuente: string,
    timestamp = Date.now(),
  ): IncidenteOficial | null {
    const severidad = this.severidad(texto);
    if (severidad === 0) return null;
    const zona = identificarZona(texto);
    if (!zona) return null;
    const peso = REPUTACIONES_DEFECTO.find((r) => r.id === fuente)?.peso ?? 0.2;
    const inc: IncidenteOficial = {
      zonaId: zona.id,
      motivo: `${descripcion(texto)} en ${zona.nombre}`,
      lat: zona.lat,
      lon: zona.lon,
      radioM: zona.radioM,
      severidad,
      peso,
      timestamp,
    };
    this.registrar(inc);
    return inc;
  }

  severidad(texto: string): number {
    const t = normalizar(texto);
    if (NEGATIVO_FUERTE.some((k) => t.includes(k))) return 1;
    if (NEGATIVO.some((k) => t.includes(k))) return 0.6;
    return 0;
  }

  activos(): IncidenteOficial[] {
    return this.incidentes;
  }

  // Impacto agregado (0..1) de los incidentes activos sobre un punto.
  impactoEn(lat: number, lon: number, ahora = Date.now()): number {
    let impacto = 0;
    for (const inc of this.incidentes) {
      const d = haversine({ lat, lon }, { lat: inc.lat, lon: inc.lon });
      if (d > inc.radioM) continue;
      const edadSeg = (ahora - inc.timestamp) / 1000;
      const decaimiento = Math.exp(-(Math.log(2) / VIDA_MEDIA_SEG) * edadSeg);
      const espacial = 1 - d / inc.radioM;
      impacto = Math.max(impacto, inc.severidad * inc.peso * decaimiento * espacial);
    }
    return Math.min(1, impacto);
  }
}
