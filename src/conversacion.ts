import { registrarReporte } from "./reporte-log.js";
import { ingestarReporte } from "./ingesta-reportes.js";
import { urlSesion, type SesionesService } from "./sesiones.js";
import type { Recomendador } from "./recomendador.js";

export interface Deps {
  recomendador: Recomendador;
  sesiones: SesionesService;
  logger: (m: string) => void;
}

export interface Canal {
  canal: "telegram" | "consola";
  clave: string;
  fuenteReportes: string;
}

async function responderRuta(texto: string, canal: Canal, deps: Deps): Promise<string> {
  const sesion = deps.sesiones.deCanal(canal.canal, canal.clave);
  try {
    const rec = await deps.recomendador.recomendarTexto(
      texto,
      deps.logger,
      sesion.resultado?.consulta,
    );
    deps.sesiones.actualizar(sesion.id, rec.resultado);
    const r = rec.resultado;
    return r.opciones.length > 0
      ? `${r.explicacion}\n\n🗺️ Ver en el mapa: ${urlSesion(sesion.id)}`
      : r.explicacion;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `No pude procesar tu consulta: ${msg}`;
  }
}

export function esRuta(texto: string): boolean {
  return /\bde\s+.+\s+a\s+.+/i.test(texto.trim());
}

export async function procesarReporte(texto: string, canal: Canal, deps: Deps): Promise<string> {
  const res = await ingestarReporte(
    texto,
    canal.fuenteReportes,
    deps.recomendador.informal,
    deps.recomendador.incidentes,
    Date.now(),
    deps.logger,
  );

  registrarReporte({
    timestamp: new Date().toISOString(),
    canal: canal.canal,
    fuente: canal.fuenteReportes,
    nivel: "informal",
    fiabilidad: res.fiabilidad,
    segmento: res.segmento,
    valor: res.valor,
    lat: res.lat,
    lon: res.lon,
    texto,
  });

  await new Promise((r) => setImmediate(r));
  deps.sesiones.eventos.emit("congestion");

  if (res.segmento.startsWith("punto:")) {
    return (
      `Incidente geolocalizado en ${res.segmento.replace(/^punto:/, "")} ` +
      `(fiabilidad ${(res.fiabilidad * 100).toFixed(0)}%). Gracias, alimenta la base de conocimiento.`
    );
  }
  if (res.mapeado) {
    return (
      `Reporte registrado en ${res.segmento} ` +
      `(fiabilidad ${(res.fiabilidad * 100).toFixed(0)}%). Gracias, alimenta la base de conocimiento.`
    );
  }
  return (
    "Gracias, registré tu reporte. Aún no tengo mapeado ese lugar, " +
    "pero quedó guardado en la base de conocimiento."
  );
}

export async function manejarMensaje(texto: string, canal: Canal, deps: Deps): Promise<string> {
  const t = texto.trim();
  if (deps.recomendador.informal.esIncidenteFuerte(t)) return procesarReporte(t, canal, deps);
  if (esRuta(t)) return responderRuta(t, canal, deps);
  if (deps.recomendador.informal.esReporte(t)) return procesarReporte(t, canal, deps);
  return responderRuta(t, canal, deps);
}

export function urlDeCanal(canal: Canal, deps: Deps): string | null {
  const sesion = deps.sesiones.deCanal(canal.canal, canal.clave);
  return sesion.resultado && sesion.resultado.opciones.length > 0 ? urlSesion(sesion.id) : null;
}
