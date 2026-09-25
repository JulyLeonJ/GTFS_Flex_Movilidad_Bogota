import type { Agent, AgentContext } from "../agent.js";
import { fetchJson } from "../util.js";
import { esTransitoBogota } from "../relevancia.js";
import type { ConjuntoDatos } from "../types.js";

interface SocrataItem {
  resource: {
    id: string;
    name: string;
    description?: string;
    attribution?: string;
  };
}

interface SocrataResponse {
  resultSetSize: number;
  results: SocrataItem[];
}

// Consulta el portal nacional de Datos Abiertos (datos.gov.co), que es un
// portal Socrata. Para no perder tiempo con datasets de otras ciudades, la
// consulta se restringe a los sistemas de Bogotá y se aplica un filtro de
// relevancia posterior.
export class SocrataAgent implements Agent {
  readonly name = "catalogo_datos_gov_co";

  async run(ctx: AgentContext): Promise<void> {
    const base =
      process.env.SOCRATA_CATALOG ??
      "https://api.us.socrata.com/api/catalog/v1";
    const domain = process.env.SOCRATA_DOMAIN ?? "www.datos.gov.co";
    const q = "SITP OR TransMilenio OR TransMiCable";

    const url = `${base}?domains=${encodeURIComponent(domain)}&q=${encodeURIComponent(q)}&limit=20`;
    const data = await fetchJson<SocrataResponse>(url);

    const datasets: ConjuntoDatos[] = data.results
      .filter((it) =>
        esTransitoBogota(
          [it.resource.name, it.resource.description, it.resource.attribution]
            .filter(Boolean)
            .join(" "),
        ),
      )
      .slice(0, 6)
      .map((it) => ({
        fuente: "datos_gov_co",
        id: it.resource.id,
        nombre: it.resource.name,
        descripcion: it.resource.description,
        organizacion: it.resource.attribution,
      }));

    ctx.state.datasets_colombia = datasets;
    ctx.log(`${datasets.length} datasets de datos.gov.co (SITP/TransMilenio/TransMiCable)`);
  }
}
