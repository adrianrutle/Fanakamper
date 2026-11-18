// Chat med to grupper: «Alle» (alle med tilgang) og «Evalueringsgruppen».
// Tekst ligger i chat_<gruppe>, bilder (komprimert JPEG som data-URL) i chat_img_<gruppe>,
// slik at meldingslisten holder seg liten og bildene hentes først når de vises.
import * as store from "./store.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const CHANNELS = { alle: { label: "Alle", coll: "chat_alle", img: "chat_img_alle" },
  eval: { label: "Evalueringsgruppen", coll: "chat_eval", img: "chat_img_eval" } };
const MAX_IMG_CHARS = 900_000; // Firestore-dokumenter kan være maks 1 MiB
const SEEN_KEY = "fk_chat_seen";

const chat = { me: "", name: "", isEval: false, isOwner: false, channel: "alle",
  msgs: { alle: [], eval: [] }, query: "", pending: null, imgCache: new Map(), started: false };

const seen = () => { try { return JSON.parse(localStorage.getItem(SEEN_KEY) || "{}"); } catch (e) { return {}; } };
function markSeen(ch) {
  const last = chat.msgs[ch].at(-1)?.at;
  if (!last) return;
  try { localStorage.setItem(SEEN_KEY, JSON.stringify({ ...seen(), [ch]: last })); } catch (e) { /* ignorer */ }
}
const visible = () => !$("#chat").hidden;

export function startChat({ user, isEval, isOwner }) {
  if (chat.started) return;
  chat.started = true;
  chat.me = user.email.toLowerCase();
  chat.name = user.displayName || user.email.split("@")[0];
  chat.isEval = isEval;
  chat.isOwner = isOwner;
  $("#chatChannel [data-ch=eval]").hidden = !isEval;
  for (const ch of Object.keys(CHANNELS)) {
    if (ch === "eval" && !isEval) continue;
    store.subscribe(CHANNELS[ch].coll, (list) => {
      chat.msgs[ch] = list.sort((a, b) => (a.at || "").localeCompare(b.at || ""));
      if (ch === chat.channel) render(true);
      if (visible() && ch === chat.channel) markSeen(ch);
      updateBadge();
    }, (e) => {
      if (ch === chat.channel) $("#chatLog").innerHTML = `<p class="error">Kunne ikke hente chatten (${esc(e.code || e.message)}).
        Er de nye Firebase-reglene publisert?</p>`;
    });
  }
  bindUi();
}

// Kalles når Chat-fanen åpnes
export function onChatShown() {
  markSeen(chat.channel);
  updateBadge();
  scrollToEnd();
  setTimeout(() => $("#chatText").focus(), 50);
}

function updateBadge() {
  const s = seen();
  let n = 0;
  for (const ch of Object.keys(CHANNELS)) {
    if (ch === "eval" && !chat.isEval) continue;
    const unread = chat.msgs[ch].filter((m) => m.by !== chat.me && (!s[ch] || m.at > s[ch])).length;
    if (visible() && ch === chat.channel) continue;
    n += unread;
    const b = $(`#chatChannel [data-ch=${ch}] .unread`);
    if (b) { b.textContent = unread || ""; b.hidden = !unread; }
  }
  const cur = $(`#chatChannel [data-ch=${chat.channel}] .unread`);
  if (cur && visible()) cur.hidden = true;
  const tab = $("#chatBadge");
  tab.textContent = n || "";
  tab.hidden = !n;
}

function bindUi() {
  document.querySelectorAll("#chatChannel button").forEach((b) => (b.onclick = () => {
    chat.channel = b.dataset.ch;
    document.querySelectorAll("#chatChannel button").forEach((x) => x.classList.toggle("active", x === b));
    render(true);
    markSeen(chat.channel);
    updateBadge();
  }));
  $("#chatSearch").oninput = (e) => { chat.query = e.target.value.trim().toLowerCase(); render(!chat.query); };
  $("#chatForm").onsubmit = (e) => { e.preventDefault(); send(); };
  $("#chatText").onkeydown = (e) => {
    // Enter sender, Shift+Enter gir ny linje
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  };
  $("#chatText").oninput = autoGrow;
  // Lim inn bilde (Ctrl+V / Cmd+V) hvor som helst i chatten
  $("#chat").addEventListener("paste", (e) => {
    const file = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"))?.getAsFile();
    if (file) { e.preventDefault(); attach(file); }
  });
  $("#chatFile").onchange = (e) => { if (e.target.files[0]) attach(e.target.files[0]); e.target.value = ""; };
  $("#chatAttach").onclick = () => $("#chatFile").click();
  // Dra og slipp bilde
  $("#chat").addEventListener("dragover", (e) => { if ([...e.dataTransfer.types].includes("Files")) e.preventDefault(); });
  $("#chat").addEventListener("drop", (e) => {
    const f = [...e.dataTransfer.files].find((x) => x.type.startsWith("image/"));
    if (f) { e.preventDefault(); attach(f); }
  });
}

function autoGrow() {
  const t = $("#chatText");
  t.style.height = "auto";
  t.style.height = Math.min(t.scrollHeight, 160) + "px";
}

// Skalerer ned og komprimerer bildet så det får plass i ett Firestore-dokument
async function compress(file) {
  const bmp = await createImageBitmap(file).catch(() => null);
  const img = bmp || await new Promise((res, rej) => {
    const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file);
  });
  let max = 1600, q = 0.82, url = "";
  for (let tries = 0; tries < 8; tries++) {
    const s = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement("canvas");
    c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
    const g = c.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); // gjennomsiktige skjermbilder får hvit bakgrunn
    g.drawImage(img, 0, 0, c.width, c.height);
    url = c.toDataURL("image/jpeg", q);
    if (url.length <= MAX_IMG_CHARS) return { url, w: c.width, h: c.height };
    max = Math.round(max * 0.8); q = Math.max(0.5, q - 0.08);
  }
  throw new Error("Bildet er for stort");
}

async function attach(file) {
  $("#chatPreview").innerHTML = `<span class="muted">Forbereder bilde …</span>`;
  $("#chatPreview").hidden = false;
  try {
    chat.pending = await compress(file);
    $("#chatPreview").innerHTML = `<img src="${chat.pending.url}" alt="Bilde som sendes">
      <button type="button" class="ghost" id="chatUnattach" title="Fjern bildet">✕</button>`;
    $("#chatUnattach").onclick = clearPending;
    $("#chatText").focus();
  } catch (e) {
    chat.pending = null;
    $("#chatPreview").innerHTML = `<span class="error">Klarte ikke å lese bildet.</span>`;
  }
}
function clearPending() {
  chat.pending = null;
  $("#chatPreview").hidden = true;
  $("#chatPreview").innerHTML = "";
}

let sending = false;
async function send() {
  const text = $("#chatText").value.trim();
  if ((!text && !chat.pending) || sending) return;
  sending = true;
  $("#chatSend").disabled = true;
  const ch = CHANNELS[chat.channel];
  try {
    const msg = { text, by: chat.me, name: chat.name, at: new Date().toISOString() };
    if (chat.pending) {
      msg.img = await store.add(ch.img, { data: chat.pending.url, by: chat.me, at: msg.at });
      msg.w = chat.pending.w; msg.h = chat.pending.h;
      chat.imgCache.set(msg.img, chat.pending.url);
    }
    await store.add(ch.coll, msg);
    $("#chatText").value = "";
    autoGrow();
    clearPending();
    chat.query = ""; $("#chatSearch").value = "";
  } catch (e) {
    alert("Meldingen ble ikke sendt: " + (e.code || e.message));
  } finally {
    sending = false;
    $("#chatSend").disabled = false;
  }
}

async function removeMsg(m) {
  if (!confirm("Slette meldingen?")) return;
  const ch = CHANNELS[chat.channel];
  await store.remove(ch.coll, m.id);
  if (m.img) await store.remove(ch.img, m.img).catch(() => {});
}

const timeOf = (iso) => new Date(iso).toLocaleTimeString("nb-NO", { hour: "2-digit", minute: "2-digit" });
const dayOf = (iso) => {
  const d = new Date(iso), t = new Date();
  const y = new Date(); y.setDate(t.getDate() - 1);
  if (d.toDateString() === t.toDateString()) return "I dag";
  if (d.toDateString() === y.toDateString()) return "I går";
  return d.toLocaleDateString("nb-NO", { weekday: "long", day: "numeric", month: "long", year: d.getFullYear() === t.getFullYear() ? undefined : "numeric" });
};
// Lenker blir klikkbare, søkeord markeres
function format(text, q) {
  let h = esc(text).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  if (q) {
    const re = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?![^<]*>)`, "gi");
    h = h.replace(re, "<mark>$1</mark>");
  }
  return h.replace(/\n/g, "<br>");
}

function render(stick) {
  const log = $("#chatLog");
  const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  const q = chat.query;
  const all = chat.msgs[chat.channel];
  const list = q ? all.filter((m) => (m.text || "").toLowerCase().includes(q) || (m.name || "").toLowerCase().includes(q)) : all;
  $("#chatHits").textContent = q ? `${list.length} treff` : "";
  if (!list.length) {
    log.innerHTML = `<p class="muted center">${q ? "Ingen meldinger passer søket." :
      `Ingen meldinger i «${esc(CHANNELS[chat.channel].label)}» ennå. Si hei!`}</p>`;
    return;
  }
  let lastDay = "", html = "";
  for (const m of list) {
    const day = dayOf(m.at);
    if (day !== lastDay) { html += `<div class="chat-day"><span>${esc(day)}</span></div>`; lastDay = day; }
    const mine = m.by === chat.me;
    const ratio = m.w && m.h ? `style="aspect-ratio:${m.w}/${m.h}"` : "";
    html += `<div class="msg${mine ? " mine" : ""}" data-id="${m.id}">
      ${mine ? "" : `<div class="who">${esc(m.name || m.by)}</div>`}
      ${m.img ? `<button type="button" class="msg-img" data-img="${esc(m.img)}" ${ratio} title="Åpne bildet"></button>` : ""}
      ${m.text ? `<div class="txt">${format(m.text, q)}</div>` : ""}
      <div class="meta">${timeOf(m.at)}${mine || chat.isOwner ? ` · <button type="button" class="linkbtn del-msg">slett</button>` : ""}</div>
    </div>`;
  }
  log.innerHTML = html;
  log.querySelectorAll(".del-msg").forEach((b) => (b.onclick = () => removeMsg(list.find((m) => m.id === b.closest(".msg").dataset.id))));
  log.querySelectorAll(".msg-img").forEach(loadImg);
  if (q) log.querySelector("mark")?.scrollIntoView({ block: "center" });
  else if (stick || atEnd) scrollToEnd();
}

async function loadImg(el) {
  const id = el.dataset.img;
  let url = chat.imgCache.get(id);
  if (!url) {
    try {
      url = (await store.get(CHANNELS[chat.channel].img, id))?.data;
      if (url) chat.imgCache.set(id, url);
    } catch (e) { /* bildet er slettet eller utilgjengelig */ }
  }
  if (!url) { el.textContent = "Bildet er ikke tilgjengelig"; return; }
  el.innerHTML = `<img src="${url}" alt="Bilde i chatten" loading="lazy">`;
  el.onclick = () => {
    const box = $("#chatLightbox");
    box.innerHTML = `<img src="${url}" alt="Bilde i full størrelse"><a class="dl" href="${url}" download="fana-chat.jpg">Last ned</a>`;
    box.hidden = false;
    box.onclick = (e) => { if (e.target.tagName !== "A") box.hidden = true; };
  };
  const log = $("#chatLog");
  const nearEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 200;
  el.querySelector("img").onload = () => { if (!chat.query && nearEnd) scrollToEnd(); };
}

function scrollToEnd() {
  const log = $("#chatLog");
  log.scrollTop = log.scrollHeight;
}
