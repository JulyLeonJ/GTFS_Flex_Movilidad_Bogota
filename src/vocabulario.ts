// Vocabulario compartido para detectar reportes de estado de vía. Se usa en la
// ingesta (subsistema informal, src/agents/ingesta.ts) y en incidentes (red
// oficial, src/incidentes.ts) para que ambas fuentes reconozcan las mismas
// señales. Palabras en minúsculas y sin tildes: se comparan contra texto
// normalizado con `normalizar()` (src/relevancia.ts).

// Incidente inequívoco: gana sobre la estructura de ruta en la clasificación.
export const INCIDENTE_FUERTE = [
  "bloqueo",
  "protesta",
  "manifestacion",
  "disturbio",
  "desvio",
  "cierre",
  "accidente",
  "choque",
  "colision",
  "siniestro",
  "derrumb",
  "derrumbado",
  "caida de arbol",
  "arbol caido",
  "cerrado",
  "cierre",
  "volcamiento",
  "volcado",
  "atropello",
  "atropellado",
  "incendio",
  "explosion",
  "manifestacion",
  "disturbio",
  "estrellon",
  "estrello",
  "estrellaron",
];

// Afectación moderada (congestión, demora): es reporte si no hay estructura de
// ruta. Incluye las formas verbales de "chocar" (chocó/chocaron/…) que, por ser
// subcadenas ambiguas, se mantienen aquí para no ganarle a una ruta real.
export const AFECTACION = [
  "trancon",
  "demora",
  "demorado",
  "lento",
  "parado",
  "no pasa",
  "desvio",
  "restringido",
  "congestion",
  "congestionado",
  "embotellamiento",
  "embotellado",
  "varado",
  "detenido",
  "accidentado",
  "choco",
  "choca",
  "chocan",
  "chocaron",
  "chocar",
];

// Señales de fluidez (positivas).
export const FLUIDEZ = [
  "fluido",
  "todo bien",
  "normal",
  "paso",
  "salio",
  "andando",
  "sin novedad",
  "operando",
];

// Señales positivas no ambiguas para clasificar un mensaje como reporte
// (se excluyen "normal", "paso", "salio" por ser demasiado comunes).
export const FLUIDEZ_CLARA = [
  "fluido",
  "todo bien",
  "sin novedad",
  "operando",
  "andando",
];
