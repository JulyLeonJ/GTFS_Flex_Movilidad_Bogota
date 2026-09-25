import type { SegmentBus } from "../segmentos.js";
import type { Reporte } from "../confianza.js";
import { normalizar } from "../relevancia.js";
import {
  INCIDENTE_FUERTE,
  AFECTACION,
  FLUIDEZ,
  FLUIDEZ_CLARA,
} from "../vocabulario.js";

// Agente de Ingesta: escucha la API de WhatsApp y traduce mensajes asíncronos
// ("Hay un bloqueo en la vía X") a reportes estructurados, que luego "grita"
// al Agente de Tramo afectado vía el bus de mensajes.

export interface FuenteReputacion {
  id: string;
  peso: number;
  descripcion: string;
}

export const REPUTACIONES_DEFECTO: FuenteReputacion[] = [
  { id: "telegram", peso: 0.2, descripcion: "Reporte de Telegram (canal informal, no verificado)" },
  { id: "whatsapp_anonimo", peso: 0.2, descripcion: "WhatsApp anónimo (primera vez)" },
  { id: "usuario_frecuente", peso: 0.5, descripcion: "Usuario frecuente" },
  { id: "validador_comunitario", peso: 0.7, descripcion: "Validador de emisora comunitaria" },
  { id: "conductor_red", peso: 1.0, descripcion: "Conductor red incentivada (ETB/Rappi)" },
];

// Peso/reputación (0..1) de una fuente por su id. Desconocida → 0.2.
export function pesoDeFuente(fuente: string): number {
  return REPUTACIONES_DEFECTO.find((r) => r.id === fuente)?.peso ?? 0.2;
}

const NEGATIVO_FUERTE = INCIDENTE_FUERTE;
const NEGATIVO = AFECTACION;
const POSITIVO = FLUIDEZ;
// Señales positivas no ambiguas para clasificar un mensaje como reporte.
const POSITIVO_CLARO = FLUIDEZ_CLARA;

export interface Traduccion {
  segmento: string;
  valor: number;
}

export class IngestionAgent {
  private reputaciones: Map<string, number>;

  constructor(
    private bus: SegmentBus,
    private nombres: { id: string; nombre: string }[],
    reputaciones?: FuenteReputacion[],
  ) {
    this.reputaciones = new Map(
      (reputaciones ?? REPUTACIONES_DEFECTO).map((r) => [r.id, r.peso]),
    );
  }

  // Traduce el mensaje, resuelve el peso de la fuente y publica al tramo.
  procesarMensaje(
    texto: string,
    fuente: string,
    timestamp: number = Date.now(),
  ): Reporte | null {
    const t = this.traducir(texto);
    if (!t) return null;
    const peso = this.reputaciones.get(fuente) ?? 0.1;
    const reporte: Reporte = {
      segmento: t.segmento,
      fuente,
      valor: t.valor,
      peso,
      timestamp,
      texto,
    };
    this.bus.publicar(reporte);
    return reporte;
  }

  traducir(texto: string): Traduccion | null {
    const seg = this.identificarSegmento(texto);
    if (!seg) return null;
    return { segmento: seg, valor: this.polaridad(texto) };
  }

  polaridad(texto: string): number {
    const t = normalizar(texto);
    if (NEGATIVO_FUERTE.some((k) => t.includes(k))) return -2;
    if (NEGATIVO.some((k) => t.includes(k))) return -1.5;
    if (POSITIVO.some((k) => t.includes(k))) return 1;
    return 0.5; // señal débil por defecto
  }

  identificarSegmento(texto: string): string | null {
    const t = normalizar(texto);
    for (const s of this.nombres) {
      if (t.includes(normalizar(s.nombre))) return s.id;
      if (t.includes(normalizar(s.id))) return s.id;
    }
    return null;
  }

  // ¿El texto es un reporte (estado de un tramo informal) y no una consulta?
  // Requiere una señal de estado (positiva o negativa), aunque NO mencione un
  // tramo conocido. No tiene efectos secundarios (solo clasifica).
  esReporte(texto: string): boolean {
    const t = normalizar(texto);
    return (
      NEGATIVO_FUERTE.some((k) => t.includes(k)) ||
      NEGATIVO.some((k) => t.includes(k)) ||
      POSITIVO_CLARO.some((k) => t.includes(k))
    );
  }

  // ¿Es un incidente grave (bloqueo/accidente/derrumbe/…)? Estas señales son
  // tan inequívocas que ganan sobre la estructura de ruta en la clasificación.
  esIncidenteFuerte(texto: string): boolean {
    const t = normalizar(texto);
    return NEGATIVO_FUERTE.some((k) => t.includes(k));
  }
}
