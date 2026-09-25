// Adaptador de LLM (opencode) con fallback determinista.
// Usa el SDK de OpenAI apuntando a la baseURL OpenAI-compatible de opencode
// (OpenCode Zen). Si no hay OPENCODE_API_KEY, generarTexto() devuelve null y
// los agentes usan su lógica determinista. Así el prototipo corre sin LLM.

import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

// Se leen en tiempo de llamada (no al importar) para que cargarDotenv() ya
// haya poblado process.env antes del primer uso.
function config() {
  return {
    key: process.env.OPENCODE_API_KEY?.trim(),
    model: process.env.OPENCODE_MODEL?.trim() || "deepseek-v4-pro",
    baseURL:
      process.env.OPENCODE_BASE_URL?.trim() || "https://opencode.ai/zen/v1",
  };
}

let client: OpenAI | null = null;
function getClient(): OpenAI | null {
  const { key, baseURL } = config();
  if (!key) return null;
  if (!client) client = new OpenAI({ apiKey: key, baseURL });
  return client;
}

export function hayLlm(): boolean {
  return Boolean(config().key);
}

export function nombreModeloLlm(): string {
  return config().model;
}

export interface GenOpts {
  system?: string;
  json?: boolean;
}

export async function generarTexto(
  prompt: string,
  opts: GenOpts = {},
): Promise<string | null> {
  const c = getClient();
  if (!c) return null;

  const messages: ChatCompletionMessageParam[] = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({ role: "user", content: prompt });

  try {
    const res = await c.chat.completions.create({
      model: config().model,
      messages,
      temperature: 0,
      ...(opts.json ? { response_format: { type: "json_object" } } : {}),
    });
    const text = res.choices?.[0]?.message?.content;
    return text ? text.trim() : null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[llm] fallo al consultar opencode: ${msg}`);
    return null;
  }
}
