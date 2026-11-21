const api = typeof browser !== "undefined" ? browser : chrome;
const DEFAULTS = READ_ALOUD_DEFAULTS;
const $ = (id) => document.getElementById(id);
const fields = ["voiceURI", "rate", "showButton", "useServer", "serverURL", "serverKey", "serverModel", "serverVoice"];

function note(text) {
  $("note").textContent = text;
  $("note").hidden = !text;
}

async function activeTab() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function send(message) {
  const tab = await activeTab();
  if (!tab) throw new Error("no tab");
  return api.tabs.sendMessage(tab.id, message);
}

function fillVoices(selected) {
  const list = (speechSynthesis.getVoices() || []).slice().sort((a, b) =>
    a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
  const select = $("voiceURI");
  select.length = 1;
  const lang = (navigator.language || "en").split("-")[0];
  const mine = list.filter((v) => v.lang.startsWith(lang));
  const others = list.filter((v) => !v.lang.startsWith(lang));
  for (const [label, group] of [["Your language", mine], ["Other languages", others]]) {
    if (!group.length) continue;
    const og = document.createElement("optgroup");
    og.label = label;
    for (const v of group) {
      const o = document.createElement("option");
      o.value = v.voiceURI;
      o.textContent = `${v.name} (${v.lang})`;
      og.appendChild(o);
    }
    select.appendChild(og);
  }
  select.value = selected || "";
}

function showRate(rate) {
  $("rateLabel").textContent = (+rate).toFixed(2).replace(/\.?0+$/, "") + "×";
}

async function load() {
  const s = { ...DEFAULTS, ...(await api.storage.local.get(DEFAULTS)) };
  for (const key of fields) {
    const el = $(key);
    if (el.type === "checkbox") el.checked = !!s[key];
    else el.value = s[key];
  }
  showRate(s.rate);
  $("serverFields").hidden = !s.useServer;
  fillVoices(s.voiceURI);
  speechSynthesis.addEventListener("voiceschanged", () => fillVoices($("voiceURI").value));
}

for (const key of fields) {
  const el = $(key);
  const event = el.type === "checkbox" || el.tagName === "SELECT" ? "change" : "input";
  el.addEventListener(event, () => {
    let value = el.type === "checkbox" ? el.checked : el.value;
    if (key === "rate") { value = parseFloat(value); showRate(value); }
    if (key === "useServer") $("serverFields").hidden = !value;
    api.storage.local.set({ [key]: value });
  });
}

$("read").addEventListener("click", async () => {
  try {
    const res = await send({ type: "read" });
    if (res && res.ok) window.close();
    else note("Highlight some text on the page first, then try again.");
  } catch (e) {
    note("Read Aloud can't reach this page. Check that it's allowed on this website in Settings › Apps › Safari › Extensions.");
  }
});

$("readPage").addEventListener("click", async () => {
  try {
    const res = await send({ type: "readPage" });
    if (res && res.ok) window.close();
    else note("There's no text to read on this page.");
  } catch (e) {
    note("Read Aloud can't reach this page. Check that it's allowed on this website in Settings › Apps › Safari › Extensions.");
  }
});

$("stop").addEventListener("click", async () => {
  try { await send({ type: "stop" }); } catch (e) {}
  window.close();
});

$("testVoice").addEventListener("click", () => {
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance("This is how Read Aloud will sound.");
  const v = speechSynthesis.getVoices().find((x) => x.voiceURI === $("voiceURI").value);
  if (v) { u.voice = v; u.lang = v.lang; }
  u.rate = parseFloat($("rate").value) || 1;
  speechSynthesis.speak(u);
});

$("testServer").addEventListener("click", async () => {
  note("Asking your speech server…");
  const audio = new Audio();
  try {
    const res = await api.runtime.sendMessage({
      type: "tts",
      text: "Your speech server is working.",
      url: $("serverURL").value,
      key: $("serverKey").value,
      model: $("serverModel").value,
      voice: $("serverVoice").value
    });
    if (!res || !res.ok) throw new Error((res && res.error) || "No answer.");
    audio.src = res.dataURL;
    await audio.play();
    note("Your speech server works.");
  } catch (e) {
    note(String(e.message || e));
  }
});

load();
