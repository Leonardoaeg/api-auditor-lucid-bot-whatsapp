# Lucid Bot Auditor — instrucciones para Claude Code

Todas las instrucciones operativas (qué hacer, estructura del proyecto, reglas de seguridad) están en **[AGENTS.md](AGENTS.md)** — léelo primero, aplica igual para Claude Code.

Lo único específico de Claude Code:

- Para el **análisis cualitativo** (ver la sección correspondiente en `AGENTS.md`), Claude Code sí trae integrada la capacidad de navegador necesaria (herramienta "Browser": `navigate`, `computer` para clics, `get_page_text`, `javascript_tool` para ejecutar JS en la página) — puedes ejecutar el flujo completo de las 5 partes sin pedirle nada especial al usuario, más allá de que inicie sesión manualmente en `panel.lucidbot.co` y `panel.lucidsales.co` cuando se lo pidas (nunca pidas ni guardes su contraseña).
- Si el usuario pide programar la auditoría diaria automática (`daily-audit-all.js`), puedes usar tu capacidad de tareas programadas si la tienes disponible en este entorno; si no, dale las instrucciones manuales del README (Programador de tareas de Windows / cron).
