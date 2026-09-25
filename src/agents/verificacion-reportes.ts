import type { Agent, AgentContext } from "../agent.js";
import type { IncidentesService } from "../incidentes.js";
import type { InformalService } from "../informal.js";
import type { ConsultaNormalizada, OpcionRuta, Punto } from "../types.js";
import { haversine } from "../util.js";

// Verificación de reportes contra la ruta recomendada. Antes de la síntesis,
// cruza el origen/destino (y el punto medio del corredor) contra los incidentes
// activos y, si hay transporte informal con confianza baja, añade esos motivos
// a ctx.state.motivos para que la explicación final los mencione.
export class VerificacionReportesAgent implements Agent {
  readonly name = "reportes_verificacion";

  constructor(
    private incidentes: IncidentesService,
    private informal: InformalService,
  ) {}

  async run(ctx: AgentContext): Promise<void> {
    const consulta = ctx.state.consulta as ConsultaNormalizada | undefined;
    const opciones = (ctx.state.opciones as OpcionRuta[] | undefined) ?? [];
    const existentes = Array.isArray(ctx.state.motivos)
      ? (ctx.state.motivos as string[])
      : [];

    const nuevos: string[] = [];
    const vistos = new Set(existentes);

    const agregar = (motivo: string) => {
      if (!vistos.has(motivo)) {
        vistos.add(motivo);
        nuevos.push(motivo);
      }
    };

    // Incidentes activos cerca del origen/destino o del punto medio del corredor.
    if (consulta) {
      const puntos: Punto[] = [];
      if (consulta.origenPunto) puntos.push(consulta.origenPunto);
      if (consulta.destinoPunto) puntos.push(consulta.destinoPunto);
      if (consulta.origenPunto && consulta.destinoPunto) {
        puntos.push({
          lat: (consulta.origenPunto.lat + consulta.destinoPunto.lat) / 2,
          lon: (consulta.origenPunto.lon + consulta.destinoPunto.lon) / 2,
        });
      }

      for (const inc of this.incidentes.activos()) {
        const afecta = puntos.some(
          (p) => haversine(p, { lat: inc.lat, lon: inc.lon }) <= inc.radioM,
        );
        if (afecta) agregar(inc.motivo);
      }
    }

    // Incidentes que afectaron la búsqueda de rutas (los detecta el agente de
    // tránsito a partir de los viajes alcanzables): cubren el caso en que el
    // corredor bloqueado no coincide con el punto medio pero aun así desvió la
    // ruta recomendada.
    const enRuta = ctx.state.incidentesEnRuta;
    if (Array.isArray(enRuta)) {
      for (const m of enRuta as string[]) agregar(m);
    }

    // Transporte informal con confianza baja por reportes recientes.
    for (const o of opciones) {
      if (
        o.fuente === "informal" &&
        o.confianza !== undefined &&
        o.confianza < 0.5
      ) {
        agregar(
          `transporte informal "${o.resumen}" con confianza baja (${(o.confianza * 100).toFixed(0)}%)`,
        );
      }
    }

    if (nuevos.length > 0) {
      ctx.state.motivos = [...existentes, ...nuevos];
      ctx.log(`${nuevos.length} motivo(s) de reporte detectado(s) en la ruta`);
    }
  }
}
