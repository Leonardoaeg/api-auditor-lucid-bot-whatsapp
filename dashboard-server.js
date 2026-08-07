// Dashboard local de auditoría Lucid Bot.
// Uso: node dashboard-server.js  ->  abre http://localhost:4545
const http = require("http");
const fs = require("fs");
const path = require("path");
const { runAudit } = require("./audit-core.js");
const { buildDocxBuffer } = require("./report-generator.js");

const PORT = 4545;
const ACCOUNTS_FILE = path.join(__dirname, "accounts.local.json");
const AUDITS_DIR = path.join(__dirname, "Informes", "auditorias");
if (!fs.existsSync(AUDITS_DIR)) fs.mkdirSync(AUDITS_DIR, { recursive: true });

function readAccounts() {
  return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8"));
}
function writeAccounts(accounts) {
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
}
function slugify(s) {
  return String(s).trim().replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "Tienda";
}

function getAccountsPublic() {
  const accounts = readAccounts();
  return Object.entries(accounts).map(([id, a]) => ({
    id, name: a.name, slug: a.slug || slugify(a.name), lucidSalesStoreName: a.lucidSalesStoreName || a.name, hasToken: !!a.token,
  }));
}
function getAccount(id) {
  const accounts = readAccounts();
  return accounts[id];
}
function getAccountName(id) {
  return getAccount(id)?.name || id;
}
function getAccountSlug(id) {
  const a = getAccount(id);
  return a?.slug || slugify(a?.name || id);
}

function storeDir(accountId) {
  const dir = path.join(AUDITS_DIR, getAccountSlug(accountId));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Rango de un solo día calendario completo (00:00 a 00:00 del día siguiente) -> se etiqueta con
// el día que cubre ("from"), como siempre. Cualquier otro caso (rango de varios días, o "hasta
// ahora") se etiqueta con la fecha de "to" -- el día en que realmente se corrió la auditoría --
// para que dos corridas del mismo "from" en días distintos NO se pisen entre sí (antes ambas
// caían en el mismo archivo "{from}.json", perdiendo la auditoría anterior). Pedido explícito
// 2026-08-03: "debería aparecer fecha de auditoría el 3 pero el rango sí desde el 1 al 3".
function computeDateSlug(from, to) {
  const fromStr = String(from);
  const fromDate = fromStr.slice(0, 10);
  const fromTime = fromStr.length > 10 ? fromStr.slice(11, 16) : "00:00";
  const toDate = String(to).slice(0, 10);
  if (fromTime === "00:00") {
    const next = new Date(fromDate + "T00:00:00Z");
    next.setUTCDate(next.getUTCDate() + 1);
    if (next.toISOString().slice(0, 10) === toDate) return fromDate;
  }
  return toDate;
}

function auditFilePath(accountId, dateSlugOrFrom) {
  const dateSlug = String(dateSlugOrFrom).slice(0, 10);
  return path.join(storeDir(accountId), `${accountId}_${dateSlug}.json`);
}
function qualitativeFilePath(accountId, dateSlugOrFrom) {
  const dateSlug = String(dateSlugOrFrom).slice(0, 10);
  return path.join(storeDir(accountId), `${accountId}_${dateSlug}_qualitative.json`);
}
function requestsLogPath(accountId) {
  return path.join(storeDir(accountId), "solicitudes_analisis_cualitativo.md");
}

function buildQualitativePrompt({ accountId, accountName, from }) {
  const dateSlug = String(from).slice(0, 10);
  const slug = getAccountSlug(accountId);
  const auditFile = `Informes/auditorias/${slug}/${accountId}_${dateSlug}.json`;
  const qualFile = `Informes/auditorias/${slug}/${accountId}_${dateSlug}_qualitative.json`;
  return [
    `Haz el análisis completo (cualitativo por producto + mensajes reales) de la auditoría de Lucid Bot ya guardada en ${auditFile} (cuenta: ${accountName}, acc=${accountId}, fecha: ${dateSlug}).`,
    ``,
    `PARTE 1 — Cualitativo: lee vía Browser tool cada chat listado en "revision_dirigida" de ese JSON (usa el link_panel de cada uno). Para cada uno determina: si la venta tiene cita textual de confirmación, por qué no cerró (mensaje inicial / cierre / reglas del bot), y a qué producto corresponde. OJO: para cualquier "datos_sin_confirmar" donde el chat SÍ muestre confirmación explícita del cliente, revisa los custom_fields del contacto (Mensaje_lucidsales, Estado_pedido, Etiquetas) — puede ser el mismo bug de "confirmada_no_subida" ya visto antes (ver memoria: venta perdida por falla técnica), no un abandono real.`,
    ``,
    `PARTE 2 — Mensajes reales (Lucid Sales): entra a panel.lucidsales.co/metricas con la sesión ya logueada del usuario (si no está logueada, pídele que inicie sesión — nunca guardes ni pidas su contraseña). Si el usuario audita varias tiendas, es UNA SOLA cuenta de Lucid Sales para todas ellas — lo que cambia es la tienda ACTIVA dentro de esa cuenta, seleccionable con el switcher arriba a la izquierda (clic en el nombre de la tienda actual). ⚠️ PASO CRÍTICO: antes de pedir métricas, verifica con get_page_text que los productos mostrados en /metricas corresponden a "${accountName}" (compara contra los nombres de producto que ya aparecen en ${auditFile} → por_producto) — si no coinciden, abre el switcher y selecciónala (el buscador de texto puede fallar si el nombre registrado no es literalmente "${accountName}", así que si la búsqueda no encuentra nada, limpia el campo y revisa la lista completa en vez de asumir que falta acceso). El número de shopId en la URL (ej. /b/meta/metrics/1) NO identifica la tienda — la tienda activa se controla por ese switcher, no por la URL. Una vez confirmada la tienda correcta, usa javascript_tool para hacer fetch('/b/meta/metrics/1?page=1&itemsPerPage=200&search=&filters=%5B%5D&startDate=${dateSlug}&endDate=FECHA_FIN', {credentials:'include', headers:{'x-token': localStorage.getItem('token')}}) (ajusta startDate/endDate al rango real). Antes de confiar en el resultado, revisa GET /b/meta/insights/last (lastSync) y si está atrasado, haz clic en "Sincronizar Insights" en la UI y vuelve a consultar.`,
    ``,
    `PARTE 3 — Reconciliación por producto: la tabla de /metricas de Lucid Sales tiene una columna "Producto" y una columna "Mensajes" por cada fila de anuncio. Agrupa y suma "Mensajes" por producto (mismo nombre que usa Lucid Bot) para poder comparar contra los "contactos"/"mensajes" de Lucid Bot en ${auditFile} → por_producto. Esto alimenta la sección "Reconciliación Meta ↔ Lucid Bot" del informe.`,
    ``,
    `PARTE 4 — Pedidos y confirmación REAL por producto (Lucid Sales): entra a panel.lucidsales.co/metricas-lucidsales (con la sesión ya logueada, misma tienda verificada en PARTE 2). Pon el filtro de fecha exacto en "${dateSlug}" (usa "Ayer"/calendario si aplica, o el rango exacto del from/to de esta auditoría). Usa el filtro "Producto" (ícono de embudo junto al botón "Producto") para seleccionar UN producto a la vez de la lista que use el mismo nombre que Lucid Bot y lee con get_page_text la tarjeta "Pedidos totales" (número) y "Confirmación de pedidos" (Confirmado / Por confirmar / Cancelado, con cantidad y %). Repite para cada producto relevante de ${auditFile} → por_producto (prioriza los que tengan ventas o errores en revision_dirigida). ⚠️ IMPORTANTE: "Pedidos totales" de Lucid Sales es la fuente MÁS CONFIABLE del producto real vendido — si difiere de las "ventas" que Lucid Bot atribuye a ese producto (vía Producto Interesado _ Ad ID), es señal de un bug de atribución/plantilla mezclando productos: la diferencia probablemente aparece como pedidos "de más" en otro producto relacionado (revisa cuál producto del mismo catálogo podría estar absorbiendo esas ventas). Documenta cualquier discrepancia encontrada como hallazgo explícito.`,
    ``,
    `PARTE 5 — Diagnóstico cualitativo por producto (rúbrica de causa raíz, con chats reales): el motor estadístico automático solo cuenta números — nunca lee lo que realmente se dice. Esta parte SÍ lee conversaciones reales para determinar la causa raíz real, no solo una hipótesis. Usa ${auditFile} → muestra_cualitativa.por_producto — YA viene precalculada (muestreo estratificado 10%, reproducible) con exactamente qué contact_id leer por producto, separados en "casos_precio_reglas" (prueban objeción de precio / reglas del bot) y "casos_mensaje_inicial" (prueban si el contenido del mensaje de bienvenida en sí funciona). NO improvises la muestra ni leas contactos fuera de esta lista — así el resultado es reproducible entre corridas.`,
    `Para cada caso de la muestra, abre el chat real (link_panel) vía Browser tool y clasifica en EXACTAMENTE UNA de estas 7 causas, con una cita textual literal como evidencia (nunca inventes ni resumas de más — cita las palabras reales):`,
    `  - mensaje_inicial_contenido: el mensaje de bienvenida (texto/imagen/video) SÍ llegó pero no genera interés real — evalúa si el contenido es claro, atractivo, y coincide con lo que promete el anuncio que originó el clic.`,
    `  - objecion_precio: la persona avanzaba bien (mostraba interés, daba datos) pero se queda en silencio justo DESPUÉS de que el bot da el precio — el precio es el punto de quiebre visible en la conversación.`,
    `  - bot_error_contexto: el bot da un dato incorrecto (color, talla, disponibilidad, información que contradice lo real o lo que el cliente ya dijo).`,
    `  - bot_alucina: el bot inventa información que no está en las reglas/catálogo del producto (promesas, políticas, o datos que no deberían existir).`,
    `  - bot_incoherente: el cliente pregunta algo puntual y la respuesta del bot no tiene relación real con la pregunta.`,
    `  - bot_abandona_conversacion: el bot no insiste ni intenta retomar o cerrar — deja ir al cliente sin manejar la objeción ni ofrecer alternativa (ej. "avísame si luego lo quieres, ¡gracias!" sin más).`,
    `  - leads_baja_calidad: hay bastante interacción/preguntas genuinas pero nunca hay intención real de compra en ningún momento — apunta a la audiencia del anuncio, no al bot ni al mensaje.`,
    `  - Si un caso no encaja claramente en ninguna, usa "sin_causa_clara" y explica por qué en 1 línea — no fuerces una categoría.`,
    `Al terminar cada producto, cuenta cuántos casos cayeron en cada causa y reporta la causa DOMINANTE (la más frecuente) como el veredicto cualitativo de ese producto — respetando la "confianza" ya calculada en muestra_cualitativa (baja/media/alta según el tamaño de muestra) al describir qué tan seguro es ese veredicto.`,
    ``,
    `Guarda TODO el resultado en ${qualFile} con el formato { "hallazgos": [...], "causa_raiz_por_producto": {...}, "diagnostico_cualitativo": { "por_producto": { "<producto>": { "confianza": "baja|media|alta", "muestra_n": N, "pool_total": N, "causa_dominante": "<una de las 7, o sin_causa_clara>", "causas": { "mensaje_inicial_contenido": N, "objecion_precio": N, "bot_error_contexto": N, "bot_alucina": N, "bot_incoherente": N, "bot_abandona_conversacion": N, "leads_baja_calidad": N, "sin_causa_clara": N }, "casos": [ { "contact_id": "...", "causa": "...", "cita": "texto literal del chat", "link_panel": "..." } ] } } }, "mensajes_lucid_sales": { "fuente": "...", "total_mensajes_anuncio": N, "detalle": "...", "por_producto": [{ "producto": "...", "mensajes": N }] }, "pedidos_lucid_sales": { "fecha": "${dateSlug}", "por_producto": [{ "producto": "...", "pedidos_totales": N, "confirmado": N, "por_confirmar": N, "cancelado": N }] } } (plantilla de ejemplo: Informes/auditorias/TEMPLATE_qualitative.json).`,
    `Al terminar, avísame con un resumen de los hallazgos más importantes.`,
  ].join("\n");
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  try {
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const file = path.join(__dirname, "public", "dashboard.html");
      const body = fs.readFileSync(file);
      res.writeHead(200, { "Content-Type": MIME[".html"] });
      return res.end(body);
    }

    if (url.pathname === "/api/accounts" && req.method === "GET") {
      return sendJson(res, 200, getAccountsPublic());
    }

    if (url.pathname === "/api/audit" && req.method === "POST") {
      const { accountId, from, to } = await readBody(req);
      if (!accountId || !from || !to) return sendJson(res, 400, { error: "Faltan accountId, from o to" });
      // El dashboard trata "Hasta" como fecha INCLUSIVA (selector de calendario);
      // runAudit espera un límite exclusivo, así que si "to" es solo fecha (sin hora)
      // avanzamos un día para cubrir el día completo seleccionado.
      const toExclusive = /^\d{4}-\d{2}-\d{2}$/.test(to)
        ? new Date(new Date(to + "T00:00:00Z").getTime() + 24 * 3600 * 1000).toISOString().slice(0, 10)
        : to;
      const reporte = await runAudit(accountId, from, toExclusive);
      const dateSlug = computeDateSlug(from, toExclusive);
      fs.writeFileSync(auditFilePath(accountId, dateSlug), JSON.stringify(reporte, null, 2));
      const qPath = qualitativeFilePath(accountId, dateSlug);
      const qualitative = fs.existsSync(qPath) ? JSON.parse(fs.readFileSync(qPath, "utf8")) : null;
      return sendJson(res, 200, { reporte, accountName: getAccountName(accountId), qualitative, fecha_guardado: dateSlug });
    }

    if (url.pathname === "/api/report" && req.method === "GET") {
      const accountId = url.searchParams.get("accountId");
      const from = url.searchParams.get("from");
      if (!accountId || !from) return sendJson(res, 400, { error: "Faltan accountId o from" });
      const auditPath = auditFilePath(accountId, from);
      if (!fs.existsSync(auditPath)) return sendJson(res, 404, { error: "Corre la auditoría primero (no hay JSON guardado para esa fecha)." });
      const reporte = JSON.parse(fs.readFileSync(auditPath, "utf8"));
      const accountName = getAccountName(accountId);
      const qPath = qualitativeFilePath(accountId, from);
      const qualitative = fs.existsSync(qPath) ? JSON.parse(fs.readFileSync(qPath, "utf8")) : null;
      const buf = await buildDocxBuffer(reporte, { accountName, mensajesLucidSales: qualitative?.mensajes_lucid_sales || null, pedidosLucidSales: qualitative?.pedidos_lucid_sales || null, diagnosticoCualitativo: qualitative?.diagnostico_cualitativo || null });
      const fname = `Auditoria_${getAccountSlug(accountId)}_${String(from).slice(0, 10)}.docx`;
      fs.writeFileSync(path.join(storeDir(accountId), fname), buf);
      res.writeHead(200, {
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="${fname}"`,
        "Content-Length": buf.length,
      });
      return res.end(buf);
    }

    // --- Historial de auditorías guardadas, por tienda (lee del disco, NUNCA llama a la API de Lucid Bot) ---
    if (url.pathname === "/api/history" && req.method === "GET") {
      const accountId = url.searchParams.get("accountId");
      if (!accountId) return sendJson(res, 400, { error: "Falta accountId" });
      const dir = storeDir(accountId);
      const files = fs.readdirSync(dir).filter((f) => /^\d+_\d{4}-\d{2}-\d{2}\.json$/.test(f));
      const porProductoAcum = {};
      // Detalle día por día por producto — permite comparar un mismo producto entre dos fechas
      // distintas, en vez de solo ver el acumulado total.
      const porProductoPorFecha = {};
      const items = files.map((f) => {
        const dateSlug = f.match(/_(\d{4}-\d{2}-\d{2})\.json$/)[1];
        let reporte;
        try {
          reporte = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        } catch (e) {
          return { fecha: dateSlug, error: "Archivo dañado" };
        }
        const qExists = fs.existsSync(path.join(dir, `${accountId}_${dateSlug}_qualitative.json`));
        const valorPorProductoEsteDia = {};
        for (const v of reporte.ventas?.detalle || []) {
          const prod = v.producto_interes && v.producto_interes !== "NO_MATCH" ? v.producto_interes : null;
          if (!prod) continue;
          valorPorProductoEsteDia[prod] = (valorPorProductoEsteDia[prod] || 0) + parseFloat(v.pedido?.value || 0);
        }
        for (const [nombre, d] of Object.entries(reporte.por_producto || {})) {
          if (nombre === "(sin producto identificado)") continue;
          if (!porProductoAcum[nombre]) porProductoAcum[nombre] = { contactos: 0, ventas: 0, valor_total: 0, auditorias: 0 };
          const acc = porProductoAcum[nombre];
          acc.contactos += d.total_contactos || 0;
          acc.ventas += d.ventas || 0;
          acc.auditorias++;
          const valorEsteDia = valorPorProductoEsteDia[nombre] || 0;
          acc.valor_total += valorEsteDia;
          if (!porProductoPorFecha[nombre]) porProductoPorFecha[nombre] = [];
          porProductoPorFecha[nombre].push({
            fecha: dateSlug,
            contactos: d.total_contactos || 0,
            mensajes_verificados: d.mensajes_verificados || 0,
            ventas: d.ventas || 0,
            valor_total: valorEsteDia,
            conversion_pct: d.conversion_pct || 0,
            sin_intencion_sin_bienvenida: d.sin_intencion_sin_bienvenida || 0,
          });
        }
        return {
          fecha: dateSlug,
          rango: reporte.rango,
          total_contactos: reporte.total_contactos,
          ventas: reporte.ventas?.cantidad || 0,
          valor_total: reporte.ventas?.valor_total || 0,
          conversion_pct: reporte.conversion_pct || 0,
          errores_subida: reporte.errores_subida?.cantidad || 0,
          sospechosas: reporte.ventas?.sospechosas?.cantidad || 0,
          tiene_cualitativo: qExists,
          tuvo_advertencias: (reporte.advertencias || []).length > 0,
        };
      }).sort((a, b) => (a.fecha < b.fecha ? 1 : -1));

      const validos = items.filter((it) => !it.error);
      const resumen = {
        total_auditorias: validos.length,
        total_contactos: validos.reduce((s, it) => s + (it.total_contactos || 0), 0),
        total_ventas: validos.reduce((s, it) => s + (it.ventas || 0), 0),
        valor_total: validos.reduce((s, it) => s + (it.valor_total || 0), 0),
        total_sospechosas: validos.reduce((s, it) => s + (it.sospechosas || 0), 0),
        conversion_promedio: validos.length
          ? +(validos.reduce((s, it) => s + (it.conversion_pct || 0), 0) / validos.length).toFixed(1)
          : 0,
        por_producto: Object.entries(porProductoAcum)
          .map(([producto, d]) => ({ producto, ...d, conversion_pct: d.contactos ? +(100 * d.ventas / d.contactos).toFixed(1) : 0 }))
          .sort((a, b) => b.ventas - a.ventas),
        por_producto_por_fecha: Object.fromEntries(
          Object.entries(porProductoPorFecha).map(([nombre, lista]) => [nombre, lista.sort((a, b) => (a.fecha < b.fecha ? -1 : 1))])
        ),
      };
      return sendJson(res, 200, { accountName: getAccountName(accountId), items, resumen });
    }

    if (url.pathname === "/api/audit-file" && req.method === "GET") {
      const accountId = url.searchParams.get("accountId");
      const fecha = url.searchParams.get("fecha");
      if (!accountId || !fecha) return sendJson(res, 400, { error: "Faltan accountId o fecha" });
      const auditPath = auditFilePath(accountId, fecha);
      if (!fs.existsSync(auditPath)) return sendJson(res, 404, { error: "No hay auditoría guardada para esa fecha." });
      const reporte = JSON.parse(fs.readFileSync(auditPath, "utf8"));
      const qPath = qualitativeFilePath(accountId, fecha);
      const qualitative = fs.existsSync(qPath) ? JSON.parse(fs.readFileSync(qPath, "utf8")) : null;
      return sendJson(res, 200, { reporte, accountName: getAccountName(accountId), qualitative });
    }

    if (url.pathname === "/api/qualitative-request" && req.method === "POST") {
      const { accountId, from, accountName } = await readBody(req);
      if (!accountId || !from) return sendJson(res, 400, { error: "Faltan accountId o from" });
      const prompt = buildQualitativePrompt({ accountId, accountName: accountName || getAccountName(accountId), from });
      const entry = `\n## ${new Date().toISOString()} — ${accountName || accountId} — ${String(from).slice(0, 10)}\n\n${prompt}\n`;
      const logPath = requestsLogPath(accountId);
      fs.appendFileSync(logPath, entry);
      return sendJson(res, 200, { prompt, savedTo: `Informes/auditorias/${getAccountSlug(accountId)}/solicitudes_analisis_cualitativo.md` });
    }

    // --- Gestión de tiendas (solo token de API de Lucid Bot — NUNCA contraseñas) ---
    if (url.pathname === "/api/stores" && req.method === "POST") {
      const { accountId, name, token, lucidSalesStoreName, slug } = await readBody(req);
      if (!accountId || !name || !token) return sendJson(res, 400, { error: "Faltan accountId, name o token" });
      const accounts = readAccounts();
      if (accounts[accountId]) return sendJson(res, 409, { error: "Ya existe una tienda con ese accountId. Usa editar en vez de crear." });
      accounts[accountId] = {
        name,
        slug: slugify(slug || name),
        token,
        lucidSalesStoreName: lucidSalesStoreName || name,
      };
      writeAccounts(accounts);
      return sendJson(res, 200, { ok: true });
    }

    if (url.pathname.startsWith("/api/stores/") && req.method === "PUT") {
      const accountId = decodeURIComponent(url.pathname.slice("/api/stores/".length));
      const accounts = readAccounts();
      if (!accounts[accountId]) return sendJson(res, 404, { error: "No existe esa tienda" });
      const { name, token, lucidSalesStoreName, slug } = await readBody(req);
      if (name) accounts[accountId].name = name;
      if (token) accounts[accountId].token = token; // vacío = no tocar el token existente
      if (lucidSalesStoreName) accounts[accountId].lucidSalesStoreName = lucidSalesStoreName;
      if (slug) accounts[accountId].slug = slugify(slug);
      writeAccounts(accounts);
      return sendJson(res, 200, { ok: true });
    }

    if (url.pathname.startsWith("/api/stores/") && req.method === "DELETE") {
      const accountId = decodeURIComponent(url.pathname.slice("/api/stores/".length));
      const accounts = readAccounts();
      if (!accounts[accountId]) return sendJson(res, 404, { error: "No existe esa tienda" });
      delete accounts[accountId];
      writeAccounts(accounts);
      return sendJson(res, 200, { ok: true, nota: "La tienda se quitó del selector. Los informes ya guardados en su carpeta NO se borraron." });
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Dashboard Lucid Bot en http://localhost:${PORT}`);
});
