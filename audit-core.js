// Núcleo reutilizable de la auditoría (usado por audit.js CLI y por dashboard-server.js).
const {
  getAllOpportunities,
  resolvePipelineIdByName,
  getContactCustomFields,
  getContactTags,
  bogotaToUTC,
  apiTimestampToUTC,
} = require("./lib.js");
const { buildDiagnostico } = require("./diagnostic-rules.js");

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

const STAGE_TO_CATEGORY = {
  "pedidos subidos": "venta_verificada",
  "subido a lucidsales": "venta_verificada",
  "pendiente por confirmar": "datos_sin_confirmar",
  "error al subir": "confirmada_no_subida",
  "error al subir lucidsales": "confirmada_no_subida",
  "corregido - por subir": "revision_manual",
  "corregido - por subir lucidsales": "revision_manual",
  "pedido aplazado": "revision_manual",
  "mala calificación": "sin_intencion",
  "mala calificacion": "sin_intencion",
};

const LEAD_STAGE_TO_CATEGORY = {
  "lead": "sin_intencion",
  "frío": "sin_intencion",
  "frio": "sin_intencion",
  "spam": "sin_intencion",
  "mala calificación": "sin_intencion",
  "tibio": "intencion_sin_datos",
  "caliente": "intencion_sin_datos",
  "gestionado": "revision_manual",
  "cliente ya cargado a dropi": "venta_verificada",
};

function panelLink(accountId, contactId) {
  return `https://panel.lucidbot.co/en/inbox?acc=${accountId}&id=${contactId}`;
}

// Trae TODO el historial de un pipeline (sin filtrar por fecha) — necesario tanto para
// filtrar por rango como para detectar contactos recurrentes (que aparecen en otras fechas)
// y ventas que confirmaron dentro del rango pero se originaron en otra fecha.
async function fetchPipelineAll(accountId, pipelineName, warnings) {
  let pipelineId;
  try {
    pipelineId = await resolvePipelineIdByName(accountId, pipelineName);
  } catch (e) {
    warnings.push(`No se pudo resolver el pipeline "${pipelineName}": ${e.message}. Los resultados de esta auditoría pueden estar incompletos — vuelve a correrla.`);
    return [];
  }
  try {
    const items = await getAllOpportunities(accountId, pipelineId);
    if (items.truncated) {
      warnings.push(`⚠️ El pipeline "${pipelineName}" tiene MÁS oportunidades históricas de las que se pudieron descargar (tope de seguridad alcanzado) — contactos reales pueden estar faltando en esta auditoría, sin importar el rango de fecha pedido. Repórtalo para subir el tope.`);
    }
    return items;
  } catch (e) {
    warnings.push(`Falló la descarga de oportunidades del pipeline "${pipelineName}": ${e.message}. Los resultados de esta auditoría pueden estar incompletos — vuelve a correrla.`);
    return [];
  }
}

function inRange(apiDateStr, fromDate, toDate) {
  const d = apiTimestampToUTC(apiDateStr);
  if (fromDate && d < fromDate) return false;
  if (toDate && d >= toDate) return false;
  return true;
}

// Fecha calendario en Bogotá (YYYY-MM-DD) de un timestamp de la API — para comparar
// "mismo día" entre creación y confirmación sin líos de huso horario.
function bogotaDateOnly(apiDateStr) {
  const utc = apiTimestampToUTC(apiDateStr);
  const bogota = new Date(utc.getTime() - 5 * 3600 * 1000);
  return bogota.toISOString().slice(0, 10);
}

// De un pipeline de pedidos: oportunidades que llegaron a etapa de VENTA dentro del rango
// (por updated_at) pero que NO están ya incluidas por creación (created_at fuera de rango) —
// son ventas confirmadas en el lapso auditado que se originaron en una conversación de otra fecha.
function ventasConfirmadasEnOtraFecha(allList, yaIncluidos, fromDate, toDate) {
  const yaIds = new Set(yaIncluidos.map((o) => o.id));
  return allList.filter((o) => {
    if (yaIds.has(o.id)) return false;
    const stageKey = o.stage.name.trim().toLowerCase();
    if (STAGE_TO_CATEGORY[stageKey] !== "venta_verificada") return false;
    return inRange(o.updated_at, fromDate, toDate);
  });
}

// Reintenta una vez si custom_fields falla. Confirmado 2026-07-26: el campo "Producto
// Interesado _ Ad ID" SÍ está presente desde que el contacto entra por el anuncio, incluso
// para contactos "Frío" que nunca respondieron — antes se perdía por choques con el límite
// de la API (100 req/60s), ahora mitigado por el rate limiter de lib.js. Si aun así falla
// tras el reintento, se cuenta como fallo real (no un "campo vacío") para poder avisarlo.
async function getCustomFieldsWithRetry(accountId, contactId) {
  let lastFailed = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const cf = await getContactCustomFields(accountId, contactId);
      lastFailed = false;
      if (Array.isArray(cf) && cf.length > 0) return { ok: true, cf };
    } catch (e) {
      lastFailed = true;
    }
  }
  return { ok: !lastFailed, cf: [] };
}

// La etiqueta "Bienvenida Enviada" (confirmada por el usuario 2026-07-26) marca que el bot
// SÍ logró enviar el mensaje inicial a ese contacto. Sin ella, un "sin_intención" no es que
// la persona haya ignorado el mensaje — es que el bot nunca se lo entregó (falla técnica
// de entrega, no de contenido/segmentación). Distinguir esto es clave para no diagnosticar
// "hay que mejorar el mensaje inicial" cuando el problema real es que ni siquiera se envió.
async function getTagsWithRetry(accountId, contactId) {
  let lastFailed = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const tags = await getContactTags(accountId, contactId);
      lastFailed = false;
      if (Array.isArray(tags)) return { ok: true, tags };
    } catch (e) {
      lastFailed = true;
    }
  }
  return { ok: !lastFailed, tags: [] };
}

async function runAudit(accountId, from, to, { onProgress } = {}) {
  const fromDate = bogotaToUTC(from);
  const toDate = bogotaToUTC(to);
  const log = (msg) => onProgress && onProgress(msg);

  log(`Descargando pipelines de la cuenta ${accountId}...`);
  const warnings = [];
  const [pedidosChatAll, pedidosLandingAll, leadsAll] = await Promise.all([
    fetchPipelineAll(accountId, "Pedidos - Chat", warnings),
    fetchPipelineAll(accountId, "Pedidos - Landing", warnings),
    fetchPipelineAll(accountId, "Calificación de leads", warnings),
  ]);
  if (warnings.length) log(`⚠️ ${warnings.length} advertencia(s): ${warnings.join(" | ")}`);

  const pedidosChatEnRango = pedidosChatAll.filter((o) => inRange(o.created_at, fromDate, toDate));
  const pedidosLandingEnRango = pedidosLandingAll.filter((o) => inRange(o.created_at, fromDate, toDate));
  const leads = leadsAll.filter((o) => inRange(o.created_at, fromDate, toDate));

  // Ventas que CONFIRMARON dentro del rango (llegaron a etapa de venta) pero que se
  // originaron en una conversación de otra fecha — el filtro por created_at de arriba
  // las deja afuera; las recuperamos aparte y quedan marcadas como tal más abajo.
  const ventasChatOtraFecha = ventasConfirmadasEnOtraFecha(pedidosChatAll, pedidosChatEnRango, fromDate, toDate);
  const ventasLandingOtraFecha = ventasConfirmadasEnOtraFecha(pedidosLandingAll, pedidosLandingEnRango, fromDate, toDate);

  const pedidosChat = [...pedidosChatEnRango.map((o) => ({ o, otraFecha: false })), ...ventasChatOtraFecha.map((o) => ({ o, otraFecha: true }))];
  const pedidosLanding = [...pedidosLandingEnRango.map((o) => ({ o, otraFecha: false })), ...ventasLandingOtraFecha.map((o) => ({ o, otraFecha: true }))];

  // Historial completo por contacto (todas las fechas, los 3 pipelines) — para detectar
  // quién escribe de nuevo (recurrente) vs quién entra por primera vez.
  const historialPorContacto = new Map();
  for (const o of [...pedidosChatAll, ...pedidosLandingAll, ...leadsAll]) {
    historialPorContacto.set(o.contact_id, (historialPorContacto.get(o.contact_id) || 0) + 1);
  }

  const byContact = new Map();
  function ensure(contactId) {
    if (!byContact.has(contactId)) {
      const vecesTotal = historialPorContacto.get(contactId) || 1;
      byContact.set(contactId, {
        contact_id: contactId,
        categoria: null,
        origen_categoria: null,
        temperatura: null,
        dropi: false,
        pedido: null,
        veces_total_historial: vecesTotal,
        recurrente: vecesTotal > 1,
      });
    }
    return byContact.get(contactId);
  }

  for (const pipelineName of ["chat", "landing"]) {
    const list = pipelineName === "chat" ? pedidosChat : pedidosLanding;
    for (const { o, otraFecha } of list) {
      const c = ensure(o.contact_id);
      const stageKey = o.stage.name.trim().toLowerCase();
      const categoria = STAGE_TO_CATEGORY[stageKey] || "revision_manual";
      const prioridad = { venta_verificada: 5, confirmada_no_subida: 4, datos_sin_confirmar: 3, revision_manual: 2, intencion_sin_datos: 1, sin_intencion: 0 };
      if (!c.categoria || prioridad[categoria] > prioridad[c.categoria]) {
        c.categoria = categoria;
        c.origen_categoria = `Pedidos - ${pipelineName === "chat" ? "Chat" : "Landing"}: ${o.stage.name}`;
      }
      c.pedido = {
        pipeline: pipelineName === "chat" ? "Pedidos - Chat" : "Pedidos - Landing",
        stage: o.stage.name,
        opportunity_id: o.id,
        value: o.value,
        created_at: o.created_at,
        updated_at: o.updated_at,
        resumen: o.title,
        venta_de_otra_fecha: otraFecha,
        mismo_dia: bogotaDateOnly(o.created_at) === bogotaDateOnly(o.updated_at),
      };
    }
  }

  for (const o of leads) {
    const c = ensure(o.contact_id);
    const stageKey = o.stage.name.trim().toLowerCase();
    c.temperatura = o.stage.name;
    if (stageKey === "cliente ya cargado a dropi") c.dropi = true;
    if (!c.categoria) {
      c.categoria = LEAD_STAGE_TO_CATEGORY[stageKey] || "sin_intencion";
      c.origen_categoria = `Calificación de leads: ${o.stage.name}`;
    }
  }

  let contactos = Array.from(byContact.values());

  log(`Trayendo Interacciones y Producto de interés de ${contactos.length} contactos...`);
  let fallosCustomFields = 0;
  await mapLimit(contactos, 6, async (c) => {
    const { ok, cf } = await getCustomFieldsWithRetry(accountId, c.contact_id);
    if (!ok) fallosCustomFields++;
    const inter = cf.find((f) => f.name === "Interacciones");
    const prod = cf.find((f) => f.name === "Producto Interesado _ Ad ID" || f.name === "Producto de interes");
    c.interacciones = inter ? parseInt(inter.value, 10) || 0 : 0;
    c.producto_interes = prod ? prod.value : null;
    // "Respuesta Texto" (con fallback a "Division texto") guarda el ÚLTIMO mensaje real que el
    // bot le envió al contacto — confirmado 2026-07-30 inspeccionando contactos reales. NO es el
    // historial completo, pero para contactos que nunca volvieron a responder después de la
    // bienvenida, ese último mensaje ES el mensaje de bienvenida real — permite detectar a escala
    // el bug de plantilla (mensaje de un producto distinto al que el contacto realmente clickeó),
    // sin costo extra de API porque reutiliza este mismo fetch de custom_fields.
    const respTexto = cf.find((f) => f.name === "Respuesta Texto");
    const divisionTexto = cf.find((f) => f.name === "Division texto");
    c.ultimo_mensaje_bot = respTexto?.value || divisionTexto?.value || null;
    // "Anuncio Facebook" guarda el ID del anuncio de Meta que originó el clic. Pedido explícito
    // del usuario 2026-08-10: algunas conversaciones reciben la INFORMACIÓN del producto (texto)
    // pero NUNCA las fotos — la hipótesis es que pasa cuando el contacto sí viene de un anuncio
    // pero ese anuncio no tiene su ID guardado en las variables multimedia del producto en Lucid
    // Sales, así que el flujo no encuentra qué fotos mandar y solo entrega el texto. Se guarda
    // aquí (mismo fetch de custom_fields, sin costo extra de API) para poder cruzarlo más abajo.
    const anuncio = cf.find((f) => f.name === "Anuncio Facebook");
    c.anuncio_facebook = anuncio && String(anuncio.value).trim() ? String(anuncio.value).trim() : null;
  });
  if (fallosCustomFields > 0) {
    const msg = `No se pudo consultar el producto/interacciones de ${fallosCustomFields} de ${contactos.length} contactos (fallo de red o límite de la API tras reintento) — esos contactos pueden aparecer como "(sin producto identificado)" aunque sí tengan un producto real. Vuelve a correr la auditoría si esto afecta el análisis por producto.`;
    warnings.push(msg);
    log(`⚠️ ${msg}`);
  }

  const sinIntencionContactos = contactos.filter((c) => c.categoria === "sin_intencion");
  if (sinIntencionContactos.length) {
    log(`Verificando etiqueta "Bienvenida Enviada" de ${sinIntencionContactos.length} contactos sin intención...`);
    let fallosTags = 0;
    await mapLimit(sinIntencionContactos, 6, async (c) => {
      const { ok, tags } = await getTagsWithRetry(accountId, c.contact_id);
      if (!ok) fallosTags++;
      c.bienvenida_enviada = tags.some((t) => t.name === "Bienvenida Enviada");
    });
    if (fallosTags > 0) {
      const msg = `No se pudo consultar las etiquetas de ${fallosTags} de ${sinIntencionContactos.length} contactos sin intención — la distinción entre "no respondió" y "el bot nunca le envió el mensaje" puede estar incompleta para esos casos.`;
      warnings.push(msg);
      log(`⚠️ ${msg}`);
    }
  }

  let conteo = {};
  for (const c of contactos) conteo[c.categoria] = (conteo[c.categoria] || 0) + 1;

  let ventas = contactos.filter((c) => c.categoria === "venta_verificada" && c.pedido);
  const errores = contactos.filter((c) => c.categoria === "confirmada_no_subida");
  const sinConfirmar = contactos.filter((c) => c.categoria === "datos_sin_confirmar");
  const calientesTibios = contactos.filter((c) => c.categoria === "intencion_sin_datos");
  const dropi = contactos.filter((c) => c.dropi);

  // Verificación cruzada con las etiquetas REALES de Lucid Sales (catálogo confirmado
  // 2026-07-27): "Pedido subido LucidSales" confirma una subida genuina; "Fallo al subir
  // pedido LucidSales" / "Fallo al modificar pedido LucidSales" confirman una falla real.
  // Si una "venta_verificada" (por etapa del pipeline) NO tiene la etiqueta de subida, o SÍ
  // tiene una etiqueta de fallo, es el mismo patrón del bug "confirmado pero no subido" que
  // antes solo se detectaba leyendo chats a mano — ahora se detecta automáticamente.
  const paraVerificarEtiquetas = [...ventas, ...errores];
  if (paraVerificarEtiquetas.length) {
    log(`Verificando etiquetas reales de Lucid Sales en ${paraVerificarEtiquetas.length} ventas/errores...`);
    let fallosTagsVentas = 0;
    await mapLimit(paraVerificarEtiquetas, 6, async (c) => {
      const { ok, tags } = await getTagsWithRetry(accountId, c.contact_id);
      if (!ok) { fallosTagsVentas++; return; }
      const nombres = tags.map((t) => t.name);
      c.tag_pedido_subido = nombres.includes("Pedido subido LucidSales");
      c.tag_fallo_subida = nombres.includes("Fallo al subir pedido LucidSales");
      c.tag_fallo_modificar = nombres.includes("Fallo al modificar pedido LucidSales");
      c.tag_compra_realizada = nombres.includes("Compra Realizada Lucid Sales") || nombres.includes("Compra realizada");
      // Etapas posteriores del ciclo de vida del pedido — si el pedido ya avanzó hasta acá,
      // es prueba de que la subida a Lucid Sales sí funcionó (nunca se llega a "Entregado" sin
      // haber subido primero). Contarlas evita falsos positivos en "ventas sospechosas".
      c.tag_avance_posterior = nombres.includes("Entregado") || nombres.includes("Entrega realizada")
        || nombres.includes("Guia generada") || nombres.includes("Pedido modificado LucidSales")
        || nombres.includes("Reparto") || nombres.includes("Devuelto") || nombres.includes("Devolucion realizada")
        || nombres.includes("Subido Shopify") || nombres.includes("Subido a Google Sheet");
      // Proxy de canal: "Subido Shopify" es la única señal real (etiqueta) de que ese pedido
      // se confirmó vía integración Shopify — no mide "origen del contacto" (eso es el campo
      // "Origen" del Inbox, que vive en un backend PHP no documentado, inaccesible por API),
      // mide si la confirmación del pedido pasó por Shopify vs. quedó solo en la conversación.
      c.tag_shopify = nombres.includes("Subido Shopify");
      // Señal NEGATIVA real: el pedido fue devuelto. No confirma que la subida a Lucid Sales
      // funcionó (por eso NO debe tratarse como "avance positivo") — al contrario, indica que
      // la venta no se concretó como tal. Ver exclusión de "venta_de_otra_fecha" más abajo.
      c.tag_devuelto = nombres.includes("Devuelto") || nombres.includes("Devolucion realizada");
    });
    if (fallosTagsVentas > 0) {
      const msg = `No se pudieron consultar las etiquetas de ${fallosTagsVentas} de ${paraVerificarEtiquetas.length} ventas/errores — la verificación cruzada de subida real a Lucid Sales puede estar incompleta para esos casos.`;
      warnings.push(msg);
      log(`⚠️ ${msg}`);
    }
  }

  // Bug confirmado en una cuenta real: cuando Lucid Sales procesa
  // una DEVOLUCIÓN de un pedido viejo (ya en etapa "Pedidos Subidos" de una fecha anterior),
  // actualiza el updated_at de esa oportunidad y le manda al cliente el mensaje automático
  // "tu pedido fue devuelto..." — NO es una confirmación de venta nueva. Sin este filtro,
  // ventasConfirmadasEnOtraFecha() cuenta esa devolución como una venta más del rango auditado
  // (se verificó en el chat real: el mensaje del día era la notificación de devolución, no una
  // confirmación de compra). Se excluyen de TODO el conteo del rango (no solo de "ventas"): no
  // son un contacto nuevo ni una venta de esta auditoría, son un efecto secundario de procesar
  // la devolución de un pedido de otra fecha.
  const devolucionesOtraFecha = ventas.filter((c) => c.tag_devuelto && c.pedido?.venta_de_otra_fecha);
  if (devolucionesOtraFecha.length) {
    const idsExcluir = new Set(devolucionesOtraFecha.map((c) => c.contact_id));
    contactos = contactos.filter((c) => !idsExcluir.has(c.contact_id));
    conteo = {};
    for (const c of contactos) conteo[c.categoria] = (conteo[c.categoria] || 0) + 1;
    ventas = contactos.filter((c) => c.categoria === "venta_verificada" && c.pedido);
    // Nota: NO se agrega a `warnings` — esto es un ajuste correcto y esperado, no una falla ni
    // un dato incompleto (ese arreglo dispara el banner rojo "vuelve a correr la auditoría",
    // que sería engañoso aquí). El detalle completo queda en `devoluciones_excluidas` abajo.
    log(`↩️ ${devolucionesOtraFecha.length} pedido(s) excluido(s) del conteo por devolución: ${devolucionesOtraFecha.map((c) => c.contact_id).join(", ")}.`);
  }

  // Solo se marca "sospechosa" si hay evidencia POSITIVA de fallo (etiqueta real de error).
  // Antes también se marcaba por "falta la etiqueta Pedido subido", pero eso daba falsos
  // positivos: pedidos ya entregados/en reparto/modificados no siempre conservan esa etiqueta
  // exacta aunque la subida sí haya funcionado. Ausencia de etiqueta ya NO es evidencia de fallo.
  const ventasSospechosas = ventas.filter((c) => c.tag_fallo_subida || c.tag_fallo_modificar);

  // Canal de confirmación del PEDIDO (no del contacto): señal principal es el pipeline real
  // en el que se creó la oportunidad — "Pedidos - Landing" es el pipeline que recibe pedidos
  // confirmados por landing page / integración API (Shopify u otra), separado de "Pedidos -
  // Chat" (confirmación conversacional dentro de WhatsApp). Se refuerza con la etiqueta real
  // "Subido Shopify" por si un pedido de Chat también quedó marcado como subido a Shopify.
  // NO es el campo "Origen" del contacto (ese vive en un backend PHP de Lucid Bot no expuesto
  // por la API pública, confirmado 2026-07-28) — este es el canal de CONFIRMACIÓN del pedido.
  for (const c of contactos) {
    if (c.pedido) c.via_api_shopify = c.pedido.pipeline === "Pedidos - Landing" || !!c.tag_shopify;
  }
  function bucketPedidos(list) {
    const conVenta = list.filter((c) => c.categoria === "venta_verificada");
    return {
      contactos: list.length,
      mensajes: list.reduce((s, c) => s + (c.interacciones || 0), 0),
      ventas_confirmadas: conVenta.length,
      valor_ventas: conVenta.reduce((s, c) => s + parseFloat(c.pedido?.value || 0), 0),
      sin_confirmar: list.filter((c) => c.categoria === "datos_sin_confirmar").length,
      error_subida: list.filter((c) => c.categoria === "confirmada_no_subida").length,
      subidos_a_lucidsales: conVenta.filter((c) => c.tag_pedido_subido === true).length,
      no_subidos_a_lucidsales: conVenta.filter((c) => c.tag_pedido_subido !== true).length,
    };
  }
  const contactosConPedido = contactos.filter((c) => c.pedido);
  const canalPedidos = {
    api_shopify: bucketPedidos(contactosConPedido.filter((c) => c.via_api_shopify)),
    chat_whatsapp: bucketPedidos(contactosConPedido.filter((c) => !c.via_api_shopify)),
    nota: "\"api_shopify\" = pedido creado en el pipeline \"Pedidos - Landing\" (confirmación vía landing/integración, no conversación de WhatsApp) o con la etiqueta real \"Subido Shopify\". \"chat_whatsapp\" = el resto, pedido confirmado dentro de la conversación del bot. \"sin_confirmar\" = tiene datos pero el cliente no confirmó. \"subidos_a_lucidsales\"/\"no_subidos_a_lucidsales\" = de las ventas confirmadas de ese canal, cuántas tienen (o no) la etiqueta real \"Pedido subido LucidSales\" — las que NO la tienen son candidatas al bug de confirmado-no-subido, ver ventas.sospechosas para las que además tienen etiqueta de fallo explícita.",
  };

  // Mantenido por compatibilidad con el desglose "canal" ya usado en dashboard/docx — ahora
  // usa la misma señal combinada (pipeline Landing + etiqueta Shopify) en vez de solo el tag.
  const ventasShopify = ventas.filter((c) => c.via_api_shopify);
  const ventasWhatsapp = ventas.filter((c) => !c.via_api_shopify);

  const valorTotalVentas = ventas.reduce((sum, c) => sum + parseFloat(c.pedido?.value || 0), 0);
  const ventasMismoDia = ventas.filter((c) => c.pedido?.mismo_dia);
  const ventasOtraFecha = ventas.filter((c) => c.pedido?.venta_de_otra_fecha);

  const totalMensajes = contactos.reduce((sum, c) => sum + (c.interacciones || 0), 0);
  const mensajesPorCategoria = {};
  for (const c of contactos) {
    mensajesPorCategoria[c.categoria] = (mensajesPorCategoria[c.categoria] || 0) + (c.interacciones || 0);
  }

  const contactosRecurrentes = contactos.filter((c) => c.recurrente);
  const mensajesDeRecurrentes = contactosRecurrentes.reduce((sum, c) => sum + (c.interacciones || 0), 0);

  // "Interacciones" es acumulado de por vida del contacto — pero si el contacto NO es
  // recurrente (nunca tuvo otra oportunidad, en ningún pipeline, en ninguna otra fecha) Y su
  // conversación se originó dentro de este mismo rango (no es una "venta de otra fecha"),
  // entonces TODA su interacción ocurrió dentro del rango auditado por definición — no puede
  // tener mensajes de una visita anterior porque no existe una visita anterior. Para esos
  // contactos, Interacciones SÍ es un conteo real y verificado de mensajes de este rango.
  for (const c of contactos) {
    c.mensajes_confiables = !c.recurrente && !(c.pedido && c.pedido.venta_de_otra_fecha);
  }
  const contactosMensajesVerificados = contactos.filter((c) => c.mensajes_confiables);
  const mensajesVerificados = contactosMensajesVerificados.reduce((sum, c) => sum + (c.interacciones || 0), 0);
  const mensajesNoVerificados = totalMensajes - mensajesVerificados;

  function productoDe(c) {
    if (c.producto_interes) return c.producto_interes.trim();
    if (c.pedido) {
      const match = c.pedido.resumen.match(/\d+\s*x\s*([^—–-]+?)\s*(?:—|–|-)/);
      if (match) return match[1].trim();
    }
    return "(sin producto identificado)";
  }

  // Producto REAL según el pedido (confirmado o en borrador), ignorando el tag de atribución
  // de Ad ID — se usa para contrastar contra `producto_interes` y detectar el bug de
  // atribución de anuncio (ver más abajo, `atribucion_producto`).
  function productoRealDePedido(c) {
    if (!c.pedido || !c.pedido.resumen) return null;
    const match = c.pedido.resumen.match(/\d+\s*x\s*([^—–-]+?)\s*(?:—|–|-)/);
    return match ? match[1].trim() : null;
  }

  function mismoProducto(a, b) {
    const aBajo = a.toLowerCase();
    const bBajo = b.toLowerCase();
    if (aBajo === bBajo) return true;
    // Evita falsos positivos por nombres que se superponen como texto (ej. "Vestido X" es
    // substring de "Enterizo Vestido X") — casi siempre el MISMO producto con dos nombres
    // distintos en campos distintos de Lucid Bot, no un mismatch real.
    return aBajo.includes(bBajo) || bBajo.includes(aBajo);
  }

  const porProducto = {};
  for (const c of contactos) {
    const producto = productoDe(c);
    if (!porProducto[producto]) {
      porProducto[producto] = {
        total_contactos: 0, mensajes: 0, mensajes_verificados: 0, mensajes_no_verificados: 0, contactos_mensajes_verificados: 0,
        ventas: 0, errores: 0, sin_confirmar: 0, intencion_sin_datos: 0, sin_intencion: 0,
        sin_intencion_sin_bienvenida: 0, sin_intencion_con_bienvenida: 0,
        contactos_recurrentes: 0, mensajes_de_recurrentes: 0, ventas_mismo_dia: 0, ventas_otra_fecha: 0,
        ventas_shopify: 0, ventas_whatsapp: 0,
      };
    }
    const p = porProducto[producto];
    p.total_contactos++;
    p.mensajes += c.interacciones || 0;
    if (c.mensajes_confiables) { p.mensajes_verificados += c.interacciones || 0; p.contactos_mensajes_verificados++; }
    else p.mensajes_no_verificados += c.interacciones || 0;
    if (c.categoria === "venta_verificada") p.ventas++;
    if (c.categoria === "confirmada_no_subida") p.errores++;
    if (c.categoria === "datos_sin_confirmar") p.sin_confirmar++;
    if (c.categoria === "intencion_sin_datos") p.intencion_sin_datos++;
    if (c.categoria === "sin_intencion") {
      p.sin_intencion++;
      if (c.bienvenida_enviada) p.sin_intencion_con_bienvenida++;
      else p.sin_intencion_sin_bienvenida++;
    }
    if (c.recurrente) { p.contactos_recurrentes++; p.mensajes_de_recurrentes += c.interacciones || 0; }
    if (c.categoria === "venta_verificada" && c.pedido) {
      if (c.pedido.mismo_dia) p.ventas_mismo_dia++;
      if (c.pedido.venta_de_otra_fecha) p.ventas_otra_fecha++;
      if (c.via_api_shopify) p.ventas_shopify++;
      else p.ventas_whatsapp++;
    }
  }
  for (const p of Object.values(porProducto)) {
    p.conversion_pct = p.total_contactos ? +(100 * p.ventas / p.total_contactos).toFixed(1) : 0;
  }

  // Conteo de CONVERSACIONES reales (chats) vs. contactos que entraron directo por Shopify/API
  // sin pasar por una conversación de WhatsApp — pedido explícito 2026-07-30: "necesito Shopify
  // separado de WhatsApp para tener datos reales" + contar los chats del día, en total y por
  // producto. Un contacto es Shopify/API solo si su PEDIDO se originó en el pipeline "Pedidos -
  // Landing" o tiene la etiqueta "Subido Shopify" (ver via_api_shopify arriba) — cualquier
  // contacto SIN pedido (sin_intención, interés sin datos) es por definición un contacto de chat:
  // Shopify solo genera una entrada de pipeline al completar una compra, nunca antes.
  for (const c of contactos) c.es_shopify = c.via_api_shopify === true;
  const conversacionesPorProducto = {};
  let totalChats = 0;
  let totalShopify = 0;
  for (const c of contactos) {
    const producto = productoDe(c);
    if (!conversacionesPorProducto[producto]) conversacionesPorProducto[producto] = { chats: 0, shopify: 0 };
    if (c.es_shopify) { conversacionesPorProducto[producto].shopify++; totalShopify++; }
    else { conversacionesPorProducto[producto].chats++; totalChats++; }
  }
  const conversaciones = {
    total: contactos.length,
    total_chats: totalChats,
    total_shopify: totalShopify,
    nota: "\"Chats\" = contactos que tuvieron una conversación real de WhatsApp con el bot (incluye a todos los que NO llegaron a un pedido, más los que confirmaron dentro del chat). \"Shopify\" = contactos cuyo pedido se originó directo en el pipeline \"Pedidos - Landing\" o tiene la etiqueta real \"Subido Shopify\" — llegaron a un pedido sin necesariamente haber tenido una conversación de WhatsApp real, así que NO deben sumarse como \"chats\" para no inflar el conteo de conversaciones.",
    por_producto: conversacionesPorProducto,
  };

  // Evaluación del mensaje inicial por producto: cuántos SÍ lo recibieron (etiqueta "Bienvenida
  // Enviada", solo se chequea para "sin_intención" — ver arriba) y detección automática de
  // mismatches de contenido (¿el último mensaje real del bot menciona OTRO producto en vez del
  // que el contacto realmente clickeó?). Restringido a contactos con pocas interacciones (≤2):
  // solo para ellos el "último mensaje del bot" (campo "Respuesta Texto"/"Division texto") sigue
  // siendo, con confianza razonable, el mensaje de bienvenida original — en contactos con más
  // interacciones ese campo ya se sobreescribió con una respuesta posterior de la conversación.
  const productosConocidos = [...new Set(contactos.map((c) => c.producto_interes).filter((p) => p && p !== "NO_MATCH"))];
  function detectarProductoMencionado(texto, propio) {
    if (!texto || !propio) return null;
    const bajo = String(texto).toLowerCase();
    const propioBajo = propio.toLowerCase();
    for (const p of productosConocidos) {
      if (p === propio) continue;
      const pBajo = p.toLowerCase();
      // Evita falsos positivos cuando dos nombres de producto distintos se superponen como
      // texto (ej. "Vestido X" es substring de "Enterizo Vestido X") — casi siempre es el MISMO
      // producto real registrado con dos nombres distintos en campos distintos de Lucid Bot
      // (atribución de anuncio vs. nombre parseado del pedido), no un mismatch real.
      if (propioBajo.includes(pBajo) || pBajo.includes(propioBajo)) continue;
      if (bajo.includes(pBajo)) return p;
    }
    return null;
  }
  const UMBRAL_MENSAJE_ORIGINAL = 2;
  const mensajeInicialPorProducto = {};
  for (const c of contactos) {
    const producto = productoDe(c);
    if (!mensajeInicialPorProducto[producto]) {
      mensajeInicialPorProducto[producto] = { enviados: 0, no_enviados: 0, no_verificable: 0, mismatches: [] };
    }
    const m = mensajeInicialPorProducto[producto];
    if (c.bienvenida_enviada === true) m.enviados++;
    else if (c.bienvenida_enviada === false) m.no_enviados++;
    else m.no_verificable++;

    if ((c.interacciones || 0) <= UMBRAL_MENSAJE_ORIGINAL && c.ultimo_mensaje_bot) {
      const otro = detectarProductoMencionado(c.ultimo_mensaje_bot, c.producto_interes);
      if (otro) {
        m.mismatches.push({
          contact_id: c.contact_id,
          producto_esperado: c.producto_interes,
          producto_mencionado: otro,
          muestra: String(c.ultimo_mensaje_bot).slice(0, 220),
          link_panel: panelLink(accountId, c.contact_id),
        });
      }
    }
  }

  // Bug de atribución de anuncio (confirmado leyendo chats reales en una cuenta real, varios
  // casos en 2 días de auditoría consecutivos): el campo "Producto Interesado _ Ad ID" refleja el
  // anuncio que originó el clic, pero el flujo de conversación que realmente se disparó — y por
  // tanto el producto que la persona terminó comprando — puede ser DISTINTO. Se detecta
  // comparando ese tag contra el producto real parseado del resumen del pedido (confirmado o
  // en borrador): ahí el producto es un dato duro tomado de la conversación real, no una
  // inferencia. Distorsiona el embudo por producto en Lucid Sales (el gasto/mensajes del
  // anuncio quedan atribuidos a un producto que no fue el que se vendió).
  const atribucionProducto = [];
  for (const c of contactos) {
    if (!c.producto_interes || c.producto_interes === "NO_MATCH") continue;
    const real = productoRealDePedido(c);
    if (!real) continue;
    if (mismoProducto(c.producto_interes, real)) continue;
    atribucionProducto.push({
      contact_id: c.contact_id,
      categoria: c.categoria,
      producto_ad_id: c.producto_interes,
      producto_real_vendido: real,
      link_panel: panelLink(accountId, c.contact_id),
    });
  }

  // Candidatos a "no se enviaron las fotos del producto" — VERSIÓN 2 (2026-08-12). La versión
  // original (pedido 2026-08-10) usaba "Anuncio Facebook vacío" como proxy; validada contra 36
  // chats reales leídos a mano dio 83% de falsos positivos (30 de 36 SÍ habían recibido foto/video
  // normal) — ese campo vacío por sí solo no predice nada, así que se descartó.
  //
  // Causa raíz real, confirmada comparando dos casos reales lado a lado (2026-08-12): cuando un
  // contacto SÍ trae un ID de anuncio de Meta capturado (Origen: Ads) pero ese ID específico no se
  // encuentra en el mapeo de multimedia del producto en Lucid Sales (visible en el log de notas
  // del panel como "ID: <id> no encontrado." — distinto de "Sin AD ID." cuando nunca hubo anuncio
  // asociado, caso en el que las fotos normales SÍ se envían), el mensaje que el bot genera para
  // ese contacto queda con un marcador de "aquí van las fotos" SIN RESOLVER — se pegó como texto
  // literal en vez de convertirse en la foto/video real, ej.: "...(Te comparto unas fotos para que
  // lo veas en detalle)...". Ese marcador roto SÍ queda registrado en el campo "Respuesta
  // Texto"/"Division texto" que ya se trae por API (aunque el chat visual al cliente no lo
  // muestre), así que esto sí se puede detectar de forma directa, con evidencia textual real — no
  // es un proxy ni una adivinanza por campos vacíos.
  const REGEX_MARCADOR_FOTOS_ROTO = /[(*][^)*]{0,90}\b(fotos?|video)\b[^)*]{0,90}[)*]/i;
  const candidatosSinFotos = [];
  for (const c of contactos) {
    if (!c.ultimo_mensaje_bot) continue;
    const texto = String(c.ultimo_mensaje_bot);
    const match = texto.match(REGEX_MARCADOR_FOTOS_ROTO);
    if (!match) continue;
    // Falso positivo real encontrado 2026-08-12: algunos flujos SÍ mandan la foto/video como link
    // real de texto (formato markdown "[Video](https://r2.sales.lucidsales.co/...)") — eso es una
    // entrega exitosa, no el marcador roto. Si el fragmento capturado incluye una URL real, no es
    // el bug.
    if (/https?:\/\//i.test(match[0])) continue;
    candidatosSinFotos.push({
      contact_id: c.contact_id,
      categoria: c.categoria,
      producto_interes: c.producto_interes,
      interacciones: c.interacciones || 0,
      anuncio_facebook: c.anuncio_facebook || null,
      marcador_roto: match[0],
      ultimo_mensaje_bot: texto.slice(0, 300),
      link_panel: panelLink(accountId, c.contact_id),
    });
  }

  function pick(c) {
    return {
      contact_id: c.contact_id,
      categoria: c.categoria,
      temperatura: c.temperatura,
      interacciones: c.interacciones || 0,
      producto_interes: c.producto_interes,
      link_panel: panelLink(accountId, c.contact_id),
      recurrente: c.recurrente,
      veces_total_historial: c.veces_total_historial,
      tag_pedido_subido: c.tag_pedido_subido,
      tag_fallo_subida: c.tag_fallo_subida,
      tag_fallo_modificar: c.tag_fallo_modificar,
      tag_avance_posterior: c.tag_avance_posterior,
      tag_compra_realizada: c.tag_compra_realizada,
      tag_shopify: c.tag_shopify,
      tag_devuelto: c.tag_devuelto,
      via_api_shopify: c.via_api_shopify,
      es_shopify: c.es_shopify,
      bienvenida_enviada: c.bienvenida_enviada,
      pedido: c.pedido ? {
        pipeline: c.pedido.pipeline,
        stage: c.pedido.stage,
        resumen: c.pedido.resumen.slice(0, 150),
        value: c.pedido.value,
        mismo_dia: c.pedido.mismo_dia,
        venta_de_otra_fecha: c.pedido.venta_de_otra_fecha,
        fecha_creacion: c.pedido.created_at,
        fecha_confirmacion: c.pedido.updated_at,
      } : null,
    };
  }

  // Listado COMPLETO de contactos del rango (todas las categorías, incluyendo "sin_intención" /
  // Frío, que "revision_dirigida" deja afuera a propósito por no ser candidatos a lectura manual)
  // — esto es lo que permite filtrar por producto y ver la información completa de ESE producto,
  // no solo los casos ya priorizados para revisión. Pedido explícito 2026-07-30: filtro por
  // producto con info completa, de aquí en adelante para cualquier auditoría.
  const contactosDetalle = contactos.map(pick);

  const revisionDirigida = [
    ...ventasSospechosas.map((c) => ({ motivo: "⚠️ CRÍTICO: etapa dice venta pero falta la etiqueta de subida real (o hay etiqueta de fallo) — posible bug de confirmado-no-subido", ...pick(c) })),
    ...ventas.filter((c) => !ventasSospechosas.includes(c)).map((c) => ({ motivo: "Verificar cita de confirmación textual (venta_verificada)", ...pick(c) })),
    ...errores.map((c) => ({ motivo: "Error al subir a Lucid Sales — caso crítico", ...pick(c) })),
    ...sinConfirmar.map((c) => ({ motivo: "Tiene datos pero no confirmó — entender por qué", ...pick(c) })),
    ...calientesTibios.map((c) => ({ motivo: `Temperatura ${c.temperatura} sin cerrar — entender objeción`, ...pick(c) })),
  ];

  const diagnostico = buildDiagnostico({ contactos, porProducto, conteo, total: contactos.length });

  // Muestra estadística para el diagnóstico CUALITATIVO (lectura real de chats, vía "Pedir
  // análisis cualitativo") — pedido explícito 2026-07-31: el motor estadístico de arriba solo
  // cuenta números, nunca lee lo que realmente se dice. Para juzgar si el bot da información
  // incorrecta, alucina, es incoherente, abandona la conversación, o si la gente se cae justo
  // después del precio, hay que leer conversaciones reales — no hay atajo automatizable. Esta
  // muestra decide QUÉ leer, de forma reproducible (misma auditoría = misma muestra), en vez de
  // dejarlo a criterio de cada sesión.
  //
  // Muestreo ESTRATIFICADO 10% por sub-grupo (no mezclado), porque cada sub-grupo prueba una
  // causa distinta: "sin_confirmar"+"intención_sin_datos" (tibios) apunta a precio/reglas del
  // bot; "sin_intención" CON bienvenida confirmada apunta al contenido del mensaje inicial en sí
  // (excluye a quienes ni siquiera la recibieron — esa es pregunta de entrega, no de contenido).
  // Piso de 2 por sub-grupo (si hay ≥2 disponibles), tope de 5 — evita muestras ridículamente
  // chicas y evita que un producto con cientos de casos vuelva la lectura impracticable.
  // Selección SISTEMÁTICA (espaciada uniformemente, no "los primeros") para representar mejor
  // la variedad real del sub-grupo en vez de sesgarse hacia quienes entraron primero.
  const MUESTRA_PCT = 0.10;
  const MUESTRA_PISO = 2;
  const MUESTRA_TOPE = 5;
  function muestraSistematica(lista, motivo) {
    const n = Math.min(lista.length, Math.max(lista.length >= MUESTRA_PISO ? MUESTRA_PISO : lista.length, Math.ceil(lista.length * MUESTRA_PCT)));
    const nFinal = Math.min(n, MUESTRA_TOPE);
    if (nFinal <= 0) return [];
    const seleccionados = [];
    for (let i = 0; i < nFinal; i++) {
      const idx = Math.min(lista.length - 1, Math.floor((i * lista.length) / nFinal));
      seleccionados.push({ motivo, ...pick(lista[idx]) });
    }
    return seleccionados;
  }
  function etiquetaConfianza(n) {
    if (n < 3) return "baja";
    if (n < 8) return "media";
    return "alta";
  }
  const muestraCualitativaPorProducto = {};
  for (const [producto, d] of Object.entries(porProducto)) {
    if (producto === "(sin producto identificado)") continue;
    const sinConfirmarProd = sinConfirmar.filter((c) => productoDe(c) === producto);
    const tibiosProd = calientesTibios.filter((c) => productoDe(c) === producto);
    const sinIntencionConBienvenidaProd = contactos.filter(
      (c) => c.categoria === "sin_intencion" && c.bienvenida_enviada === true && productoDe(c) === producto
    );
    const muestraPrecioReglas = [...muestraSistematica(sinConfirmarProd, "Precio/objeción — tenía datos, no confirmó"), ...muestraSistematica(tibiosProd, "Precio/objeción — mostró interés, nunca dio datos")];
    const muestraMensajeInicial = muestraSistematica(sinIntencionConBienvenidaProd, "Contenido del mensaje inicial — recibió la bienvenida, no mostró interés");
    const poolTotal = sinConfirmarProd.length + tibiosProd.length + sinIntencionConBienvenidaProd.length;
    const muestraN = muestraPrecioReglas.length + muestraMensajeInicial.length;
    if (poolTotal === 0) continue;
    muestraCualitativaPorProducto[producto] = {
      pool_total: poolTotal,
      muestra_n: muestraN,
      muestra_pct: +(100 * muestraN / poolTotal).toFixed(1),
      confianza: etiquetaConfianza(muestraN),
      casos_precio_reglas: muestraPrecioReglas,
      casos_mensaje_inicial: muestraMensajeInicial,
    };
  }

  log("Auditoría completa.");

  return {
    cuenta: accountId,
    rango: { from, to, timezone: "America/Bogota" },
    advertencias: warnings,
    total_contactos: contactos.length,
    conversaciones,
    contactos_detalle: contactosDetalle,
    mensajes: {
      total_aproximado: totalMensajes,
      fuente: "Suma del campo 'Interacciones' — NO usar como cifra oficial de mensajes. Confirmado 2026-07-26 comparando contra un chat real: el campo SUBCUENTA (marcó 7 donde la conversación real tenía ~11 mensajes) — no es un contador 1:1 de mensajes. Ver Analíticas de Lucid Bot para la cifra oficial real (sin desglose por producto).",
      por_categoria: mensajesPorCategoria,
      de_contactos_recurrentes: mensajesDeRecurrentes,
      de_contactos_nuevos: totalMensajes - mensajesDeRecurrentes,
      verificados: {
        cantidad: mensajesVerificados,
        contactos: contactosMensajesVerificados.length,
        nota: "Suma de 'Interacciones' SOLO de contactos que no son recurrentes y cuya conversación se originó dentro de este mismo rango — para ellos, Interacciones no puede incluir mensajes de otra visita porque no existe otra visita. Es un PISO real (mínimo garantizado de mensajes de este rango), no un total exacto: el propio campo 'Interacciones' subcuenta los mensajes reales (confirmado contra un chat real), así que el número verdadero de mensajes es igual o MAYOR a esta cifra.",
      },
      no_verificados: {
        cantidad: mensajesNoVerificados,
        contactos: contactos.length - contactosMensajesVerificados.length,
        nota: "Interacciones de contactos recurrentes o de ventas confirmadas en el rango pero originadas en otra fecha — para estos sí puede incluir mensajes de otras visitas, no se puede confiar como cifra exacta de este rango.",
      },
    },
    contactos_recurrentes: {
      cantidad: contactosRecurrentes.length,
      nota: "Contactos que ya tenían al menos una oportunidad previa en otra fecha (en cualquiera de los 3 pipelines) — entraron de nuevo (ej. volvieron a hacer clic en el anuncio). Sus 'Interacciones' pueden incluir mensajes de esa visita anterior, no solo de este rango — usar como referencia de magnitud, no como cifra exacta de mensajes nuevos.",
      detalle: contactosRecurrentes.map(pick),
    },
    embudo: {
      sin_intencion: conteo.sin_intencion || 0,
      intencion_sin_datos: conteo.intencion_sin_datos || 0,
      datos_sin_confirmar: conteo.datos_sin_confirmar || 0,
      confirmada_no_subida: conteo.confirmada_no_subida || 0,
      revision_manual: conteo.revision_manual || 0,
      venta_verificada: conteo.venta_verificada || 0,
    },
    conversion_pct: contactos.length ? +(100 * (conteo.venta_verificada || 0) / contactos.length).toFixed(1) : 0,
    ventas: {
      cantidad: ventas.length,
      valor_total: valorTotalVentas,
      mismo_dia: { cantidad: ventasMismoDia.length, valor_total: ventasMismoDia.reduce((s, c) => s + parseFloat(c.pedido?.value || 0), 0) },
      otra_fecha: {
        cantidad: ventasOtraFecha.length,
        valor_total: ventasOtraFecha.reduce((s, c) => s + parseFloat(c.pedido?.value || 0), 0),
        nota: "Ventas que confirmaron (llegaron a 'Pedidos Subidos'/'Subido a LucidSales') dentro del rango auditado, pero cuya conversación se originó en una fecha anterior — no cuentan como 'venta del día' en el sentido de mensaje-inicial-a-cierre del mismo día, aunque sí son ventas reales cerradas en este período.",
      },
      sospechosas: {
        cantidad: ventasSospechosas.length,
        valor_total: ventasSospechosas.reduce((s, c) => s + parseFloat(c.pedido?.value || 0), 0),
        nota: "Ventas donde Lucid Sales SÍ aplicó una etiqueta real de fallo ('Fallo al subir pedido LucidSales' o 'Fallo al modificar pedido LucidSales') — evidencia positiva de un problema real, no solo ausencia de una etiqueta. Verificación cruzada automática del bug 'confirmado pero no subido'.",
        detalle: ventasSospechosas.map(pick),
      },
      canal: {
        shopify: {
          cantidad: ventasShopify.length,
          valor_total: ventasShopify.reduce((s, c) => s + parseFloat(c.pedido?.value || 0), 0),
          pct: ventas.length ? +(100 * ventasShopify.length / ventas.length).toFixed(1) : 0,
        },
        whatsapp: {
          cantidad: ventasWhatsapp.length,
          valor_total: ventasWhatsapp.reduce((s, c) => s + parseFloat(c.pedido?.value || 0), 0),
          pct: ventas.length ? +(100 * ventasWhatsapp.length / ventas.length).toFixed(1) : 0,
        },
        nota: "Proxy por etiqueta, no el campo 'Origen' del contacto (ese vive en un backend PHP de Lucid Bot no expuesto por la API pública, confirmado 2026-07-28). 'Shopify' = el pedido tiene la etiqueta real 'Subido Shopify' (integración automática confirmó/subió el pedido). 'WhatsApp' = venta_verificada sin esa etiqueta — la confirmación quedó registrada solo en la conversación / subida manual a Lucid Sales. No mide de dónde llegó el contacto (anuncio, directo, etc.), mide el canal de confirmación del pedido.",
      },
      detalle: ventas.map(pick),
    },
    canal_pedidos: canalPedidos,
    devoluciones_excluidas: {
      cantidad: devolucionesOtraFecha.length,
      nota: "Pedidos de otra fecha que Lucid Sales marcó como DEVUELTOS dentro de este rango — se excluyen del total de contactos y ventas porque procesar una devolución actualiza el pedido sin que sea una venta nueva confirmada en este rango. No suman a ningún conteo del reporte.",
      detalle: devolucionesOtraFecha.map(pick),
    },
    errores_subida: { cantidad: errores.length, detalle: errores.map(pick) },
    dropi: { cantidad: dropi.length, detalle: dropi.map(pick) },
    por_producto: porProducto,
    muestra_cualitativa: {
      metodologia: `Muestreo estratificado sistemático: ${MUESTRA_PCT * 100}% de cada sub-grupo (piso ${MUESTRA_PISO}, tope ${MUESTRA_TOPE} por sub-grupo), seleccionado con espaciado uniforme (no "los primeros"). Confianza declarada según el tamaño de muestra real: <3 casos = baja, 3-7 = media, 8+ = alta. Esta muestra decide QUÉ chats leer para el diagnóstico cualitativo (rúbrica de 7 causas: mensaje_inicial_contenido, objecion_precio, bot_error_contexto, bot_alucina, bot_incoherente, bot_abandona_conversacion, leads_baja_calidad) — ver "Pedir análisis cualitativo".`,
      por_producto: muestraCualitativaPorProducto,
    },
    mensaje_inicial_por_producto: {
      umbral_interacciones: UMBRAL_MENSAJE_ORIGINAL,
      nota: "\"enviados\"/\"no_enviados\" = etiqueta real \"Bienvenida Enviada\" (solo se verifica para contactos \"sin_intención\" — los demás avanzaron, así que obviamente sí recibieron algo). \"mismatches\" = contactos con ≤" + UMBRAL_MENSAJE_ORIGINAL + " interacciones cuyo último mensaje real del bot (\"Respuesta Texto\"/\"Division texto\") menciona un producto DISTINTO al que realmente clickearon — evidencia textual directa del bug de plantilla cruzada, no solo inferencia por el pedido. Solo cubre TEXTO, no imágenes ni video.",
      por_producto: mensajeInicialPorProducto,
    },
    atribucion_producto: {
      cantidad: atribucionProducto.length,
      nota: "Contactos donde 'Producto Interesado _ Ad ID' (el anuncio que originó el clic) NO coincide con el producto real del pedido (confirmado o en borrador) — el flujo de conversación disparado fue de otro producto. La venta/interés en este reporte se cuenta bajo el producto REAL del pedido, pero en Lucid Sales el anuncio (y su gasto de Meta) sigue atribuido al producto equivocado, distorsionando el embudo por producto ahí. Confirmado en una cuenta real (varios casos en 2 días de auditoría) — candidato a revisar el mapeo anuncio→flujo en Lucid Bot.",
      detalle: atribucionProducto,
    },
    posible_falta_fotos_sin_anuncio: {
      cantidad: candidatosSinFotos.length,
      nota: `Detección V2 (2026-08-12) — evidencia textual directa, no un proxy: el mensaje que el bot generó para este contacto contiene un marcador de "aquí van las fotos" SIN RESOLVER (campo "marcador_roto"), pegado como texto literal en vez de convertirse en la foto/video real. Confirmado que esto pasa cuando el contacto sí trae un ID de anuncio de Meta capturado pero ese ID no se encuentra en el mapeo de multimedia del producto en Lucid Sales (log de notas del panel: "ID: <id> no encontrado."). La versión anterior de este detector (proxy por "Anuncio Facebook vacío") se descartó tras validar contra 36 chats reales — dio 83% de falsos positivos. Aun con evidencia textual, sigue sin ser una confirmación 100% automática (la API no expone si la foto realmente faltó en el chat visible al cliente) — verificar cada caso con el link_panel antes de reportarlo como bug confirmado.`,
      detalle: candidatosSinFotos,
    },
    diagnostico,
    revision_dirigida: revisionDirigida,
    nota_metodologica:
      "Clasificación basada en pipelines 'Pedidos - Chat', 'Pedidos - Landing' y 'Calificación de leads' vía API. " +
      "La API no expone el texto de la conversación: la cita textual de confirmación del cliente y el análisis de objeciones " +
      "requieren abrir manualmente (o con el Browser tool) los contact_id listados en 'revision_dirigida'. " +
      "Recurrencia: un contacto se marca 'recurrente' si tiene más de una oportunidad histórica (cualquier pipeline, cualquier fecha) — se calcula sobre el historial completo disponible vía API, no solo el rango auditado. " +
      "Ventas 'de otra fecha': se incluyen buscando, dentro de TODO el historial de cada pipeline de pedidos, las oportunidades que llegaron a etapa de venta con updated_at dentro del rango aunque su created_at sea anterior — antes de este cambio esas ventas no aparecían en la auditoría del día en que realmente cerraron.",
  };
}

module.exports = { runAudit };
