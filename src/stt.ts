import { existsSync, readFileSync } from "node:fs";
import OpenAI, { toFile } from "openai";

// Transcripción de voz (Speech-to-Text) usando Groq (Whisper).
// Recibe un audio (base64 o ruta de archivo) y devuelve el texto transcrito.
// Sin GROQ_API_KEY devuelve null (el agente puede degradar con gracia).

export type AudioInput =
  | { tipo: "base64"; mimeType: string; data: string }
  | { tipo: "archivo"; ruta: string; mimeType?: string };

const BASE_URL = "https://api.groq.com/openai/v1";

// Se leen en tiempo de llamada (no al importar) para que cargarDotenv() ya
// haya poblado process.env antes del primer uso.
function config() {
  return {
    key: process.env.GROQ_API_KEY?.trim(),
    model: process.env.GROQ_STT_MODEL?.trim() || "whisper-large-v3-turbo",
  };
}

let client: OpenAI | null = null;
function getClient(): OpenAI | null {
  const { key } = config();
  if (!key) return null;
  if (!client) client = new OpenAI({ apiKey: key, baseURL: BASE_URL });
  return client;
}

export function hayStt(): boolean {
  return Boolean(config().key);
}

export function nombreModeloStt(): string {
  return config().model;
}

function inferirMime(ruta: string): string {
  const ext = ruta.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "mp3":
      return "audio/mp3";
    case "wav":
      return "audio/wav";
    case "ogg":
    case "oga":
      return "audio/ogg";
    case "m4a":
    case "mp4":
      return "audio/mp4";
    case "aac":
      return "audio/aac";
    default:
      return "audio/ogg";
  }
}

function extensionDe(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case "audio/mp3":
      return "mp3";
    case "audio/wav":
      return "wav";
    case "audio/mp4":
      return "m4a";
    case "audio/aac":
      return "aac";
    default:
      return "ogg";
  }
}

export async function transcribirAudio(
  audio: AudioInput,
): Promise<string | null> {
  const c = getClient();
  if (!c) return null;

  let mimeType: string;
  let data: Buffer;
  if (audio.tipo === "base64") {
    mimeType = audio.mimeType;
    data = Buffer.from(audio.data, "base64");
  } else {
    if (!existsSync(audio.ruta)) {
      throw new Error(`No existe el archivo de audio: ${audio.ruta}`);
    }
    mimeType = audio.mimeType ?? inferirMime(audio.ruta);
    data = readFileSync(audio.ruta);
  }

  try {
    const file = await toFile(
      data,
      `audio.${extensionDe(mimeType)}`,
      { type: mimeType },
    );
    const res = await c.audio.transcriptions.create({
      file,
      model: config().model,
      language: "es",
      temperature: 0,
    });
    return res.text?.trim() ?? null;
  } catch (err) {
    console.error(`[stt] fallo al transcribir con Groq: ${(err as Error).message}`);
    return null;
  }
}
