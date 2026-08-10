const fs = require("fs");
const path = require("path");

const ACCOUNTS_FILE = path.join(__dirname, "accounts.local.json");

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

async function getAllOpportunities(accountId, pipelineId, { pageSize = 100, maxPages = 50 } = {}) {
  const all = [];
  for (let page = 0; page < maxPages; page++) {
    const offset = page * pageSize;
    const data = await apiGet(accountId, `/pipelines/${pipelineId}/opportunities?limit=${pageSize}&offset=${offset}`);
    const items = data.data || [];
    all.push(...items);
    if (items.length < pageSize) break;
  }
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

// Única fuente de la regla de "slug" de nombre de tienda — antes estaba copiada verbatim en
// dashboard-server.js y en daily-audit-all.js; si se ajustaba en un lado y no en el otro, la
// auditoría nocturna (cron) y la manual (dashboard) de la misma cuenta terminaban escribiendo
// en carpetas distintas bajo Informes/auditorias/, partiendo en dos el historial de una tienda.
function slugify(s) {
  return String(s).trim().replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "Tienda";
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
  slugify,
};
