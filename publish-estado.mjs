#!/usr/bin/env node
/**
 * Lee ESTADO.md, turno.py y los tableros de Shorts (solo lectura), publica un JSON
 * público con la flota actual y lo sube al repo.
 * Uso: node /workspace/tabner-oficina/publish-estado.mjs
 *      node /workspace/tabner-oficina/publish-estado.mjs --once
 */

import { readFileSync, writeFileSync, statSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = dirname(fileURLToPath(import.meta.url));
const DOCS = join(ROOT, "docs");
const OUT = join(DOCS, "status.json");

const args = new Set(process.argv.slice(2));
const once = args.has("--once");
const noPush = args.has("--no-push");

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const ESTADO = argValue("--estado", "/workspace/tabner-ops/ESTADO.md");
const LIM = argValue("--luckismath", "/workspace/shorts-ops/estado/luckismath.md");
const TABLERO = argValue("--tablero", "/workspace/shorts-ops/estado/tablero.md");
const INTERVAL = Number(argValue("--interval", "45")) * 1000;

function madridNow() {
  return new Date().toLocaleString("sv-SE", { timeZone: "Europe/Madrid" }).replace(" ", "T") + "+01:00";
}

// Frases con lenguaje de pago o consumo: fuera del JSON público.
const MONEY_RE = /\b(tokens?|cost[eo]s?|costs?|precios?|price|pago|pagos|pagar|pagad[oa]s?|gasto|gastos|factura\w*|billing|suscrip\w*|€|\$\d)/i;
function stripMoney(text) {
  const parts = String(text).split(/(?<=[.;!?])\s+/);
  return parts.filter((p) => !MONEY_RE.test(p)).join(" ");
}

function sanitize(text) {
  if (!text) return "";
  return stripMoney(String(text))
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "correo")
    .replace(/Message-ID\s*`?<[^>]+>`?/gi, "")
    .replace(/vault[^.]{0,60}?\bid\s+\d+/gi, "vault")
    .replace(/\(id\s+\d+\)/gi, "")
    .replace(/<[a-f0-9-]{10,}@[^>]+>/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function normalizeTs(raw) {
  if (!raw) return null;
  let t = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(t)) t += ":00";
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(t)) t += "+01:00";
  return t;
}

function extractSince(text, fallbackDate) {
  if (!text) return null;
  const iso = text.match(/desde\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:[+-]\d{2}:\d{2})?)/i);
  if (iso) return normalizeTs(iso[1]);
  const clock = text.match(/desde las (\d{1,2}:\d{2}(?::\d{2})?)/i);
  if (clock && fallbackDate) {
    const hhmmss = clock[1].length === 5 ? `${clock[1]}:00` : clock[1];
    return normalizeTs(`${fallbackDate}T${hhmmss}`);
  }
  return null;
}

function isPublicationDisclaimer(block) {
  const b = (block || "").toLowerCase();
  return /la 1\.10\.8 sigue bloqueada/.test(b) && /no es un ok de publicaci/.test(b);
}

function classify(estadoReal, bloqueo, siguiente) {
  const estado = (estadoReal || "").toLowerCase();
  const next = (siguiente || "").toLowerCase();
  const block = (bloqueo || "").toLowerCase();
  const closed = `${estado} ${next}`;
  if (/(^|\. )(cerrada|cerrado|entregada|entregado)\b/.test(estado) || /^(cerrada|cerrado|entregada|entregado)\b/.test(estado) || /cerrad[oa] como unidad/.test(closed)) {
    return "hecho";
  }
  // El lanzador APTO, con residuales aparcados, no es trabajo en curso.
  if (/\bapto como herramienta\b/.test(estado) && !/\bno apto\b/.test(estado)) return "hecho";
  // "no cogido" y "lo había cogido" no son un turno vivo.
  const live = (estado + " " + block)
    .replace(/\bno\s+cogid[oa]s?\b/gi, " ")
    .replace(/\b(?:lo\s+)?hab[ií]a\s+cogid[oa]\b/gi, " ");
  if (/\ben curso\b|\bcogido\b/.test(live)) return "activo";
  if (/\bpausad|\bapar[ck]ad|\bencolada\b|\bno ha empezado\b/.test(estado + " " + next)) return "pausado";
  const hasBlock = block && !/^\s*ninguno/.test(block) && /bloquea|vetad|falta|hace falta|espera/.test(block) && !isPublicationDisclaimer(block);
  if (hasBlock) return "bloqueado";
  if (/\babierto\b/.test(estado) && /bloquea|vetad/.test(block) && !isPublicationDisclaimer(block)) return "bloqueado";
  if (/\babierto\b/.test(estado)) return "activo";
  return "pausado";
}

const BOT_RULES = [
  [/tabby\s*\(\s*archivo\s*\)|tabby archivo/i, "Tabby (archivo)"],
  [/tabby nueva/i, "Tabby"],
  [/feature analyst/i, "Feature Analyst"],
  [/\bux\b|tabner ux/i, "UX"],
  [/\bqa\b/i, "QA"],
  [/\bdev\b/i, "Dev"],
  [/\bredes\b/i, "Redes"],
  [/\bgrowth\b/i, "Growth"],
  [/\bsoporte\b/i, "Soporte"],
];

function extractBots(responsable) {
  let text = responsable || "";
  const found = [];
  if (/tabby\s*\(\s*archivo\s*\)|tabby archivo/i.test(text)) {
    found.push("Tabby (archivo)");
    text = text.replace(/tabby\s*\(\s*archivo\s*\)|tabby archivo/gi, "");
  }
  if (/\btabby\b/i.test(text)) found.push("Tabby");
  for (const [re, name] of BOT_RULES) {
    if (name.startsWith("Tabby")) continue;
    if (re.test(responsable || "") && !found.includes(name)) found.push(name);
  }
  return found;
}

function statusForBot(task, bot) {
  let status = task.status;
  // El veto de publicación de la versión no bloquea al coordinador ni al equipo técnico.
  if (status === "bloqueado" && /1\.10\.|versi[oó]n/i.test(task.name) && /vetad|publicaci[oó]n/.test(task.block || "")) {
    status = "pausado";
  }
  const blob = `${task.summary} ${task.next}`;
  const holder = blob.match(/turno\s+(DEV|QA|TABBY|UX|REDES|GROWTH)/i) || blob.match(/cogido por\s+(DEV|QA|TABBY|UX|REDES|GROWTH)/i);
  if (status === "activo" && holder) {
    const who = holder[1].toLowerCase();
    const map = { dev: "Dev", qa: "QA", tabby: "Tabby", ux: "UX", redes: "Redes", growth: "Growth" };
    const activeBot = map[who];
    if (who === "tabby") {
      if (bot !== "Tabby" && bot !== "Tabby (archivo)") status = "pausado";
    } else if (activeBot && bot !== activeBot) {
      status = "pausado";
    }
  }
  return status;
}

function splitRow(line) {
  const cells = line.split("|").slice(1);
  if (line.trim().endsWith("|")) cells.pop();
  return cells.map((c) => c.trim());
}

function parseEstado(markdown) {
  const lines = markdown.split(/\r?\n/);
  const log = [];
  let fallbackDate = "2026-11-09";

  for (const line of lines) {
    let m = line.match(/^Actualizado\s+(\S+)\s+Europe\/Madrid(?:\s+por\s+(.+?))?\.\s*(.*)$/);
    if (m) {
      const at = normalizeTs(m[1]);
      if (at) fallbackDate = at.slice(0, 10);
      log.push({ at, actor: sanitize(m[2] || ""), text: sanitize(m[3] || "Actualizado") });
      continue;
    }
    m = line.match(/^Actualización\s+(\S+)\s+Europe\/Madrid(?:\s+\(([^)]+)\))?:\s*(.*)$/);
    if (m) {
      const at = normalizeTs(m[1]);
      if (at) fallbackDate = at.slice(0, 10);
      log.push({ at, actor: sanitize(m[2] || ""), text: sanitize(m[3] || "") });
    }
  }

  const tasks = [];
  let inTable = false;
  for (const line of lines) {
    if (/^\|\s*Tarea\s*\|/.test(line)) {
      inTable = true;
      continue;
    }
    if (inTable && /^\|\s*-+/.test(line)) continue;
    if (inTable && !line.startsWith("|")) {
      inTable = false;
      continue;
    }
    if (!inTable || !line.startsWith("|")) continue;
    const [name, responsable, estadoReal, siguiente, bloqueo] = splitRow(line);
    if (!name || name === "Tarea") continue;
    const status = classify(estadoReal, bloqueo, siguiente);
    const since = extractSince(`${estadoReal} ${siguiente}`, fallbackDate);
    tasks.push({
      name: sanitize(name),
      bots: extractBots(responsable),
      status,
      since,
      summary: sanitize(estadoReal),
      next: sanitize(siguiente),
      block: sanitize(bloqueo) && !/^ninguno/i.test(bloqueo.trim()) ? sanitize(bloqueo) : "",
    });
  }

  const rank = { activo: 3, bloqueado: 2, pausado: 1, hecho: 0 };
  const isLock = (name) => /cerrojo|turno\.py/i.test(name);
  const byBot = new Map();
  for (const task of tasks) {
    for (const bot of task.bots) {
      const botStatus = statusForBot(task, bot);
      const current = byBot.get(bot);
      const better = !current || rank[botStatus] > rank[current.status] ||
        (rank[botStatus] === rank[current.status] && isLock(current.task) && !isLock(task.name));
      if (better) {
        byBot.set(bot, {
          id: bot.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
          name: bot,
          status: botStatus,
          task: task.name,
          since: task.since,
          detail: task.summary,
          next: task.next,
          block: botStatus === "bloqueado" && task.block ? task.block : null,
        });
      }
    }
  }

  return { byBot, tasks, log: log.slice().reverse() };
}

/* ---------------- Plantilla completa (ids estables) ---------------- */
const ROSTER = [
  { id: "dev", name: "Dev", from: "Dev", task: "Desarrollo de Tabner" },
  { id: "qa", name: "QA", from: "QA", task: "Pruebas de Tabner" },
  { id: "ux", name: "UX", from: "UX", task: "Revisión UX de Tabner" },
  { id: "growth", name: "Growth", from: "Growth", task: "Captación de Tabner" },
  { id: "redes", name: "Redes", from: "Redes", task: "Redes sociales de Tabner" },
  { id: "tabby", name: "Tabby", from: "Tabby", task: "Coordinación de Tabner" },
  { id: "soporte", name: "Soporte", from: "Soporte", task: "Soporte de Tabner" },
  { id: "shorts-director", name: "Shorts Director", task: "Dirección de Shorts" },
  { id: "shorts-guionista", name: "Shorts Guionista", task: "Guiones de Shorts" },
  { id: "shorts-productor", name: "Shorts Productor", task: "Producción de vídeo" },
  { id: "sabueso", name: "Sabueso", task: "Investigación de startups", detail: "Equipo nocturno. Sin parte reciente en el tablero." },
  { id: "julieta", name: "Julieta", task: "Julietas (thejulietas.com)" },
  { id: "creador", name: "Creador", task: "Diseño de Grok Bots" },
  { id: "auditor", name: "Auditor", task: "Auditoría de la flota" },
];
const NO_PARTE = "Sin parte reciente en el tablero.";

/* ---------------- Shorts: luckismath.md + tablero.md ---------------- */
const DOW = "[LMXJVSD]";
function madridIsoFromUtc(y, mo, d, h, mi, s) {
  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi, s || 0));
  return dt.toLocaleString("sv-SE", { timeZone: "Europe/Madrid" }).replace(" ", "T") + "+01:00";
}
const listEs = (a) => a.length < 2 ? a.join("") : a.slice(0, -1).join(", ") + " y " + a[a.length - 1];
const pad = (n) => String(n).padStart(2, "0");
// Líneas «- fecha: texto» de un registro. Devuelve [{at, text}] en orden de archivo.
function parseRegistro(markdown, year) {
  const out = [];
  for (const line of markdown.split(/\r?\n/)) {
    let m = line.match(/^-\s+(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s+(UTC|Europe\/Madrid))?(?:\s*\([^)]*\))?\s*:\s*(.*)$/);
    if (m) {
      const [, y, mo, d, h, mi, se, tz, text] = m;
      const at = tz === "UTC" ? madridIsoFromUtc(+y, +mo, +d, +h, +mi, +(se || 0)) : `${y}-${mo}-${d}T${pad(h)}:${mi}:${pad(se || 0)}+01:00`;
      out.push({ at, text });
      continue;
    }
    m = line.match(/^-\s+(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})(?:\s*\([^)]*\))?\s*(?:·|:)\s*(.*)$/);
    if (m) {
      const [, d, mo, h, mi, text] = m;
      out.push({ at: `${year}-${pad(mo)}-${pad(d)}T${pad(h)}:${mi}:00+01:00`, text });
    }
  }
  return out;
}
function tableRows(markdown) {
  const rows = [];
  let header = null;
  for (const line of markdown.split(/\r?\n/)) {
    if (!line.startsWith("|")) { header = null; continue; }
    const cells = splitRow(line);
    if (!header) { header = cells.map((c) => c.toLowerCase()); continue; }
    if (/^-+$/.test(cells[0] || "")) continue;
    const row = {};
    header.forEach((h, i) => { row[h] = cells[i] || ""; });
    rows.push(row);
  }
  return rows;
}
const dayOf = (iso) => (iso || "").slice(0, 10);
const shortText = (t, max = 320) => { const s = sanitize(t); return s.length > max ? s.slice(0, max - 1).replace(/\s+\S*$/, "") + "…" : s; };
const clean = (t) => sanitize(String(t || "").replace(/https?:\/\/\S+/g, "").replace(/\s+\(\s*\)/g, ""));

function parseShorts(limMd, tabMd, year) {
  const overlays = new Map();
  const log = [];
  if (limMd) {
    const reg = parseRegistro(limMd, year);
    const rows = tableRows(limMd).filter((r) => /^\d{3}-/.test(r["vídeo"] || r.video || ""));
    const published = [];
    for (const r of rows) {
      const name = (r["vídeo"] || "").slice(0, 3);
      const fase = `${r["fase"] || ""} ${r["notas"] || ""}`;
      if (/publicado/i.test(fase)) published.push(name);
    }
    // Encargos «NNN rXX para el D dd/mm a las hh:mm» (gana el más reciente).
    const pending = new Map();
    for (const e of reg) {
      const re = new RegExp(`(\\d{3})\\s+r(\\d+)\\s+(?:para el|sigue pendiente para el|pendiente para el)\\s+(${DOW}\\s+\\d{1,2}\\/\\d{1,2}(?:\\s+a las\\s+\\d{1,2}:\\d{2})?)`, "g");
      let m;
      while ((m = re.exec(e.text))) pending.set(m[1], { rev: `r${m[2]}`, due: m[3], at: e.at });
      for (const m2 of e.text.matchAll(/(\d{3})\s+r\d+\s+publicado/gi)) if (!published.includes(m2[1])) published.push(m2[1]);
    }
    for (const v of published) pending.delete(v);
    const last = reg[reg.length - 1];
    const lastDay = last ? dayOf(last.at) : "";
    const today = reg.filter((e) => dayOf(e.at) === lastDay);
    const lastMention = (re) => [...reg].reverse().find((e) => re.test(e.text));
    const busyToday = (re) => today.some((e) => re.test(e.text) && /\ben curso\b|\ben marcha\b|\bcogid[oa]\b/i.test(e.text));
    const pubList = published.slice().sort();
    const lastPub = pubList[pubList.length - 1];
    const pendList = [...pending.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const pendText = pendList.map(([v, p]) => `${v} ${p.rev} para el ${p.due}`).join("; ");

    // Orquestador Luck is Math («yo» en luckismath.md)
    if (last) {
      overlays.set("luck-is-math", {
        status: busyToday(/./) ? "activo" : "pausado",
        task: lastPub ? `Luck is Math: ${lastPub} publicado${pendList.length ? `; ${listEs(pendList.map(([v]) => v))} en revisión` : ""}` : "Canal Luck is Math",
        since: null,
        detail: shortText(clean(last.text)),
        next: pendText ? `Revisar las entregas del Productor: ${pendText}.` : "Siguiente vídeo según calendario (L-X-V).",
        block: null,
      });
    }
    // Productor
    if (pendList.length) {
      overlays.set("shorts-productor", {
        status: busyToday(/productor/i) ? "activo" : "pausado",
        task: `Vueltas de ${listEs(pendList.map(([v]) => v))}`,
        since: null,
        detail: `Encargos pendientes: ${pendText}.`,
        next: `Primera entrega: ${pendList[0][0]} ${pendList[0][1].rev} el ${pendList[0][1].due}.`,
        block: null,
      });
    }
    // Analista: próximo corte programado
    const cut = lastMention(/cortes?\b[^.]*\b24 h\b/i);
    if (cut) {
      const m = cut.text.match(/24 h el (\d{1,2}\/\d{1,2})\s*~?\s*(\d{1,2}:\d{2})?(?:[^.]*?48 h el (\d{1,2}\/\d{1,2})\s*~?\s*(\d{1,2}:\d{2})?)?/i);
      const vid = (cut.text.match(/(\d{3})\s+r\d+\s+publicado/i) || [])[1] || lastPub || "";
      overlays.set("shorts-analista", {
        status: busyToday(/analista/i) ? "activo" : "pausado",
        task: vid ? `Seguimiento del ${vid}` : "Analítica de Shorts",
        since: null,
        detail: shortText(clean(cut.text)),
        next: m ? `Corte de 24 h el ${m[1]}${m[2] ? " ~" + m[2] : ""}${m[3] ? `; 48 h el ${m[3]}${m[4] ? " ~" + m[4] : ""}` : ""}.` : "Próximo corte según la rutina diaria.",
        block: null,
      });
    }
    // Guionista
    const g = lastMention(/guionista/i);
    if (g) {
      const busy = busyToday(/guionista/i);
      const done = /recortad|aprobad|entregad|escrit/i.test(g.text);
      overlays.set("shorts-guionista", {
        status: busy ? "activo" : (done ? "hecho" : "pausado"),
        task: done ? "Guiones entregados" : "Guiones de Shorts",
        since: null,
        detail: shortText(clean(g.text)),
        next: "Sin encargo nuevo registrado.",
        block: null,
      });
    }
    // Investigador: solo si aparece hoy
    const inv = today.find((e) => /investigador/i.test(e.text));
    if (inv) overlays.set("shorts-investigador", { status: busyToday(/investigador/i) ? "activo" : "pausado", task: "Investigación de ideas", since: null, detail: shortText(clean(inv.text)), next: "", block: null });
    reg.slice(-6).forEach((e) => log.push({ at: e.at, actor: "Luck is Math", text: shortText(clean(e.text), 260) }));
  }
  if (tabMd) {
    const reg = parseRegistro(tabMd, year);
    const rows = tableRows(tabMd);
    const stuck = rows.find((r) => /padre|orquestador/i.test(r.responsable || "") && /carlos/i.test(r.fase || "") && /pendiente|falta|elecci[oó]n|esperando/i.test(r.fase || ""));
    const last = reg[reg.length - 1];
    if (stuck) {
      const vid = stuck["vídeo"] || "";
      const pretty = /^tdd-e01/i.test(vid) ? "Piloto The Die Decides (E01)" : vid;
      overlays.set("shorts-orquestador", {
        status: "bloqueado",
        task: pretty,
        since: null,
        detail: shortText(clean(`${stuck.fase}. ${last ? last.text : ""}`)),
        next: "Cuando Carlos elija, encargar el montaje final al Productor.",
        block: shortText(clean(`Pendiente de Carlos: ${stuck.fase}.`)),
      });
    } else if (last) {
      overlays.set("shorts-orquestador", { status: "pausado", task: "Orquestación de Shorts", since: null, detail: shortText(clean(last.text)), next: "", block: null });
    }
    reg.slice(-3).forEach((e) => log.push({ at: e.at, actor: "Shorts Orquestador", text: shortText(clean(e.text), 260) }));
  }
  remapArchivedOverlays(overlays);
  return { overlays, log };
}

function remapArchivedOverlays(overlays) {
  const remap = {
    "luck-is-math": "shorts-director",
    "shorts-orquestador": "shorts-director",
    "shorts-analista": "shorts-guionista",
    "shorts-investigador": "shorts-guionista",
  };
  const rank = { activo: 3, bloqueado: 2, pausado: 1, hecho: 0 };
  for (const [from, to] of Object.entries(remap)) {
    if (!overlays.has(from)) continue;
    const rec = overlays.get(from);
    overlays.delete(from);
    const cur = overlays.get(to);
    if (!cur || (rank[rec.status] || 0) > (rank[cur.status] || 0)) overlays.set(to, rec);
  }
}

function readTurno() {
  try {
    const out = execFileSync("python3", ["/workspace/tabner-ops/locks/turno.py", "ver"], { encoding: "utf8" }).trim();
    if (!out || /^libre\b/i.test(out)) return { libre: true };
    const data = JSON.parse(out);
    const quien = String(data.quien || "").trim();
    if (!quien || /^libre$/i.test(quien) || data.estado_turno === "libre") return { libre: true, data };
    return { libre: false, quien, desde: data.desde_iso || null, motivo: data.motivo || "", data };
  } catch {
    return null;
  }
}

const TURNO_NAME = { DEV: "Dev", QA: "QA", UX: "UX", TABBY: "Tabby", REDES: "Redes", GROWTH: "Growth", SOPORTE: "Soporte" };

function applyTurno(bots, turno) {
  if (!turno) return bots;
  const holder = turno.libre ? null : (TURNO_NAME[(turno.quien || "").toUpperCase()] || turno.quien);
  return bots.map((b) => {
    const fromLock = /cerrojo|turno\.py/i.test(b.task || "");
    if (fromLock && (!holder || b.name !== holder)) {
      return { ...b, status: "pausado", since: null, detail: "Turno libre.", block: null };
    }
    if (holder && b.name === holder) {
      return {
        id: b.id,
        name: b.name,
        status: "activo",
        task: turno.motivo || b.task,
        since: turno.desde || b.since,
        detail: `Turno ${turno.quien} desde ${turno.desde || "—"}${turno.motivo ? `: ${turno.motivo}` : ""}`.trim(),
        next: b.next || "",
        block: null,
      };
    }
    return b;
  });
}


function readOptional(path) {
  try { return { text: readFileSync(path, "utf8"), mtime: statSync(path).mtime }; } catch { return null; }
}
const madridIso = (d) => new Date(d).toLocaleString("sv-SE", { timeZone: "Europe/Madrid" }).replace(" ", "T") + "+01:00";

function buildPayload() {
  const estado = { text: readFileSync(ESTADO, "utf8"), mtime: statSync(ESTADO).mtime };
  const lim = readOptional(LIM), tab = readOptional(TABLERO);
  const mtimes = [estado, lim, tab].filter(Boolean).map((f) => f.mtime.getTime());
  const latest = new Date(Math.max(...mtimes));
  const year = latest.getFullYear();
  const tabner = parseEstado(estado.text, madridIso(estado.mtime));
  const shorts = parseShorts(lim && lim.text, tab && tab.text, year);
  const bots = applyTurno(ROSTER.map((r) => {
    const o = (r.from && tabner.byBot.get(r.from)) || shorts.overlays.get(r.id);
    if (o) return { id: r.id, name: r.name, status: o.status, task: o.task, since: o.since || null, detail: o.detail || "", next: o.next || "", block: o.block || null };
    return { id: r.id, name: r.name, status: "pausado", task: r.task, since: null, detail: r.detail || NO_PARTE, next: "", block: null };
  }), readTurno());
  const log = tabner.log.concat(shorts.log)
    .filter((e) => e.at)
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, 20);
  const payload = { generatedAt: madridNow(), sourceMtime: madridIso(latest), bots, tasks: tabner.tasks, log };
  payload.contentHash = hashStable(payload);
  return payload;
}

function hashStable(payload) {
  const basis = JSON.stringify({
    bots: payload.bots,
    tasks: payload.tasks,
    log: payload.log,
    sourceMtime: payload.sourceMtime,
  });
  let h = 2166136261;
  for (let i = 0; i < basis.length; i++) {
    h ^= basis.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function previousHash() {
  try {
    const prev = JSON.parse(readFileSync(OUT, "utf8"));
    return prev.contentHash || "";
  } catch {
    return "";
  }
}

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

function publish(payload) {
  mkdirSync(DOCS, { recursive: true });
  const changed = payload.contentHash !== previousHash();
  writeFileSync(OUT, JSON.stringify(payload, null, 2) + "\n");
  if (!changed || noPush) return { changed, pushed: false };

  try {
    git(["add", "docs/status.json"]);
    const porcelain = git(["status", "--porcelain", "docs/status.json"]);
    if (!porcelain) return { changed, pushed: false };
    git(["commit", "-m", `estado ${payload.generatedAt}`]);
    git(["push", "origin", "HEAD"]);
    return { changed, pushed: true };
  } catch (err) {
    console.error("No se pudo publicar en GitHub:", err.message || err);
    return { changed, pushed: false, error: String(err.message || err) };
  }
}

function tick() {
  let payload;
  try {
    payload = buildPayload();
  } catch (err) {
    console.error("No se pudo leer el estado:", err.message || err);
    return { changed: false, pushed: false };
  }
  const result = publish(payload);
  const activos = payload.bots.filter((b) => b.status === "activo").map((b) => `${b.name}: ${b.task}`);
  console.log(
    `${payload.generatedAt} hash=${payload.contentHash} bots=${payload.bots.length}` +
      (activos.length ? ` activos=[${activos.join("; ")}]` : "") +
      (result.pushed ? " publicado" : result.changed ? " escrito" : " sin cambios")
  );
  return result;
}

tick();
if (!once) {
  console.log(`Vigilando ${ESTADO}, ${LIM} y ${TABLERO} cada ${INTERVAL / 1000}s. Ctrl+C para parar.`);
  setInterval(tick, INTERVAL);
}
