import {
  appendFileSync,
  existsSync,
  mkdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

// Registro de consultas en CSV como base de conocimiento local. Cada consulta
// (origen/destino/tiempo + recomendación) se apenda a un archivo para poder
// integrarlo después en un motor de base de datos. La ruta se configura con
// CONSULTAS_CSV (por defecto data/consultas.csv).

const RUTA_DEFAULT = "data/consultas.csv";

const COLUMNAS = [
  "timestamp",
  "origen_texto",
  "destino_texto",
  "tiempo_min",
  "hora_salida",
  "origen_lat",
  "origen_lon",
  "destino_lat",
  "destino_lon",
  "num_opciones",
  "mejor_tipo",
  "mejor_fuente",
  "mejor_resumen",
  "mejor_tiempo_min",
  "mejor_confianza",
  "mejor_puntaje",
  "opciones_json",
  "datasets_json",
  "explicacion",
  "llm_modelo",
  "stt_modelo",
] as const;

export interface RegistroConsulta {
  timestamp: string;
  origenTexto: string;
  destinoTexto: string;
  tiempoMin: number;
  horaSalida?: string;
  origenLat?: number;
  origenLon?: number;
  destinoLat?: number;
  destinoLon?: number;
  numOpciones: number;
  mejorTipo?: string;
  mejorFuente?: string;
  mejorResumen?: string;
  mejorTiempoMin?: number;
  mejorConfianza?: number;
  mejorPuntaje?: number;
  opcionesJson: string;
  datasetsJson: string;
  explicacion: string;
  llmModelo: string;
  sttModelo: string;
}

function escapar(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function registrarConsulta(r: RegistroConsulta): string {
  const ruta = resolve(
    process.cwd(),
    process.env.CONSULTAS_CSV?.trim() || RUTA_DEFAULT,
  );

  const valores: unknown[] = [
    r.timestamp,
    r.origenTexto,
    r.destinoTexto,
    r.tiempoMin,
    r.horaSalida,
    r.origenLat,
    r.origenLon,
    r.destinoLat,
    r.destinoLon,
    r.numOpciones,
    r.mejorTipo,
    r.mejorFuente,
    r.mejorResumen,
    r.mejorTiempoMin,
    r.mejorConfianza,
    r.mejorPuntaje,
    r.opcionesJson,
    r.datasetsJson,
    r.explicacion,
    r.llmModelo,
    r.sttModelo,
  ];
  const linea = valores.map(escapar).join(",");

  const dir = dirname(ruta);
  mkdirSync(dir, { recursive: true });

  const vacio = !existsSync(ruta) || statSync(ruta).size === 0;
  if (vacio) writeFileSync(ruta, `${COLUMNAS.join(",")}\n`);
  appendFileSync(ruta, `${linea}\n`);
  return ruta;
}
