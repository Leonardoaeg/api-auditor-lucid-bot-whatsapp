# Lucid Bot Auditor

Auditor automatizado de conversaciones y ventas para cuentas de **Lucid Bot**, con dashboard visual, diagnóstico por producto (mensaje inicial / reglas del bot / precio), y verificación cruzada contra **Lucid Sales**. Diseñado para operarse conversando en español con un agente de código IA — funciona con **[Claude Code](https://claude.com/claude-code)**, **[OpenAI Codex](https://developers.openai.com/codex)**, o cualquier otro agente compatible con la convención [AGENTS.md](https://agents.md) — ver [Usar con un agente de código](#usar-con-un-agente-de-código).

## Qué hace

- Audita cualquier rango de fecha/hora vía la API de Lucid Bot — sin login, sin leer chats a mano.
- Clasifica cada contacto: sin intención, interesado sin datos, datos sin confirmar, error de subida, o venta verificada.
- Detecta contactos recurrentes, ventas confirmadas en el rango pero originadas en otra fecha, y cruza etiquetas reales de Lucid Sales para detectar ventas "confirmadas pero no subidas".
- Diagnóstico automático por producto: identifica si el problema es el mensaje inicial, la falla de entrega del bot, la forma de comunicar el precio, o las reglas de cierre — con recomendaciones basadas 100% en datos reales, nunca inventadas.
- Separa el canal real de confirmación de cada venta (Shopify/API vs. conversación de WhatsApp) y cuenta las conversaciones reales del rango, en total y por producto.
- Detecta automáticamente cuando el mensaje de bienvenida real que recibió un contacto menciona un producto distinto al que clickeó (bug de plantilla cruzada), citando el mensaje real.
- Detecta automáticamente cuando el producto del anuncio que originó el clic no coincide con el producto realmente vendido (bug de atribución de anuncio), citando ambos productos y el link al chat.
- Diagnóstico cualitativo por producto con rúbrica de 7 causas (mensaje inicial, precio, error de contexto del bot, alucinación, incoherencia, abandono de conversación, lead de baja calidad) — usa muestreo estadístico reproducible y lectura real de chats con cita textual como evidencia.
- Compara un mismo producto entre auditorías guardadas para ver su tendencia día por día.
- Dashboard local en el navegador: corre auditorías, descarga informes Word, mantiene historial y operación acumulada por tienda.
- Soporta múltiples tiendas/cuentas desde el mismo panel.
- Tarea diaria automática opcional (sin intervención).

## Requisitos

- [Node.js](https://nodejs.org/) 18 o superior.
- Una cuenta de Lucid Bot con acceso a **Ajustes → Integraciones** para sacar el token de API.
- Un agente de código IA (recomendado, no obligatorio) para operar el sistema conversando en español y para el análisis cualitativo (lectura de chats, cruce con Lucid Sales) — ver [Usar con un agente de código](#usar-con-un-agente-de-código) para las opciones y sus diferencias.

## Instalación

1. Clona el repositorio:
   ```bash
   git clone https://github.com/TU-USUARIO/lucidbot-auditor.git
   cd lucidbot-auditor
   ```
2. Instala las dependencias:
   ```bash
   npm install
   ```
3. Copia el archivo de ejemplo de cuentas y complétalo con tus datos reales:
   ```bash
   cp accounts.example.json accounts.local.json
   ```
   Edita `accounts.local.json` y por cada tienda agrega:
   - `name`: nombre visible.
   - `slug`: nombre corto sin espacios (se usa para carpetas y nombres de archivo).
   - `token`: tu token de API de Lucid Bot, formato `{accountId}.{token}` (Ajustes → Integraciones dentro del panel de esa tienda).
   - `lucidSalesStoreName`: cómo aparece esa tienda en el switcher de Lucid Sales (puede no ser idéntico al nombre — si no lo sabes, deja el mismo `name` y corrígelo después desde el dashboard).

   **`accounts.local.json` nunca se sube a git** (ya está en `.gitignore`) — contiene tus credenciales reales.

## Uso

### 1. Prender el dashboard

```bash
npm start
```

Abre en tu navegador: **http://localhost:4545**

### 2. Gestionar tiendas

Desde el panel **"⚙️ Gestionar tiendas"** puedes agregar, editar o quitar tiendas sin tocar archivos a mano.

### 3. Ejecutar una auditoría

1. Elige la tienda, fecha y hora "Desde"/"Hasta".
2. Clic en **Ejecutar auditoría**.
3. Revisa el embudo general y por producto, ventas verificadas, y el panel de diagnóstico con recomendaciones.
4. **⬇ Descargar informe Word** para un reporte completo y profesional.

### 4. Historial y operación por tienda

El panel **"📊 Cómo va la operación — histórico por tienda"** acumula las auditorías guardadas de una tienda (contactos, ventas, valor, conversión, por producto) sin volver a llamar la API. Incluye:
- **Filtro de rango de fechas** (botón "📅 Rango de fechas"): un popover con atajos (Hoy, Ayer, Últimos 7 días, Últimos 30 días, Este mes, Mes anterior, Todo el histórico) y un calendario navegable para elegir un rango libre — filtra tanto el listado de auditorías como los KPIs/tabla por producto, no solo la tabla.
- **📈 Tendencia general**: un mini-gráfico de conversión % y otro de ventas, una barra/punto por auditoría guardada en orden cronológico, para ver de un vistazo si el rango elegido va mejorando o empeorando.
- **🏆 Efectividad por producto**: ranking de qué producto convierte mejor (ventas ÷ contactos), con los productos de muestra confiable primero — los que tienen pocos contactos acumulados quedan marcados como "muestra baja" al final, para que un 100% con 1 solo contacto no le gane el primer puesto a un producto real con cientos.
- Un selector para **comparar un producto entre auditorías guardadas** (ej. un mismo producto entre dos fechas) y ver su tendencia día por día.
- El listado de auditorías individuales — verlas de nuevo no gasta cuota, se leen del disco.

### 5. Correr siempre en segundo plano (Windows, opcional)

Si quieres que el dashboard se mantenga corriendo solo (se reinicia automáticamente si se cae) en vez de correr `npm start` manualmente cada vez:

1. Doble clic en `keep-alive.cmd` — queda corriendo en segundo plano y reinicia el servidor si se cierra.
2. Para que arranque solo al iniciar sesión en Windows: crea un acceso directo a `keep-alive.cmd` en la carpeta de inicio (`Win+R` → `shell:startup`).

### 6. Análisis cualitativo (opcional, requiere navegador)

El botón **"📋 Pedir análisis cualitativo"** genera un texto listo para pegarle a Claude Code, que entonces:
- Lee los chats reales de los casos más importantes (ventas a confirmar, errores, datos sin confirmar).
- Trae los mensajes reales de Meta Ads y los pedidos reales confirmados desde Lucid Sales (esto sí requiere que inicies sesión ahí manualmente — nunca se automatiza ni se guardan contraseñas).
- Desglosa automáticamente los pedidos del rango auditado por canal (WhatsApp / Shopify / otros), a partir del listado real de pedidos de Lucid Sales.

### 7. Informe profundo (opcional, requiere navegador — lento pero exhaustivo)

El botón **"📄 Pedir informe profundo"** es un TERCER modo, distinto del análisis cualitativo: en vez de una muestra del 10%, lee cada chat COMPLETO (hasta 200 por corrida) para encontrar bugs concretos de comportamiento del bot que el motor automático no puede detectar (son juicios sobre el hilo completo de la conversación, no datos estructurados de la API) — por ejemplo: el bot vuelve a saludar a mitad de una conversación, manda 5+ fotos seguidas sin que nadie responda, describe el producto equivocado, ignora una pregunta directa, repite la misma pregunta, o falla al mandar una foto pedida. También agrega los errores técnicos vistos en "Ver acciones ejecutadas" de cada chat en una tabla contada. El resultado: un informe con cita textual y la regla/flujo exacto a corregir por cada falla, más un orden de ataque priorizado — úsalo cuando necesites cazar bugs reales del bot, no para la auditoría de ventas de todos los días.

## Usar con un agente de código

Este proyecto es un servidor Node.js normal — cualquier agente de código con acceso a terminal puede operarlo. Trae dos archivos de instrucciones para que el agente entienda el proyecto automáticamente, sin que se los tengas que explicar:

- **[AGENTS.md](AGENTS.md)** — instrucciones completas y neutrales (estructura del proyecto, cómo correr una auditoría, cómo funciona el análisis cualitativo, reglas de seguridad). Es la convención [agents.md](https://agents.md), que leen automáticamente **OpenAI Codex**, **Cursor**, y varios otros agentes.
- **[CLAUDE.md](CLAUDE.md)** — un archivo corto que remite a `AGENTS.md` más una nota específica de Claude Code. Es la convención que lee **Claude Code** automáticamente.

En cualquiera de los dos, no necesitas explicarle nada al agente — solo pídele en español lo que quieres, por ejemplo:

- *"Corre la auditoría de [tienda] del [fecha] al [fecha]."*
- *"Haz el análisis cualitativo de [tienda] del [fecha]."*
- *"Prende el dashboard."*

### Claude Code

```bash
cd lucidbot-auditor
claude
```

Claude Code trae integrada una herramienta de navegador interactivo, así que puede ejecutar el **análisis cualitativo completo** (leer chats reales, entrar a Lucid Sales con tu sesión) sin configuración adicional — solo le tienes que iniciar sesión manualmente cuando te lo pida.

### OpenAI Codex

```bash
npm install -g @openai/codex   # instala el CLI de Codex (verifica el nombre exacto del paquete en la documentación oficial de OpenAI si este comando cambió)
cd lucidbot-auditor
codex
```

Codex lee `AGENTS.md` automáticamente igual que Claude Code lee `CLAUDE.md`. Puede correr auditorías y operar el dashboard sin ningún ajuste — es solo Node.js.

⚠️ **Diferencia importante:** el análisis cualitativo (leer chats reales, entrar a Lucid Sales) necesita que el agente pueda **navegar un navegador real, interactivamente, ya logueado con tu sesión** — no solo hacer peticiones HTTP. Codex CLI, por defecto, no trae esa capacidad integrada como Claude Code. Si tu instalación de Codex tiene un servidor MCP de navegador configurado, debería funcionar igual; si no, puedes: (a) usar Claude Code solo para esa parte del flujo, o (b) copiar manualmente el texto de los chats señalados (`link_panel` de cada caso en el JSON de la auditoría) y pegárselo a Codex para que aplique la rúbrica de causas sin que él mismo tenga que navegar.

### Otros agentes compatibles con AGENTS.md

Cualquier agente que lea `AGENTS.md` automáticamente (Cursor, y otros) funciona igual para la parte de auditoría automática — la misma limitación de navegador interactivo del análisis cualitativo aplica.

## Automatización diaria (opcional)

Para correr `daily-audit-all.js` automáticamente todos los días (audita todas las tiendas configuradas, sin necesitar navegador ni presencia):

- **Con un agente de código:** pídele que programe una tarea diaria que corra `node daily-audit-all.js` en esta carpeta (usando su propia capacidad de tareas programadas, si la tiene).
- **Manual (Windows):** usa el Programador de tareas de Windows apuntando a `node.exe daily-audit-all.js` con el directorio de trabajo en esta carpeta.
- **Manual (cron, Linux/Mac):** `0 7 * * * cd /ruta/a/lucidbot-auditor && node daily-audit-all.js`

## Desplegar en un hosting (Railway u otro)

El proyecto está preparado para correr fuera de tu computadora — en Railway, Render, Fly.io o cualquier hosting que corra Node.js — sin cambiar nada del uso local (todas las variables de entorno son opcionales y, sin definirlas, todo funciona exactamente igual que en `localhost:4545`).

1. Copia `.env.example` a `.env` (o configura las mismas variables en el panel de tu hosting) y ajústalas.
2. **⚠️ Paso crítico — no te lo saltes:** define `DATA_DIR` apuntando a un **volumen persistente** de tu hosting (en Railway: agrega un "Volume" al servicio). La mayoría de hostings usan disco **efímero** — sin esto, `accounts.local.json` y todo `Informes/` se borran en cada redeploy o reinicio, y pierdes tus tiendas y tu histórico completo.
3. `npm start` arranca el servidor (`railway.json` ya trae `startCommand`, `healthcheckPath: /api/health` y reinicio automático si falla, para Railway específicamente — otros hostings pueden ignorarlo y usar `npm start` directo).
4. Una vez desplegado, el mismo dashboard queda accesible desde cualquier dispositivo con la URL que te dé el hosting — no solo desde tu computadora.
5. `ALLOWED_ORIGINS` controla CORS — con `*` (el valor por defecto) cualquier página o app puede consultar la API del dashboard (`/api/history`, `/api/audit-file`, etc.) directamente vía `fetch`, útil si quieres mostrar estos datos en otro sitio tuyo. Restringe a tus dominios si no lo necesitas abierto.

**⚠️ Este proyecto todavía no tiene ningún login.** Es un riesgo aceptado a propósito mientras solo tú conozcas la URL — pero si vas a publicarla donde cualquiera pueda encontrarla, agrega autenticación primero: hoy cualquiera con el link ve datos reales de tus clientes y puede cambiar los tokens de tus tiendas sin que se le pida ninguna clave.

## Actualizar a una versión nueva

```bash
git pull
npm install
```

Tu `accounts.local.json` y todo lo guardado en `Informes/` nunca se tocan ni se sobreescriben — viven fuera del control de versiones.

## Seguridad

- **Nunca** se guardan usuarios ni contraseñas de ningún sistema, en ningún archivo. El único dato sensible que este proyecto maneja es el **token de API de Lucid Bot** (una llave de integración, no una contraseña de inicio de sesión), guardado únicamente en `accounts.local.json` (excluido de git).
- Lucid Sales no tiene API pública — cualquier dato de ahí requiere sesión manual del usuario en su propio navegador, nunca credenciales guardadas.
- **El dashboard mismo no tiene login.** En `localhost` es un riesgo aceptado (solo tú tienes acceso a tu computadora). Si lo despliegas en un hosting con una URL pública, cualquiera que la conozca ve datos reales de tus clientes y puede cambiar los tokens de tus tiendas — agrega autenticación antes de compartir esa URL. Ver "Desplegar en un hosting" arriba.

## Límites conocidos

- La API de Lucid Bot tiene un límite real de 100 solicitudes/60 segundos — el sistema ya incluye un limitador de velocidad automático, pero auditorías de cuentas grandes pueden tardar varios minutos.
- No existe ningún campo o dashboard (API ni UI) con mensajes reales por producto y fecha exacta en Lucid Bot — el sistema usa el campo "Interacciones" como piso mínimo garantizado, dejándolo siempre marcado como tal, nunca como cifra exacta.
- La etiqueta "Bienvenida Enviada" de Lucid Bot **no es confiable** como señal de entrega — se comprobó con chats reales que el mensaje sí llega aunque la etiqueta no se aplique. El diagnóstico nunca afirma "falla de entrega" como hecho por esta etiqueta sola; siempre recomienda verificar con un chat real primero.
- El diagnóstico cualitativo (rúbrica de 7 causas) requiere leer chats reales uno por uno — no es instantáneo ni 100% automatizable, se ejecuta como una sesión de Claude Code con acceso al navegador (el prompt lo genera el botón "Pedir análisis cualitativo" del dashboard).
- Algunos patrones de fallo del bot (ej. mensajes duplicados enviados dos veces seguidas) solo se detectan leyendo el chat real — la API de Lucid Bot no expone el historial de mensajes, así que no son detectables de forma automática a escala.

## Changelog

Ver [CHANGELOG.md](CHANGELOG.md).
