import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fetchJson } from "./util.js";

// Descubre y descarga el GTFS oficial del SITP (publicado por TransMilenio en
// su hub de ArcGIS). La URL directa se obtiene de la API de búsqueda del hub
// (no se "adivina" ninguna ruta).

const HUB_SEARCH =
  "https://datosabiertos-transmilenio.hub.arcgis.com/api/search/v1/collections/all/items";

interface HubFeature {
  properties?: { title?: string; url?: string; created?: number };
}
interface HubResponse {
  features?: HubFeature[];
}

export interface GtfsOficial {
  url: string;
  titulo: string;
}

export async function descubrirGtfsOficial(
  log: (m: string) => void,
): Promise<GtfsOficial | undefined> {
  const data = await fetchJson<HubResponse>(`${HUB_SEARCH}?q=gtfs&limit=50`);
  const candidatos = (data.features ?? []).filter(
    (f) => f.properties?.url && /GTFS Estáticos/i.test(f.properties.title ?? ""),
  );
  if (candidatos.length === 0) return undefined;

  candidatos.sort(
    (a, b) => (b.properties!.created ?? 0) - (a.properties!.created ?? 0),
  );
  const mejor = candidatos[0].properties!;
  log(`GTFS oficial más reciente: "${mejor.title}"`);
  return { url: mejor.url!, titulo: mejor.title! };
}

export function cacheDir(): string {
  return fileURLToPath(new URL("../data/gtfs_cache", import.meta.url));
}

export function cacheZip(): string {
  return `${cacheDir()}/sitp-gtfs.zip`;
}

export function cacheMeta(): string {
  return `${cacheDir()}/meta.json`;
}

export async function descargarGtfs(
  url: string,
  dest: string,
  log: (m: string) => void = () => {},
): Promise<void> {
  mkdirSync(cacheDir(), { recursive: true });
  log(`descargando ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} descargando ${url}`);
  const total = Number(res.headers.get("content-length") ?? 0);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
  log(`guardado ${(buf.length / 1e6).toFixed(1)} MB en ${dest}`);
  void total;
}

export function leerMeta(): { url?: string; titulo?: string } {
  if (!existsSync(cacheMeta())) return {};
  try {
    return JSON.parse(readFileSync(cacheMeta(), "utf-8"));
  } catch {
    return {};
  }
}

export function escribirMeta(meta: { url: string; titulo: string }): void {
  mkdirSync(cacheDir(), { recursive: true });
  writeFileSync(cacheMeta(), JSON.stringify(meta, null, 2));
}
