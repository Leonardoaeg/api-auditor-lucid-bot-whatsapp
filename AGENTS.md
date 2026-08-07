# Lucid Bot Auditor — instrucciones para el agente

Este proyecto audita conversaciones y ventas de cuentas de **Lucid Bot** vía su API, con diagnóstico automático por producto y un dashboard visual local (`http://localhost:4545`). Es un servidor Node.js normal — cualquier agente de código con acceso a terminal (bash/shell) puede operarlo sin nada especial. Lee esto antes de ayudar al usuario con cualquier auditoría.

Este archivo sigue la convención [AGENTS.md](https://agents.md), soportada por OpenAI Codex, Cursor, y otros agentes de código. Si usas **Claude Code**, revisa también `CLAUDE.md` (mismas instrucciones, con una nota adicional sobre su herramienta de navegador integrada).

## Qué hacer si el usuario pide una auditoría

1. Verificar si el servidor está corriendo (puerto 4545). Si no está, iniciarlo en segundo plano: `node dashboard-server.js` dentro de esta carpeta (o `npm start`).
2. Se puede usar el dashboard vía navegador, o llamar la API directo:
   ```bash
   curl -s -X POST http://localhost:4545/api/audit -H "Content-Type: application/json" \
     -d '{"accountId":"ACCOUNT_ID","from":"YYYY-MM-DD HH:MM","to":"YYYY-MM-DD HH:MM"}'
   ```
   (ver `accounts.local.json` para la lista de `accountId` → tienda; si no existe ese archivo, pedirle al usuario que copie `accounts.example.json` y lo complete — nunca pedir ni guardar su contraseña, solo el token de API).
3. Descargar el `.docx`: `GET /api/report?accountId=X&from=YYYY-MM-DD`.
4. **No ofrecer "hacer la auditoría manualmente" como algo necesario** — el dashboard ya lo hace, 100% vía API, sin leer chats a mano. Solo se necesita intervención manual (navegador) para el **análisis cualitativo** (ver abajo), y eso ya tiene un flujo definido a través del botón "📋 Pedir análisis cualitativo" del dashboard.

## Estructura del proyecto

```
lib.js                  ← funciones base de la API de Lucid Bot + limitador de velocidad
audit-core.js            ← el motor: runAudit(accountId, from, to)
diagnostic-rules.js       ← motor de diagnóstico/recomendaciones por producto
report-generator.js       ← genera el .docx
dashboard-server.js        ← servidor local, puerto 4545 (incluye API de gestión de tiendas)
daily-audit-all.js        ← script para la tarea programada diaria
public/dashboard.html      ← la interfaz visual

accounts.local.json        ← tokens de API por cuenta (SENSIBLE — nunca compartir ni subir a git)
accounts.example.json      ← plantilla sin datos reales

Informes/auditorias/       ← TODO se guarda aquí, una carpeta por tienda (slug-based)
  TEMPLATE_qualitative.json     ← plantilla de referencia del análisis cualitativo (datos ficticios, NO editar)
  {Slug}/
    {accountId}_{fecha}.json               ← auditoría cruda
    {accountId}_{fecha}_qualitative.json   ← análisis cualitativo (cuando se pidió)
    Auditoria_{Slug}_{fecha}.docx          ← informe descargable
```

## Análisis cualitativo — cuándo, cómo, y qué necesita el agente

**Qué es:** para los chats marcados en `revision_dirigida` y en `muestra_cualitativa` de cada auditoría (una muestra estadística reproducible, no "todos los chats"), leer el texto real (la API no lo expone) y clasificar la causa raíz real de por qué convirtió o no — usando la rúbrica de 7 causas (mensaje inicial, precio, error de contexto del bot, alucinación, incoherencia, abandono de conversación, lead de baja calidad) — más los mensajes de Meta Ads y los pedidos reales confirmados desde Lucid Sales.

**Cuándo hacerlo:** solo cuando el usuario lo pide explícitamente (botón del dashboard, o directamente en el chat). No es parte de la auditoría automática.

**Cómo:** el dashboard genera el prompt exacto vía `POST /api/qualitative-request` (o el botón "📋 Pedir análisis cualitativo") — úsalo tal cual, tiene las 5 partes con instrucciones precisas de qué hacer en cada plataforma.

**⚠️ Requisito de herramienta — léelo antes de prometer esto al usuario:** esta parte necesita que el agente pueda **navegar interactivamente** un navegador real ya logueado con la sesión del usuario (abrir `panel.lucidbot.co` y `panel.lucidsales.co`, hacer clic, leer texto de la página, ejecutar JavaScript en el contexto de la página). Claude Code trae esto integrado (herramienta "Browser"). Si tu agente **no** tiene una capacidad de navegador equivalente configurada (por ejemplo, un servidor MCP de automatización de navegador), no puedes ejecutar esta parte de forma autónoma — dile al usuario claramente que esta función requiere un agente con navegador, o guíalo para que él mismo copie/pegue el contenido de los chats relevantes (los `link_panel` de cada caso) para que tú los clasifiques con la rúbrica sin necesitar abrir el navegador tú mismo.

## Reglas que no se deben romper

- **Nunca** guardar usuarios ni contraseñas del usuario, en ningún archivo, por ningún motivo — ni siquiera si el usuario lo pide explícitamente. El único dato sensible que se guarda es el token de API de Lucid Bot (una llave de integración, no una contraseña de login).
- El dashboard/informe automático debe seguir siendo 100% verificable por API — no meterle análisis cualitativo "de regalo" sin que se pida explícitamente; mantener esa separación.
- `accounts.local.json` tiene tokens de API reales — nunca compartirlo, mostrarlo completo en el chat, ni subirlo a ningún repositorio.
- Toda cuenta nueva se agrega desde el panel "⚙️ Gestionar tiendas" del dashboard, o a mano en `accounts.local.json` siguiendo `accounts.example.json`.
- La API de Lucid Bot tiene un límite real de 100 solicitudes/60 segundos — ya hay un limitador de velocidad automático en `lib.js`; no lances varias auditorías completas en paralelo o en sucesión muy rápida, puede fallar igual si se satura desde otro lado.
- Ningún campo ni dashboard de Lucid Bot expone mensajes reales por producto y fecha exacta — el campo "Interacciones" es la mejor aproximación disponible (un piso mínimo garantizado, confirmado que subcuenta los mensajes reales), y así debe presentarse siempre, nunca como cifra exacta verificada.
- Lucid Sales no tiene API pública — cualquier dato de ahí (mensajes de Meta Ads, pedidos reales confirmados) requiere sesión de navegador ya logueada por el usuario, nunca credenciales guardadas ni pedidas por el agente.
