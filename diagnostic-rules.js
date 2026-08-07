// Motor de diagnóstico y recomendaciones — 100% basado en datos estructurados de la
// API de Lucid Bot (embudo por producto, temperaturas, errores de subida). NUNCA afirma
// una causa textual exacta (ej. "el mensaje inicial dice X mal") porque la API no expone
// el texto de las conversaciones — eso solo se puede confirmar leyendo chats reales
// (ver "Pedir análisis cualitativo" en el dashboard). Lo que sí hace, con total respaldo
// en los números reales de la auditoría: detectar EN QUÉ ETAPA del embudo se concentra la
// fuga de cada producto, y a partir de eso apuntar a la categoría de causa más probable
// (mensaje inicial / objeción de precio / cierre-reglas del bot / error técnico).
//
// Cada señal queda etiquetada como hipótesis estadística, nunca como hecho confirmado —
// así el informe automático se mantiene 100% verídico y no inventa nada que no esté en
// los datos. Los umbrales están centralizados aquí para poder afinarlos con el tiempo
// según lo que confirmen los análisis cualitativos reales.

const MIN_SAMPLE = 3; // por debajo de esto, no se afirma nada — "muestra insuficiente"

const THRESHOLDS = {
  mensajeInicialFugaAlta: 70, // % de TODOS los contactos del producto que nunca mostraron intención (Frío/Spam)
  mensajeInicialFugaMedia: 50,
  entregaFallidaAlta: 50, // % del bucket "sin intención" que NUNCA recibió la etiqueta "Bienvenida Enviada"
  interesFugaAlta: 50, // % de interesados (Tibio/Caliente) que nunca llegaron a dar datos
  interesFugaMedia: 30,
  cierreFugaAlta: 50, // % de quienes dieron datos completos pero no confirmaron
  cierreFugaMedia: 30,
};

function pct(n, d) {
  return d > 0 ? +((100 * n) / d).toFixed(1) : null;
}

// Veredicto de causa raíz: dado en qué etapa se concentra la fuga de ESTE producto,
// ¿es más probable que sea el MENSAJE INICIAL (o el encaje anuncio↔producto — casi nadie
// muestra intención), el EMBUDO/precio (sí se interesan pero no dan datos), el BOT
// (sí dan datos completos, o sea van en serio, pero no cierran — reglas de confirmación),
// o un error TÉCNICO de subida? Es una hipótesis basada en dónde se concentra la fuga,
// nunca una lectura de las conversaciones.
function veredictoCausaRaiz({ d, miFugaPct, entregaFallidaPct, interesFugaPct, cierreFugaPct, baseInteres, baseCierre, muestraInsuficiente }) {
  if (muestraInsuficiente) {
    return { tipo: "muestra_insuficiente", texto: "Muy pocos casos en este rango para diagnosticar con confianza.", recomendacion: "Esperar a acumular más volumen, o revisar un rango de fechas más amplio." };
  }
  const miAlto = miFugaPct !== null && miFugaPct >= THRESHOLDS.mensajeInicialFugaMedia;
  const entregaFallidaAlta = entregaFallidaPct !== null && entregaFallidaPct >= THRESHOLDS.entregaFallidaAlta;
  const interesAlto = interesFugaPct !== null && interesFugaPct >= THRESHOLDS.interesFugaMedia;
  const cierreAlto = cierreFugaPct !== null && cierreFugaPct >= THRESHOLDS.cierreFugaMedia;
  const problemas = [miAlto, interesAlto, cierreAlto].filter(Boolean).length;

  if (miAlto && entregaFallidaAlta) {
    return {
      tipo: "entrega_fallida",
      texto: `${entregaFallidaPct}% de quienes no mostraron intención NUNCA recibieron la etiqueta "Bienvenida Enviada". ⚠️ ADVERTENCIA (confirmado 2026-07-30): esta etiqueta demostró ser POCO CONFIABLE como señal de entrega — se verificaron chats reales con video e imagen entregados y "Visto" por el cliente que igual carecían de la etiqueta. No asumir falla real de entrega sin leer el chat.`,
      recomendacion: "No concluir falla técnica solo por esta etiqueta — verifica una muestra de chats reales de este producto antes de tocar el flujo de bienvenida. Si al leerlos confirmas que el mensaje SÍ llega, la etiqueta es un problema de tagging (menos urgente) y la fuga real está más adelante en el embudo.",
    };
  }

  if (d.errores > 0 && !miAlto && !interesAlto && !cierreAlto) {
    return {
      tipo: "tecnico",
      texto: "El proceso conversacional funciona (la gente sí llega a confirmar) — el único problema detectado es técnico (falla de subida a Lucid Sales), no del bot ni del embudo.",
      recomendacion: "Escalar a soporte de Lucid Bot. No tocar mensaje inicial, precio ni reglas de cierre por esto.",
    };
  }
  if (problemas >= 2) {
    const partes = [];
    if (miAlto) partes.push("el mensaje inicial (muchos ni siquiera muestran intención)");
    if (interesAlto) partes.push("el paso de interés a datos (objeción de precio/oferta probable)");
    if (cierreAlto) partes.push("el cierre (reglas del bot en la confirmación)");
    return {
      tipo: "mixto",
      texto: `Fuga en más de un punto del proceso a la vez: ${partes.join(" y ")}. Son problemas distintos, no uno solo.`,
      recomendacion: cierreAlto
        ? "Priorizar el cierre primero (esos clientes ya invirtieron tiempo, están más cerca de comprar) y después atacar la etapa más temprana."
        : "Empezar por el mensaje inicial (afecta a todo lo que viene después) y luego revisar la etapa siguiente.",
    };
  }
  if (miAlto) {
    const entregaTexto = entregaFallidaPct !== null
      ? ` El ${100 - entregaFallidaPct}% sí tiene la etiqueta "Bienvenida Enviada" (⚠️ etiqueta confirmada poco confiable 2026-07-30 — no usar por sí sola para descartar problemas de entrega, ni para confirmarlos).`
      : "";
    return {
      tipo: "mensaje_inicial",
      texto: `${miFugaPct}% de quienes llegaron por este producto nunca mostraron intención real (se quedaron en Frío/Spam) — el problema está en el primerísimo contacto, antes de cualquier objeción de precio o de cierre.${entregaTexto}`,
      recomendacion: "Candidato a revisar el mensaje inicial de este producto específico (redacción, si coincide con lo que promete el anuncio, o si el anuncio está atrayendo a la audiencia equivocada). Confirmar la causa exacta con análisis cualitativo antes de reescribir nada.",
    };
  }
  if (cierreAlto) {
    return {
      tipo: "bot",
      texto: "La gente SÍ se interesa y SÍ da sus datos completos (o sea, el mensaje inicial y la oferta están funcionando) — la fuga está específicamente en el cierre, ya con el cliente comprometido.",
      recomendacion: "Esto apunta a las REGLAS del bot en el paso de confirmación final, no al mensaje inicial ni al precio — revisar cómo el bot pide la confirmación, cómo maneja el silencio o las dudas de último momento, y si genera suficiente urgencia para cerrar.",
    };
  }
  if (interesAlto) {
    return {
      tipo: "embudo",
      texto: "El mensaje inicial funciona (la gente sí muestra intención), pero muchos interesados nunca completan sus datos de envío. De los que sí llegan a esa etapa, el cierre funciona razonablemente.",
      recomendacion: "Esto apunta a la forma de comunicar el precio/valor o a la oferta en sí, más que a un fallo de reglas del bot en el cierre — revisar cómo se presenta el producto y el precio antes de pedir los datos.",
    };
  }
  return {
    tipo: "sin_problema",
    texto: "Sin fugas relevantes detectadas en ninguna etapa — el proceso conversacional de este producto funciona de principio a fin en esta muestra.",
    recomendacion: null,
  };
}

function diagnosticoProducto(nombre, d) {
  const senales = [];
  const positivas = [];
  const baseInteres = d.intencion_sin_datos + d.sin_confirmar + d.errores + d.ventas;
  const baseCierre = d.sin_confirmar + d.errores + d.ventas;
  const miFugaPct = pct(d.sin_intencion, d.total_contactos);
  const entregaFallidaPct = pct(d.sin_intencion_sin_bienvenida || 0, d.sin_intencion);
  const interesFugaPct = pct(d.intencion_sin_datos, baseInteres);
  const cierreFugaPct = pct(d.sin_confirmar, baseCierre);

  if (d.sin_intencion >= MIN_SAMPLE && entregaFallidaPct !== null) {
    if (entregaFallidaPct >= THRESHOLDS.entregaFallidaAlta) {
      senales.push({
        tipo: "entrega_fallida",
        nivel: "alto",
        texto: `${entregaFallidaPct}% de los "sin intención" de este producto (${d.sin_intencion_sin_bienvenida} de ${d.sin_intencion}) nunca recibieron la etiqueta "Bienvenida Enviada" — el bot no les entregó el mensaje inicial.`,
        recomendacion: "Falla técnica de entrega, no de contenido — revisar el flujo/disparador de bienvenida de este producto antes de tocar la redacción del mensaje.",
      });
    } else {
      positivas.push(`El bot sí entrega el mensaje de bienvenida: solo ${entregaFallidaPct}% de los "sin intención" se quedó sin recibirlo.`);
    }
  }

  if (d.errores > 0) {
    senales.push({
      tipo: "tecnico",
      nivel: "alto",
      texto: `${d.errores} caso(s) confirmado(s) por el cliente pero con error al subir a Lucid Sales — pérdida de ingresos confirmada, no es un problema de conversación.`,
      recomendacion: "Reportar a soporte de Lucid Bot como bug de pérdida de ingresos (ver bug conocido de confirmación-sin-subida). No requiere cambios en el flujo conversacional.",
    });
  } else if (baseCierre >= MIN_SAMPLE) {
    positivas.push("Sin errores técnicos de subida a Lucid Sales.");
  }

  if (d.total_contactos >= MIN_SAMPLE && miFugaPct !== null) {
    if (miFugaPct >= THRESHOLDS.mensajeInicialFugaAlta) {
      senales.push({
        tipo: "mensaje_inicial",
        nivel: "alto",
        texto: `${miFugaPct}% de quienes llegaron por este producto (${d.sin_intencion} de ${d.total_contactos}) nunca mostraron intención — se quedaron en Frío/Spam desde el primer contacto.`,
        recomendacion: "Señal estadística fuerte de fuga en el mensaje inicial — candidato a revisar la redacción, si coincide con el anuncio que originó el clic, o si el anuncio atrae a la audiencia equivocada. Confirmar con análisis cualitativo antes de reescribir el mensaje.",
      });
    } else if (miFugaPct >= THRESHOLDS.mensajeInicialFugaMedia) {
      senales.push({
        tipo: "mensaje_inicial",
        nivel: "medio",
        texto: `${miFugaPct}% de quienes llegaron por este producto (${d.sin_intencion} de ${d.total_contactos}) no mostraron intención tras el mensaje inicial.`,
        recomendacion: "Fuga moderada en el mensaje inicial — vigilar en próximas auditorías.",
      });
    } else {
      positivas.push(`Buen mensaje inicial: ${100 - miFugaPct}% de quienes llegaron sí mostraron intención real.`);
    }
  }

  if (baseInteres >= MIN_SAMPLE && interesFugaPct !== null) {
    if (interesFugaPct >= THRESHOLDS.interesFugaAlta) {
      senales.push({
        tipo: "interes",
        nivel: "alto",
        texto: `${interesFugaPct}% de los interesados (Tibio/Caliente) nunca llegaron a dar sus datos (${d.intencion_sin_datos} de ${baseInteres}).`,
        recomendacion: "Señal estadística fuerte de fuga en la etapa de interés — candidato a objeción de precio, falta de urgencia, o información poco clara al mostrar el producto. Confirmar la causa exacta con análisis cualitativo antes de cambiar el flujo.",
      });
    } else if (interesFugaPct >= THRESHOLDS.interesFugaMedia) {
      senales.push({
        tipo: "interes",
        nivel: "medio",
        texto: `${interesFugaPct}% de los interesados no llegaron a dar sus datos (${d.intencion_sin_datos} de ${baseInteres}).`,
        recomendacion: "Fuga moderada en la etapa de interés — vigilar en próximas auditorías; si se mantiene o sube, priorizar análisis cualitativo de este producto.",
      });
    } else {
      positivas.push(`Buen paso de interés a datos completos: ${100 - interesFugaPct}% de los interesados (Tibio/Caliente) sí llegó a dar sus datos.`);
    }
  }

  if (baseCierre >= MIN_SAMPLE && cierreFugaPct !== null) {
    if (cierreFugaPct >= THRESHOLDS.cierreFugaAlta) {
      senales.push({
        tipo: "cierre",
        nivel: "alto",
        texto: `${cierreFugaPct}% de quienes completaron sus datos no confirmaron el pedido (${d.sin_confirmar} de ${baseCierre}).`,
        recomendacion: "Señal estadística fuerte de fuga en el cierre — candidato a revisar las reglas del bot en el paso de confirmación final (mensaje de resumen, manejo de dudas de último momento, insistencia/urgencia). Confirmar con análisis cualitativo antes de modificar el flujo.",
      });
    } else if (cierreFugaPct >= THRESHOLDS.cierreFugaMedia) {
      senales.push({
        tipo: "cierre",
        nivel: "medio",
        texto: `${cierreFugaPct}% de quienes completaron datos no confirmaron (${d.sin_confirmar} de ${baseCierre}).`,
        recomendacion: "Fuga moderada en el cierre — vigilar en próximas auditorías.",
      });
    } else {
      positivas.push(`Buen cierre: ${100 - cierreFugaPct}% de quienes completaron sus datos confirmaron el pedido.`);
    }
  }

  const muestraInsuficiente = d.total_contactos < MIN_SAMPLE && d.errores === 0;
  const veredicto = veredictoCausaRaiz({ d, miFugaPct, entregaFallidaPct, interesFugaPct, cierreFugaPct, baseInteres, baseCierre, muestraInsuficiente });

  return {
    producto: nombre,
    muestra_contactos: d.total_contactos,
    conversion_pct: d.conversion_pct,
    ventas: d.ventas,
    muestra_insuficiente: muestraInsuficiente,
    embudo: {
      sin_intencion: d.sin_intencion,
      sin_intencion_sin_bienvenida: d.sin_intencion_sin_bienvenida || 0,
      intencion_sin_datos: d.intencion_sin_datos,
      datos_sin_confirmar: d.sin_confirmar,
      confirmada_no_subida: d.errores,
      venta_verificada: d.ventas,
    },
    senales,
    positivas,
    veredicto,
  };
}

function diagnosticoMensajeInicial(conteo, total) {
  const sinIntencion = conteo.sin_intencion || 0;
  const globalPct = pct(sinIntencion, total);
  if (total < MIN_SAMPLE || globalPct === null) {
    return { pct_sin_intencion: globalPct, nivel: "sin_datos", texto: "Muestra insuficiente para evaluar el mensaje inicial en este rango.", recomendacion: null };
  }
  if (globalPct >= THRESHOLDS.mensajeInicialFugaAlta) {
    return {
      pct_sin_intencion: globalPct,
      nivel: "alto",
      texto: `${globalPct}% de todos los contactos del rango (${sinIntencion} de ${total}) nunca mostraron intención (quedaron en Frío/Spam). Ver el desglose por producto más abajo para saber si es un problema general o concentrado en productos puntuales.`,
      recomendacion: "Señal estadística fuerte de que el mensaje inicial (o el encaje anuncio↔mensaje) no está generando suficiente interés. Candidato a revisar el copy del primer mensaje del bot y la consistencia con el anuncio que originó el clic.",
    };
  }
  if (globalPct >= THRESHOLDS.mensajeInicialFugaMedia) {
    return {
      pct_sin_intencion: globalPct,
      nivel: "medio",
      texto: `${globalPct}% de los contactos (${sinIntencion} de ${total}) no mostraron intención tras el mensaje inicial.`,
      recomendacion: "Señal moderada — vigilar en próximas auditorías. Ver el desglose por producto más abajo.",
    };
  }
  return {
    pct_sin_intencion: globalPct,
    nivel: "ok",
    texto: `${globalPct}% sin intención (${sinIntencion} de ${total}) — dentro de un rango razonable.`,
    recomendacion: null,
  };
}

// contactos: array crudo de runAudit (para temperaturas); porProducto/conteo/total: ya calculados en runAudit.
function buildDiagnostico({ contactos, porProducto, conteo, total }) {
  const temperaturas = {};
  for (const c of contactos) {
    const key = c.temperatura || "Sin clasificar";
    temperaturas[key] = (temperaturas[key] || 0) + 1;
  }
  temperaturas["Compra realizada"] = conteo.venta_verificada || 0;

  const veredictoRank = { entrega_fallida: 7, mixto: 6, mensaje_inicial: 5, bot: 4, embudo: 3, tecnico: 2, sin_problema: 1, muestra_insuficiente: 0 };
  const porProductoDiag = Object.entries(porProducto)
    .filter(([nombre]) => nombre !== "(sin producto identificado)")
    .map(([nombre, d]) => diagnosticoProducto(nombre, d))
    .sort((a, b) => (veredictoRank[b.veredicto.tipo] - veredictoRank[a.veredicto.tipo]) || (b.muestra_contactos - a.muestra_contactos));

  return {
    nota_metodologica:
      "Diagnóstico calculado 100% a partir de las etapas del embudo por producto y las temperaturas de calificación (API de Lucid Bot). " +
      "Cada señal es una hipótesis estadística, no una causa confirmada — la API no expone el texto de las conversaciones. " +
      "Para confirmar la causa exacta (redacción del mensaje inicial, forma de comunicar el precio, regla específica del bot) usar 'Pedir análisis cualitativo'.",
    temperaturas,
    mensaje_inicial: diagnosticoMensajeInicial(conteo, total),
    por_producto: porProductoDiag,
  };
}

module.exports = { buildDiagnostico, THRESHOLDS, MIN_SAMPLE };
