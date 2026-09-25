import { cacheZip, descargarGtfs, descubrirGtfsOficial, escribirMeta } from "./gtfs-source.js";

// Descarga el GTFS oficial del SITP y lo deja en caché para que el enrutador
// lo use automáticamente. Uso: `npm run gtfs:sync`.
async function main(): Promise<void> {
  console.log("Buscando el GTFS oficial del SITP…");
  const oficial = await descubrirGtfsOficial((m) => console.log(`  ${m}`));
  if (!oficial) {
    console.error("No se encontró el GTFS oficial en el hub de TransMilenio.");
    process.exit(1);
  }
  await descargarGtfs(oficial.url, cacheZip(), (m) => console.log(`  ${m}`));
  escribirMeta({ url: oficial.url, titulo: oficial.titulo });
  console.log("Listo. El enrutador usará el GTFS oficial automáticamente.");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
