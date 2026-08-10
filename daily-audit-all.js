// Corre la auditoría cuantitativa (100% API, sin login) para TODAS las cuentas
// guardadas en accounts.local.json, ventana 7:00 AM Bogotá de ayer -> 7:00 AM de hoy.
// Guarda JSON + .docx en Informes/auditorias/ y sale con un resumen por cuenta.
//
// Uso: node daily-audit-all.js
const fs = require("fs");
const path = require("path");
const { runAudit } = require("./audit-core.js");
const { buildDocxBuffer } = require("./report-generator.js");
const { slugify, utcToBogotaString } = require("./lib.js");

const ACCOUNTS_FILE = path.join(__dirname, "accounts.local.json");
const AUDITS_DIR = path.join(__dirname, "Informes", "auditorias");
if (!fs.existsSync(AUDITS_DIR)) fs.mkdirSync(AUDITS_DIR, { recursive: true });

// Offset de Bogotá centralizado en lib.js (utcToBogotaString) — antes se repetía el literal
// "5 * 3600 * 1000" acá; si se desalinea con el resto del código, la ventana de la auditoría
// nocturna (que corre sin supervisión) se corre una hora respecto al resto del sistema.
function bogotaWindow7amTo7am() {
  const todayStr = utcToBogotaString(new Date()).slice(0, 10); // fecha Bogotá de "hoy"
  const to = `${todayStr} 07:00`;
  const yesterday = new Date(new Date(`${todayStr}T00:00:00Z`).getTime() - 24 * 3600 * 1000);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);
  const from = `${yesterdayStr} 07:00`;
  return { from, to, fileDateSlug: yesterdayStr }; // el archivo se nombra con el día que arrancó la ventana
}

function storeDir(info) {
  const dir = path.join(AUDITS_DIR, info.slug || slugify(info.name));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function auditFilePath(accountId, dateSlug, info) {
  return path.join(storeDir(info), `${accountId}_${dateSlug}.json`);
}

async function main() {
  const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8"));
  const { from, to, fileDateSlug } = bogotaWindow7amTo7am();
  console.log(`Ventana: ${from} -> ${to} (hora Bogotá)\n`);

  const resumen = [];
  for (const [accountId, info] of Object.entries(accounts)) {
    process.stdout.write(`Auditando ${info.name} (acc=${accountId})... `);
    try {
      const reporte = await runAudit(accountId, from, to);
      fs.writeFileSync(auditFilePath(accountId, fileDateSlug, info), JSON.stringify(reporte, null, 2));

      const qPath = path.join(storeDir(info), `${accountId}_${fileDateSlug}_qualitative.json`);
      const qualitative = fs.existsSync(qPath) ? JSON.parse(fs.readFileSync(qPath, "utf8")) : null;
      // Antes solo pasaba mensajesLucidSales — si ya existía un JSON de análisis cualitativo en
      // disco (de una corrida manual anterior) el .docx nocturno se generaba sin
      // pedidosLucidSales/diagnosticoCualitativo, mostrando esas secciones como "sin datos"
      // aunque el dato real ya existiera (dashboard-server.js /api/report sí los pasa).
      const buf = await buildDocxBuffer(reporte, {
        accountName: info.name,
        mensajesLucidSales: qualitative?.mensajes_lucid_sales || null,
        pedidosLucidSales: qualitative?.pedidos_lucid_sales || null,
        diagnosticoCualitativo: qualitative?.diagnostico_cualitativo || null,
      });
      const fname = `Auditoria_${info.slug || slugify(info.name)}_${fileDateSlug}.docx`;
      fs.writeFileSync(path.join(storeDir(info), fname), buf);

      console.log("OK");
      resumen.push({
        cuenta: info.name,
        contactos: reporte.total_contactos,
        ventas: reporte.ventas.cantidad,
        valor_total: reporte.ventas.valor_total,
        conversion_pct: reporte.conversion_pct,
        errores_subida: reporte.errores_subida.cantidad,
        docx: fname,
      });
    } catch (err) {
      console.log("ERROR: " + err.message);
      resumen.push({ cuenta: info.name, error: err.message });
    }
  }

  console.log("\n=== Resumen ===");
  console.log(JSON.stringify(resumen, null, 2));
  console.log("\nNota: este resumen es 100% cuantitativo (API). El análisis cualitativo por producto y los");
  console.log("mensajes reales de Lucid Sales NO se incluyen aquí — requieren sesión de navegador logueada");
  console.log("(ver COMO_USAR.md, secciones 4 y 5) y deben pedirse explícitamente.");
}

main().catch((err) => {
  console.error("ERROR FATAL:", err.message);
  process.exit(1);
});
