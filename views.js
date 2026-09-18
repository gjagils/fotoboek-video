// views.js
// Houdt bij hoe vaak een video geopend, gestart en uitgekeken is.
//
// Bewust privacyvriendelijk: alleen tellingen per video (en per dag), geen
// IP-adressen, geen cookies, geen bezoekersprofielen. De teller staat in het
// geheugen van de server en wordt gebufferd naar data/views.json geschreven,
// zodat een druk moment niet elke keer een schrijfactie op de NAS kost.

const fs = require("fs");
const path = require("path");

const EVENT_FIELDS = { open: "opens", play: "plays", complete: "completions" };
const DAYS_KEPT = 120;
const FILE_VERSION = 1;

function emptyStats() {
  return { opens: 0, plays: 0, completions: 0, firstAt: null, lastAt: null, days: {} };
}

function dayKey(date) {
  return date.toISOString().slice(0, 10);
}

// Tellingen over de laatste N dagen, inclusief vandaag.
function recentTotals(stats, days, now = new Date()) {
  const totals = { opens: 0, plays: 0, completions: 0 };
  if (!stats) return totals;
  const oldest = new Date(now.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
  for (const [day, counts] of Object.entries(stats.days || {})) {
    if (day < dayKey(oldest)) continue;
    totals.opens += counts.opens || 0;
    totals.plays += counts.plays || 0;
    totals.completions += counts.completions || 0;
  }
  return totals;
}

function createViewCounter(dataDir, { flushMs = 5000, clock = () => new Date() } = {}) {
  const file = path.join(dataDir, "views.json");
  let videos = readFile();
  let flushTimer = null;
  let pendingWrite = false;

  function readFile() {
    if (!fs.existsSync(file)) return {};
    try {
      const stored = JSON.parse(fs.readFileSync(file, "utf8"));
      return stored && typeof stored.videos === "object" && stored.videos ? stored.videos : {};
    } catch (error) {
      // Nooit stil overschrijven: bewaar het onleesbare bestand en begin opnieuw.
      const broken = `${file}.kapot-${Date.now()}`;
      try { fs.renameSync(file, broken); } catch { /* al weg */ }
      console.warn(`Kijkcijfers onleesbaar (${error.message}); bewaard als ${path.basename(broken)}.`);
      return {};
    }
  }

  function flush() {
    if (!pendingWrite) return;
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    pendingWrite = false;
    const temporary = `${file}.tmp-${process.pid}`;
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify({ version: FILE_VERSION, updatedAt: clock().toISOString(), videos }, null, 2));
      fs.renameSync(temporary, file);
    } catch (error) {
      console.warn(`Kijkcijfers niet opgeslagen: ${error.message}`);
      try { fs.unlinkSync(temporary); } catch { /* niets te doen */ }
    }
  }

  function scheduleFlush() {
    pendingWrite = true;
    if (flushTimer || flushMs <= 0) { if (flushMs <= 0) flush(); return; }
    flushTimer = setTimeout(() => { flushTimer = null; flush(); }, flushMs);
    if (typeof flushTimer.unref === "function") flushTimer.unref();
  }

  function record(id, event) {
    const field = EVENT_FIELDS[event];
    if (!field) return false;
    const now = clock();
    const stats = videos[id] || (videos[id] = emptyStats());
    const day = dayKey(now);
    stats[field] = (stats[field] || 0) + 1;
    stats.firstAt = stats.firstAt || now.toISOString();
    stats.lastAt = now.toISOString();
    stats.days = stats.days || {};
    const today = stats.days[day] || (stats.days[day] = { opens: 0, plays: 0, completions: 0 });
    today[field] = (today[field] || 0) + 1;
    const days = Object.keys(stats.days).sort();
    for (const stale of days.slice(0, Math.max(0, days.length - DAYS_KEPT))) delete stats.days[stale];
    scheduleFlush();
    return true;
  }

  return {
    record,
    flush,
    stats: (id) => videos[id] || emptyStats(),
    all: () => videos,
  };
}

module.exports = { createViewCounter, recentTotals, emptyStats, EVENT_FIELDS };
