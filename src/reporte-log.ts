import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

// Registro de reportes en CSV (base de conocimiento de reportes). Cada reporte
// de transporte informal que llega por un canal (Telegram, WhatsApp, …) se
// apenda con su nivel y fiabilidad. La fiabilidad (0..1) refleja la reputación
// de la fuente: los reportes de canales informales (p. ej. Telegram) tienen
// menor fiabilidad que los reportes oficiales/validados. La ruta se configura
// con REPORTES_CSV (por defecto data/reportes.csv).
//
// Además de escribirse, el CSV se lee al arrancar (leerReportes) para rehidratar
// la base de conocimiento: los reportes recientes vuelven a alimentar el modelo
// de confianza C(t) y los incidentes de la red oficial.

const RUTA_DEFAULT = "data/reportes.csv";

const COLUMNAS = [
  "timestamp",
  "canal",
  "fuente",
  "nivel",
  "fiabilidad",
  "segmento",
  "valor",
  "lat",
  "lon",
  "texto",
] as const;

export interface RegistroReporte {
  timestamp: string;
  canal: string; // canal de ingreso: "telegram", "whatsapp", …
  fuente: string; // id de reputación ("telegram", "usuario_frecuente", …)
  nivel: "informal" | "oficial"; // los informales pesan menos
  fiabilidad: number; // 0..1 (peso/reputación resuelta de la fuente)
  segmento: string; // objetivo mapeado: tramo informal, zona oficial o "punto:nombre"
  valor: number; // polaridad V_i (+1 fluido, -1.5 demora, -2 bloqueo)
  lat?: number; // coordenadas si el reporte se geolocalizó a un punto
  lon?: number;
  texto: string; // mensaje original
}

function escapar(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function desescapar(s: string): string {
  return s.replace(/^"|"$/g, "").replace(/""/g, '"');
}

export function rutaReportes(): string {
  return resolve(
    process.cwd(),
    process.env.REPORTES_CSV?.trim() || RUTA_DEFAULT,
  );
}

export function registrarReporte(r: RegistroReporte): string {
  const ruta = rutaReportes();

  const valores: unknown[] = [
    r.timestamp,
    r.canal,
    r.fuente,
    r.nivel,
    r.fiabilidad,
    r.segmento,
    r.valor,
    r.lat ?? "",
    r.lon ?? "",
    r.texto,
  ];
  const linea = valores.map(escapar).join(",");

  const dir = dirname(ruta);
  mkdirSync(dir, { recursive: true });

  const vacio = !existsSync(ruta) || statSync(ruta).size === 0;
  if (vacio) writeFileSync(ruta, `${COLUMNAS.join(",")}\n`);
  appendFileSync(ruta, `${linea}\n`);
  return ruta;
}

// Lee el CSV de reportes y devuelve los registros (sin la fila de cabecera).
// Si el archivo no existe, devuelve un arreglo vacío.
export function leerReportes(): RegistroReporte[] {
  const ruta = rutaReportes();
  if (!existsSync(ruta)) return [];

  const lineas = readFileSync(ruta, "utf-8").split("\n");
  const out: RegistroReporte[] = [];
  for (const linea of lineas) {
    if (!linea.trim()) continue;
    const cols = parsearLinea(linea);
    if (cols.length === 0) continue;
    if (cols[0] === "timestamp") continue; // cabecera

    out.push({
      timestamp: cols[0] ?? "",
      canal: cols[1] ?? "",
      fuente: cols[2] ?? "",
      nivel: (cols[3] as "informal" | "oficial") ?? "informal",
      fiabilidad: Number(cols[4]) || 0,
      segmento: cols[5] ?? "",
      valor: Number(cols[6]) || 0,
      lat: cols[7] ? Number(cols[7]) : undefined,
      lon: cols[8] ? Number(cols[8]) : undefined,
      texto: cols[9] ?? "",
    });
  }
  return out;
}

// Parser de CSV simple que respeta comillas dobles ("" para comillas escapadas).
function parsearLinea(linea: string): string[] {
  const out: string[] = [];
  let actual = "";
  let enComillas = false;
  for (let i = 0; i < linea.length; i++) {
    const c = linea[i];
    if (c === '"') {
      if (enComillas && linea[i + 1] === '"') {
        actual += '"';
        i++;
      } else {
        enComillas = !enComillas;
      }
    } else if (c === "," && !enComillas) {
      out.push(desescapar(actual));
      actual = "";
    } else {
      actual += c;
    }
  }
  out.push(desescapar(actual));
  return out;
}
