import type { Agent, AgentContext } from "../agent.js";
import { FatalAgentError } from "../agent.js";
import { generarTexto, hayLlm } from "../llm.js";
import { horaASeg } from "../util.js";
import type { ConsultaNormalizada } from "../types.js";

// Convierte la consulta (ya sea estructurada desde CLI o texto libre)
// en una ConsultaNormalizada. Preferimos la vía determinista cuando vienen
// flags explícitos; el LLM solo se usa para texto libre y con fallback regex.
export class NluAgent implements Agent {
  readonly name = "nlu";

  async run(ctx: AgentContext): Promise<void> {
    const origen = (ctx.state.rawOrigen as string | undefined) ?? "";
    const destino = (ctx.state.rawDestino as string | undefined) ?? "";
    const tiempoRaw = (ctx.state.rawTiempo as string | undefined) ?? "";
    const horaRaw = (ctx.state.rawHora as string | undefined) ?? "";
    const libre = (ctx.state.textoLibre as string | undefined) ?? "";

    let consulta: ConsultaNormalizada;

    if (origen || destino) {
      // Flags estructurados: además del flag --tiempo, extraemos el tiempo si
      // vino pegado al origen o al destino ("... en 30 minutos").
      const o = extraerTiempo(origen);
      const d = extraerTiempo(destino);
      const t = parseTiempo(tiempoRaw);
      consulta = {
        origenTexto: o.texto,
        destinoTexto: d.texto,
        tiempoMin: t ?? o.tiempoMin ?? d.tiempoMin ?? 30,
      };
    } else if (libre) {
      const previa = ctx.state.consultaPrevia as ConsultaNormalizada | undefined;
      consulta = previa
        ? await this.parseSeguimiento(libre, previa)
        : await this.parseLibre(libre);
    } else {
      throw new FatalAgentError(
        "Sin consulta: usa --origen/--destino o un texto libre con --texto.",
      );
    }

    ctx.state.consulta = consulta;

    // Hora de salida: prioriza --hora (HH:MM); si no, intenta extraerla del texto.
    const hora =
      horaASeg(horaRaw) ??
      extraerHora(`${origen} ${destino} ${tiempoRaw} ${libre}`);
    if (hora !== null) consulta.salidaSeg = hora;

    ctx.log(
      `consulta normalizada: "${consulta.origenTexto}" → "${consulta.destinoTexto}" (${consulta.tiempoMin} min${consulta.salidaSeg !== undefined ? `, salida ${consulta.salidaSeg}` : ""})`,
    );
  }

  private async parseLibre(texto: string): Promise<ConsultaNormalizada> {
    if (hayLlm()) {
      const raw = await generarTexto(
        `Extrae origen, destino y tiempo disponible (minutos) del texto. ` +
          `Devuelve SOLO JSON con claves "origen", "destino", "tiempoMin".\nTexto: ${texto}`,
        { system: "Eres un extractor de consultas de movilidad. Sé exacto.", json: true },
      );
      if (raw) {
        try {
          const j = JSON.parse(raw) as {
            origen?: string;
            destino?: string;
            tiempoMin?: number;
          };
          if (j.origen && j.destino) {
            return {
              origenTexto: j.origen,
              destinoTexto: j.destino,
              tiempoMin: typeof j.tiempoMin === "number" ? j.tiempoMin : 30,
            };
          }
        } catch {
          // cae al fallback
        }
      }
    }
    return this.fallback(texto);
  }

  private fallback(texto: string): ConsultaNormalizada {
    const { texto: resto, tiempoMin } = extraerTiempo(quitarHora(texto));
    const m = resto.match(/^(?:de\s+)?(.+?)\s+a\s+(.+)$/i);
    if (m && m[1].trim() && m[2].trim()) {
      return {
        origenTexto: m[1].trim(),
        destinoTexto: m[2].trim(),
        tiempoMin: tiempoMin ?? 30,
      };
    }
    throw new FatalAgentError(
      `No pude interpretar el texto libre: "${texto}". Usa la forma "de ORIGEN a DESTINO en N min".`,
    );
  }

  private async parseSeguimiento(
    texto: string,
    previa: ConsultaNormalizada,
  ): Promise<ConsultaNormalizada> {
    if (hayLlm()) {
      const raw = await generarTexto(
        `Consulta previa: origen "${previa.origenTexto}", destino "${previa.destinoTexto}". ` +
          `Mensaje nuevo del usuario (puede cambiar origen, destino y/o hora): "${texto}". ` +
          `Devuelve SOLO JSON con claves "origen", "destino", "tiempoMin", "hora".`,
        { system: "Eres un extractor de consultas de movilidad de seguimiento. Sé exacto.", json: true },
      );
      if (raw) {
        try {
          const j = JSON.parse(raw) as {
            origen?: string;
            destino?: string;
            tiempoMin?: number;
            hora?: string;
          };
          if (j.origen && j.destino) {
            return {
              origenTexto: j.origen,
              destinoTexto: j.destino,
              tiempoMin: typeof j.tiempoMin === "number" ? j.tiempoMin : previa.tiempoMin,
              salidaSeg: horaASeg(j.hora ?? "") ?? undefined,
            };
          }
        } catch {
          // cae al fallback determinista
        }
      }
    }

    const sinHora = quitarHora(texto);
    if (/\bde\s+.+\s+a\s+.+/i.test(sinHora)) return this.fallback(texto);

    const { texto: resto, tiempoMin } = extraerTiempo(sinHora);
    const origen = resto.match(
      /\b(?:desde|salgo de|saliendo de|parto de)\s+(?:el\s+|la\s+)?(.+?)(?=\s+(?:hasta|hacia|para)\s+|$)/i,
    )?.[1]?.trim();
    const destino = resto.match(
      /\b(?:hasta|hacia|para|voy a|ir a|llegar a)\s+(?:el\s+|la\s+)?(.+)$/i,
    )?.[1]?.trim();

    if (!origen && !destino && tiempoMin === null && extraerHora(texto) === null) {
      throw new FatalAgentError(
        `No entendí el cambio. Sigo con "${previa.origenTexto}" → "${previa.destinoTexto}"; dime qué quieres cambiar (origen, destino, hora o tiempo).`,
      );
    }

    return {
      origenTexto: origen ?? previa.origenTexto,
      destinoTexto: destino ?? previa.destinoTexto,
      tiempoMin: tiempoMin ?? previa.tiempoMin,
      salidaSeg: previa.salidaSeg,
    };
  }
}

function parseTiempo(raw: string): number | null {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function quitarHora(texto: string): string {
  return texto
    .replace(
      /\b(?:a\s+las?\s+|al\s+|a\s+)?(?:\d{1,2}:\d{2}|media\s*noche|medianoche|medio\s*d[ií]a|mediod[ií]a)\b/gi,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}

// Extrae una hora de salida de un texto ("a las 23:30", "media noche", "mediodía").
function extraerHora(texto: string): number | null {
  const t = texto.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (/\bmedianoche\b/.test(t)) return 0;
  if (/\bmediodia\b/.test(t)) return 12 * 3600;
  const m = texto.match(/\b(\d{1,2}):(\d{2})\b/);
  return m ? horaASeg(`${m[1]}:${m[2]}`) : null;
}

// Extrae un tiempo expresado como "... en N min/minutos/horas" (opcionalmente
// con "en"). Devuelve el texto sin el tiempo y el tiempo en minutos (o null).
function extraerTiempo(texto: string): { texto: string; tiempoMin: number | null } {
  const m = texto.match(
    /\s*(?:en\s+)?(\d+(?:[.,]\d+)?)\s*(min(?:uto)?s?|horas?|h)\b\s*$/i,
  );
  if (!m) return { texto: texto.trim(), tiempoMin: null };
  const n = Number(m[1].replace(",", "."));
  const unidad = m[2].toLowerCase();
  const minutos = unidad.startsWith("h") ? n * 60 : n;
  return {
    texto: texto.slice(0, m.index).trim(),
    tiempoMin: Number.isFinite(minutos) && minutos > 0 ? Math.round(minutos) : null,
  };
}
