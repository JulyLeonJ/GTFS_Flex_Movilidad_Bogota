import { fetchJson } from "./util.js";

// Geocodificación con IDECA (fuente oficial de cartografía de Bogotá) y
// fallback a Nominatim (OSM). La interfaz devuelve siempre el mismo contrato,
// así que el resto del flujo no cambia al alternar proveedor.

export interface GeocodeResult {
  lat: number;
  lon: number;
  nombre: string;
  clasificacion?: string;
  fuente: "ideca" | "nominatim";
}

type Log = (m: string) => void;

export async function geocodificar(
  texto: string,
  log: Log,
): Promise<GeocodeResult | undefined> {
  const proveedor = (process.env.GEOCODE_PROVIDER ?? "auto").toLowerCase();

  if (proveedor === "ideca") {
    return (await ideca(texto, log)) ?? (await nominatim(texto, log));
  }
  if (proveedor === "nominatim") {
    return nominatim(texto, log);
  }
  // "auto": IDECA primero (fuente oficial), Nominatim de respaldo.
  return (await ideca(texto, log)) ?? (await nominatim(texto, log));
}

// ---- IDECA: Nomenclátor de nombres geográficos (ArcGIS REST) ----
interface IdecaFeature {
  attributes?: Record<string, unknown>;
  geometry?: { x: number; y: number };
}
interface IdecaResponse {
  features?: IdecaFeature[];
}

async function ideca(texto: string, log: Log): Promise<GeocodeResult | undefined> {
  const base =
    process.env.IDECA_GEOCODER_URL ??
    "https://serviciosgis.catastrobogota.gov.co/arcgis/rest/services/sitiosinteres/nombregeografico/MapServer/0/query";

  const where = `UPPER(NGENOMBRE) LIKE '%${texto.toUpperCase().replace(/'/g, "''")}%'`;
  const params = new URLSearchParams({
    where,
    outFields: "NGENOMBRE,NGECLASIFI,NGEFUENTE",
    returnGeometry: "true",
    outSR: "4326",
    orderByFields: "NGENOMBRE ASC",
    f: "json",
  });

  try {
    const data = await fetchJson<IdecaResponse>(`${base}?${params}`);
    const features = (data.features ?? []).filter(
      (f) => f.geometry && Number.isFinite(f.geometry.x),
    );
    if (features.length === 0) return undefined;

    const target = texto.trim().toLowerCase();
    features.sort(
      (a, b) =>
        rank(a, target) - rank(b, target) ||
        nombre(a).length - nombre(b).length,
    );

    const best = features[0];
    const nombreTxt = nombreOriginal(best);
    log(`IDECA: "${nombreTxt}" (clasif. ${String(best.attributes?.NGECLASIFI ?? "n/d")})`);

    return {
      lat: best.geometry!.y,
      lon: best.geometry!.x,
      nombre: nombreTxt,
      clasificacion: best.attributes?.NGECLASIFI
        ? String(best.attributes.NGECLASIFI)
        : undefined,
      fuente: "ideca",
    };
  } catch (err) {
    log(`IDECA geocoder falló para "${texto}": ${(err as Error).message}`);
    return undefined;
  }
}

function nombre(f: IdecaFeature): string {
  return nombreOriginal(f).toLowerCase();
}

function nombreOriginal(f: IdecaFeature): string {
  return String(f.attributes?.NGENOMBRE ?? "").trim();
}

function rank(f: IdecaFeature, target: string): number {
  const n = nombre(f);
  if (n === target) return 0;
  if (n.startsWith(target)) return 1;
  if (n.includes(target)) return 2;
  return 3;
}

// ---- Nominatim (OSM) como respaldo ----
async function nominatim(
  texto: string,
  log: Log,
): Promise<GeocodeResult | undefined> {
  const base =
    process.env.NOMINATIM_URL ?? "https://nominatim.openstreetmap.org/search";
  const q = encodeURIComponent(`${texto}, Bogotá, Colombia`);
  const url = `${base}?format=json&limit=1&countrycodes=co&q=${q}`;
  try {
    const res = await fetchJson<{ lat: string; lon: string; display_name: string }[]>(url);
    const r = res[0];
    if (!r) return undefined;
    log(`Nominatim: "${r.display_name}"`);
    return { lat: Number(r.lat), lon: Number(r.lon), nombre: r.display_name, fuente: "nominatim" };
  } catch (err) {
    log(`Nominatim falló para "${texto}": ${(err as Error).message}`);
    return undefined;
  }
}
