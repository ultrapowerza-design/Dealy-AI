const chatForm = document.getElementById("chatForm");
const messageInput = document.getElementById("messageInput");
const messages = document.getElementById("messages");
const sendButton = document.getElementById("sendButton");
const newChatButton = document.getElementById("newChat");
const quickButtons = document.querySelectorAll(".quick-actions button");
const panel = document.getElementById("chatPanel");
const toggleButton = document.getElementById("chatToggle");
const closeButton = document.getElementById("chatClose");
const isEmbed = document.documentElement.classList.contains("embed");

// Set to true while testing to see technical errors in the chat.
const DEBUG = false;

const STORAGE_KEY = "dealy_chat_v1";
const MAX_CHARS = 500;
const MAX_SAVED = 20;
const SAVE_HOURS = 24;

let conversation = [];
let sessionId = "";
let config = { email: "support@dealy.co.za", phone: "+27 11 314 8451", whatsapp: null };

/* ---------- saved chat (survives page refresh) ---------- */

function newId() {
    return (crypto.randomUUID && crypto.randomUUID()) || Date.now() + "-" + Math.random().toString(16).slice(2);
}

function loadState() {
    try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
        const fresh = saved.savedAt && Date.now() - saved.savedAt < SAVE_HOURS * 3600 * 1000;
        if (fresh) {
            sessionId = saved.sessionId || "";
            if (Array.isArray(saved.conversation)) {
                conversation = saved.conversation
                    .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
                    .map(m => ({ role: m.role, content: m.role === "assistant" ? unwrapReply(m.content) : m.content }))
                    .slice(-MAX_SAVED);
            }
        }
    } catch { /* storage unavailable: chat still works, it just isn't remembered */ }
    if (!sessionId) sessionId = newId();
}

function saveState() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            sessionId,
            savedAt: Date.now(),
            conversation: conversation.slice(-MAX_SAVED)
        }));
    } catch { /* ignore */ }
}

/* ---------- replies ---------- */

// The older server answered with {"reply":"..."}. Show only the text, even if it was wrapped more than once.
function unwrapReply(text) {
    let out = text;
    for (let i = 0; i < 3; i++) {
        const t = out.trim();
        if (!t.startsWith("{") || !t.includes('"reply"')) break;
        try {
            const parsed = JSON.parse(t);
            if (typeof parsed.reply !== "string") break;
            out = parsed.reply;
        } catch { break; }
    }
    return out;
}

/* ---------- rendering (escapes HTML first, so replies can't inject markup) ---------- */

function escapeHtml(text) {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function renderRich(text) {
    let html = escapeHtml(text);

    html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

    html = html.replace(/(^|[\s(])(https?:\/\/[^\s<"]+)/g, (match, pre, url) => {
        const trail = (url.match(/[.,;:!?)]+$/) || [""])[0];
        const link = trail ? url.slice(0, -trail.length) : url;
        return `${pre}<a href="${link}" target="_blank" rel="noopener noreferrer">${link}</a>${trail}`;
    });

    return html.replace(/\n/g, "<br>");
}

function scrollDown() {
    messages.scrollTop = messages.scrollHeight;
}

function addMessage(text, sender) {
    const el = document.createElement("div");
    el.classList.add("message", sender === "user" ? "user-message" : "bot-message");
    if (sender === "user") el.textContent = text;
    else el.innerHTML = renderRich(text);
    messages.appendChild(el);
    scrollDown();
    return el;
}

/* ---------- talk to a person ---------- */

function addLink(parent, href, label, note) {
    const a = document.createElement("a");
    a.href = href;
    if (href.startsWith("http")) { a.target = "_blank"; a.rel = "noopener noreferrer"; }
    a.textContent = label;
    if (note) {
        const small = document.createElement("small");
        small.textContent = note;
        a.appendChild(small);
    }
    parent.appendChild(a);
}

function showHandoff() {
    const card = document.createElement("div");
    card.className = "message bot-message contact-card";

    const title = document.createElement("div");
    title.className = "contact-title";
    title.textContent = "Here's how to reach our team. Have your order number ready if it's about an order.";
    card.appendChild(title);

    const links = document.createElement("div");
    links.className = "contact-links";
    if (config.whatsapp) addLink(links, "https://wa.me/" + config.whatsapp, "WhatsApp", "Message us");
    addLink(links, "mailto:" + config.email, "Email", config.email);
    addLink(links, "tel:" + config.phone.replace(/\s/g, ""), "Call", config.phone);
    card.appendChild(links);

    messages.appendChild(card);
    scrollDown();
}

/* ---------- sending ---------- */

function setBusy(busy) {
    sendButton.disabled = busy;
}

async function sendMessage(text) {
    const cleanText = text.trim().slice(0, MAX_CHARS);
    if (!cleanText || sendButton.disabled) return;

    addMessage(cleanText, "user");
    conversation.push({ role: "user", content: cleanText });

    messageInput.value = "";
    setBusy(true);

    const bubble = addMessage("Dealy AI is typing...", "bot");
    bubble.classList.add("typing");

    try {
        const response = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ messages: conversation, sessionId })
        });

        if (!response.ok) {
            const raw = await response.text();
            let data = {};
            try { data = JSON.parse(raw); } catch { /* not JSON */ }
            const err = new Error(`(${response.status}) ${data.error || raw.slice(0, 120) || "Request failed"}`);
            if (response.status === 400 || response.status === 429) err.userMessage = data.error;
            throw err;
        }

        // The reply arrives in pieces; show it as it is written.
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let reply = "";

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            reply += decoder.decode(value, { stream: true });
            bubble.classList.remove("typing");
            bubble.innerHTML = renderRich(unwrapReply(reply));
            scrollDown();
        }
        reply = unwrapReply(reply + decoder.decode());

        if (!reply.trim()) throw new Error("The AI returned an empty response.");

        conversation.push({ role: "assistant", content: reply });
        saveState();

    } catch (error) {
        console.error(error);
        conversation.pop();
        bubble.classList.remove("typing");

        const friendly = error.userMessage || "Sorry, I'm having trouble connecting right now. Please try again.";
        bubble.innerHTML = renderRich(friendly + (DEBUG ? "\n\n[debug] " + error.message : ""));

    } finally {
        setBusy(false);
        messageInput.focus();
    }
}

/* ---------- open / close (standalone page only; the website widget has its own button) ---------- */

function setOpen(open, returnFocus) {
    panel.classList.toggle("open", open);
    toggleButton.classList.toggle("open", open);
    toggleButton.setAttribute("aria-expanded", String(open));
    toggleButton.setAttribute("aria-label", open ? "Close Dealy support chat" : "Open Dealy support chat");
    if (open) {
        scrollDown();
        messageInput.focus();
    } else if (returnFocus) {
        toggleButton.focus();
    }
}

if (!isEmbed) {
    toggleButton.addEventListener("click", () => setOpen(!panel.classList.contains("open"), false));
    closeButton.addEventListener("click", () => setOpen(false, true));
    document.addEventListener("keydown", event => {
        if (event.key === "Escape" && panel.classList.contains("open")) setOpen(false, true);
    });
    // http://localhost:3000/?open opens the chat on load
    if (new URLSearchParams(location.search).has("open")) setOpen(true, false);
}

/* ---------- start-up and events ---------- */

function restoreChat() {
    conversation.forEach(m => addMessage(m.content, m.role === "user" ? "user" : "bot"));
}

newChatButton.addEventListener("click", () => {
    conversation = [];
    sessionId = newId();
    saveState();
    [...messages.children].slice(1).forEach(node => node.remove());
});

chatForm.addEventListener("submit", event => {
    event.preventDefault();
    sendMessage(messageInput.value);
});

quickButtons.forEach(button => {
    button.addEventListener("click", () => {
        if (button.dataset.action === "human") showHandoff();
        else sendMessage(button.dataset.prompt);
    });
});

loadState();
restoreChat();

fetch("/api/config")
    .then(r => r.json())
    .then(c => { config = { ...config, ...c }; })
    .catch(() => { /* defaults are fine */ });
