import type { IngestionAgent } from "./ingesta.js";
import { transcribirAudio, type AudioInput } from "../stt.js";
import type { Reporte } from "../confianza.js";

// Agente intermediario de voz: recibe una nota de voz de WhatsApp, la transcribe
// a texto (STT) y entrega ese texto al Agente de Ingesta, que a su vez lo
// traduce a un reporte y lo "grita" al tramo afectado.
//
// WhatsApp (nota de voz) → TranscripcionAgent → IngestionAgent → SegmentBus.

export type Transcriber = (audio: AudioInput) => Promise<string | null>;

export class TranscripcionAgent {
  constructor(
    private ingesta: IngestionAgent,
    private transcriber: Transcriber = transcribirAudio,
  ) {}

  async recibirNotaDeVoz(
    audio: AudioInput,
    fuente: string,
    timestamp: number = Date.now(),
  ): Promise<Reporte | null> {
    const texto = await this.transcriber(audio);
    if (!texto) return null;
    return this.ingesta.procesarMensaje(texto, fuente, timestamp);
  }
}
