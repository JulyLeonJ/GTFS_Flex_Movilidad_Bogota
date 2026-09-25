import { fileURLToPath } from "node:url";
import { Orchestrator } from "./agent.js";
import { NluAgent } from "./agents/nlu.js";
import { GeocoderAgent } from "./agents/geocoder.js";
import { CkanAgent } from "./agents/ckan.js";
import { SocrataAgent } from "./agents/socrata.js";
import { TransitAgent } from "./agents/transit.js";
import { InformalAgent } from "./agents/informal.js";
import { ConocimientoComunitarioAgent } from "./agents/conocimiento-comunitario.js";
import { SynthesizerAgent } from "./agents/synth.js";
import { InformalService } from "./informal.js";
import { IncidentesService } from "./incidentes.js";
import { minutosATexto, segAHora } from "./util.js";
import { registrarConsulta } from "./consulta-log.js";
import { nombreModeloLlm } from "./llm.js";
import { nombreModeloStt } from "./stt.js";
import type { ResultadoRecomendacion } from "./types.js";

// Núcleo reutilizable: construye el pipeline multiagente y lo ejecuta desde
// cualquier entrada (CLI o Telegram). Mantiene el subsistema informal vivo
// entre consultas para que la confianza C(t) conserve su decaimiento temporal.

export interface GeocodeInfo {
  origen?: { nombre: string; fuente: string } | null;
  destino?: { nombre: string; fuente: string } | null;
}

export interface Recomendacion {
  resultado: ResultadoRecomendacion;
  gtfsFuente: string;
  geocode?: GeocodeInfo;
  csvRuta: string;
}

export class Recomendador {
  readonly informal: InformalService;
  readonly incidentes: IncidentesService;

  constructor() {
    this.informal = new InformalService(
      process.env.FLEX_PATH ??
        fileURLToPath(new URL("../data/sample_flex", import.meta.url)),
    );
    this.incidentes = new IncidentesService();

    const ahoraMs = Date.now();
    this.informal.ingestaDeTexto(
      "Todo bien en Quiba Mochuelo",
      "usuario_frecuente",
      ahoraMs - 5 * 60_000,
    );
    this.informal.ingestaDeTexto(
      "Todo bien en Quiba Bajo",
      "validador_comunitario",
      ahoraMs - 8 * 60_000,
    );
  }

  private construirOrquestador(logger: (m: string) => void): Orchestrator {
    const orch = new Orchestrator();
    orch.stage(new NluAgent());
    orch.stage(new GeocoderAgent(), new CkanAgent(), new SocrataAgent());
    orch.stage(new TransitAgent(this.incidentes));
    orch.stage(new InformalAgent(this.informal));
    orch.stage(new ConocimientoComunitarioAgent());
    orch.stage(new SynthesizerAgent());
    return orch;
  }

  // Ejecuta el pipeline completo con un estado inicial arbitrario (texto libre
  // o flags estructurados) y persiste la consulta en la base de conocimiento.
  async ejecutar(
    initial: Record<string, unknown>,
    logger: (m: string) => void = () => {},
  ): Promise<Recomendacion> {
    const orch = this.construirOrquestador(logger);
    const state = await orch.run(initial, logger);

    const resultado = state.resultado as ResultadoRecomendacion;
    if (!resultado) {
      throw new Error("No se pudo construir la recomendación.");
    }

    return {
      resultado,
      gtfsFuente: (state.gtfsFuente as string) ?? "desconocida",
      geocode: state.geocode as GeocodeInfo | undefined,
      csvRuta: this.registrar(resultado),
    };
  }

  // Entrada como texto libre (la vía usada por Telegram).
  async recomendarTexto(
    texto: string,
    logger: (m: string) => void = () => {},
  ): Promise<Recomendacion> {
    return this.ejecutar({ textoLibre: texto, motivos: [] }, logger);
  }

  private registrar(resultado: ResultadoRecomendacion): string {
    const mejor = resultado.opciones[0];
    return registrarConsulta({
      timestamp: new Date().toISOString(),
      origenTexto: resultado.consulta.origenTexto,
      destinoTexto: resultado.consulta.destinoTexto,
      tiempoMin: resultado.consulta.tiempoMin,
      horaSalida:
        resultado.consulta.salidaSeg !== undefined
          ? segAHora(resultado.consulta.salidaSeg)
          : undefined,
      origenLat: resultado.consulta.origenPunto?.lat,
      origenLon: resultado.consulta.origenPunto?.lon,
      destinoLat: resultado.consulta.destinoPunto?.lat,
      destinoLon: resultado.consulta.destinoPunto?.lon,
      numOpciones: resultado.opciones.length,
      mejorTipo: mejor?.tipo,
      mejorFuente: mejor?.fuente,
      mejorResumen: mejor?.resumen,
      mejorTiempoMin: mejor?.tiempoEstimadoMin,
      mejorConfianza: mejor?.confianza,
      mejorPuntaje: mejor?.puntaje,
      opcionesJson: JSON.stringify(resultado.opciones),
      datasetsJson: JSON.stringify(resultado.datasets),
      explicacion: resultado.explicacion,
      llmModelo: nombreModeloLlm(),
      sttModelo: nombreModeloStt(),
    });
  }

  detener(): void {
    this.informal.detener();
  }
}

// Formatea una recomendación como texto plano (para consola o chat).
export function formatearResultado(
  r: ResultadoRecomendacion,
  fuente: string,
  geocode?: GeocodeInfo,
): string {
  const sep = "─".repeat(64);
  const lineas: string[] = [];

  lineas.push(sep);
  lineas.push(`ORIGEN  : ${r.consulta.origenTexto}`);
  lineas.push(`DESTINO : ${r.consulta.destinoTexto}`);
  lineas.push(`TIEMPO  : ${r.consulta.tiempoMin} min`);
  if (r.consulta.salidaSeg !== undefined) {
    lineas.push(`SALIDA  : ${segAHora(r.consulta.salidaSeg)}`);
  }
  lineas.push(`GTFS    : ${fuente}`);
  if (geocode?.origen) {
    lineas.push(`GEOCOD  : origen → ${geocode.origen.nombre} [${geocode.origen.fuente}]`);
  }
  if (geocode?.destino) {
    lineas.push(`          destino → ${geocode.destino.nombre} [${geocode.destino.fuente}]`);
  }
  lineas.push(sep);

  lineas.push("");
  lineas.push("OPCIONES DE RUTA (ordenadas por puntaje):");
  if (r.opciones.length === 0) {
    lineas.push("  — no se encontraron rutas —");
  }
  r.opciones.forEach((o, i) => {
    const tag = o.tipo === "directa" ? "DIRECTA" : "TRANSBORDO";
    const tagFuente =
      o.fuente === "informal"
        ? " · INFORMAL"
        : o.fuente === "comunitaria"
          ? " · COMUNITARIA"
          : "";
    const conf =
      o.confianza !== undefined && o.confianza < 1
        ? ` · confianza ${(o.confianza * 100).toFixed(0)}%`
        : "";
    lineas.push(`\n${i + 1}. [${tag}${tagFuente}] ${o.resumen}`);
    lineas.push(
      `   tiempo ≈ ${minutosATexto(o.tiempoEstimadoMin)} · caminata ≈ ${o.caminataMts} m · puntaje ${o.puntaje.toFixed(1)}${conf}`,
    );
    for (const paso of o.pasos) lineas.push(`     • ${paso}`);
  });

  lineas.push(`\n${sep}`);
  lineas.push("DATASETS CRUZADOS:");
  if (r.datasets.length === 0) lineas.push("  (ninguno)");
  r.datasets.forEach((d) => {
    lineas.push(
      `  • [${d.fuente}] ${d.nombre}${d.organizacion ? ` — ${d.organizacion}` : ""}`,
    );
  });

  lineas.push(`\n${sep}`);
  lineas.push("RECOMENDACIÓN:");
  lineas.push(`  ${r.explicacion}`);
  lineas.push(sep);

  return lineas.join("\n");
}
