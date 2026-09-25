// Filtro de relevancia para los catálogos: solo nos interesan datasets de
// tránsito de BOGOTÁ (SITP / TransMilenio / TransMiCable / GTFS), no los
// nacionales ni los de otras ciudades (Bucaramanga, Medellín, etc.).

export function normalizar(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

const TERMINOS_BOGOTA = [
  "bogota",
  "sitp",
  "transmilenio",
  "transmicable",
  "gtfs",
  "distrito capital",
  "transmilenio s.a",
];

const OTRAS_CIUDADES = [
  "bucaramanga",
  "medellin",
  "cali",
  "barranquilla",
  "cartagena",
  "pereira",
  "manizales",
  "villavicencio",
  "ibague",
  "cucuta",
  "neiva",
  "pasto",
  "popayan",
  "monteria",
  "sincelejo",
  "valledupar",
  "riohacha",
  "santa marta",
  "antioquia",
  "santander",
  "quindio",
  "tolima",
  "huila",
  "narino",
  "cundinamarca municipios",
];

export function esTransitoBogota(texto: string): boolean {
  const t = normalizar(texto);
  const mencionaBogota = TERMINOS_BOGOTA.some((b) => t.includes(b));
  const mencionaOtraCiudad = OTRAS_CIUDADES.some((c) => t.includes(c));
  return mencionaBogota && !mencionaOtraCiudad;
}
