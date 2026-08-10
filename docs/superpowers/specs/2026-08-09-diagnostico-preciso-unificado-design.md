# Diagnóstico preciso y unificado por producto — diseño

**Fecha:** 2026-08-09
**Estado:** Aprobado por el usuario (brainstorming), pendiente de plan de implementación.

## Contexto

Lucid Bot Auditor ya tiene dos motores de diagnóstico por producto:

1. **Estadístico automático** (`diagnostic-rules.js`, siempre corre): calcula en qué etapa del embudo se concentra la fuga de cada producto (mensaje inicial / interés→datos / cierre) y da una hipótesis de causa raíz con recomendación. Nunca lee texto de conversaciones (la API no lo expone).
2. **Cualitativo** (flujo de 5 partes, "📋 Pedir análisis cualitativo", solo bajo pedido): un agente con navegador lee chats reales de una muestra estadística reproducible y clasifica cada caso en una de 7 causas raíz, con cita textual como evidencia. También reconcilia con mensajes de Meta Ads y pedidos confirmados de Lucid Sales (ambos solo accesibles vía sesión de navegador logueada — Lucid Sales no tiene API pública, confirmado en `AGENTS.md`).

El 2026-08-09 se corrigieron 10 bugs de exactitud/limpieza en el motor de auditoría (`audit-core.js`, `audit.js`, `daily-audit-all.js`) encontrados en un code review — ver commits de esa fecha. Este diseño es la fase siguiente: **el usuario reporta que el sistema funciona pero le falta precisión** — ejemplo concreto dado: un caso clasificado como `objecion_precio` cuando la causa real era que el cliente "no tiene el dinero todavía" (una causa con una acción de negocio distinta: seguimiento programado, no ajustar precio).

## Objetivo de esta fase

Que el informe indique, con precisión y en un solo lugar, dónde está la falla real de cada producto y qué hacer al respecto — sin construir todavía la integración con Lucid Sales (no tiene API) ni la plataforma pública multiusuario (fase de escalamiento que el usuario dirigirá después de esta).

## Alcance

**Dentro de esta fase:**
1. Rúbrica cualitativa v2: sub-causas específicas donde cambian la recomendación de negocio.
2. Instrucciones más rigurosas al agente que lee los chats (Parte 5 del prompt cualitativo).
3. Diagnóstico unificado: un solo veredicto por producto en el reporte (JSON + dashboard + docx), no dos secciones separadas que hay que cruzar a mano.
4. Actualización de plantillas/esquema de archivos (`TEMPLATE_qualitative.json`, formato de salida del prompt, sección del docx) para soportar sub-causas.
5. Investigación (spike) de una fuente más precisa de conteo de mensajes en la API de Lucid Bot, en reemplazo o complemento de "Interacciones" (que subcuenta, confirmado contra un chat real).

**Fuera de esta fase (confirmado con el usuario):**
- Conexión programática con Lucid Sales — no existe API pública hoy; se sigue usando solo vía sesión de navegador logueada.
- Plataforma pública multiusuario / SaaS — el usuario la dirigirá en una fase de escalamiento posterior. Queda registrada como pregunta abierta (ver "Consideraciones futuras" abajo) pero no se diseña ni implementa ahora.

## 1. Rúbrica cualitativa v2

Se mantienen las 7 causas raíz de alto nivel (para no romper comparabilidad con auditorías/análisis previos ya guardados) y se agregan sub-causas **solo donde distintas sub-causas requieren una recomendación de negocio distinta** — criterio YAGNI explícito, no se subdivide por subdividir.

| Causa raíz | Sub-causas nuevas | Por qué se separan (acción distinta) |
|---|---|---|
| `mensaje_inicial_contenido` | `contenido_no_atractivo`, `desalineado_con_anuncio` | Reescribir el mensaje vs. corregir el anuncio/segmentación de Meta. `desalineado_con_anuncio` debe cruzarse con la detección automática ya existente (`atribucion_producto`, `mensaje_inicial_por_producto.mismatches`) como evidencia de apoyo. |
| `objecion_precio` | `precio_alto_percibido`, `sin_fondos_momento`, `precio_no_visto`, `precio_sin_confianza` | Bajar precio/oferta vs. programar seguimiento a 2-4 semanas vs. rediseñar dónde/cómo se muestra el precio vs. reescribir cómo el bot responde cuando preguntan directo. Este es el caso que motivó el rediseño. |
| `bot_error_contexto` | `dato_desactualizado`, `dato_contradice_cliente` | Actualizar catálogo/reglas en Lucid Sales vs. ajustar manejo de contexto conversacional del asistente. |
| `bot_alucina` | *(sin sub-causas)* | La acción siempre es la misma: revisar/ajustar las reglas del asistente para ese producto en Lucid Sales. |
| `bot_incoherente` | *(sin sub-causas)* | La acción siempre es la misma: revisar el flujo conversacional del asistente. |
| `bot_abandona_conversacion` | `no_maneja_objecion`, `no_hay_llamado_a_cierre` | Reglas de manejo de objeciones vs. reglas de urgencia/cierre. |
| `leads_baja_calidad` | `curioso_no_comprador`, `publico_no_objetivo` | Nada que ajustar en el bot vs. ajustar segmentación de la campaña de Meta. |
| `sin_causa_clara` | *(sin sub-causas)* | Se mantiene igual — no se fuerza una categoría. |

**Nota de validación:** esta tabla es un primer diseño basado en el ejemplo real que dio el usuario y en las categorías ya documentadas en el código. Durante la implementación se valida contra `TEMPLATE_qualitative.json` y auditorías cualitativas ya guardadas (si existen) antes de darla por final — si algún caso real no encaja bien en ninguna sub-causa, se ajusta la tabla, no se fuerza el caso.

## 2. Instrucciones más rigurosas (Parte 5 del prompt cualitativo)

En `buildQualitativePrompt()` (`dashboard-server.js`), la Parte 5 ya exige cita textual literal por caso. Se agrega:

- Una **regla de desambiguación explícita por sub-causa** de la tabla anterior (ej.: "si el cliente dice que le interesa pero no tiene el dinero AHORA, es `sin_fondos_momento`, NO `precio_alto_percibido` — son recomendaciones de negocio opuestas, no las mezcles").
- Un **paso de auto-chequeo** antes de fijar la causa final: releer la cita elegida y confirmar que respalda específicamente la sub-causa asignada (no solo la causa raíz general).
- El formato de salida pedido (JSON) incluye `sub_causa` junto a `causa` en cada caso de `casos`, y `causas`/conteos se agregan también por sub-causa.

## 3. Diagnóstico unificado (un veredicto por producto)

Hoy: `diagnostico.por_producto` (estadístico, siempre presente en el JSON de la auditoría) y `diagnostico_cualitativo.por_producto` (cualitativo, en un JSON aparte, solo si se pidió) son dos artefactos separados que hay que cruzar a mano.

Diseño:
- Al armar la respuesta de `/api/report`, `/api/audit-file` y el flujo del docx (`dashboard-server.js`, `daily-audit-all.js`), si existe el JSON cualitativo para esa fecha, su veredicto (causa + sub-causa + cita) **reemplaza** la hipótesis estadística como el veredicto mostrado para ese producto. La hipótesis estadística queda como contexto/respaldo (visible pero no como conclusión principal).
- Si no hay análisis cualitativo, se sigue mostrando la hipótesis estadística, rotulada explícitamente como **"hipótesis estadística, no confirmada"** (ya es parcialmente así en el texto de `diagnostic-rules.js`; se refuerza para que sea inequívoco en el docx/dashboard).
- Las recomendaciones de texto se reescriben por sub-causa, no solo por causa raíz (ver ejemplos en la tabla de la sección 1).
- Archivos afectados: `audit-core.js` o `dashboard-server.js` (dónde vive la lógica de merge — se decide en el plan de implementación), `report-generator.js` (una sola sección de veredicto en el docx en vez de dos), `public/dashboard.html` (misma fusión en la vista web).

## 4. Plantillas/esquema de archivos

- `Informes/auditorias/TEMPLATE_qualitative.json`: agregar `sub_causa` junto a `causa` en cada caso de ejemplo, y `causas` desglosado también por sub-causa.
- `buildQualitativePrompt()` (Parte 5, `dashboard-server.js`): actualizar el formato de salida JSON pedido para incluir `sub_causa`.
- `report-generator.js`: nueva sección de veredicto unificado (reemplaza las dos secciones actuales de diagnóstico estadístico + cualitativo).

## 5. Investigación de conteo de mensajes (spike)

El campo "Interacciones" (custom field) es hoy la única fuente disponible y está confirmado que subcuenta contra un chat real. El reporte ya lo declara como "piso mínimo garantizado", no cifra exacta.

Alcance del spike: revisar la API de Lucid Bot (endpoints de conversación/mensajería por contacto, no solo `custom_fields`) buscando una fuente 1:1 real de conteo de mensajes por contacto y por rango de fechas. Es investigación, no una implementación comprometida — si no existe tal endpoint, se documenta como límite confirmado (no solo asumido) y se deja el mecanismo actual sin cambios, con el texto de advertencia ya existente.

## Consideraciones futuras (fuera de esta fase, no se diseña ahora)

Pregunta abierta que el usuario planteó para cuando se decida escalar a una plataforma pública: si un tercero quiere auditar cualitativamente su propia tienda, ¿lo hace con su propio agente de IA (modelo "traé tu propio agente", como funciona hoy — la plataforma nunca ve credenciales/sesión del usuario) o la plataforma corre su propia infraestructura de automatización de navegador por cliente (modelo "servicio hospedado", con costo/responsabilidad de seguridad mucho mayor)? Registrada para la fase de escalamiento, no bloquea ni afecta el diseño de esta fase (que sigue siendo local, una cuenta a la vez).

## Testing / validación

- Los cambios de `audit-core.js`/`dashboard-server.js`/`daily-audit-all.js` para el merge de diagnóstico se validan con un escenario en memoria (mock de `lib.js`, sin red), igual al usado para verificar los 10 bugs corregidos el 2026-08-09 — casos: producto sin cualitativo (debe mostrar hipótesis rotulada como tal), producto con cualitativo (debe mostrar el veredicto cualitativo con sub-causa, no la hipótesis).
- La rúbrica v2 y el prompt de Parte 5 no son testeables por unit test (dependen de lectura de chats reales por un agente) — se validan releyendo `TEMPLATE_qualitative.json` actualizado y, si hay auditorías cualitativas reales guardadas, revisando si la sub-causa asignada tiene sentido retroactivamente.
- El spike de conteo de mensajes no tiene criterio de "éxito" fijo — su resultado (hay fuente mejor / no la hay) define si abre una tarea de implementación adicional.

## Archivos que toca esta fase (resumen)

- `diagnostic-rules.js` — recomendaciones por sub-causa, texto del veredicto.
- `dashboard-server.js` — `buildQualitativePrompt()` (Parte 5), lógica de merge del diagnóstico unificado en las rutas que arman el reporte.
- `report-generator.js` — sección única de veredicto en el docx.
- `public/dashboard.html` — misma fusión en la vista web.
- `Informes/auditorias/TEMPLATE_qualitative.json` — esquema con `sub_causa`.
- `daily-audit-all.js` — si el merge de diagnóstico también aplica al .docx nocturno (debe ser consistente con `dashboard-server.js`, ver hallazgo ya corregido sobre esto mismo).
- `lib.js` / investigación de API — spike de conteo de mensajes, sin archivo de destino fijo hasta ver el resultado.
