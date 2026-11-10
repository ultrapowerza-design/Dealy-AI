/* Dealy chat bubble. Add to the website with:
   <script src="https://YOUR-CHAT-DOMAIN/widget.js" defer></script>
   Optional: data-position="left"   data-hide="/checkout,/cart"
   The chat runs inside an iframe on the chat server, so it cannot read the website's pages, cookies or checkout. */
(function () {
  "use strict";
  // Speed/cache plugins can run scripts late, so fall back to finding our own script tag.
  var tag = document.currentScript || document.querySelector('script[src*="/widget.js"]');
  if (!tag || !tag.src) return;
  if (window.__dealyChat) return;
  window.__dealyChat = true;

  var origin = new URL(tag.src).origin;
  var left = tag.getAttribute("data-position") === "left";

  // Never show the bubble on payment-related pages.
  var hide = (tag.getAttribute("data-hide") || "/checkout,/cart,/order-pay,/my-account")
    .split(",").map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
  var path = location.pathname.toLowerCase();
  for (var i = 0; i < hide.length; i++) if (path.indexOf(hide[i]) !== -1) return;

  var side = left ? "left" : "right";
  var css =
    "#nsc-btn,#nsc-panel{position:fixed;z-index:2147483000;" + side + ":20px;font-family:Barlow,Arial,Helvetica,sans-serif}" +
    "#nsc-btn{bottom:max(20px,env(safe-area-inset-bottom));width:64px;height:64px;border:0;border-radius:50%;background:#fff;" +
    "box-shadow:0 6px 24px rgba(20,28,45,.28);cursor:pointer;padding:0;display:grid;place-items:center;transition:transform .18s}" +
    "#nsc-btn:hover{transform:scale(1.06)}" +
    "#nsc-btn img{width:42px;height:42px;object-fit:contain}" +
    "#nsc-btn .nsc-x{display:none;font-size:32px;line-height:1;color:#b80079}" +
    "#nsc-btn.open img{display:none}#nsc-btn.open .nsc-x{display:block}" +
    "#nsc-panel{bottom:calc(max(20px,env(safe-area-inset-bottom)) + 76px);width:380px;height:min(640px,calc(100vh - 120px));" +
    "display:none;flex-direction:column;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 14px 50px rgba(20,28,45,.32)}" +
    "#nsc-panel.open{display:flex}" +
    "#nsc-bar{background:#e4009a;color:#fff;text-shadow:0 1px 2px rgba(70,45,110,.4);display:flex;align-items:center;gap:10px;padding:10px 12px 10px 14px;flex:none}" +
    "#nsc-bar img{width:30px;height:30px;padding:3px;border-radius:50%;background:#fff;object-fit:contain}" +
    "#nsc-bar strong{font-family:\"Archivo Black\",Arial,sans-serif;text-transform:uppercase;letter-spacing:.03em;font-weight:400;font-size:15px;display:block}#nsc-bar small{font-size:12px;font-weight:600;color:#fff;display:block}" +
    "#nsc-close{margin-left:auto;width:34px;height:34px;border:0;border-radius:50%;background:transparent;color:#fff;font-size:24px;cursor:pointer}" +
    "#nsc-close:hover{background:rgba(255,255,255,.2)}" +
    "#nsc-frame{flex:1;width:100%;border:0;background:#fff}" +
    "@media(max-width:480px){#nsc-panel{inset:0;width:100%;height:100%;border-radius:0}#nsc-btn.open{display:none}}" +
    "@media(prefers-reduced-motion:reduce){#nsc-btn{transition:none}}";

  var style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  // Fonts that match the Dealy logo (fall back to Arial if they cannot load).
  var font = document.createElement("link");
  font.rel = "stylesheet";
  font.href = "https://fonts.googleapis.com/css2?family=Archivo+Black&family=Barlow:wght@500;600;700&display=swap";
  document.head.appendChild(font);

  var btn = document.createElement("button");
  btn.id = "nsc-btn";
  btn.type = "button";
  btn.setAttribute("aria-label", "Open Dealy support chat");
  btn.setAttribute("aria-expanded", "false");
  btn.innerHTML = '<img alt="" src="' + origin + '/logo.png"><span class="nsc-x" aria-hidden="true">&times;</span>';

  var panel = document.createElement("div");
  panel.id = "nsc-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Dealy support chat");
  panel.innerHTML =
    '<div id="nsc-bar"><img alt="" src="' + origin + '/logo.png"><div><strong>Dealy AI</strong><small>Here to help you</small></div>' +
    '<button id="nsc-close" type="button" aria-label="Close chat">&times;</button></div>';

  var frame = null;
  function open() {
    // The chat is only loaded when the visitor first opens it.
    if (!frame) {
      frame = document.createElement("iframe");
      frame.id = "nsc-frame";
      frame.title = "Dealy support chat";
      frame.src = origin + "/?embed=1";
      frame.setAttribute("referrerpolicy", "no-referrer");
      panel.appendChild(frame);
    }
    panel.classList.add("open");
    btn.classList.add("open");
    btn.setAttribute("aria-expanded", "true");
    btn.setAttribute("aria-label", "Close Dealy support chat");
  }
  function close() {
    panel.classList.remove("open");
    btn.classList.remove("open");
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-label", "Open Dealy support chat");
    btn.focus();
  }

  btn.addEventListener("click", function () { panel.classList.contains("open") ? close() : open(); });
  panel.querySelector("#nsc-close").addEventListener("click", close);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && panel.classList.contains("open")) close(); });

  // Wake a sleeping free-plan server shortly before it is needed.
  var warmed = false;
  function warm() {
    if (warmed) return;
    warmed = true;
    try { fetch(origin + "/api/config", { mode: "no-cors", cache: "no-store" }); } catch (e) {}
  }
  btn.addEventListener("pointerenter", warm);
  btn.addEventListener("focus", warm);

  function mount() {
    document.body.appendChild(panel);
    document.body.appendChild(btn);
  }
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount);
})();
