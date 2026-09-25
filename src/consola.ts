import { createInterface } from "node:readline";
import { manejarMensaje, urlDeCanal, type Canal, type Deps } from "./conversacion.js";

// Consola interactiva (REPL): mismo flujo que Telegram, con una sesión fija
// ("consola:local"), para probar la integración con el mapa sin el bot.
export function iniciarConsola(deps: Deps): void {
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "tú> " });
  const canal: Canal = { canal: "consola", clave: "local", fuenteReportes: "usuario_frecuente" };
  console.log(
    'Consola lista (solo Ciudad Bolívar). Ej.: "de Portal Tunal a Mirador del Paraiso", "a las 18:30", "accidente en Casalinda", /mapa, salir',
  );
  rl.prompt();
  rl.on("line", async (linea) => {
    const t = linea.trim();
    if (t === "salir") return rl.close();
    if (t === "/mapa") console.log(urlDeCanal(canal, deps) ?? "(aún sin ruta)");
    else if (t) console.log(`\nagente> ${await manejarMensaje(t, canal, deps)}\n`);
    rl.prompt();
  });
  rl.on("close", () => process.kill(process.pid, "SIGINT"));
}
