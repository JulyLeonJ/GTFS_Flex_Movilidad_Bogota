import type { Agent, AgentContext } from "../agent.js";
import { fetchJson } from "../util.js";
import { esTransitoBogota } from "../relevancia.js";
import type { ConjuntoDatos } from "../types.js";

interface CkanPackage {
  name: string;
  title: string;
  notes?: string;
  url?: string;
  organization?: { title?: string };
  resources?: { format?: string; url?: string; name?: string }[];
}

interface CkanResponse {
  result: { count: number; results: CkanPackage[] };
}

// Consulta el portal de Datos Abiertos de Bogotá (Bogotá Abierta, CKAN).
export class CkanAgent implements Agent {
  readonly name = "catalogo_bogota_abierta";

  async run(ctx: AgentContext): Promise<void> {
    const base =
      process.env.CKAN_BOGOTA ??
      "https://datosabiertos.bogota.gov.co/api/3/action";
    const q = this.construirQuery(ctx);

    const url = `${base}/package_search?rows=20&q=${encodeURIComponent(q)}`;
    const data = await fetchJson<CkanResponse>(url);

    const datasets: ConjuntoDatos[] = data.result.results
      .filter((p) => esTransitoBogota([p.title, p.notes, p.organization?.title].filter(Boolean).join(" ")))
      .slice(0, 6)
      .map((p) => ({
        fuente: "bogota_abierta",
        id: p.name,
        nombre: p.title,
        descripcion: p.notes,
        organizacion: p.organization?.title,
        url: p.url,
        formato: p.resources?.[0]?.format,
      }));

    ctx.state.datasets_bogota = datasets;
    ctx.log(`${datasets.length} datasets de Bogotá Abierta para: ${q}`);
  }

  private construirQuery(ctx: AgentContext): string {
    // Priorizamos los sistemas de transporte de Bogotá.
    return "SITP OR TransMilenio OR TransMiCable OR GTFS";
  }
}
