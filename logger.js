// Saves every exchange to logs/chats.jsonl so you can see what customers ask.
import { mkdir, appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DIR = path.resolve("logs");
const FILE = path.join(DIR, "chats.jsonl");

// Chats are deleted after this many days (POPIA: don't keep personal data longer than needed).
const RETENTION_DAYS = Number(process.env.LOG_RETENTION_DAYS) || 60;

// Hide emails and phone numbers customers type in, but keep Dealy's own contact details readable.
function maskPII(text = "") {
  return String(text)
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, (m) => (/@dealy\.co\.za$/i.test(m) ? m : "[email hidden]"))
    .replace(/\+?\d[\d\s-]{7,}\d/g, (m) => (m.replace(/\D/g, "").includes("113148451") ? m : "[number hidden]"));
}

export async function pruneLogs() {
  try {
    const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
    const raw = await readFile(FILE, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    const kept = lines.filter((line) => {
      try { return new Date(JSON.parse(line).time).getTime() >= cutoff; } catch { return false; }
    });
    if (kept.length !== lines.length) await writeFile(FILE, kept.length ? kept.join("\n") + "\n" : "");
  } catch { /* no log file yet */ }
}
pruneLogs();
setInterval(pruneLogs, 86_400_000).unref();

// Permanent storage (optional). Render's free disk is wiped on every redeploy, so each chat is also sent to a
// private Google Sheet through an Apps Script web app. Set LOG_WEBHOOK_URL and LOG_WEBHOOK_SECRET to switch it on.
const SHEET_URL = process.env.LOG_WEBHOOK_URL || "";
const SHEET_SECRET = process.env.LOG_WEBHOOK_SECRET || "";
const BOT_NAME = process.env.BOT_NAME || "Dealy";

async function sendToSheet(row) {
  if (!SHEET_URL || !SHEET_SECRET) return;
  try {
    const res = await fetch(SHEET_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        ...row,
        secret: SHEET_SECRET,
        bot: BOT_NAME,
        tools: (row.tools ?? []).map((t) => `${t.name}: ${t.args?.query ?? ""}`).join("; ")
      }),
      redirect: "follow",
      signal: AbortSignal.timeout(10_000)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    console.error("LOG SHEET ERROR:", err.message);
  }
}

export async function logChat(entry) {
  const safe = { ...entry, question: maskPII(entry.question), reply: maskPII(entry.reply) };
  sendToSheet(safe); // not awaited, so the customer never waits for it
  try {
    await mkdir(DIR, { recursive: true });
    await appendFile(FILE, JSON.stringify(safe) + "\n");
  } catch (err) {
    console.error("LOG ERROR:", err.message);
  }
}

export async function readLogs({ limit = 100, followUpOnly = false } = {}) {
  try {
    const raw = await readFile(FILE, "utf8");
    let rows = raw
      .split("\n")
      .filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
    if (followUpOnly) rows = rows.filter((r) => r.needsFollowUp);
    return rows.slice(-limit).reverse();
  } catch {
    return [];
  }
}

