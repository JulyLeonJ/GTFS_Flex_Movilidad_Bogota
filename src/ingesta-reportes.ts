import type { InformalService } from "./informal.js";
import type { IncidentesService } from "./incidentes.js";
import { geocodificar } from "./geocode.js";
import { generarTexto, hayLlm } from "./llm.js";
import { pesoDeFuente } from "./agents/ingesta.js";
import { normalizar } from "./relevancia.js";
import {
  INCIDENTE_FUERTE,
  AFECTACION,
  FLUIDEZ,
} from "./vocabulario.js";

// Ingesta de reportes con geolocalización. Recibe el texto de un reporte y lo
// ingiere donde corresponda, en este orden:
//   1. Tramo informal (GTFS-Flex) → afecta la confianza C(t) del tramo.
//   2. Zona oficial predefinida (Avenida Villavicencio / Boyacá) → penaliza viajes.
//   3. Geolocalización por punto (geocoder IDECA/Nominatim) → penaliza viajes
//      cerca de ese punto, aunque el lugar no esté en una zona/tramo predefinido.
// Devuelve un resumen listo para persistir en el CSV de reportes.

export interface IngestaReporte {
  segmento: string; // objetivo mapeado: tramo informal, zona oficial o "punto:nombre"
  valor: number; // polaridad V_i
  fiabilidad: number; // peso/resolución de la fuente
  lat?: number; // coordenadas si se geolocalizó a un punto
  lon?: number;
  mapeado: boolean;
}

type Log = (m: string) => void;

const RADIO_PUNTO_M = 500; // radio de afección de un incidente geolocalizado

export async function ingestarReporte(
  texto: string,
  fuente: string,
  informal: InformalService,
  incidentes: IncidentesService,
  timestamp: number = Date.now(),
  log: Log = () => {},
  coords?: { lat: number; lon: number; nombre: string },
): Promise<IngestaReporte> {
  // 1. Tramo informal.
  const reporte = informal.ingestaDeTexto(texto, fuente, timestamp);

  // 2. Zona oficial.
  const incidente = incidentes.registrarDeReporte(texto, fuente, timestamp);

  const valor = reporte?.valor ?? informal.polaridad(texto);
  const fiabilidad = reporte?.peso ?? incidente?.peso ?? pesoDeFuente(fuente);

  if (reporte) {
    return {
      segmento: reporte.segmento,
      valor,
      fiabilidad,
      mapeado: true,
    };
  }
  if (incidente) {
    return {
      segmento: incidente.zonaId,
      valor,
      fiabilidad,
      mapeado: true,
    };
  }

  // 3. Geolocalización por punto (solo reportes negativos).
  if (incidentes.severidad(texto) === 0) {
    return { segmento: "", valor, fiabilidad, mapeado: false };
  }

  const punto =
    coords ??
    (await localizarPunto(texto, log));

  if (punto) {
    incidentes.registrarPunto({
      nombre: punto.nombre,
      lat: punto.lat,
      lon: punto.lon,
      radioM: RADIO_PUNTO_M,
      severidad: incidentes.severidad(texto),
      peso: fiabilidad,
      timestamp,
      texto,
    });
    return {
      segmento: `punto:${punto.nombre}`,
      valor,
      fiabilidad,
      lat: punto.lat,
      lon: punto.lon,
      mapeado: true,
    };
  }

  return { segmento: "", valor, fiabilidad, mapeado: false };
}

// Extrae una ubicación del reporte y la geocodifica. Primero intenta con el LLM
// (si está disponible); si no, con una limpieza determinista del texto.
async function localizarPunto(
  texto: string,
  log: Log,
): Promise<{ lat: number; lon: number; nombre: string } | null> {
  const nombre = await extraerUbicacion(texto, log);
  if (!nombre) return null;

  const geo = await geocodificar(nombre, log);
  if (!geo) return null;
  const nombreCorto =
    geo.fuente === "nominatim" ? geo.nombre.split(",")[0].trim() : geo.nombre;
  return { lat: geo.lat, lon: geo.lon, nombre: nombreCorto };
}

async function extraerUbicacion(texto: string, log: Log): Promise<string | null> {
  if (hayLlm()) {
    const raw = await generarTexto(
      `Del siguiente reporte de tráfico, extrae SOLO el nombre del lugar o la vía afectada. ` +
        `Devuelve SOLO JSON con la clave "lugar" (string) o "lugar": null si no hay un lugar claro.\n` +
        `Reporte: ${texto}`,
      { system: "Extraes nombres de lugares de reportes de tráfico. Sé exacto.", json: true },
    );
    if (raw) {
      try {
        const j = JSON.parse(raw) as { lugar?: string | null };
        if (typeof j.lugar === "string" && j.lugar.trim()) {
          return j.lugar.trim();
        }
      } catch {
        // cae al fallback determinista
      }
    }
  }
  return extraerUbicacionDeterminista(texto);
}

function extraerUbicacionDeterminista(texto: string): string | null {
  const t = normalizar(texto);

  let resto = t;
  for (const k of [...INCIDENTE_FUERTE, ...AFECTACION, ...FLUIDEZ]) {
    resto = resto.split(k).join(" ");
  }

  const stop = new Set([
    "acabo", "acaba", "acabamos", "ver", "vi", "vio", "hay", "hubo",
    "frente", "al", "del", "de", "en", "a", "un", "una", "unos", "unas",
    "que", "por", "con", "mi", "me", "se", "ya", "justo", "reporto",
    "informo", "aviso", "estaba", "estan", "esta", "estoy", "sobre",
    "cerca", "cerca de", "aqui", "aca", "es", "son", "esta",
  ]);

  const palabras = resto
    .split(/\s+/)
    .filter((p) => p && !stop.has(p));

  const nombre = palabras.join(" ").trim();
  return nombre.length >= 3 ? nombre : null;
}
