import type { Agent, AgentContext } from "../agent.js";
import { generarTexto, hayLlm } from "../llm.js";
import type { ConsultaNormalizada, OpcionRuta, TramoGeo } from "../types.js";

// Agente de último recurso: cuando no hay rutas oficiales ni informales
// recientes (por WhatsApp), usa el LLM para rastrear conocimiento comunitario
// histórico —grupos de vecinos, juntas de acción comunal, publicaciones de
// Facebook, habitantes del destino— y convertirlo en una recomendación de BAJA
// confianza pero útil. En producción esto se apoyaría en una búsqueda web/RAG
// sobre contenido comunitario; aquí el LLM sintetiza su conocimiento.

const CONFIANZA_HISTORICA = 0.25; // baja confianza: no verificado en tiempo real

interface DatosHistoricos {
  existe: boolean;
  descripcion?: string;
  tiempoEstimadoMin?: number;
  nota?: string;
}

export class ConocimientoComunitarioAgent implements Agent {
  readonly name = "conocimiento_comunitario";

  async run(ctx: AgentContext): Promise<void> {
    const consulta = ctx.state.consulta as ConsultaNormalizada;
    const opciones = (ctx.state.opciones as OpcionRuta[] | undefined) ?? [];

    if (opciones.length > 0) {
      ctx.log("ya hay opciones oficiales/informales; se omite la búsqueda comunitaria");
      return;
    }

    const op = await this.investigar(consulta, ctx.log);
    if (op) {
      ctx.state.opciones = [op];
      ctx.log("recomendación comunitaria histórica (baja confianza) añadida");
    } else {
      ctx.log("sin opción de conocimiento comunitario");
    }
  }

  private async investigar(
    consulta: ConsultaNormalizada,
    log: (m: string) => void,
  ): Promise<OpcionRuta | null> {
    if (!hayLlm()) {
      log("sin LLM (OPENCODE_API_KEY): no se puede investigar");
      return null;
    }
    const raw = await generarTexto(
      `¿Cómo llega la gente al sector "${consulta.destinoTexto}" desde "${consulta.origenTexto}" ` +
        `en Bogotá (Ciudad Bolívar) usando transporte informal (colectivo, mototaxi, chiva, bicitaxi)? ` +
        `Busca en tu conocimiento de grupos comunitarios, juntas de acción comunal, grupos de Facebook ` +
        `y publicaciones de habitantes. Responde SOLO JSON con claves: "existe" (boolean), ` +
        `"descripcion" (string corto: vehículo y punto de abordaje), "tiempoEstimadoMin" (number), ` +
        `"nota" (string con advertencia). Propón la opción más citada por la comunidad aunque sea ` +
        `aproximada; solo devuelve "existe": false si realmente no conoces ninguna.`,
      {
        system:
          "Eres un investigador de movilidad informal en Bogotá. Usa el conocimiento comunitario " +
          "(juntas de acción comunal, grupos de Facebook, vecinos) para proponer la opción informal " +
          "más probable hacia el destino rural. Marca con claridad la incertidumbre en la nota.",
        json: true,
      },
    );
    if (!raw) {
      log("el LLM no respondió; no se pudo investigar");
      return null;
    }
    const datos = extraerJson<DatosHistoricos>(raw);
    if (!datos) {
      log("respuesta del LLM no interpretable como JSON");
      return null;
    }
    if (!datos.existe || !datos.descripcion) {
      log(
        `el LLM no halló evidencia de ruta informal${datos.nota ? ` — ${datos.nota}` : ""}`,
      );
      return null;
    }
    log(`LLM halló conocimiento comunitario: "${datos.descripcion}"`);
    return this.construir(consulta, datos);
  }

  private construir(consulta: ConsultaNormalizada, datos: DatosHistoricos): OpcionRuta {
    const tiempo = Math.max(5, Math.round(datos.tiempoEstimadoMin ?? 30));
    const desc = datos.descripcion!.trim();
    const nota = datos.nota?.trim() || "Conocimiento histórico no verificado en tiempo real";
    const o = consulta.origenPunto;
    const d = consulta.destinoPunto;
    const tramos: TramoGeo[] | undefined =
      o && d
        ? [{ modo: "comunitaria", etiqueta: desc, geometria: "recta", coords: [[o.lon, o.lat], [d.lon, d.lat]] }]
        : undefined;
    return {
      tipo: "directa",
      resumen: `Colectivo histórico (comunidad): ${desc}`,
      paradaOrigen: consulta.origenTexto,
      paradaDestino: consulta.destinoTexto,
      pasos: [
        `Preguntar a los residentes por ${desc}`,
        "Abordar el vehículo informal identificado en el punto de encuentro",
        nota,
      ],
      rutasUsadas: [desc],
      tiempoEstimadoMin: tiempo,
      caminataMts: 0,
      puntaje: (1000 / (1 + tiempo)) * CONFIANZA_HISTORICA,
      fuente: "comunitaria",
      confianza: CONFIANZA_HISTORICA,
      tramos,
    };
  }
}

// Extrae un objeto JSON de la respuesta del LLM (tolera cercos de markdown).
function extraerJson<T>(texto: string): T | null {
  const limpio = texto.replace(/```(?:json)?/gi, "").trim();
  const inicio = limpio.indexOf("{");
  const fin = limpio.lastIndexOf("}");
  if (inicio === -1 || fin === -1 || fin <= inicio) return null;
  try {
    return JSON.parse(limpio.slice(inicio, fin + 1)) as T;
  } catch {
    return null;
  }
}
