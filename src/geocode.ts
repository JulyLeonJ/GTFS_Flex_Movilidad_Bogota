import { fetchJson } from "./util.js";
import { areaMvp, enArea } from "./gtfs.js";

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

const SEPARADORES =
  /,|\s+(?:y\s+)?(?:al\s+)?frente\s+(?:a|al|de|del)\s+|\s+(?:cerca|junto|al\s+lado|detr[aá]s)\s+(?:de|del|a|al)\s+|\s+(?:el|la)\s+que\s+(?:queda|est[aá])\s*/i;
const TIPO_LUGAR =
  /^(?:parque|centro\s+m[eé]dico|centro\s+comercial|centro\s+de\s+salud|hospital|colegio|barrio|urbanizaci[oó]n|conjunto|iglesia|paradero|estaci[oó]n)\s+(?:de\s+(?:la\s+|los\s+|las\s+)?|del\s+)?/i;

// El usuario describe lugares como en la calle ("el centro médico de X, frente
// al C.C. Y"): si el texto completo no geocodifica, se prueban sus fragmentos.
export function variantesLugar(texto: string): string[] {
  const partes = texto
    .split(SEPARADORES)
    .map((p) => p?.trim().replace(/^(?:el|la|los|las)\s+/i, ""))
    .filter((p): p is string => Boolean(p && p.length > 2));
  const vistas = new Set<string>();
  return [texto.trim(), ...partes, ...partes.map((p) => p.replace(TIPO_LUGAR, ""))]
    .filter((v) => v.length > 2 && !vistas.has(v.toLowerCase()) && vistas.add(v.toLowerCase()))
    .slice(0, 6);
}

export async function geocodificar(
  texto: string,
  log: Log,
): Promise<GeocodeResult | undefined> {
  for (const v of variantesLugar(texto)) {
    const r = await geocodificarTexto(v, log);
    if (r) {
      if (v !== texto.trim()) log(`geocodificado usando "${v}"`);
      return r;
    }
  }
  return undefined;
}

async function geocodificarTexto(
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
    // MVP de una sola localidad: un resultado dentro del área gana aunque el
    // nombre calce un poco peor (evita homónimos de "Lucero"/"Paraíso" en otras
    // localidades).
    const dentro = (f: IdecaFeature) =>
      Number(!enArea({ lat: f.geometry!.y, lon: f.geometry!.x }));
    features.sort(
      (a, b) =>
        dentro(a) - dentro(b) ||
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
  // Con área definida, sesgamos (sin `bounded=1`, que filtraría en vez de
  // sesgar) y pedimos varios candidatos para poder preferir uno dentro del área.
  const area = areaMvp();
  const viewbox = area
    ? `&viewbox=${area.bbox.oeste},${area.bbox.norte},${area.bbox.este},${area.bbox.sur}`
    : "";
  const url = `${base}?format=json&limit=5&countrycodes=co&q=${q}${viewbox}`;
  try {
    const res = await fetchJson<{ lat: string; lon: string; display_name: string }[]>(url);
    const r =
      res.find((x) => enArea({ lat: Number(x.lat), lon: Number(x.lon) })) ?? res[0];
    if (!r) return undefined;
    log(`Nominatim: "${r.display_name}"`);
    return { lat: Number(r.lat), lon: Number(r.lon), nombre: r.display_name, fuente: "nominatim" };
  } catch (err) {
    log(`Nominatim falló para "${texto}": ${(err as Error).message}`);
    return undefined;
  }
}
