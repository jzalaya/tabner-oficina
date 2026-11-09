#!/usr/bin/env node
/**
 * Lee ESTADO.md (solo lectura), publica un JSON público y lo sube al repo.
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
const INTERVAL = Number(argValue("--interval", "45")) * 1000;

function madridNow() {
  return new Date().toLocaleString("sv-SE", { timeZone: "Europe/Madrid" }).replace(" ", "T") + "+01:00";
}

function sanitize(text) {
  if (!text) return "";
  return String(text)
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

function classify(estadoReal, bloqueo) {
  const estado = (estadoReal || "").toLowerCase();
  const block = (bloqueo || "").toLowerCase();
  if (/(^|\. )(cerrada|cerrado|entregada|entregado)\b/.test(estado) || /^(cerrada|cerrado|entregada|entregado)\b/.test(estado)) {
    return "hecho";
  }
  if (/\ben curso\b|\bcogido\b/.test(estado + " " + block)) return "activo";
  if (/\bpausad|\bapar[ck]ad|\bencolada\b|\bno ha empezado\b/.test(estado)) return "pausado";
  const hasBlock = block && !/^\s*ninguno/.test(block) && /bloquea|vetad|falta|hace falta|espera/.test(block);
  if (hasBlock) return "bloqueado";
  if (/\babierto\b/.test(estado) && /bloquea|vetad/.test(block)) return "bloqueado";
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
  [/luck is math|\bshorts\b/i, "Shorts"],
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

function parseEstado(markdown, mtimeIso) {
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
    const status = classify(estadoReal, bloqueo);
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

  const payload = {
    generatedAt: madridNow(),
    sourceMtime: mtimeIso,
    bots: [...byBot.values()].sort((a, b) => rank[b.status] - rank[a.status] || a.name.localeCompare(b.name, "es")),
    tasks,
    log: log.slice().reverse(),
  };
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
  const raw = readFileSync(ESTADO, "utf8");
  const mtime = statSync(ESTADO).mtime;
  const mtimeIso = new Date(mtime).toLocaleString("sv-SE", { timeZone: "Europe/Madrid" }).replace(" ", "T") + "+01:00";
  const payload = parseEstado(raw, mtimeIso);
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
  console.log(`Vigilando ${ESTADO} cada ${INTERVAL / 1000}s. Ctrl+C para parar.`);
  setInterval(tick, INTERVAL);
}
