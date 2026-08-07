// Genera el buffer .docx del informe a partir de la salida de runAudit() (audit-core.js).
// 100% automático — solo datos que la API de Lucid Bot puede dar en vivo. No depende
// de ninguna lectura manual de chats.
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,
  WidthType, ShadingType,
} = require("docx");

const PAGE = { size: { width: 12240, height: 15840 } };
const fmt = (n) => "$" + Number(n).toLocaleString("es-CO");

function h1(text) { return new Paragraph({ text, heading: HeadingLevel.HEADING_1, spacing: { before: 300, after: 150 } }); }
function p(text, opts = {}) { return new Paragraph({ children: [new TextRun({ text, ...opts })], spacing: { after: 120 } }); }

function cell(text, opts = {}) {
  return new TableCell({
    width: { size: opts.width || 2000, type: WidthType.DXA },
    shading: opts.header ? { type: ShadingType.CLEAR, fill: "6B21A8" } : undefined,
    margins: { top: 80, bottom: 80, left: 100, right: 100 },
    children: [new Paragraph({
      children: [new TextRun({ text: String(text), bold: !!opts.header, color: opts.header ? "FFFFFF" : undefined, size: opts.size || 18 })],
    })],
  });
}
function table(headers, rows, widths) {
  return new Table({
    width: { size: widths.reduce((a, b) => a + b, 0), type: WidthType.DXA },
    columnWidths: widths,
    rows: [
      new TableRow({ tableHeader: true, children: headers.map((htxt, i) => cell(htxt, { header: true, width: widths[i] })) }),
      ...rows.map((r) => new TableRow({ children: r.map((c, i) => cell(c, { width: widths[i] })) })),
    ],
  });
}

function buildDocx(reporte, meta = {}) {
  const embudo = reporte.embudo;
  const total = reporte.total_contactos;
  const pct = (n) => (total ? ((100 * n) / total).toFixed(1) + "%" : "0%");
  const accountName = meta.accountName || reporte.cuenta;
  const hasShopify = !!(reporte.canal_pedidos && reporte.canal_pedidos.api_shopify.contactos > 0);

  function tagLabel(v) {
    if (v.tag_fallo_subida) return "Fallo al subir";
    if (v.tag_fallo_modificar) return "Fallo al modificar";
    if (v.tag_pedido_subido) return "Pedido subido";
    if (v.tag_compra_realizada) return "Compra realizada";
    if (v.tag_avance_posterior) return "Avanzó (entregado/reparto/modificado)";
    if (v.tag_pedido_subido === undefined) return "—";
    return "Sin etiqueta de subida (no es error)";
  }
  const ventasRows = reporte.ventas.detalle.map((v) => [
    v.contact_id,
    v.producto_interes && v.producto_interes !== "NO_MATCH" ? v.producto_interes : (v.pedido?.resumen.split("—")[0].replace(/^\d+\s*x\s*/, "").trim() || "-"),
    fmt(v.pedido?.value || 0),
    ...(hasShopify ? [v.via_api_shopify ? "API/Shopify" : "Chat WhatsApp"] : []),
    tagLabel(v),
  ]);
  const sospechosasRows = (reporte.ventas.sospechosas?.detalle || []).map((c) => [c.contact_id, c.producto_interes || "-", fmt(c.pedido?.value || 0), c.link_panel]);

  const sinConfirmarRows = (reporte.revision_dirigida || [])
    .filter((r) => r.categoria === "datos_sin_confirmar")
    .map((r) => [r.contact_id, r.producto_interes || "-", r.pedido?.stage || "-"]);

  const erroresRows = (reporte.errores_subida.detalle || []).map((e) => [e.contact_id, e.producto_interes || "-", e.pedido?.stage || "-"]);

  const productoRows = Object.entries(reporte.por_producto)
    .filter(([k]) => k !== "(sin producto identificado)")
    .sort((a, b) => b[1].total_contactos - a[1].total_contactos)
    .map(([nombre, d]) => [
      nombre, String(d.total_contactos), String(d.mensajes_verificados || 0), String(d.mensajes_no_verificados || 0), String(d.ventas),
      ...(hasShopify ? [String(d.ventas_shopify || 0), String(d.ventas_whatsapp || 0)] : []),
      d.conversion_pct + "%", String(d.contactos_recurrentes || 0), String(d.ventas_mismo_dia || 0), String(d.ventas_otra_fecha || 0),
    ]);

  const revisionRows = (reporte.revision_dirigida || []).map((r) => [r.contact_id, r.motivo, r.link_panel]);

  const recurrentesRows = (reporte.contactos_recurrentes?.detalle || []).map((c) => [c.contact_id, c.producto_interes || "-", String(c.veces_total_historial), String(c.interacciones)]);
  const otraFechaRows = (reporte.ventas.detalle || [])
    .filter((v) => v.pedido?.venta_de_otra_fecha)
    .map((v) => [v.contact_id, v.producto_interes || "-", v.pedido.fecha_creacion, v.pedido.fecha_confirmacion]);

  const metaPorProducto = meta.mensajesLucidSales?.por_producto;
  const reconciliacionRows = [];
  if (metaPorProducto && metaPorProducto.length) {
    const metaMap = new Map(metaPorProducto.map((m) => [m.producto, m.mensajes]));
    const nombres = new Set([...Object.keys(reporte.por_producto).filter((k) => k !== "(sin producto identificado)"), ...metaMap.keys()]);
    for (const nombre of nombres) {
      const lb = reporte.por_producto[nombre];
      const metaMsg = metaMap.get(nombre);
      const lbMsg = lb ? lb.mensajes : null;
      const dif = metaMsg != null && lbMsg != null ? metaMsg - lbMsg : null;
      reconciliacionRows.push([nombre, metaMsg != null ? String(metaMsg) : "—", lbMsg != null ? String(lbMsg) : "—", dif != null ? (dif >= 0 ? "+" : "") + dif : "—"]);
    }
  }

  const pedidosLucidSales = meta.pedidosLucidSales?.por_producto;
  const pedidosRows = [];
  if (pedidosLucidSales && pedidosLucidSales.length) {
    for (const pl of pedidosLucidSales) {
      const lb = reporte.por_producto[pl.producto];
      const lbVentas = lb ? lb.ventas : null;
      const dif = lbVentas != null ? pl.pedidos_totales - lbVentas : null;
      pedidosRows.push([
        pl.producto, String(pl.pedidos_totales), String(pl.confirmado), String(pl.por_confirmar), String(pl.cancelado),
        lbVentas != null ? String(lbVentas) : "—", dif != null ? (dif >= 0 ? "+" : "") + dif : "—",
      ]);
    }
  }

  const diag = reporte.diagnostico;
  const diagBlocks = [];
  if (diag) {
    diagBlocks.push(h1("14. Diagnóstico y recomendaciones"));
    diagBlocks.push(p(diag.nota_metodologica, { italics: true, size: 18 }));
    diagBlocks.push(
      table(
        ["Estado", "Contactos"],
        Object.entries(diag.temperaturas).map(([k, v]) => [k, String(v)]),
        [5000, 2000]
      )
    );
    if (diag.mensaje_inicial && diag.mensaje_inicial.nivel !== "sin_datos") {
      diagBlocks.push(p("Mensaje inicial (señal global):", { bold: true }));
      diagBlocks.push(p(diag.mensaje_inicial.texto));
      if (diag.mensaje_inicial.recomendacion) diagBlocks.push(p("→ " + diag.mensaje_inicial.recomendacion, { italics: true }));
    }
    const veredictoLabel = {
      entrega_fallida: "Etiqueta \"Bienvenida Enviada\" ausente — señal POCO CONFIABLE, verificar chats reales antes de concluir falla de entrega",
      mensaje_inicial: "Causa probable: MENSAJE INICIAL (no muestran intención)",
      bot: "Causa probable: REGLAS DEL BOT (cierre)",
      mixto: "Causa probable: MÁS DE UN PROBLEMA a la vez",
      embudo: "Causa probable: forma de comunicar precio/oferta",
      tecnico: "Causa: error técnico de subida",
      sin_problema: "Sin problemas detectados",
      muestra_insuficiente: "Muestra insuficiente",
    };
    diagBlocks.push(p("Por producto — qué funciona, qué no, y por qué:", { bold: true }));
    for (const prod of diag.por_producto) {
      diagBlocks.push(p(`${prod.producto} — ${prod.muestra_contactos} contactos, ${prod.ventas} ventas, ${prod.conversion_pct}% conversión`, { bold: true, size: 20 }));
      diagBlocks.push(p(`${veredictoLabel[prod.veredicto.tipo]}: ${prod.veredicto.texto}`, { bold: true }));
      if (prod.veredicto.recomendacion) diagBlocks.push(p(`→ ${prod.veredicto.recomendacion}`, { italics: true }));
      if (prod.positivas.length) diagBlocks.push(p("✅ " + prod.positivas.join(" · ")));
      for (const s of prod.senales) {
        diagBlocks.push(p(`⚠ ${s.texto}`));
        diagBlocks.push(p(`  → ${s.recomendacion}`, { italics: true }));
      }
    }
    diagBlocks.push(p("Estas señales y veredictos son hipótesis estadísticas basadas en el embudo por etapa — no reemplazan la confirmación por análisis cualitativo (lectura real de chats).", { italics: true, size: 18 }));
  }

  const muestraCualitativa = reporte.muestra_cualitativa;
  const diagCualitativo = meta.diagnosticoCualitativo?.por_producto;
  if (muestraCualitativa && Object.keys(muestraCualitativa.por_producto || {}).length) {
    diagBlocks.push(h1("14b. Diagnóstico cualitativo por producto (rúbrica de causa raíz)"));
    diagBlocks.push(p(muestraCualitativa.metodologia, { italics: true, size: 18 }));
    const causaLabel = {
      mensaje_inicial_contenido: "Contenido del mensaje inicial", objecion_precio: "Objeción de precio",
      bot_error_contexto: "Bot da info incorrecta", bot_alucina: "Bot alucina/inventa info",
      bot_incoherente: "Bot responde incoherente", bot_abandona_conversacion: "Bot abandona la conversación",
      leads_baja_calidad: "Leads de baja calidad (audiencia)", sin_causa_clara: "Sin causa clara",
    };
    if (!diagCualitativo) {
      diagBlocks.push(
        table(
          ["Producto", "Casos disponibles", "Muestra a leer", "% muestreado", "Confianza esperada"],
          Object.entries(muestraCualitativa.por_producto).map(([n, d]) => [n, String(d.pool_total), String(d.muestra_n), d.muestra_pct + "%", d.confianza]),
          [2600, 1600, 1600, 1400, 1600]
        )
      );
      diagBlocks.push(p("Todavía no se ha leído esta muestra — usa \"📋 Pedir análisis cualitativo\" para completar la causa raíz verificada por producto.", { italics: true, size: 18 }));
    } else {
      for (const [nombre, d] of Object.entries(diagCualitativo)) {
        diagBlocks.push(p(`${nombre} — muestra ${d.muestra_n} de ${d.pool_total} (confianza ${d.confianza})`, { bold: true, size: 20 }));
        diagBlocks.push(p(`Causa dominante: ${causaLabel[d.causa_dominante] || d.causa_dominante}`, { bold: true }));
        const causasStr = Object.entries(d.causas || {}).filter(([, n]) => n > 0).map(([c, n]) => `${causaLabel[c] || c}: ${n}`).join(" · ");
        if (causasStr) diagBlocks.push(p(causasStr, { italics: true, size: 18 }));
        for (const c of d.casos || []) {
          diagBlocks.push(p(`${causaLabel[c.causa] || c.causa} — ${c.contact_id}: "${c.cita}"`));
        }
      }
    }
  }

  const embudoProductoRows = [];
  for (const [nombre, d] of Object.entries(reporte.por_producto)) {
    if (nombre === "(sin producto identificado)") continue;
    const base = d.total_contactos;
    if (base === 0) continue;
    embudoProductoRows.push([nombre, String(d.sin_intencion || 0), String(d.intencion_sin_datos), String(d.sin_confirmar), String(d.errores), String(d.ventas), String(base)]);
  }

  return new Document({
    sections: [{
      properties: { page: { ...PAGE, margin: { top: 1000, bottom: 1000, left: 1000, right: 1000 } } },
      children: [
        new Paragraph({ children: [new TextRun({ text: "Auditoría de Conversaciones — Lucid Bot", bold: true, size: 40, color: "6B21A8" })], spacing: { after: 100 } }),
        new Paragraph({ children: [new TextRun({ text: `${accountName} · Cuenta acc=${reporte.cuenta}`, size: 22, color: "555555" })], spacing: { after: 60 } }),
        new Paragraph({ children: [new TextRun({ text: `Periodo: ${reporte.rango.from} — ${reporte.rango.to} (hora Bogotá)`, size: 22, italics: true })], spacing: { after: 400 } }),

        h1("1. Alcance y cobertura"),
        p("Auditoría generada automáticamente vía API de Lucid Bot, cruzando los pipelines 'Pedidos - Chat', 'Pedidos - Landing' y 'Calificación de leads' por contact_id (sin duplicados)."),
        table(["Total contactos", "Analizados"], [[String(total), String(total) + " (100%)"]], [4000, 4000]),

        h1("2. Resumen ejecutivo"),
        p(`De ${total} contactos, ${embudo.venta_verificada} son ventas verificadas (${pct(embudo.venta_verificada)}), identificadas por llegar a la etapa "Pedidos Subidos" / "Subido a LucidSales" de Lucid Sales. Mayor fuga: ${embudo.sin_intencion} contactos (${pct(embudo.sin_intencion)}) no avanzaron más allá de la calificación inicial de "Frío".`),

        h1("3. Contactos y mensajes"),
        ...(reporte.conversaciones ? [
          p(`💬 Conversaciones (chats reales): ${reporte.conversaciones.total_chats}${hasShopify ? ` · 🛒 Vía Shopify/API (sin chat real): ${reporte.conversaciones.total_shopify}` : ""} · Total contactos: ${reporte.conversaciones.total}.`, { bold: true }),
          table(
            hasShopify ? ["Producto", "Chats reales", "Shopify/API", "Total"] : ["Producto", "Chats reales", "Total"],
            Object.entries(reporte.conversaciones.por_producto)
              .filter(([k]) => k !== "(sin producto identificado)")
              .sort((a, b) => (b[1].chats + b[1].shopify) - (a[1].chats + a[1].shopify))
              .map(([nombre, d]) => hasShopify
                ? [nombre, String(d.chats), String(d.shopify), String(d.chats + d.shopify)]
                : [nombre, String(d.chats), String(d.chats + d.shopify)]),
            hasShopify ? [3000, 1500, 1500, 1200] : [4000, 2000, 2000]
          ),
          p(reporte.conversaciones.nota, { italics: true, size: 18 }),
        ] : []),
        p(`✅ Mensajes verificados: ${reporte.mensajes.verificados.cantidad} (${reporte.mensajes.verificados.contactos} contactos sin historial previo).`, { bold: true }),
        p(reporte.mensajes.verificados.nota, { italics: true, size: 18 }),
        p(`⚪ Mensajes no verificables: ${reporte.mensajes.no_verificados.cantidad} (${reporte.mensajes.no_verificados.contactos} contactos recurrentes/otra fecha).`, { bold: true }),
        p(reporte.mensajes.no_verificados.nota, { italics: true, size: 18 }),
        ...(meta.mensajesLucidSales
          ? [
              p(`Mensajes de anuncio (Meta, vía Lucid Sales): ${meta.mensajesLucidSales.total_mensajes_anuncio}.`, { bold: true }),
              p(`Fuente: ${meta.mensajesLucidSales.fuente}`),
              p(meta.mensajesLucidSales.detalle || ""),
              p("Contactos nuevos y mensajes reales bot+humano (cifra oficial de Lucid Bot, sin desglose por producto): consultar Lucid Bot → Reportes → Analíticas."),
            ]
          : [p("Contactos nuevos y mensajes reales bot+humano (cifra oficial de Lucid Bot, sin desglose por producto) y mensajes de anuncio (Meta): consultar Lucid Bot → Reportes → Analíticas y Lucid Sales → Métricas Facebook Ads respectivamente — no disponibles por producto vía ninguna API.")]),

        h1("4. Ventas verificadas"),
        hasShopify
          ? table(["Contacto", "Producto", "Valor", "Canal", "Etiqueta Lucid Sales"], ventasRows.length ? ventasRows : [["-", "-", "-", "-", "-"]], [2000, 2600, 1300, 1200, 1600])
          : table(["Contacto", "Producto", "Valor", "Etiqueta Lucid Sales"], ventasRows.length ? ventasRows : [["-", "-", "-", "-"]], [2200, 3200, 1400, 1800]),
        p(`Total: ${fmt(reporte.ventas.valor_total)}. Cantidad: ${reporte.ventas.cantidad}.`),
        p("\"Etiqueta Lucid Sales\" cruza la etapa del pipeline contra la etiqueta real aplicada en Lucid Sales.", { italics: true, size: 18 }),
        ...(hasShopify ? [
          p("Canal de confirmación del pedido — API/Shopify (pipeline Landing) vs Chat WhatsApp:", { bold: true }),
          table(
            ["Canal", "Contactos", "Mensajes", "Ventas conf.", "Valor", "Sin confirmar", "Error subida", "Subidos LucidSales", "No subidos"],
            [
              ["🛒 API/Shopify", String(reporte.canal_pedidos.api_shopify.contactos), String(reporte.canal_pedidos.api_shopify.mensajes), String(reporte.canal_pedidos.api_shopify.ventas_confirmadas), fmt(reporte.canal_pedidos.api_shopify.valor_ventas), String(reporte.canal_pedidos.api_shopify.sin_confirmar), String(reporte.canal_pedidos.api_shopify.error_subida), String(reporte.canal_pedidos.api_shopify.subidos_a_lucidsales), String(reporte.canal_pedidos.api_shopify.no_subidos_a_lucidsales)],
              ["💬 Chat WhatsApp", String(reporte.canal_pedidos.chat_whatsapp.contactos), String(reporte.canal_pedidos.chat_whatsapp.mensajes), String(reporte.canal_pedidos.chat_whatsapp.ventas_confirmadas), fmt(reporte.canal_pedidos.chat_whatsapp.valor_ventas), String(reporte.canal_pedidos.chat_whatsapp.sin_confirmar), String(reporte.canal_pedidos.chat_whatsapp.error_subida), String(reporte.canal_pedidos.chat_whatsapp.subidos_a_lucidsales), String(reporte.canal_pedidos.chat_whatsapp.no_subidos_a_lucidsales)],
            ],
            [1600, 1000, 1000, 1100, 1200, 1200, 1100, 1400, 1000]
          ),
          p(reporte.canal_pedidos.nota, { italics: true, size: 18 }),
        ] : []),

        h1("5. Ventas sospechosas — posible bug de confirmado-no-subido"),
        p(reporte.ventas.sospechosas?.cantidad
          ? `${reporte.ventas.sospechosas.cantidad} venta(s) por ${fmt(reporte.ventas.sospechosas.valor_total)} donde la etapa del pipeline dice venta pero falta la etiqueta real de subida (o hay etiqueta de fallo). ${reporte.ventas.sospechosas.nota}`
          : "Sin ventas sospechosas detectadas en este rango — todas las ventas verificadas tienen la etiqueta real de subida a Lucid Sales."),
        ...(sospechosasRows.length ? [table(["Contacto", "Producto", "Valor", "Link"], sospechosasRows, [2200, 3000, 1400, 1800])] : []),

        h1("6. Datos sin confirmar"),
        table(["Contacto", "Producto", "Etapa"], sinConfirmarRows.length ? sinConfirmarRows : [["-", "-", "Sin casos en el rango"]], [2600, 3800, 1600]),

        h1("7. Errores de subida a Lucid Sales"),
        table(["Contacto", "Producto", "Etapa"], erroresRows.length ? erroresRows : [["-", "-", "Sin errores detectados en el rango"]], [2600, 3800, 1600]),

        h1("8. Embudo"),
        table(
          ["Etapa", "Contactos", "%"],
          [
            ["Sin intención (solo mensaje inicial)", String(embudo.sin_intencion), pct(embudo.sin_intencion)],
            ["Intención sin datos (Tibio/Caliente)", String(embudo.intencion_sin_datos), pct(embudo.intencion_sin_datos)],
            ["Datos sin confirmar", String(embudo.datos_sin_confirmar), pct(embudo.datos_sin_confirmar)],
            ["Confirmada no subida (error)", String(embudo.confirmada_no_subida), pct(embudo.confirmada_no_subida)],
            ["Venta verificada", String(embudo.venta_verificada), pct(embudo.venta_verificada)],
          ],
          [4200, 2400, 2400]
        ),

        h1("9. Embudo por producto"),
        p("Incluye la etapa \"Sin intención\" real por producto — Lucid Bot guarda el producto de interés desde que el contacto entra por el anuncio, no solo cuando muestra intención.", { italics: true, size: 18 }),
        embudoProductoRows.length
          ? table(["Producto", "Sin intención", "Intención sin datos", "Datos sin confirmar", "Confirmada no subida", "Venta verificada", "Base"], embudoProductoRows, [2200, 1600, 1800, 1800, 1800, 1600, 1000])
          : p("Sin datos suficientes para el embudo por producto en este rango."),

        h1("10. Por producto"),
        hasShopify
          ? table(
              ["Producto", "Contactos", "Msj. ✅ verificados", "Msj. ⚪ no verificables", "Ventas", "🛒 Shopify", "💬 WhatsApp", "Conversión", "Recurrentes", "Vtas. mismo día", "Vtas. otra fecha"],
              productoRows.length ? productoRows : [["-", "-", "-", "-", "-", "-", "-", "-", "-", "-", "-"]],
              [1600, 800, 1100, 1100, 700, 900, 900, 1000, 900, 1100, 1100]
            )
          : table(
              ["Producto", "Contactos", "Msj. ✅ verificados", "Msj. ⚪ no verificables", "Ventas", "Conversión", "Recurrentes", "Vtas. mismo día", "Vtas. otra fecha"],
              productoRows.length ? productoRows : [["-", "-", "-", "-", "-", "-", "-", "-", "-"]],
              [1800, 900, 1300, 1300, 800, 1100, 1000, 1200, 1200]
            ),
        p("\"Recurrentes\" = contactos que ya habían escrito antes en otra fecha. \"Ventas otra fecha\" = confirmaron dentro del rango pero la conversación empezó antes.", { italics: true, size: 18 }),
        p("✅ \"Mensajes verificados\" = PISO real (mínimo garantizado) de contactos SIN historial previo — Interacciones no puede mezclar otra visita para ellos. ⚠ Pero el campo Interacciones subcuenta los mensajes reales (confirmado 2026-07-26: marcó 7 donde una conversación real tenía ~11 mensajes), así que el número verdadero de mensajes es igual o MAYOR al mostrado, nunca menor. \"⚪ No verificables\" = Interacciones de contactos recurrentes o ventas de otra fecha, donde además podría mezclar visitas distintas.", { italics: true, size: 18, bold: true }),

        ...(reporte.atribucion_producto?.cantidad ? [
          p(`🎯 ${reporte.atribucion_producto.cantidad} caso(s) de atribución de anuncio INCORRECTA: ${reporte.atribucion_producto.nota}`, { bold: true }),
          table(
            ["Contacto", "Producto del anuncio (Ad ID)", "Producto real vendido", "Categoría"],
            reporte.atribucion_producto.detalle.map((c) => [c.contact_id, c.producto_ad_id, c.producto_real_vendido, c.categoria]),
            [2200, 2400, 2400, 1600]
          ),
        ] : []),

        ...(reporte.devoluciones_excluidas?.cantidad ? [
          p(`↩️ ${reporte.devoluciones_excluidas.cantidad} pedido(s) EXCLUIDO(S) del conteo por devolución: ${reporte.devoluciones_excluidas.nota}`, { bold: true }),
          table(
            ["Contacto", "Producto", "Valor"],
            reporte.devoluciones_excluidas.detalle.map((c) => [c.contact_id, c.producto_interes || "-", fmt(c.pedido?.value || 0)]),
            [2600, 3400, 1600]
          ),
        ] : []),

        h1("11. Contactos recurrentes"),
        p(reporte.contactos_recurrentes?.cantidad
          ? `${reporte.contactos_recurrentes.cantidad} contacto(s) que ya tenían al menos una oportunidad previa en otra fecha (volvieron a escribir / a hacer clic en el anuncio). ${reporte.contactos_recurrentes.nota}`
          : "Sin contactos recurrentes detectados en este rango."),
        ...(recurrentesRows.length ? [table(["Contacto", "Producto", "Veces en el historial", "Interacciones"], recurrentesRows, [2600, 3000, 2000, 1400])] : []),

        h1("12. Ventas confirmadas en el rango, de otra fecha"),
        p(reporte.ventas.otra_fecha?.cantidad
          ? `${reporte.ventas.otra_fecha.cantidad} venta(s) por ${fmt(reporte.ventas.otra_fecha.valor_total)} que confirmaron dentro del rango auditado pero cuya conversación se originó antes. ${reporte.ventas.otra_fecha.nota}`
          : "Sin ventas de este tipo en el rango — todas las ventas verificadas se originaron y confirmaron dentro del mismo período."),
        ...(otraFechaRows.length ? [table(["Contacto", "Producto", "Creado", "Confirmado"], otraFechaRows, [2200, 2800, 2000, 2000])] : []),

        h1("13. Revisión dirigida"),
        p(`${reporte.revision_dirigida.length} contacto(s) marcados para revisión manual (ventas a verificar por chat, datos sin confirmar, o intención sin cerrar). El texto de la conversación no está disponible vía API — abrir el link del panel para leerlo.`),
        table(["Contacto", "Motivo", "Link"], revisionRows.length ? revisionRows : [["-", "-", "-"]], [2200, 4200, 1600]),

        ...diagBlocks,

        h1("15. Confirmación real de pedidos (Lucid Sales)"),
        p("\"Pedidos totales\" de Lucid Sales es la fuente MÁS CONFIABLE del producto realmente vendido (viene del pedido real, no de la etiqueta del anuncio). \"Confirmado / Por confirmar / Cancelado\" es un estado POSTERIOR a que Lucid Bot marque \"Pedidos Subidos\" — una venta_verificada de Lucid Bot puede seguir \"Por confirmar\" en Lucid Sales."),
        pedidosRows.length
          ? table(["Producto", "Pedidos (Lucid Sales)", "Confirmado", "Por confirmar", "Cancelado", "Ventas (Lucid Bot)", "Diferencia"], pedidosRows, [1800, 1400, 1200, 1300, 1200, 1300, 1200])
          : p("Todavía no hay datos de confirmación real por producto — se completa al pedir el análisis cualitativo (parte 4)."),
        p("\"Diferencia\" = pedidos reales en Lucid Sales − ventas que Lucid Bot atribuyó a ese producto. Distinto de cero suele indicar que el bug de plantilla mezcló productos.", { italics: true, size: 18 }),

        h1("16. Reconciliación Meta ↔ Lucid Bot"),
        p("Lucid Sales se basa en las métricas de Meta Ads (mensajes de anuncio). Lucid Bot registra las conversaciones y mensajes reales del bot. La diferencia normal viene de contactos recurrentes y de clics que Meta cuenta como conversación sin que el bot registre interacción real."),
        reconciliacionRows.length
          ? table(["Producto", "Mensajes Meta (Lucid Sales)", "Mensajes Lucid Bot (aprox.)", "Diferencia"], reconciliacionRows, [2800, 2200, 2200, 1600])
          : p("Todavía no hay mensajes de Meta por producto para este rango — se completa al pedir el análisis cualitativo (parte 3)."),
        p("⚠ El lado \"Lucid Bot\" es el campo \"Interacciones\" (acumulado de por vida del contacto, no exclusivo de este rango). Ni la API ni Analíticas de Lucid Bot exponen mensajes reales por producto y fecha — verificado 2026-07-26 revisando ambos exhaustivamente. Esta columna es la mejor aproximación disponible sin leer cada chat a mano, no una cifra verificada.", { italics: true, size: 18, bold: true }),

        h1("17. Metodología"),
        p("Venta verificada = contacto cuya oportunidad llegó a la etapa \"Pedidos Subidos\" (Pedidos - Chat) o \"Subido a LucidSales\" (Pedidos - Landing) en Lucid Bot. Generado 100% automáticamente vía API — sin lectura manual de chats. Para verificar la cita textual de confirmación del cliente o entender el motivo de abandono de un caso puntual, usar los links de \"Revisión dirigida\"."),
      ],
    }],
  });
}

async function buildDocxBuffer(reporte, meta) {
  const doc = buildDocx(reporte, meta);
  return Packer.toBuffer(doc);
}

module.exports = { buildDocxBuffer };
