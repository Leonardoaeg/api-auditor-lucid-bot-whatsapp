# Changelog

Todas las novedades importantes de este proyecto se documentan aquí. Para actualizar, ver la sección "Actualizar a una versión nueva" del [README](README.md).

## [1.3.0] — 2026-08-07

Instalación con más agentes de código, y limpieza del repositorio.

- **Compatible con OpenAI Codex (y otros agentes AGENTS.md).** Nuevo `AGENTS.md` con instrucciones completas y neutrales para cualquier agente de código con acceso a terminal — Codex, Cursor, y otros lo leen automáticamente igual que Claude Code lee `CLAUDE.md`. Ver la sección "Usar con un agente de código" del README para las diferencias entre agentes (en particular, la parte de análisis cualitativo necesita navegador interactivo, que no todos los agentes traen integrado).
- **Limpieza de ejemplos.** Se reemplazaron nombres de productos/tiendas reales usados como ejemplos ilustrativos en comentarios y en la plantilla de análisis cualitativo por datos genéricos — el repositorio documenta la estructura y el funcionamiento del sistema, no datos de ninguna cuenta real.

## [1.2.0] — 2026-08-07

Motor de diagnóstico cualitativo (lectura real de chats) y una corrección importante de fechas.

- **Diagnóstico cualitativo por producto con rúbrica de 7 causas.** Nuevo motor de muestreo estadístico estratificado (10% por sub-grupo, reproducible entre corridas) que decide exactamente qué chats leer para determinar la causa raíz REAL de por qué un producto no convierte: contenido del mensaje inicial, objeción de precio, error de contexto del bot, alucinación, incoherencia, abandono de conversación, o mala calidad del lead — con cita textual como evidencia, no solo hipótesis estadística. Se ejecuta con el botón "Pedir análisis cualitativo" del dashboard.
- **Nuevo: detección automática de atribución de anuncio incorrecta.** El campo "Producto Interesado _ Ad ID" (el anuncio que originó el clic) a veces no coincide con el producto que la persona realmente terminó comprando — el auditor ahora lo detecta automáticamente comparando ese tag contra el producto real del pedido, sin necesidad de leer chats a mano. Aparece como tarjeta nueva en el dashboard y sección nueva en el DOCX solo cuando hay casos.
- **Corregido: auditorías de varios días o "hasta ahora" se pisaban entre sí.** El archivo guardado se nombraba con la fecha de inicio del rango — dos corridas distintas con el mismo inicio pero fechas de fin diferentes terminaban sobrescribiéndose. Ahora se nombra con la fecha en que la auditoría realmente se corrió cuando el rango no es exactamente un día calendario completo.

## [1.1.0] — 2026-08-01

Mejoras grandes al motor de auditoría y al dashboard, todas basadas en casos reales encontrados usando el auditor día a día.

- **Canal de confirmación separado: API/Shopify vs. Chat WhatsApp.** Cada venta y cada contacto ahora se clasifica por el canal real donde se confirmó el pedido (pipeline "Pedidos - Landing" o etiqueta real "Subido Shopify" = Shopify/API; el resto = conversación de WhatsApp). Se muestra en una tarjeta nueva y en columnas de las tablas existentes — pero solo aparece si la tienda realmente usa esa integración, para no ensuciar el reporte de tiendas que no la tienen.
- **Conteo de conversaciones (chats reales), total y por producto.** Nueva sección que cuenta cuántas conversaciones de WhatsApp reales entraron en el rango, separado de los pedidos que llegaron directo por Shopify/API sin pasar por un chat — con desglose por producto.
- **Corregido: devoluciones contadas como ventas nuevas.** Cuando Lucid Sales procesa la devolución de un pedido viejo, el pedido se actualiza y antes lo contábamos como una venta nueva del día. Ahora se detecta por la etiqueta real de devolución y se excluye del conteo, mostrando el detalle aparte para que quede visible por qué se excluyó.
- **Corregido: falsos positivos en "ventas sospechosas".** Antes se marcaba una venta como sospechosa solo por no tener una etiqueta específica, aunque el pedido ya estuviera entregado o en reparto. Ahora solo se marca cuando hay evidencia real de fallo (etiqueta de error explícita).
- **Detalle completo de contactos por producto.** Antes solo se veían en detalle los contactos ya priorizados (ventas, errores, etc.) — ahora cualquier producto muestra el listado completo de TODOS sus contactos, filtrable desde el mismo selector de producto de siempre.
- **Comparación de un producto entre auditorías guardadas.** Nuevo selector en el histórico por tienda: elige un producto y ves su evolución día por día en todas las auditorías guardadas, para detectar tendencias sin abrir cada informe por separado.
- **Evaluación del mensaje inicial por producto.** Nueva sección que muestra cuántos contactos sí/no tienen la etiqueta de bienvenida, y detecta automáticamente cuando el mensaje real que recibió el contacto menciona un producto DISTINTO al que clickeó (bug de plantilla cruzada) — con la cita real del mensaje y el link al chat.
- **Corrección importante de metodología: la etiqueta "Bienvenida Enviada" no es confiable.** Se comprobó con chats reales que el mensaje sí llega aunque la etiqueta no se aplique. El diagnóstico ya no afirma "falla de entrega" como hecho — ahora advierte que hay que verificar el chat real antes de concluir eso.
- **Supervisor `keep-alive.cmd` (Windows).** Script opcional que reinicia el dashboard automáticamente si el proceso se cae — ver el README para cómo usarlo.

## [1.0.0] — 2026-07-27

Primera versión pública del auditor.

- Motor de auditoría vía API de Lucid Bot (embudo, ventas, errores de subida, por producto).
- Detección de contactos recurrentes y ventas confirmadas en el rango pero originadas en otra fecha.
- Verificación cruzada automática de ventas contra las etiquetas reales de Lucid Sales (`Pedido subido LucidSales`, fallas de subida/modificación) — detecta el bug "confirmado pero no subido" sin leer chats a mano.
- Motor de diagnóstico por producto: distingue entre falla de entrega del bot, mensaje inicial, forma de comunicar precio/oferta, y reglas de cierre — con recomendaciones basadas 100% en datos reales.
- Dashboard visual con gestión de tiendas, historial de auditorías (sin re-consultar la API), y descarga de informes Word.
- Reconciliación opcional con Lucid Sales: mensajes reales de Meta Ads y pedidos reales confirmados por producto (vía análisis cualitativo asistido).
- Limitador de velocidad automático para respetar el límite real de la API de Lucid Bot (100 solicitudes/60s).
- Tarea diaria automatizable (`daily-audit-all.js`) para auditar todas las cuentas sin intervención.
