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

  console.error(`=== Auditoría cuenta ${accountId} | ${from} -> ${to} (hora Bogotá) ===`);
  const reporte = await runAudit(accountId, from, to, { onProgress: (m) => console.error(m) });

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
