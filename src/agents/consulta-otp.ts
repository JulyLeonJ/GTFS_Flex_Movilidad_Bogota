import type { SegmentAgent } from "../segmentos.js";

// Agente Orquestador de Viajes (Query Agent): cuando llega una solicitud de
// ruta, NO hace un "SELECT" a una BD; pregunta a cada Agente de Tramo su
// confianza actual C(t), consolida la señal y arma la petición a OpenTripPlanner 2
// inyectando la penalización (reluctance) proporcional a la desconfianza.

const PENALIZACION_MAX = 5; // reluctance extra cuando C = 0

export type EstadoRuta = "operativa" | "degradada" | "critica";

export interface SegmentoConsolidado {
  id: string;
  nombre: string;
  c: number;
  reluctance: number;
}

export interface Consolidado {
  porSegmento: SegmentoConsolidado[];
  minima: number;
  media: number;
  estado: EstadoRuta;
}

export class QueryAgent {
  constructor(
    private agentes: SegmentAgent[],
    readonly otpEndpoint =
      process.env.OTP_ENDPOINT ??
      "http://localhost:8080/otp/routers/default/index/graphql",
  ) {}

  // Pregunta a los Agentes de Tramo su C(t) y consolida.
  consolidar(ids: string[], t: number = Date.now()): Consolidado {
    const porSegmento: SegmentoConsolidado[] = [];
    for (const id of ids) {
      const ag = this.agentes.find((a) => a.segmento.id === id);
      if (!ag) continue;
      const c = ag.c(t);
      porSegmento.push({
        id,
        nombre: ag.segmento.nombre,
        c,
        reluctance: this.reluctance(c),
      });
    }
    const valores = porSegmento.map((s) => s.c);
    const minima = valores.length ? Math.min(...valores) : 1;
    const media = valores.length
      ? valores.reduce((a, b) => a + b, 0) / valores.length
      : 1;
    return { porSegmento, minima, media, estado: this.estado(minima) };
  }

  reluctance(c: number): number {
    return 1 + (1 - c) * PENALIZACION_MAX;
  }

  estado(c: number): EstadoRuta {
    if (c >= 0.7) return "operativa";
    if (c >= 0.35) return "degradada";
    return "critica";
  }

  // Construye la consulta GraphQL a OTP2 con la reluctance del modo informal
  // (y la penalización por tramo como extensión flex). Modo "dry-run": devuelve
  // el texto de la petición sin enviarla.
  construirPlanOtp(
    origen: { lat: number; lon: number },
    destino: { lat: number; lon: number },
    consolidado: Consolidado,
    ahora = new Date(),
  ): string {
    const fecha = ahora.toISOString().slice(0, 10);
    const hora = ahora.toISOString().slice(11, 19);
    const reluctanceModo = this.reluctance(consolidado.minima).toFixed(2);
    const porTramo = consolidado.porSegmento
      .map((s) => `      { tramo: "${s.id}", reluctance: ${s.reluctance.toFixed(2)} }`)
      .join(",\n");

    return `POST ${this.otpEndpoint}\n\nquery {\n` +
      `  plan(\n` +
      `    from: { lat: ${origen.lat}, lon: ${origen.lon} }\n` +
      `    to: { lat: ${destino.lat}, lon: ${destino.lon} }\n` +
      `    date: "${fecha}", time: "${hora}",\n` +
      `    modes: [\n` +
      `      { mode: FLEX, reluctance: ${reluctanceModo} }\n` +
      `    ],\n` +
      `    flexReluctancePerSegment: [\n${porTramo}\n    ]\n` +
      `  ) {\n` +
      `    itineraries { duration generalizedCost legs { mode from { name } to { name } } }\n` +
      `  }\n` +
      `}`;
  }
}
