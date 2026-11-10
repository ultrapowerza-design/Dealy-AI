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

export async function logChat(entry) {
  try {
    await mkdir(DIR, { recursive: true });
    const safe = { ...entry, question: maskPII(entry.question), reply: maskPII(entry.reply) };
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
