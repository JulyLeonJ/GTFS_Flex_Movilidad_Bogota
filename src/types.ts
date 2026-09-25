// Contratos compartidos entre agentes. Mantenerlos estables es lo que
// garantiza consistencia en el cruce de fuentes (evita respuestas vagas).

export interface Punto {
  lat: number;
  lon: number;
}

export interface Consulta {
  origen: string;
  destino: string;
  tiempoMin: number;
}

export interface ConsultaNormalizada {
  origenTexto: string;
  destinoTexto: string;
  tiempoMin: number;
  origenPunto?: Punto;
  destinoPunto?: Punto;
  // Hora de salida deseada, en segundos desde medianoche (opcional). Permite
  // descartar rutas oficiales fuera del horario de servicio del SITP.
  salidaSeg?: number;
}

export type Fuente = "bogota_abierta" | "datos_gov_co" | "ideca" | "referencia";

export interface ConjuntoDatos {
  fuente: Fuente;
  id: string;
  nombre: string;
  descripcion?: string;
  organizacion?: string;
  url?: string;
  formato?: string;
}

export interface Parada {
  id: string;
  nombre: string;
  lat: number;
  lon: number;
  rutas: string[];
}

export interface RutaGTFS {
  id: string;
  corta: string;
  larga: string;
  tipo: number;
  color?: string;
}

// [lon, lat]: orden GeoJSON/Mapbox. OJO: Punto es {lat, lon}; no mezclarlos.
export type Coord = [number, number];

export type Subsistema = "troncal" | "alimentador" | "dual" | "zonal" | "cable";

// Geometría de un tramo de la opción, en orden de viaje, lista para dibujar.
export interface TramoGeo {
  modo: "caminata" | "oficial" | "informal" | "comunitaria";
  etiqueta: string;
  subsistema?: Subsistema;
  color?: string; // "#rrggbb"
  coords: Coord[];
  geometria: "shape" | "paradas" | "flex" | "recta";
}

export interface OpcionRuta {
  tipo: "directa" | "transbordo";
  resumen: string;
  paradaOrigen: string;
  paradaDestino: string;
  pasos: string[];
  rutasUsadas: string[];
  tiempoEstimadoMin: number;
  caminataMts: number;
  puntaje: number;
  // Fuente de la opción: oficial (GTFS del SITP), informal (GTFS-Flex) o
  // comunitaria (conocimiento comunitario histórico vía LLM, último recurso).
  fuente?: "oficial" | "informal" | "comunitaria";
  // Confianza 0..1. Oficial = 1 por defecto; informal = C(t) por decaimiento.
  confianza?: number;
  // Geometría para el mapa (en orden de viaje). Ausente si no hubo coordenadas.
  tramos?: TramoGeo[];
  // Nivel máximo de trancamiento (0..1) de las zonas que cruza (CongestionAgent).
  congestion?: number;
}

export interface ResultadoRecomendacion {
  consulta: ConsultaNormalizada;
  opciones: OpcionRuta[];
  datasets: ConjuntoDatos[];
  explicacion: string;
  motivos?: string[];
}
