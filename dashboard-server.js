// Dashboard local de auditoría Lucid Bot.
// Uso: node dashboard-server.js  ->  abre http://localhost:4545
//
// Listo para hosting (pedido explícito 2026-08-13, "prepararlo para usarlo desde cualquier
// hosting/repositorio como Railway"): nada de esto cambia el comportamiento local por defecto —
// cada variable de entorno tiene un valor por defecto idéntico al de siempre. Ver la sección
// "Desplegar en un hosting" del README antes de publicar esto en internet de verdad: en
// particular, la mayoría de hostings (Railway incluido) usan disco EFÍMERO — sin un volumen
// persistente montado en DATA_DIR, accounts.local.json y todo Informes/ se BORRAN en cada
// redeploy/reinicio. Y este servidor todavía no tiene ningún login (pedido explícito: "dejarlo
// sin login por ahora") — antes de exponerlo en una URL pública de verdad hay que agregar uno.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { runAudit } = require("./audit-core.js");
const { buildDocxBuffer } = require("./report-generator.js");

const PORT = process.env.PORT ? Number(process.env.PORT) : 4545;
// DATA_DIR: si se define, accounts.local.json y Informes/auditorias/ viven ahí en vez de junto
// al código — es el patrón para montar un volumen persistente en un hosting (Railway, etc.).
// Sin DATA_DIR, todo se comporta exactamente igual que siempre (relativo a este archivo).
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : null;
const ACCOUNTS_FILE = process.env.ACCOUNTS_FILE
  ? path.resolve(process.env.ACCOUNTS_FILE)
  : DATA_DIR ? path.join(DATA_DIR, "accounts.local.json") : path.join(__dirname, "accounts.local.json");
const AUDITS_DIR = process.env.AUDITS_DIR
  ? path.resolve(process.env.AUDITS_DIR)
  : DATA_DIR ? path.join(DATA_DIR, "Informes", "auditorias") : path.join(__dirname, "..", "Informes", "auditorias");
if (!fs.existsSync(AUDITS_DIR)) fs.mkdirSync(AUDITS_DIR, { recursive: true });
if (!fs.existsSync(ACCOUNTS_FILE)) fs.mkdirSync(path.dirname(ACCOUNTS_FILE), { recursive: true });
if (!fs.existsSync(ACCOUNTS_FILE)) fs.writeFileSync(ACCOUNTS_FILE, "{}"); // primer arranque en un volumen vacío

// CORS: permite que otras páginas/apps consulten los datos directamente (pedido explícito
// 2026-08-13, "conectar con cualquier página o lugar"). Por defecto abierto ("*") para que
// funcione desde cualquier origen sin configurar nada; para restringirlo a dominios concretos,
// define ALLOWED_ORIGINS="https://misitio.com,https://otro.com" (separado por comas).
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "*").split(",").map((s) => s.trim()).filter(Boolean);
function corsOriginFor(req) {
  if (ALLOWED_ORIGINS.includes("*")) return "*";
  const origin = req.headers.origin;
  return origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0] || "";
}

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
    `PARTE 4B — Desglose de canal por pedido (WhatsApp vs Shopify vs otros): con la MISMA sesión de Lucid Sales ya logueada (misma tienda verificada en PARTE 2), usa javascript_tool para hacer fetch('/b/pedidos/get-pedidos-light-data?idEmpresa=<ID_EMPRESA>&page=1&itemsPerPage=500&search=&filters=%5B%7B%22name%22%3A%22date%22%2C%22searchValues%22%3A%5B%5D%2C%22sortOrder%22%3A%22desc%22%7D%5D', {credentials:'include', headers:{'x-token': localStorage.getItem('token')}}). idEmpresa se ve en cualquier llamada XHR reciente del panel (Network) o en la URL activa; si no lo tienes a mano, ábrelo con read_network_requests tras cargar /metricas-lucidsales. La respuesta trae {pedidos:[{id, Fecha (UTC, con sufijo Z — a diferencia de los timestamps de Lucid Bot, este SÍ trae Z), producto, source, shopify_order_id, EstadoPedido, ...}], totalRecords}. Convierte cada Fecha de UTC a Bogotá (UTC-5) y quédate solo con los pedidos dentro del rango exacto auditado (mismo from/to de esta auditoría, no el día completo). Agrupa y cuenta por el campo "source" (valores vistos: "WhatsApp", puede haber "Shopify" u otros) — un pedido con shopify_order_id no vacío es señal adicional de canal Shopify aunque "source" no lo diga explícitamente. Si itemsPerPage=500 no alcanza a cubrir el rango (totalRecords > 500 y el pedido más antiguo devuelto todavía cae dentro del rango buscado), sube page para traer más. Guarda el resultado como "canal_pedidos_lucidsales" en el JSON final (ver formato abajo) — esta es la respuesta directa a "cuántas ventas fueron de WhatsApp vs Shopify", no la omitas ni la infieras de otra fuente.`,
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
    `Guarda TODO el resultado en ${qualFile} con el formato { "hallazgos": [...], "causa_raiz_por_producto": {...}, "diagnostico_cualitativo": { "por_producto": { "<producto>": { "confianza": "baja|media|alta", "muestra_n": N, "pool_total": N, "causa_dominante": "<una de las 7, o sin_causa_clara>", "causas": { "mensaje_inicial_contenido": N, "objecion_precio": N, "bot_error_contexto": N, "bot_alucina": N, "bot_incoherente": N, "bot_abandona_conversacion": N, "leads_baja_calidad": N, "sin_causa_clara": N }, "casos": [ { "contact_id": "...", "causa": "...", "cita": "texto literal del chat", "link_panel": "..." } ] } } }, "mensajes_lucid_sales": { "fuente": "...", "total_mensajes_anuncio": N, "detalle": "...", "por_producto": [{ "producto": "...", "mensajes": N }] }, "pedidos_lucid_sales": { "fecha": "${dateSlug}", "por_producto": [{ "producto": "...", "pedidos_totales": N, "confirmado": N, "por_confirmar": N, "cancelado": N }] }, "canal_pedidos_lucidsales": { "fuente": "Lucid Sales — /b/pedidos/get-pedidos-light-data, campo 'source' (+ 'shopify_order_id' como señal adicional)", "rango": "${dateSlug} a FECHA_FIN exacta auditada", "total_pedidos": N, "por_canal": [{ "canal": "WhatsApp", "pedidos": N, "valor_total": N }, { "canal": "Shopify", "pedidos": N, "valor_total": N }], "nota": "Si un canal no aparece en la muestra, repórtalo igual con pedidos:0 en vez de omitirlo." } } (plantilla de ejemplo: Informes/auditorias/TEMPLATE_qualitative.json).`,
    `Al terminar, avísame con un resumen de los hallazgos más importantes.`,
  ].join("\n");
}

// Informe profundo (pedido explícito 2026-08-18, tras ver un informe real hecho leyendo 500
// chats a mano — mucho más accionable que el análisis cualitativo de muestra 10%: encuentra
// fallas de COMPORTAMIENTO del bot con cita textual y regla/flujo exacto a tocar, cosa que el
// motor JS nunca podrá detectar de forma confiable con reglas/regex porque requiere leer el
// HILO COMPLETO de cada chat con criterio, no solo el último mensaje del bot). No reemplaza el
// análisis cualitativo (que es rápido, 10% de muestra, bueno para causa raíz estadística) ni el
// auditor JS (rápido, 100% de cobertura, bueno para verificar ventas) — es un TERCER modo,
// deliberadamente lento y exhaustivo, para cuando se necesita encontrar bugs concretos del bot.
function buildDeepAuditPrompt({ accountId, accountName, from }) {
  const dateSlug = String(from).slice(0, 10);
  const slug = getAccountSlug(accountId);
  const auditFile = `Informes/auditorias/${slug}/${accountId}_${dateSlug}.json`;
  const outFile = `Informes/auditorias/${slug}/${dateSlug}-${slug.toLowerCase()}-informe-profundo.md`;
  return [
    `Necesito un INFORME PROFUNDO de fallas del bot para "${accountName}" (acc=${accountId}) — leyendo cada chat completo, no solo campos estructurados. Este es un modo distinto y mucho más lento que la auditoría normal: el objetivo es encontrar bugs concretos de COMPORTAMIENTO del bot con evidencia textual, no solo contar ventas.`,
    ``,
    `PASO 0 — Alcance: si existe ${auditFile}, úsalo como referencia del rango/total ya auditado (campo "rango", "total_contactos"). Si no existe o quieres un rango distinto, pídeme fecha/hora exacta antes de arrancar. Analiza HASTA 200 conversaciones por corrida (mismo límite que la auditoría normal) — si hay más, procesa las primeras 200 por orden visible en el inbox, dime cuántas quedan pendientes, y ofrece continuar en un segundo lote sin repetir chats ya leídos.`,
    ``,
    `PASO 1 — Lee cada chat COMPLETO vía Browser tool (todo el hilo, no solo el último mensaje): entra a panel.lucidbot.co/en/inbox?acc=${accountId}, filtra por fecha, y abre cada conversación una por una. Para cada una: (a) lee el hilo completo con get_page_text, (b) abre "Ver acciones ejecutadas" (parte inferior derecha) y anota cualquier error técnico que aparezca ahí (mensaje exacto + tipo).`,
    ``,
    `PASO 2 — Clasifica cada chat en UNA etapa del embudo (igual vocabulario que usa el resto de este proyecto, solo que aquí se reporta de forma compacta):`,
    `  - E0 — No pasó del saludo: el bot mandó el mensaje inicial y el cliente nunca respondió, o el chat nunca avanzó de ahí.`,
    `  - E1 — Respondió pero no avanzó: hubo mensaje(s) del cliente, pero nunca llegó a dar talla/color/modelo/cantidad ni preguntó precio.`,
    `  - E2 — Llegó a talla/color/modelo/cantidad: dio detalles del producto pero no hay evidencia de que viera el precio, o se fue justo ahí.`,
    `  - E3 — Vio el precio y se fue: el bot dio el valor y el cliente no volvió a responder.`,
    `  - E4 — El bot le pidió los datos (nombre/dirección/teléfono) pero no llegó al resumen.`,
    `  - E5 — Llegó al resumen del pedido (con o sin confirmación final — la confirmación de venta ya la cubre la auditoría normal, aquí interesa el embudo).`,
    `Cuenta cuántos chats cayeron en cada etapa y su % sobre el total leído — este es el "Los números" / "El embudo" del informe.`,
    ``,
    `PASO 3 — Detecta estas 7 fallas de comportamiento del bot en cada chat (pueden aplicar varias a la vez). Para CADA falla que encuentres, guarda: contact_id, cita textual literal (nunca resumas ni inventes), y a qué producto/flujo pertenece:`,
    `  - saludo_a_mitad: el bot vuelve a saludar ("¡Hola! Soy [nombre] de [tienda]...") en medio de una conversación que ya había arrancado — no es el primer mensaje.`,
    `  - bombardeo_fotos: 5 o más fotos/videos seguidos del bot sin que el cliente haya preguntado o respondido nada entre medio.`,
    `  - producto_equivocado: el bot describe/muestra un producto DISTINTO al que el cliente pidió o mostró interés (compara el nombre que el cliente escribió o el producto del anuncio contra lo que el bot realmente ofrece).`,
    `  - ignora_pregunta_directa: el cliente hace una pregunta concreta (precio, talla, disponibilidad, envío) y la respuesta del bot no la contesta — da otra cosa, repite una ficha de producto, o saluda de nuevo.`,
    `  - pregunta_repetida: el bot pregunta EXACTAMENTE lo mismo dos o más veces en la misma conversación (señal de que perdió el contexto).`,
    `  - foto_pedida_no_llega: el cliente pide ver una foto/color/detalle específico y el bot responde que no tiene imágenes, o el envío de la imagen falla.`,
    `  - error_tecnico: cualquier error visto en "Ver acciones ejecutadas" (mensaje vacío, falla de API, modelo cortado a media respuesta, etc.) — anota el mensaje exacto del error.`,
    `Para cada falla, cuenta cuántos chats la tienen en total y desglosado por producto — así se arma la tabla de errores técnicos (agrupando por mensaje de error exacto) y la sección de fallas con ejemplos.`,
    ``,
    `PASO 4 — Por cada producto con chats en la muestra, arma una fila con: chats, ventas, % cierre, en qué etapa muere más gente, la falla dominante de ese producto (la más frecuente de las 7 de arriba), y una recomendación concreta y accionable (qué regla/flujo/campo tocar — sé específico: nombre del campo, número de flujo si lo ves en la URL o en la config, no una recomendación genérica).`,
    ``,
    `PASO 5 — Diagnóstico de causa: para cada falla encontrada, clasifícala en UNA categoría — "Marketing" (el problema es el anuncio/atribución, no el bot), "Bot / flujo" (una regla o secuencia del bot está mal armada), o "Bot / modelo" (el modelo de IA detrás del bot es insuficiente — se le olvida contexto, ignora instrucciones explícitas del prompt, corta respuestas). Prioriza por impacto (cuántos chats/cuánta plata mueve) y esfuerzo, en una lista ordenada de "qué atacar primero".`,
    ``,
    `PASO 6 — Para cada falla principal, deja una conversación testigo (contact_id) y el mensaje exacto que la reproduce, para poder probarla de nuevo en el simulador de LucidBot después de corregir la regla.`,
    ``,
    `FORMATO DE SALIDA — usa exactamente esta estructura markdown (títulos, tablas y orden), como el ejemplo real que ya validamos:`,
    `  1. Encabezado: cuántas conversaciones, cuántas son nuevas del rango exacto, canal, si fue de solo lectura.`,
    `  2. "Los números": tabla con conversaciones auditadas, ventas con etiqueta real de Lucid Sales, tasa de cierre, profundidad promedio de mensajes del cliente.`,
    `  3. "El embudo: dónde muere la plata": tabla E0-E5 con chats y % (del PASO 2), con la etapa/las etapas de mayor pérdida resaltadas.`,
    `  4. "FALLAS DEL BOT": una sub-sección por cada falla del PASO 3 que tenga casos, ordenada por impacto (🔴 alto / 🟠 medio), con: cuántos casos, 2-3 citas textuales reales con contact_id, la hipótesis de causa con evidencia, y "Dónde tocar" (específico).`,
    `  5. "Errores técnicos": tabla de mensajes de error exactos (agrupados) × veces vistos × qué significa en una frase.`,
    `  6. "Producto por producto": tabla del PASO 4.`,
    `  7. "Diagnóstico: ¿marketing o bot?": tabla del PASO 5 (causa × chats × tipo × impacto).`,
    `  8. "Orden de ataque": lista numerada priorizada.`,
    `  9. "Cómo replicar cada falla": tabla del PASO 6 (falla × conversación testigo × mensaje exacto).`,
    `Guarda el resultado completo en ${outFile} (formato .md, mismo estilo que ya usamos). Si hiciste un lote parcial (por el tope de 200), dilo explícitamente al inicio del archivo y en tu resumen.`,
    `Al terminar, avísame con el resumen ejecutivo: la falla #1 por impacto, y las 2-3 acciones de mayor prioridad.`,
  ].join("\n");
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

// Trabajos de auditoría en segundo plano (pedido explícito 2026-08-13): cuentas con pipelines
// grandes (confirmado: 45.000-48.000 registros históricos en "Calificación de leads" de una
// cuenta real) necesitan traer TODO para que el conteo sea correcto — priorizado sobre la
// velocidad ("no importa si se tarda unos minutos, sea un día o sea una semana"). Una sola
// solicitud HTTP bloqueante de 15-20+ minutos es fragil: cualquier timeout de cliente, proxy o
// conexión la corta a mitad de camino aunque el servidor siga trabajando bien — no es que la
// auditoría falle, es que quien la pidió deja de esperar la respuesta. La solución real no es
// "esperar más" de un lado, es dejar de depender de una sola conexión abierta: la auditoría
// arranca como un trabajo en memoria con un ID, contesta de inmediato, y el progreso (y el
// resultado final) se consultan aparte cuantas veces haga falta — sin importar cuánto tarde.
const auditJobs = new Map(); // jobId -> { status, log: [...], reporte, accountName, qualitative, fecha_guardado, error, startedAt, finishedAt }

function startAuditJob(accountId, from, toExclusive) {
  const jobId = `${accountId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const job = { status: "running", log: [], reporte: null, accountName: null, qualitative: null, fecha_guardado: null, error: null, startedAt: new Date().toISOString(), finishedAt: null };
  auditJobs.set(jobId, job);

  (async () => {
    try {
      const reporte = await runAudit(accountId, from, toExclusive, {
        onProgress: (msg) => {
          job.log.push({ t: new Date().toISOString(), msg });
          if (job.log.length > 500) job.log.shift(); // no crecer sin límite en auditorías larguísimas
        },
      });
      const dateSlug = computeDateSlug(from, toExclusive);
      fs.writeFileSync(auditFilePath(accountId, dateSlug), JSON.stringify(reporte, null, 2));
      const qPath = qualitativeFilePath(accountId, dateSlug);
      const qualitative = fs.existsSync(qPath) ? JSON.parse(fs.readFileSync(qPath, "utf8")) : null;
      job.reporte = reporte;
      job.accountName = getAccountName(accountId);
      job.qualitative = qualitative;
      job.fecha_guardado = dateSlug;
      job.status = "done";
    } catch (e) {
      job.error = e.message || String(e);
      job.status = "error";
    } finally {
      job.finishedAt = new Date().toISOString();
    }
  })();

  return jobId;
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

  // CORS en todas las respuestas (ver ALLOWED_ORIGINS arriba) + respuesta corta al preflight
  // OPTIONS que el navegador manda automáticamente antes de una llamada cross-origin.
  res.setHeader("Access-Control-Allow-Origin", corsOriginFor(req));
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  try {
    // Healthcheck para plataformas de hosting (Railway y similares lo llaman antes de dar
    // tráfico real) — no toca disco ni depende de accounts.local.json, así que responde aunque
    // el volumen de datos todavía no exista.
    if (url.pathname === "/api/health" && req.method === "GET") {
      return sendJson(res, 200, { ok: true, service: "lucidbot-auditor", version: require("./package.json").version });
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      const file = path.join(__dirname, "public", "dashboard.html");
      const body = fs.readFileSync(file);
      res.writeHead(200, { "Content-Type": MIME[".html"] });
      return res.end(body);
    }

    if (url.pathname === "/api/accounts" && req.method === "GET") {
      return sendJson(res, 200, getAccountsPublic());
    }

    // Punto de entrada recomendado para auditorías que pueden tardar (cuentas grandes): arranca
    // el trabajo y contesta de inmediato con un jobId — nunca mantiene la conexión abierta.
    if (url.pathname === "/api/audit-async" && req.method === "POST") {
      const { accountId, from, to } = await readBody(req);
      if (!accountId || !from || !to) return sendJson(res, 400, { error: "Faltan accountId, from o to" });
      const toExclusive = /^\d{4}-\d{2}-\d{2}$/.test(to)
        ? new Date(new Date(to + "T00:00:00Z").getTime() + 24 * 3600 * 1000).toISOString().slice(0, 10)
        : to;
      const jobId = startAuditJob(accountId, from, toExclusive);
      return sendJson(res, 202, { jobId });
    }

    // Consulta el estado/progreso de un trabajo de auditoría iniciado con /api/audit-async.
    // status: "running" | "done" | "error". El log trae las últimas líneas de progreso
    // (descarga de pipelines, custom fields, etc.) para saber que sigue avanzando, no colgado.
    if (url.pathname === "/api/audit-status" && req.method === "GET") {
      const jobId = url.searchParams.get("jobId");
      const job = jobId && auditJobs.get(jobId);
      if (!job) return sendJson(res, 404, { error: "jobId no encontrado (¿expiró o el servidor se reinició?)" });
      const base = { status: job.status, startedAt: job.startedAt, finishedAt: job.finishedAt, log: job.log };
      if (job.status === "error") return sendJson(res, 200, { ...base, error: job.error });
      if (job.status === "done") return sendJson(res, 200, { ...base, reporte: job.reporte, accountName: job.accountName, qualitative: job.qualitative, fecha_guardado: job.fecha_guardado });
      return sendJson(res, 200, base);
    }

    // Versión síncrona original — se mantiene para auditorías rápidas (rangos cortos, cuentas
    // chicas), pero para cuentas con pipelines grandes puede cortarse por timeout del cliente
    // antes de terminar. Usar /api/audit-async + /api/audit-status para esos casos.
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
      // Filtro opcional por rango de fecha (día/mes/rango libre) — from/to son "YYYY-MM-DD",
      // ambos inclusivos, comparados como texto contra el dateSlug del nombre de archivo (funciona
      // porque el formato ISO ordena igual como string que como fecha). Sin from/to, se comporta
      // igual que antes (todo el histórico). Pedido explícito 2026-08-13.
      const fromFilter = url.searchParams.get("from");
      const toFilter = url.searchParams.get("to");
      const dir = storeDir(accountId);
      let files = fs.readdirSync(dir).filter((f) => /^\d+_\d{4}-\d{2}-\d{2}\.json$/.test(f));
      if (fromFilter || toFilter) {
        files = files.filter((f) => {
          const dateSlug = f.match(/_(\d{4}-\d{2}-\d{2})\.json$/)[1];
          if (fromFilter && dateSlug < fromFilter) return false;
          if (toFilter && dateSlug > toFilter) return false;
          return true;
        });
      }
      const porProductoAcum = {};
      // Detalle día por día por producto — permite comparar el mismo producto entre distintas
      // fechas, en vez de solo ver el acumulado total. Pedido explícito 2026-07-30.
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

    // Informe profundo (pedido explícito 2026-08-18): lee cada chat completo en vez de solo
    // campos estructurados — mucho más lento, pero encuentra bugs de comportamiento del bot que
    // el motor JS no puede detectar de forma confiable. Ver buildDeepAuditPrompt arriba.
    if (url.pathname === "/api/deep-audit-request" && req.method === "POST") {
      const { accountId, from, accountName } = await readBody(req);
      if (!accountId || !from) return sendJson(res, 400, { error: "Faltan accountId o from" });
      const prompt = buildDeepAuditPrompt({ accountId, accountName: accountName || getAccountName(accountId), from });
      const entry = `\n## ${new Date().toISOString()} — ${accountName || accountId} — ${String(from).slice(0, 10)}\n\n${prompt}\n`;
      const logPath = path.join(storeDir(accountId), "solicitudes_informe_profundo.md");
      fs.appendFileSync(logPath, entry);
      return sendJson(res, 200, { prompt, savedTo: `Informes/auditorias/${getAccountSlug(accountId)}/solicitudes_informe_profundo.md` });
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
  if (DATA_DIR) console.log(`Datos persistentes en: ${DATA_DIR}`);
  console.log(`accounts.local.json: ${ACCOUNTS_FILE}`);
  console.log(`Informes/auditorias: ${AUDITS_DIR}`);
});
