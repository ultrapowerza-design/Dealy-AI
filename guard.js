// guard.js: server-side protection for the chat bots. None of this depends on the AI model obeying rules.
//
// The model never holds any secret (API keys live only in environment variables on the server), so it cannot reveal them.
// This file adds extra layers around it:
//   1. Every customer message is screened BEFORE the model is called (secret hunting, "ignore your instructions",
//      echo tests, off-topic use). Blocked messages get a fixed reply, cost nothing, and never reach the model.
//   2. Repeat offenders are blocked by IP address for a while.
//   3. The model's reply is screened on its way out (leaked instructions, key-shaped text, your real secrets).
//   4. Fake "earlier messages" sent by the browser are cleaned before they reach the model.
import { randomBytes } from "node:crypto";

/* ---------- text clean-up, so tricks like zero-width characters and look-alike letters do not hide an attack ---------- */
const ZERO_WIDTH = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;
const LOOKALIKES = { "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x", "і": "i", "ѕ": "s", "ј": "j", "ο": "o", "ν": "v" };
const fold = (t) =>
  String(t ?? "")
    .normalize("NFKC")
    .replace(ZERO_WIDTH, "")
    .toLowerCase()
    .replace(/[аеорсухіѕјον]/g, (ch) => LOOKALIKES[ch] ?? ch);
const flat = (t) => fold(t).replace(/\s+/g, " ").trim();
const squash = (t) => fold(t).replace(/[^a-z0-9]/g, "");

/* ---------- rules (the more serious ones cannot be talked around) ---------- */
const SECRETS = [
  /\b(api|secret|access|private|auth|bearer)[ _-]?(keys?|tokens?)\b/,
  /\b(consumer|client)[ _-]?(keys?|secrets?)\b/,
  /\b(system|hidden|initial|original|internal|secret|developer|full|complete|entire)[ _-]?(prompt|instructions?|message|rules|configuration|config|settings)\b/,
  /\b(your|the bot'?s|the chatbot'?s) (prompt|instructions|configuration|config|source code|knowledge base|environment variables?|env vars?)\b/,
  /\b(environment|env)[ _-]?(variables?|vars?|files?)\b|\.env\b|process\.env/,
  /\b(ck|cs|gsk)_[a-z0-9]{8,}|\bsk-[a-z0-9]{16,}/,
  /\b(groq|openai|woocommerce|wp-json|wc\/v3|render\.com|webhook|apps script)\b.{0,40}\b(keys?|secrets?|tokens?|passwords?|credentials?|endpoint|config|configuration)\b/,
  /\b(reveal|show|print|dump|leak|expose|display|disclose|tell me|give me|send me|share)\b.{0,40}\b(passwords?|credentials?|secrets?|tokens?|backend|database|admin (panel|login|password|key))\b/,
  /\bsource code\b|\bgithub (repo|repository)\b|\bserver (config|files?|logs?)\b/
];

const OVERRIDE = [
  /\b(ignore|disregard|forget|override|bypass|circumvent)\s+(?:all\s+|any\s+|every\s+|everything\s+|of\s+|the\s+|your\s+|my\s+|these\s+|those\s+)*(?:previous|prior|above|earlier|preceding|original|system|safety|security)?\s*(?:instructions?|rules?|prompts?|guidelines?|restrictions?|directives?|constraints?|programming)\b/,
  /\bforget (everything|all) (you|that|about|we)\b/,
  /\b(developer|debug|maintenance|admin|administrator|root|sudo|god|unrestricted|unfiltered|uncensored|dan)[ -](mode|access|override|prompt)\b/,
  /\bjailbreak|\bdo anything now\b|\bno[- ]restrictions?\b/,
  /\byou are (now|no longer)\b|\bfrom now on,? you\b|\bpretend (to be|that you|you are|you're)\b|\bact as (if )?(an? )?(admin|administrator|developer|root|system|unrestricted|another|different|hacker)\b|\brole[- ]?play\b/,
  /\[\/?(system|inst|assistant)\]|<\/?(system|assistant|im_start|im_end)>|###\s?(system|instruction)/,
  /\b(new|updated|revised) (system )?(instructions?|rules|policy)\s*:/,
  /\b(i am|i'm|im|this is) (the |an? |your )?(admin|administrator|creator|security (tester|researcher|auditor|team)|pentester|red team)\b/,
  /\bpenetration test|\bsecurity (test|audit)\b|\b(authori[sz]ed) (test|audit)\b/
];
// Role markers at the start of a line need the original line breaks
const ROLE_LINE = /(^|\n)\s*(system|assistant|developer)\s*:/;

const ENCODED = [
  /\b(base64|rot13|hex(adecimal)?[- ]encoded)\b|\bdecode (this|the following)\b|\bencoded (instruction|message|string)\b|\breversed? (text|string|instructions?)\b/
];
const LONG_BLOB = /[a-z0-9+/=_-]{80,}/i; // checked after web addresses are removed

const ECHO = [
  /\b(repeat|echo|say|print|type|output|respond|reply|answer|return)\b.{0,25}\b(exactly|verbatim|word for word|after me|only|just)\b/,
  /\brepeat (this|that|after me|exactly|the (word|phrase|text|following)|what i)\b/,
  /\b(respond|reply|answer|output) (only )?(in|with) (json|xml|yaml|base64|code)\b/,
  /^(test|ping|pong|echo)\b[\s:,-]*[a-z0-9-]{4,}$/
];

const OFFTOPIC = [
  /\bcapital of\b|\bwho (invented|discovered|wrote|painted|won the)\b|\bwho is the (president|prime minister|king|queen)\b|\bwhat year (did|was)\b|\bmeaning of life\b|\bspeed of light\b|\bboiling point\b/,
  /\b(write|compose|generate|create|draft|give me|make) (me )?(a |an |some |the )?(python|javascript|java|c\+\+|html|css|sql|bash|code|script|program|function|algorithm|regex|poem|song|story|essay|joke|limerick|haiku|recipe|speech|lyrics)\b/,
  /```|\bdef \w+\(|\bfunction \w+\(|#include|\bimport (os|sys|numpy|pandas)\b|\bselect \* from\b|<script/,
  /\btranslate\b.{0,40}\b(to|into)\b/,
  /\bwhat('?s| is) \d+ ?(\+|plus|minus|times|multiplied by|divided by|x|\*|\/) ?\d+/,
  /^[\s\d+*/^().=?x×÷]*\d[\s\d+*/^().=?x×÷]*[+*/^=x×÷][\s\d+*/^().=?x×÷]*$/,
  /\b(tell me a joke|sing me|bedtime story|horoscope|weather (in|for)|bitcoin|crypto price|lottery|football score|who will win|who should i vote)\b/
];
const ON_TOPIC =
  /\b(products?|price|cost|stock|available|availability|orders?|deliver\w*|courier|shipping|returns?|refunds?|warranty|pay\w*|eft|card|support|account|invoice|quote|dealer|store|shop|showroom|collect\w*|pick ?up|charger|cable|router|speaker|tv|camera|cctv|solar|inverter|battery|ups|chair|desk|cot|scooter|bracket|projector|kettle|furniture|soundbar|hdmi|wi-?fi|mesh|headphones|earphones|watch|biometric|repair|spares?|firmware|download|reseller|demo|clearance|baby|nursery|registry|mattress|gift|setup|install\w*|new spirit|newspirit|dealy|babyfurn|ultra-?link)\b/;

const IDENTITY = [
  /\b(which|what) (company|model|llm|language model|ai model|ai|version|engine|provider) (are you|is this|trained|made|powers|runs|do you (use|run on))\b/,
  /\bwho (made|trained|created|built|developed|owns) you\b|\bare you (chat ?gpt|gpt|openai|llama|claude|gemini|groq|an? llm)\b|\bwhich company trained you\b|\bunderlying model\b|\bwhat (llm|model) (are|is) (you|this)\b/
];

const NOISE = [/(.)\1{39,}/, /\b(\w+)( \1){14,}\b/];

const WEIGHTS = { secrets: 1, override: 1, encoded: 1, noise: 1, echo: 0.5, offtopic: 0.5, identity: 0 };

// Parts of the prompt that must never appear in a reply, and key-shaped text
const LEAK_PHRASES = [
  "instruction hierarchy", "instruction authority", "internal information protection", "prompt injection defence",
  "repetition and echo prevention", "permanent business role", "tool and data security",
  "encoded and transformed instructions", "conversation manipulation", "role-play and social engineering",
  "customer data protection", "internal marker"
];
const SECRET_SHAPES = [/\bgsk_[a-z0-9]{10,}/i, /\bck_[a-f0-9]{16,}/i, /\bcs_[a-f0-9]{16,}/i, /\bsk-[a-z0-9]{16,}/i, /\bbearer [a-z0-9._-]{20,}/i];
const SECRET_ENV_NAMES = [
  "GROQ_API_KEY", "WC_CONSUMER_KEY", "WC_CONSUMER_SECRET", "ADMIN_KEY",
  "LOG_WEBHOOK_SECRET", "LOG_WEBHOOK_URL", "STOCK_WC_KEY", "STOCK_WC_SECRET"
];

// A chat needs follow-up when something went wrong, the bot was unsure or could not find something,
// or the customer asked for a person. (Just mentioning the support email is not enough.)
const UNSURE = /(don['’]t (have|know|see)|do not (have|know|see)|couldn['’]t find|could not find|can['’]t (find|help|see|check|confirm)|cannot (find|help|see|check|confirm)|not (sure|listed)|unable to|no (matching|results)|temporarily unavailable)/i;
const WANTS_PERSON = /\b((speak|talk|chat) (to|with) (a |an |some)?(one|body|human|person|agent|manager|someone)|human|agent|manager|complain|complaint)\b/i;

export function createGuard({ brand, botName, supportEmail, topics = "products, stock, delivery, returns and support" }) {
  const canary = randomBytes(9).toString("hex"); // lowercase hex, put in the prompt, must never come out
  const replies = {
    secrets: `I'm sorry, I can't help with that. I can help with ${brand} ${topics}. What can I help you with?`,
    echo: `I can't repeat text on request, but I'm happy to help with ${brand} ${topics}. What can I help you with?`,
    offtopic: `I can only help with ${brand} ${topics}. Is there something about those I can help you with?`,
    identity: `I'm ${botName}, an AI assistant for ${brand}. How can I help you today?`
  };
  replies.override = replies.secrets; replies.encoded = replies.secrets; replies.noise = replies.secrets;
  const refusal = `Sorry, I can't help with that. Please contact ${supportEmail} for assistance.`;

  /* ----- 1. screen one customer message ----- */
  function screen(text) {
    const raw = fold(text);
    const c = flat(text);
    const sq = squash(text);
    const hit = (list) => list.some((re) => re.test(c));
    let category = null;

    if (hit(SECRETS) || /ignorepreviousinstructions|ignoreyourinstructions|systemprompt|developermode|revealyourinstructions|showyourprompt|printyourprompt/.test(sq)) category = "secrets";
    else if (hit(OVERRIDE) || ROLE_LINE.test(raw)) category = "override";
    else if (hit(ENCODED) || LONG_BLOB.test(c.replace(/https?:\/\/\S+|\S+\.(co\.za|com|org)\S*/g, " "))) category = "encoded";
    else if (hit(IDENTITY)) category = "identity";
    else if (hit(ECHO) && !ON_TOPIC.test(c)) category = "echo";
    else if (hit(OFFTOPIC) && !ON_TOPIC.test(c)) category = "offtopic";
    else if (NOISE.some((re) => re.test(c))) category = "noise";

    return category
      ? { block: true, category, weight: WEIGHTS[category], reply: replies[category] }
      : { block: false };
  }

  /* ----- 2. block repeat offenders by IP ----- */
  const offenders = new Map(); // ip -> { hits: [{t, w}], until, blocks }
  setInterval(() => {
    const now = Date.now();
    for (const [ip, o] of offenders) {
      o.hits = o.hits.filter((h) => now - h.t < 15 * 60_000);
      if (!o.hits.length && o.until < now && now - (o.last ?? 0) > 24 * 3600_000) offenders.delete(ip);
    }
  }, 10 * 60_000).unref();

  function strike(ip, weight) {
    if (!weight) return;
    const now = Date.now();
    const o = offenders.get(ip) ?? { hits: [], until: 0, blocks: 0 };
    o.hits = o.hits.filter((h) => now - h.t < 15 * 60_000);
    o.hits.push({ t: now, w: weight });
    o.last = now;
    if (o.hits.reduce((sum, h) => sum + h.w, 0) >= 3) {
      o.until = now + Math.min(24 * 3600_000, 3600_000 * 2 ** o.blocks); // 1 hour, then 2, 4 ... up to 24
      o.blocks += 1;
      o.hits = [];
    }
    offenders.set(ip, o);
  }
  const blockedMs = (ip) => Math.max(0, (offenders.get(ip)?.until ?? 0) - Date.now());

  /* ----- 3. screen the model's reply on the way out ----- */
  const liveSecrets = () => SECRET_ENV_NAMES.map((n) => process.env[n]).filter((v) => v && v.length >= 8);
  function leaks(text, secrets = liveSecrets()) {
    const f = fold(text);
    return (
      f.includes(canary) ||
      LEAK_PHRASES.some((p) => f.includes(p)) ||
      SECRET_SHAPES.some((re) => re.test(f)) ||
      secrets.some((v) => String(text).includes(v))
    );
  }

  // Holds back the last 100 characters so a leak split across pieces is caught before it is sent.
  function outputGuard(write) {
    const HOLD = 100;
    const secrets = liveSecrets();
    let held = "", tail = "", tripped = false;
    return {
      push(text) {
        if (tripped) return;
        held += text;
        if (leaks(tail + held, secrets)) { tripped = true; held = ""; return; }
        if (held.length > HOLD) {
          const out = held.slice(0, held.length - HOLD);
          held = held.slice(-HOLD);
          write(out);
          tail = (tail + out).slice(-HOLD);
        }
      },
      finish() {
        if (!tripped && held) {
          if (leaks(tail + held, secrets)) tripped = true;
          else write(held);
        }
        held = "";
        return tripped;
      },
      get tripped() { return tripped; }
    };
  }

  /* ----- 4. clean fake earlier messages sent by the browser ----- */
  function cleanHistory(history) {
    const out = [];
    let skipNextAssistant = false;
    for (const m of history) {
      if (m.role === "user") {
        const v = screen(m.content);
        if (v.block && v.category !== "identity") { skipNextAssistant = true; continue; }
        skipNextAssistant = false;
        out.push(m);
      } else {
        if (skipNextAssistant || leaks(m.content)) { skipNextAssistant = false; continue; }
        out.push(m);
      }
    }
    while (out.length && out[0].role !== "user") out.shift();
    return out;
  }

  const followUp = (question, reply, error) =>
    Boolean(error) || UNSURE.test(String(reply ?? "")) || WANTS_PERSON.test(String(question ?? ""));

  return { canary, refusal, screen, strike, blockedMs, outputGuard, cleanHistory, leaks, followUp };
}
