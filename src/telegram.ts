import { Bot } from "grammy";
import { cargarDotenv } from "./dotenv.js";
import { Recomendador, formatearResultado } from "./recomendador.js";
import { transcribirAudio } from "./stt.js";

// Bot de Telegram: recibe consultas de movilidad por texto o nota de voz y
// responde por el mismo chat con ctx.reply. El pipeline multiagente es el
// mismo que usa la CLI (src/index.ts) vía Recomendador.

cargarDotenv();

const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
if (!token) {
  console.error(
    "TELEGRAM_BOT_TOKEN no está definida. Copia el token de @BotFather en .env (ver .env.example).",
  );
  process.exit(1);
}

const bot = new Bot(token);
const recomendador = new Recomendador();

const logger = (m: string) => console.log(`  [telegram] ${m}`);

async function responder(texto: string): Promise<string> {
  try {
    const rec = await recomendador.recomendarTexto(texto, logger);
    return formatearResultado(rec.resultado, rec.gtfsFuente, rec.geocode);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `No pude procesar tu consulta: ${msg}`;
  }
}

bot.command("start", async (ctx) => {
  await ctx.reply(
    "¡Hola! Soy el orquestador de movilidad de Bogotá.\n" +
      'Escríbeme un texto como "de Quiba Bajo a Mochuelo Alto en 30 min" ' +
      "o envíame una nota de voz.",
  );
});

bot.on("message:text", async (ctx) => {
  const texto = ctx.message.text.trim();
  if (!texto || texto.startsWith("/")) return;
  await ctx.replyWithChatAction("typing");
  const respuesta = await responder(texto);
  await ctx.reply(respuesta);
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
    const respuesta = await responder(texto);
    await ctx.reply(respuesta);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.reply(`No pude procesar la nota de voz: ${msg}`);
  }
});

bot.catch((err) => {
  console.error(`[telegram] error: ${(err as Error).message}`);
});

bot.start({
  onStart: (info) =>
    console.log(`[telegram] bot @${info.username} escuchando…`),
});
