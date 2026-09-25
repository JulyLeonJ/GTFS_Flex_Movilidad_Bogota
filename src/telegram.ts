import { Bot } from "grammy";
import { transcribirAudio } from "./stt.js";
import { manejarMensaje, procesarReporte, urlDeCanal, type Canal, type Deps } from "./conversacion.js";

// Bot de Telegram: recibe mensajes por texto o nota de voz y los clasifica:
//
//   - Consulta de ruta  → responde con la recomendación (ctx.reply).
//   - Reporte           → ingesta al subsistema informal/oficial y persiste en
//     CSV (data/reportes.csv) con fiabilidad baja (canal no verificado).
//
// Regla de clasificación (ver manejarMensaje en conversacion.ts):
//   1. Incidente grave (bloqueo/accidente/derrumbe/…) → reporte.
//   2. Estructura de ruta ("de X a Y") → consulta.
//   3. Señal de estado (demora, lento, fluido, todo bien, …) → reporte.
//   4. En otro caso → se intenta como consulta (el NLU fallará con mensaje
//      claro si no es una ruta válida).

export function iniciarTelegram(deps: Deps, token: string): Bot {
  const bot = new Bot(token);
  const canal = (chatId: number): Canal => ({
    canal: "telegram",
    clave: String(chatId),
    fuenteReportes: "telegram",
  });

  bot.command("start", async (ctx) => {
    await ctx.reply(
      "¡Hola! Soy el orquestador de movilidad de Ciudad Bolívar (Bogotá). Por ahora solo cubro esta localidad.\n" +
        'Pídeme una ruta con "de Quiba Bajo a Mochuelo Alto en 30 min" ' +
        "o envíame una nota de voz.\n" +
        'Para reportar el estado de una vía informal, escribe algo como ' +
        '"bloqueo en Quiba Bajo" (o usa /reporte <descripción>).\n' +
        "Cada ruta que te recomiende trae un enlace a un mapa que se actualiza solo si " +
        "cambias tu consulta (también con /mapa).",
    );
  });

  bot.command("reporte", async (ctx) => {
    const texto = (ctx.match ?? "").trim();
    if (!texto) {
      await ctx.reply(
        "Uso: /reporte <descripción del estado de la vía>. Ej.: /reporte bloqueo en Quiba Bajo",
      );
      return;
    }
    await ctx.reply(await procesarReporte(texto, canal(ctx.chat.id), deps));
  });

  bot.command("mapa", async (ctx) => {
    await ctx.reply(
      urlDeCanal(canal(ctx.chat.id), deps) ??
        'Aún no te he recomendado una ruta. Pídeme una con "de X a Y".',
    );
  });

  bot.on("message:text", async (ctx) => {
    const texto = ctx.message.text.trim();
    if (!texto || texto.startsWith("/")) return;
    await ctx.replyWithChatAction("typing");
    await ctx.reply(await manejarMensaje(texto, canal(ctx.chat.id), deps));
  });

  bot.on("message:voice", async (ctx) => {
    await ctx.replyWithChatAction("typing");
    try {
      const file = await ctx.getFile();
      const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
      const res = await fetch(url);
      if (!res.ok) {
        await ctx.reply("No pude descargar la nota de voz.");
        return;
      }
      const data = Buffer.from(await res.arrayBuffer());
      const texto = await transcribirAudio({
        tipo: "base64",
        mimeType: "audio/ogg",
        data: data.toString("base64"),
      });
      if (!texto) {
        await ctx.reply(
          "No pude transcribir la nota de voz (¿falta GROQ_API_KEY en .env?).",
        );
        return;
      }
      await ctx.reply(await manejarMensaje(texto, canal(ctx.chat.id), deps));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`No pude procesar la nota de voz: ${msg}`);
    }
  });

  bot.catch((err) => {
    console.error(`[telegram] error: ${(err as Error).message}`);
  });

  bot.start({
    onStart: (info) => console.log(`[telegram] bot @${info.username} escuchando…`),
  });
  return bot;
}
