# Changelog

Todas las novedades importantes de este proyecto se documentan aquí. Para actualizar, ver la sección "Actualizar a una versión nueva" del [README](README.md).

## [1.7.0] — 2026-08-14

Efectividad por producto, tendencia general entre auditorías, y listo para desplegar en un hosting.

- **Nuevo: "🏆 Efectividad por producto" en el histórico.** Ranking de qué producto convierte mejor (ventas ÷ contactos), con los productos de muestra confiable primero — los que tienen pocos contactos acumulados quedan al final marcados como "muestra baja" para que no le ganen el primer puesto a un producto real con volumen (ej. un 100% con 1 solo contacto ya no aparece como "el más efectivo").
- **Nuevo: "📈 Tendencia general" en el histórico.** Dos mini-gráficos (conversión % y ventas) con una barra/punto por auditoría guardada en orden cronológico, con tooltip al pasar el mouse — responde al mismo filtro de rango de fechas del panel.
- **Nuevo: listo para desplegar en un hosting (Railway u otro).** `PORT`, `DATA_DIR`/`ACCOUNTS_FILE`/`AUDITS_DIR` y `ALLOWED_ORIGINS` (CORS) ahora se leen de variables de entorno, con los mismos valores por defecto de siempre — el uso local no cambia en nada. Incluye `.env.example`, `railway.json` y un healthcheck en `GET /api/health`. Ver la nueva sección "Desplegar en un hosting" del README — en particular, el aviso de que la mayoría de hostings usan disco efímero y de que el dashboard todavía no tiene login.

## [1.6.0] — 2026-08-13

Filtro de fechas para el histórico, estilo Meta Ads Manager.

- **Nuevo: filtro de rango de fechas en "Cómo va la operación — histórico por tienda".** Botón "📅 Rango de fechas" que abre un popover con atajos (Hoy, Ayer, Últimos 7 días, Últimos 30 días, Este mes, Mes anterior, Todo el histórico) y un calendario navegable para elegir un rango libre haciendo clic en el día inicial y el final. El filtro es real de extremo a extremo: `GET /api/history` ahora acepta `from`/`to` y recalcula KPIs, tabla por producto y listado de auditorías solo con las auditorías del rango elegido — no es solo cosmético sobre la tabla. Sin dependencias externas (widget propio en vanilla JS).

## [1.5.0] — 2026-08-13

Corrección definitiva de la paginación en cuentas grandes, auditorías asíncronas, y desglose de canal por pedido.

- **Corregido: el corte de 5.000 registros de la v1.4.0 seguía sin alcanzar en cuentas realmente grandes.** Se confirmó (consultando la API directamente) que un pipeline de una cuenta real puede tener 45.000–48.000 oportunidades históricas, y que NO vienen ordenadas por fecha — están dispersas en todo el rango de IDs internos, así que no hay forma segura de "parar antes" por fecha. El tope de páginas ahora es solo un techo de seguridad contra un bucle infinito (el corte real sigue siendo "la página trajo menos registros de los pedidos", es decir, el final real de los datos).
- **Nuevo: auditorías en segundo plano, sin límite de tiempo de conexión.** Antes, una auditoría larga podía fallar por timeout del lado del cliente aunque el servidor ya hubiera terminado bien. Ahora `POST /api/audit-async` devuelve un `jobId` al instante y el dashboard hace polling cada 3s contra `GET /api/audit-status` hasta que termina — sin depender de mantener una sola conexión HTTP abierta durante minutos u horas.
- **Nuevo: desglose de canal por pedido (WhatsApp vs Shopify vs otros) en el análisis cualitativo.** El flujo de "Pedir análisis cualitativo" ahora consulta directamente el listado real de pedidos de Lucid Sales y reporta automáticamente cuántas ventas del rango auditado vinieron por cada canal, en vez de requerir investigarlo a mano cada vez.

## [1.4.0] — 2026-08-12

Un bug crítico de pérdida de datos, y detección real de fotos no enviadas.

- **Corregido: pérdida silenciosa de contactos en cuentas grandes.** El motor traía como máximo 5.000 oportunidades históricas por pipeline — cualquier cuenta con más leads que eso perdía contactos reales en TODAS las auditorías, sin ningún aviso. Ahora el corte es por tiempo (no se queda colgado en cuentas enormes) y, si aun así no alcanza a traer todo, la auditoría lo dice explícitamente en las advertencias en vez de fallar en silencio.
- **Nuevo: detección de fotos del producto no enviadas.** Cuando el anuncio de Meta que originó el contacto no está mapeado en las variables multimedia del producto en Lucid Sales, el bot puede terminar enviando un marcador de "aquí van las fotos" sin resolver, como texto literal, en vez de la foto/video real. El auditor ahora detecta ese marcador roto directamente en el mensaje generado — evidencia textual real, no una suposición por campos vacíos (un primer intento basado en eso dio 83% de falsos positivos y se descartó).

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
