// CLI: node audit.js --account <id> --from YYYY-MM-DD --to YYYY-MM-DD [--out archivo.json]
// La lógica real vive en audit-core.js (reutilizada también por dashboard-server.js).
const fs = require("fs");
const { runAudit } = require("./audit-core.js");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : fallback;
}

async function main() {
  const accountId = arg("account");
  const from = arg("from");
  const to = arg("to");
  const outFile = arg("out");

  if (!accountId || !from || !to) {
    console.error("Uso: node audit.js --account <id> --from YYYY-MM-DD --to YYYY-MM-DD [--out archivo.json]");
    process.exit(1);
  }

  // runAudit() trata "to" como límite EXCLUSIVO (inRange usa `d >= toDate`), pero el uso de
  // arriba lo documenta como si fuera inclusivo ("--to YYYY-MM-DD") — sin este ajuste, correr
  // con --to 2026-08-05 descartaba en silencio todo lo del 5. Mismo ajuste que ya hace
  // dashboard-server.js para "to" con fecha sin hora.
  const toExclusive = /^\d{4}-\d{2}-\d{2}$/.test(to)
    ? new Date(new Date(to + "T00:00:00Z").getTime() + 24 * 3600 * 1000).toISOString().slice(0, 10)
    : to;

  console.error(`=== Auditoría cuenta ${accountId} | ${from} -> ${to} (hora Bogotá) ===`);
  const reporte = await runAudit(accountId, from, toExclusive, { onProgress: (m) => console.error(m) });

  const json = JSON.stringify(reporte, null, 2);
  if (outFile) {
    fs.writeFileSync(outFile, json);
    console.error(`Reporte guardado en ${outFile}`);
  }
  console.log(json);
}

main().catch((err) => {
  console.error("ERROR:", err.message);
  process.exit(1);
});
