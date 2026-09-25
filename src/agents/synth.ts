import type { Agent, AgentContext } from "../agent.js";
import { generarTexto, hayLlm } from "../llm.js";
import { minutosATexto, segAHora } from "../util.js";
import type {
  ConjuntoDatos,
  ConsultaNormalizada,
  OpcionRuta,
  ResultadoRecomendacion,
} from "../types.js";

// Consolida los resultados de todos los agentes y produce la recomendación
// final. El ranking es determinista (ya ordenado por puntaje); el LLM solo
// redacta la explicación en lenguaje natural cuando está disponible.
export class SynthesizerAgent implements Agent {
  readonly name = "sintesis";

  async run(ctx: AgentContext): Promise<void> {
    const consulta = ctx.state.consulta as ConsultaNormalizada;
    const opciones = (ctx.state.opciones as OpcionRuta[] | undefined) ?? [];
    const datasets = this.recogerDatasets(ctx);
    const motivos = (ctx.state.motivos as string[] | undefined) ?? [];

    let explicacion: string;
    if (opciones.length === 0) {
      explicacion = this.sinOpciones(consulta, datasets);
    } else {
      explicacion = await this.explicar(consulta, opciones, datasets, motivos);
    }

    const resultado: ResultadoRecomendacion = {
      consulta,
      opciones,
      datasets,
      explicacion,
    };
    ctx.state.resultado = resultado;
    ctx.log("recomendación final consolidada");
  }

  private recogerDatasets(ctx: AgentContext): ConjuntoDatos[] {
    const a = (ctx.state.datasets_bogota as ConjuntoDatos[] | undefined) ?? [];
    const b = (ctx.state.datasets_colombia as ConjuntoDatos[] | undefined) ?? [];
    return [...a, ...b];
  }

  private async explicar(
    consulta: ConsultaNormalizada,
    opciones: OpcionRuta[],
    datasets: ConjuntoDatos[],
    motivos: string[],
  ): Promise<string> {
    const mejor = opciones[0];
    const fuente =
      mejor.fuente === "informal"
        ? " (transporte informal)"
        : mejor.fuente === "comunitaria"
          ? " (conocimiento comunitario)"
          : " (SITP/TransMilenio)";
    const conf =
      mejor.confianza !== undefined && mejor.confianza < 1
        ? ` confianza ${(mejor.confianza * 100).toFixed(0)}%`
        : "";
    const motivoTxt = motivos.length
      ? ` Desvío por reporte de vía: ${motivos.join("; ")}.`
      : "";
    const base = `Ruta recomendada: ${mejor.resumen}${fuente} (~${minutosATexto(mejor.tiempoEstimadoMin)}${conf}). ` +
      `Alternativas: ${opciones.length - 1} (oficiales e informales). ` +
      `Fuentes cruzadas: ${datasets.length} datasets (${datasets.map((d) => d.fuente).join(", ") || "ninguno"}).${motivoTxt}`;

    if (!hayLlm()) return base;

    const texto = await generarTexto(
      `A partir de estos datos, redacta en 2-3 frases una recomendación de movilidad clara y sin ambigüedades. ` +
        `Menciona si la mejor opción es oficial (SITP/TransMilenio) o informal (colectivo veredal) y su confianza. ` +
        `Si hay un reporte de vía (accidente o tráfico), indícalo EXPLÍCITAMENTE como motivo del desvío:\n` +
        `Origen: ${consulta.origenTexto}; Destino: ${consulta.destinoTexto}; Tiempo disponible: ${consulta.tiempoMin} min` +
        (consulta.salidaSeg !== undefined ? `; Hora de salida: ${segAHora(consulta.salidaSeg)}` : "") + `.\n` +
        `Reportes de vía (motivo de desvío): ${motivos.length ? motivos.join("; ") : "ninguno"}.\n` +
        `Opciones (ordenadas por puntaje):\n${opciones
          .map((o, i) => {
            const c = o.confianza !== undefined ? ` confianza ${(o.confianza * 100).toFixed(0)}%` : "";
            const f = ` [${o.fuente ?? "oficial"}]`;
            return `${i + 1}. ${o.resumen}${f} — ${minutosATexto(o.tiempoEstimadoMin)}, caminata ${o.caminataMts} m${c}`;
          })
          .join("\n")}`,
      { system: "Eres un asesor de movilidad de Bogotá. Responde solo en español, concreto." },
    );
    return texto ?? base;
  }

  private sinOpciones(
    consulta: ConsultaNormalizada,
    datasets: ConjuntoDatos[],
  ): string {
    const hora =
      consulta.salidaSeg !== undefined
        ? ` a las ${segAHora(consulta.salidaSeg)}`
        : "";
    return `No se encontraron rutas oficiales (SITP/TransMilenio)${hora} para "${consulta.origenTexto}" → "${consulta.destinoTexto}". ` +
      `Se cruzaron ${datasets.length} datasets abiertos; considera ampliar el radio de búsqueda, ajustar la hora de salida o cargar un feed GTFS oficial (GTFS_PATH).`;
  }
}
