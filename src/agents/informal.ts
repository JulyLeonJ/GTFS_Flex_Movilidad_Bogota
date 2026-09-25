import type { Agent, AgentContext } from "../agent.js";
import type { InformalService } from "../informal.js";
import type { ConsultaNormalizada, OpcionRuta } from "../types.js";

// Agente de integración: consulta el transporte informal (GTFS-Flex) y mezcla
// sus opciones (ponderadas por la confianza C(t) con decaimiento temporal) con
// las oficiales del enrutador GTFS. Resultado: una única recomendación híbrida.
export class InformalAgent implements Agent {
  readonly name = "informal";

  constructor(private servicio: InformalService) {}

  async run(ctx: AgentContext): Promise<void> {
    const consulta = ctx.state.consulta as ConsultaNormalizada;
    const oficiales = (ctx.state.opciones as OpcionRuta[] | undefined) ?? [];
    const informales = this.servicio.opciones(
      consulta.origenPunto,
      consulta.destinoPunto,
    );

    ctx.state.informales = informales;
    ctx.state.opciones = [...oficiales, ...informales].sort(
      (a, b) => b.puntaje - a.puntaje,
    );
    ctx.log(
      `${informales.length} opción(es) informales integradas a la recomendación`,
    );
  }
}
