const fs = require("fs");
const path = require("path");

// Misma lógica de DATA_DIR/ACCOUNTS_FILE que dashboard-server.js — deben apuntar SIEMPRE al
// mismo archivo, porque este módulo es el que realmente usa el token para hablar con la API de
// Lucid Bot durante una auditoría. Sin esto, en un hosting con DATA_DIR configurado el dashboard
// vería las tiendas guardadas pero las auditorías fallarían buscando el archivo en el lugar
// viejo. Pedido explícito 2026-08-13 ("prepararlo para usarlo desde cualquier hosting").
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : null;
const ACCOUNTS_FILE = process.env.ACCOUNTS_FILE
  ? path.resolve(process.env.ACCOUNTS_FILE)
  : DATA_DIR ? path.join(DATA_DIR, "accounts.local.json") : path.join(__dirname, "accounts.local.json");

function getAccount(accountId) {
  const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8"));
  const acc = accounts[String(accountId)];
  if (!acc) throw new Error(`No hay token guardado para la cuenta ${accountId} en accounts.local.json`);
  return acc;
}

// La API de Lucid Bot tiene un límite real de 100 solicitudes / 60 segundos por cuenta
// (confirmado 2026-07-26: "Your account exceeded the limit of 100 requests per 60 seconds").
// Una auditoría de una cuenta con 100+ contactos necesita 1 solicitud de custom_fields por
// contacto — sin control de ritmo, eso chocaba con el límite y hacía que el campo "Producto
// Interesado _ Ad ID" quedara vacío silenciosamente para muchos contactos "Frío" (parecía que
// el dato no existía, pero sí existe — solo la solicitud fallaba). Este limitador central
// evita eso: cualquier llamada a la API (de cualquier cuenta, cualquier función) espera su
// turno si ya se hicieron demasiadas solicitudes en la ventana de 60s.
const RATE_LIMIT_WINDOW_MS = 60000;
const RATE_LIMIT_MAX = 90; // margen de seguridad bajo el límite real de 100/60s
const requestTimestamps = [];

async function waitForRateLimitSlot() {
  for (;;) {
    const now = Date.now();
    while (requestTimestamps.length && now - requestTimestamps[0] > RATE_LIMIT_WINDOW_MS) {
      requestTimestamps.shift();
    }
    if (requestTimestamps.length < RATE_LIMIT_MAX) {
      requestTimestamps.push(now);
      return;
    }
    const waitMs = RATE_LIMIT_WINDOW_MS - (now - requestTimestamps[0]) + 50;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

async function apiGet(accountId, apiPath) {
  const { token } = getAccount(accountId);
  await waitForRateLimitSlot();
  const url = `https://panel.lucidbot.co/api${apiPath}`;
  const res = await fetch(url, { headers: { "X-ACCESS-TOKEN": token } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GET ${apiPath} -> ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

// Bug real encontrado 2026-08-12: con el tope anterior (maxPages=50, pageSize=100 -> 5000
// registros), un pipeline con más de 5000 oportunidades históricas (confirmado en "Calificación
// de leads" de una cuenta real, que ya superó ese número) se truncaba EN SILENCIO — sin ningún
// aviso, contactos reales quedaban fuera de TODAS las auditorías (no solo de una función puntual).
// Primer intento de arreglo (subir maxPages a 300 = 30.000 registros) resultó SEGUIR truncando —
// la misma cuenta real ya tiene 45.000-48.000 registros en ese pipeline (confirmado consultando la
// API directamente, offset por offset). Pedido explícito 2026-08-13: la corrección es correctitud
// por encima de velocidad, sin importar cuánto tarde — así que maxPages ahora es solo un techo de
// seguridad contra un bucle infinito real (nunca debería alcanzarse en la práctica: el loop ya
// para solo en cuanto una página devuelve menos de `pageSize` registros, es decir, en cuanto se
// llega al final real de los datos — subir este número no hace más lenta una cuenta chica, solo
// deja de cortar de más a una cuenta grande). maxMillis (ver dashboard-server.js /api/audit-async)
// es el segundo techo de seguridad, ya no un límite práctico porque la auditoría corre en segundo
// plano sin depender de una sola conexión HTTP abierta.
async function getAllOpportunities(accountId, pipelineId, { pageSize = 100, maxPages = 2000, maxMillis = 60000 } = {}) {
  const all = [];
  let truncated = false;
  const startedAt = Date.now();
  for (let page = 0; page < maxPages; page++) {
    if (Date.now() - startedAt > maxMillis) {
      truncated = true;
      break;
    }
    const offset = page * pageSize;
    const data = await apiGet(accountId, `/pipelines/${pipelineId}/opportunities?limit=${pageSize}&offset=${offset}`);
    const items = data.data || [];
    all.push(...items);
    if (items.length < pageSize) break;
    if (page === maxPages - 1) truncated = true;
  }
  all.truncated = truncated;
  return all;
}

async function getPipelines(accountId) {
  const data = await apiGet(accountId, `/pipelines`);
  return data.data || [];
}

async function getStages(accountId, pipelineId) {
  const data = await apiGet(accountId, `/pipelines/${pipelineId}/stages`);
  return data.data || [];
}

async function getContact(accountId, contactId) {
  return apiGet(accountId, `/contacts/${contactId}`);
}

async function getContactTags(accountId, contactId) {
  return apiGet(accountId, `/contacts/${contactId}/tags`);
}

async function getContactCustomFields(accountId, contactId) {
  return apiGet(accountId, `/contacts/${contactId}/custom_fields`);
}

async function getContactFull(accountId, contactId) {
  const [profile, tags, customFields] = await Promise.all([
    getContact(accountId, contactId).catch(() => null),
    getContactTags(accountId, contactId).catch(() => []),
    getContactCustomFields(accountId, contactId).catch(() => []),
  ]);
  return { profile, tags, customFields };
}

async function resolvePipelineIdByName(accountId, name) {
  const pipelines = await getPipelines(accountId);
  const found = pipelines.find((p) => p.name.trim().toLowerCase() === name.trim().toLowerCase());
  if (!found) throw new Error(`No se encontró un pipeline llamado "${name}" en la cuenta ${accountId}. Disponibles: ${pipelines.map((p) => p.name).join(", ")}`);
  return found.id;
}

// Bogotá = UTC-5 todo el año (sin horario de verano). La API de Lucid Bot
// devuelve created_at/updated_at en UTC pero sin sufijo de zona horaria.
const BOGOTA_OFFSET_HOURS = 5;

function bogotaToUTC(dateStr) {
  if (!dateStr) return null;
  const iso = dateStr.includes("T") ? dateStr : dateStr.replace(" ", "T");
  const asIfUTC = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : `${iso}:00Z`);
  return new Date(asIfUTC.getTime() + BOGOTA_OFFSET_HOURS * 3600 * 1000);
}

function apiTimestampToUTC(apiDateStr) {
  return new Date(apiDateStr.replace(" ", "T") + "Z");
}

function utcToBogotaString(date) {
  const bogota = new Date(date.getTime() - BOGOTA_OFFSET_HOURS * 3600 * 1000);
  return bogota.toISOString().replace("T", " ").slice(0, 19);
}

module.exports = {
  getAccount,
  apiGet,
  getAllOpportunities,
  getPipelines,
  getStages,
  getContact,
  getContactTags,
  getContactCustomFields,
  getContactFull,
  resolvePipelineIdByName,
  bogotaToUTC,
  apiTimestampToUTC,
  utcToBogotaString,
};
