import type { Agent, AgentContext } from "../agent.js";
import { calcularCongestion, congestionDeOpcion, umbralCongestion, type ZonaCongestion } from "../congestion.js";
import type { IncidentesService } from "../incidentes.js";
import type { InformalService } from "../informal.js";
import type { OpcionRuta } from "../types.js";

// Agente de congestión: calcula el nivel de trancamiento por zona (el mismo que
// pinta el mapa) y excluye las opciones que cruzan zonas ≥ umbral, siempre que
// quede alguna alternativa. Es la "exclusión dura"; el desvío suave por
// severidad ya ocurrió dentro del RAPTOR (impactoDeRutaEn).
export class CongestionAgent implements Agent {
  readonly name = "congestion";
  constructor(private incidentes: IncidentesService, private informal: InformalService) {}

  async run(ctx: AgentContext): Promise<void> {
    const zonas = calcularCongestion(this.incidentes, this.informal);
    ctx.state.congestion = zonas;
    const opciones = (ctx.state.opciones as OpcionRuta[] | undefined) ?? [];
    if (opciones.length === 0 || zonas.length === 0) return;

    const umbral = umbralCongestion();
    const cruces = new Map<OpcionRuta, ZonaCongestion[]>();
    for (const o of opciones) {
      const c = congestionDeOpcion(o, zonas);
      o.congestion = c.nivel;
      cruces.set(o, c.zonas);
    }
    const libres = opciones.filter((o) => (o.congestion ?? 0) < umbral);
    if (libres.length === opciones.length) return;

    const motivos = Array.isArray(ctx.state.motivos) ? [...(ctx.state.motivos as string[])] : [];
    const pct = (x: number) => `${Math.round(x * 100)}%`;
    if (libres.length > 0) {
      const descartadas = opciones.filter((o) => !libres.includes(o));
      const nombres = [
        ...new Set(
          descartadas.flatMap((o) =>
            cruces.get(o)!.filter((z) => z.nivel >= umbral).map((z) => `${z.nombre} (${pct(z.nivel)})`),
          ),
        ),
      ];
      ctx.state.opciones = libres;
      motivos.push(`se evitaron ${descartadas.length} ruta(s) que cruzan zonas con trancón: ${nombres.join(", ")}`);
    } else {
      const ordenadas = [...opciones].sort(
        (a, b) => (a.congestion ?? 0) - (b.congestion ?? 0) || b.puntaje - a.puntaje,
      );
      ctx.state.opciones = ordenadas;
      motivos.push(`todas las rutas cruzan zonas con trancón; se recomienda la menos afectada (${pct(ordenadas[0].congestion ?? 0)})`);
    }
    ctx.state.motivos = motivos;
    ctx.log(
      `congestión: ${zonas.length} zona(s) activas, ${opciones.length - libres.length} opción(es) sobre el umbral ${pct(umbral)}`,
    );
  }
}
