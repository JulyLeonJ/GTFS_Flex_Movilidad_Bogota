import type { Agent, AgentContext } from "../agent.js";
import { FatalAgentError } from "../agent.js";
import { geocodificar } from "../geocode.js";
import { areaMvp, enArea } from "../gtfs.js";
import type { ConsultaNormalizada } from "../types.js";

// Geocodifica origen y destino usando IDECA (fuente oficial) con fallback a
// Nominatim. Registra en el estado qué proveedor resolvió cada punto para
// trazabilidad y para el reporte final.

export function fueraDeArea(consulta: ConsultaNormalizada): string | null {
  const area = areaMvp();
  if (!area) return null;
  const fueraOrigen = consulta.origenPunto && !enArea(consulta.origenPunto);
  const fueraDestino = consulta.destinoPunto && !enArea(consulta.destinoPunto);
  if (!fueraOrigen && !fueraDestino) return null;
  const lugares = [fueraOrigen && consulta.origenTexto, fueraDestino && consulta.destinoTexto]
    .filter(Boolean)
    .join(" y ");
  return `Por ahora solo cubrimos ${area.nombre}: "${lugares}" queda fuera de esa zona.`;
}

export class GeocoderAgent implements Agent {
  readonly name = "geocoder";

  async run(ctx: AgentContext): Promise<void> {
    const consulta = ctx.state.consulta as ConsultaNormalizada;

    const [o, d] = await Promise.all([
      geocodificar(consulta.origenTexto, ctx.log),
      geocodificar(consulta.destinoTexto, ctx.log),
    ]);

    consulta.origenPunto = o ? { lat: o.lat, lon: o.lon } : undefined;
    consulta.destinoPunto = d ? { lat: d.lat, lon: d.lon } : undefined;

    ctx.state.geocode = { origen: o, destino: d };

    if (o) ctx.log(`origen geocodificado por ${o.fuente}: (${o.lat}, ${o.lon})`);
    else ctx.log("advertencia: origen no geocodificado");
    if (d) ctx.log(`destino geocodificado por ${d.fuente}: (${d.lat}, ${d.lon})`);
    else ctx.log("advertencia: destino no geocodificado");

    const fuera = fueraDeArea(consulta);
    if (fuera) throw new FatalAgentError(fuera);

    ctx.state.consulta = consulta;
  }
}
