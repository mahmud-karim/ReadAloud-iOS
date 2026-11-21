// Read Aloud for Safari on iPhone.
// Highlight text, tap the speaker button, and the text is read aloud with the current word marked.
// Uses the iPhone's own voices by default, or an OpenAI-compatible speech server if one is set.
(() => {
  if (window.__readAloudLoaded) return;
  window.__readAloudLoaded = true;

  const api = typeof browser !== "undefined" ? browser : chrome;
  const DEFAULTS = {
    rate: 1,
    voiceURI: "",
    showButton: true,
    useServer: false,
    serverURL: "",
    serverKey: "",
    serverModel: "kokoro",
    serverVoice: "af_heart"
  };
  const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];
  const MAX_CHUNK = 220;
  const BLOCK_SKIP = "script,style,noscript,template,textarea,input,select,svg,math,[aria-hidden=true]";

  let settings = { ...DEFAULTS };
  try {
    api.storage.local.get(DEFAULTS).then((s) => { settings = { ...DEFAULTS, ...s }; render(); });
    api.storage.onChanged.addListener((changes) => {
      for (const key of Object.keys(changes)) settings[key] = changes[key].newValue;
      if (session && session.engine === "server") session.player.playbackRate = settings.rate;
      render();
    });
  } catch (e) {}

  // ---------------------------------------------------------------- text capture

  // A captured selection: the text to speak, and where each piece of it lives in the page so the
  // word being spoken can be marked in place.
  let saved = null;

  const blockCache = new WeakMap();
  function blockOf(node) {
    let el = node.parentElement;
    while (el && el !== document.body) {
      let display = blockCache.get(el);
      if (display === undefined) {
        display = getComputedStyle(el).display;
        blockCache.set(el, display);
      }
      if (display && !display.startsWith("inline")) return el;
      el = el.parentElement;
    }
    return document.body;
  }

  const visibleCache = new WeakMap();
  function isReadable(textNode) {
    const el = textNode.parentElement;
    if (!el) return false;
    if (el.closest(BLOCK_SKIP) || el.closest("#read-aloud-host")) return false;
    let ok = visibleCache.get(el);
    if (ok === undefined) {
      ok = typeof el.checkVisibility === "function"
        ? el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })
        : true;
      visibleCache.set(el, ok);
    }
    return ok;
  }

  function capture(range) {
    const segments = [];
    let text = "";
    let lastBlock = null;

    const add = (node, start, end) => {
      const block = blockOf(node);
      if (lastBlock && block !== lastBlock && text && !/\s$/.test(text)) text += "\n";
      lastBlock = block;
      segments.push({ node, start, gStart: text.length, len: end - start });
      text += node.data.slice(start, end);
    };

    const root = range.commonAncestorContainer;
    if (root.nodeType === Node.TEXT_NODE) {
      if (isReadable(root)) add(root, range.startOffset, range.endOffset);
    } else {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (!range.intersectsNode(node)) continue;
        const start = node === range.startContainer ? range.startOffset : 0;
        const end = node === range.endContainer ? range.endOffset : node.data.length;
        if (end <= start || !isReadable(node)) continue;
        add(node, start, end);
      }
    }
    if (!text.trim()) return null;
    return { text, segments };
  }

  function rangeFor(captured, gStart, gEnd) {
    const segs = captured.segments;
    let first = null;
    let last = null;
    for (const s of segs) {
      if (s.gStart + s.len <= gStart) continue;
      if (s.gStart >= gEnd) break;
      if (!first) first = s;
      last = s;
    }
    if (!first || !first.node.isConnected || !last.node.isConnected) return null;
    try {
      const r = document.createRange();
      r.setStart(first.node, first.start + Math.max(0, gStart - first.gStart));
      r.setEnd(last.node, last.start + Math.min(last.len, gEnd - last.gStart));
      return r;
    } catch (e) {
      return null;
    }
  }

  // ---------------------------------------------------------------- chunking

  // Splits text into sentence-sized pieces. iOS stops long utterances partway, and short pieces let
  // pause and skip work by sentence. Each piece keeps its offsets into the full text.
  function chunk(text) {
    const pieces = [];
    const sentence = /[^.!?…\n]+(?:[.!?…]+["'”’)\]]*\s*|\n+|$)/g;
    let m;
    while ((m = sentence.exec(text)) !== null) {
      if (m[0] === "") { sentence.lastIndex++; continue; }
      splitLong(m.index, m.index + m[0].length, text, pieces);
    }
    // Join short neighbours so the voice doesn't stop after every few words.
    const merged = [];
    for (const p of pieces) {
      const prev = merged[merged.length - 1];
      if (prev && p.end - prev.start <= MAX_CHUNK && prev.end - prev.start < 60) prev.end = p.end;
      else merged.push({ ...p });
    }
    return merged.filter((p) => text.slice(p.start, p.end).trim());
  }

  function splitLong(start, end, text, out) {
    while (end - start > MAX_CHUNK) {
      const slice = text.slice(start, start + MAX_CHUNK);
      let cut = Math.max(slice.lastIndexOf(", "), slice.lastIndexOf("; "), slice.lastIndexOf(": "));
      if (cut < MAX_CHUNK / 2) cut = slice.lastIndexOf(" ");
      if (cut < MAX_CHUNK / 3) cut = MAX_CHUNK - 1;
      out.push({ start, end: start + cut + 1 });
      start += cut + 1;
    }
    if (end > start) out.push({ start, end });
  }

  function wordAt(text, g) {
    let s = g;
    while (s > 0 && !/\s/.test(text[s - 1])) s--;
    let e = g;
    while (e < text.length && !/\s/.test(text[e])) e++;
    return { start: s, end: Math.max(e, s + 1) };
  }

  // ---------------------------------------------------------------- marking words in the page

  const canMark = typeof CSS !== "undefined" && CSS.highlights && typeof Highlight === "function";

  function injectPageStyle() {
    if (document.getElementById("read-aloud-marks")) return;
    const style = document.createElement("style");
    style.id = "read-aloud-marks";
    style.textContent =
      "::highlight(read-aloud-sentence){background-color:rgba(255,204,0,.22)}" +
      "::highlight(read-aloud-word){background-color:rgba(255,170,0,.85);color:#000}";
    (document.head || document.documentElement).appendChild(style);
  }

  function mark(gStart, gEnd, sentenceStart, sentenceEnd) {
    if (!session) return;
    if (canMark) {
      const sentenceRange = rangeFor(session.captured, sentenceStart, sentenceEnd);
      const wordRange = gEnd > gStart ? rangeFor(session.captured, gStart, gEnd) : null;
      if (sentenceRange) CSS.highlights.set("read-aloud-sentence", new Highlight(sentenceRange));
      if (wordRange) CSS.highlights.set("read-aloud-word", new Highlight(wordRange));
      else CSS.highlights.delete("read-aloud-word");
      keepInView(wordRange || sentenceRange);
    }
    ui.setCaption(session.text.slice(sentenceStart, sentenceEnd), gStart - sentenceStart, gEnd - sentenceStart);
  }

  function clearMarks() {
    if (!canMark) return;
    CSS.highlights.delete("read-aloud-sentence");
    CSS.highlights.delete("read-aloud-word");
  }

  let lastScroll = 0;
  function keepInView(range) {
    if (!range || Date.now() - lastScroll < 800) return;
    const rect = range.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return;
    const vv = window.visualViewport;
    const top = vv ? vv.offsetTop : 0;
    const height = vv ? vv.height : window.innerHeight;
    const panel = 170 * zoomFactor();
    if (rect.top < top + 40 || rect.bottom > top + height - panel) {
      lastScroll = Date.now();
      window.scrollBy({ top: rect.top - top - height * 0.3, behavior: "smooth" });
    }
  }

  // ---------------------------------------------------------------- reading

  // One reading of one piece of text. A new session replaces the old one; callbacks from an old
  // session check `alive` and do nothing.
  let session = null;

  function start(captured) {
    stop();
    const pieces = chunk(captured.text);
    if (!pieces.length) return;
    injectPageStyle();
    const useServer = settings.useServer && settings.serverURL.trim();
    session = {
      captured,
      text: captured.text,
      pieces,
      index: 0,
      offset: 0,
      playing: false,
      alive: true,
      engine: useServer ? "server" : "device",
      player: null,
      audio: new Map(),
      started: false
    };
    if (session.engine === "server") session.player = unlockedPlayer();
    window.getSelection()?.removeAllRanges();
    ui.showPanel();
    play();
    // A read started from the toolbar menu isn't a tap on the page, and iOS may not let it speak.
    // If nothing has started after a moment, wait for a tap on play instead.
    const s = session;
    setTimeout(() => {
      if (session === s && s.engine === "device" && s.playing && !s.started) {
        halt();
        s.playing = false;
        ui.toast("Tap play to start reading.");
        render();
      }
    }, 1500);
  }

  function play() {
    const s = session;
    if (!s) return;
    s.playing = true;
    render();
    if (s.engine === "server") playServer(s.index);
    else speakDevice(s.index, s.offset);
  }

  function pause() {
    const s = session;
    if (!s || !s.playing) return;
    s.playing = false;
    if (s.engine === "server") s.player.pause();
    else halt();
    render();
  }

  function skip(delta) {
    const s = session;
    if (!s) return;
    const next = Math.min(Math.max(s.index + delta, 0), s.pieces.length - 1);
    halt();
    if (s.engine === "server") s.player.pause();
    s.index = next;
    s.offset = 0;
    s.resumeAt = 0;
    if (s.playing) play();
    else {
      const p = s.pieces[next];
      mark(p.start, p.start, p.start, p.end);
    }
  }

  function stop() {
    if (!session) return;
    session.alive = false;
    halt();
    if (session.player) {
      session.player.pause();
      session.player.removeAttribute("src");
    }
    session = null;
    clearMarks();
    ui.hidePanel();
    render();
  }

  function finished() {
    stop();
  }

  // Bumped each time speech is cancelled, so late events from cancelled utterances are ignored.
  let utteranceGen = 0;
  function halt() {
    utteranceGen++;
    try { speechSynthesis.cancel(); } catch (e) {}
  }

  // ---- the iPhone's own voices

  let voices = [];
  function loadVoices() {
    try { voices = speechSynthesis.getVoices() || []; } catch (e) { voices = []; }
  }
  loadVoices();
  try { speechSynthesis.addEventListener("voiceschanged", loadVoices); } catch (e) {}

  function pickVoice() {
    if (!voices.length) loadVoices();
    if (settings.voiceURI) {
      const chosen = voices.find((v) => v.voiceURI === settings.voiceURI);
      if (chosen) return chosen;
    }
    const lang = (document.documentElement.lang || navigator.language || "en").toLowerCase();
    const base = lang.split("-")[0];
    return (
      voices.find((v) => v.lang.toLowerCase() === lang && v.default) ||
      voices.find((v) => v.lang.toLowerCase().startsWith(base)) ||
      null
    );
  }

  function speakDevice(index, offset) {
    const s = session;
    if (!s || !s.alive) return;
    if (index >= s.pieces.length) return finished();
    halt();
    const gen = utteranceGen;
    const piece = s.pieces[index];
    const from = piece.start + offset;
    s.index = index;
    s.offset = offset;
    // Same length as the original, so boundary offsets map straight back onto the page.
    const spoken = s.text.slice(from, piece.end).replace(/\s/g, " ");
    const u = new SpeechSynthesisUtterance(spoken);
    const voice = pickVoice();
    if (voice) { u.voice = voice; u.lang = voice.lang; }
    u.rate = settings.rate;
    u.onstart = () => {
      if (gen !== utteranceGen) return;
      s.started = true;
      const w = wordAt(s.text, from + (spoken.length - spoken.trimStart().length));
      mark(w.start, w.end, piece.start, piece.end);
    };
    u.onboundary = (e) => {
      if (gen !== utteranceGen || (e.name && e.name !== "word")) return;
      const g = from + e.charIndex;
      const end = e.charLength ? g + e.charLength : wordAt(s.text, g).end;
      s.offset = g - piece.start;
      mark(g, end, piece.start, piece.end);
    };
    const next = () => {
      if (gen !== utteranceGen || !s.alive || !s.playing) return;
      s.offset = 0;
      speakDevice(index + 1, 0);
    };
    u.onend = next;
    u.onerror = (e) => {
      if (e && (e.error === "interrupted" || e.error === "canceled")) return;
      if (e && e.error === "not-allowed") {
        if (gen !== utteranceGen) return;
        s.playing = false;
        render();
        ui.toast("Tap play to start reading.");
        return;
      }
      next();
    };
    // iOS sometimes ignores speak() right after cancel(); a short delay avoids that.
    setTimeout(() => {
      if (gen !== utteranceGen) return;
      try { speechSynthesis.resume(); } catch (e) {}
      speechSynthesis.speak(u);
    }, 60);
  }

  // ---- a speech server

  function silentWavURL() {
    const samples = 800;
    const buf = new ArrayBuffer(44 + samples * 2);
    const v = new DataView(buf);
    const w = (o, str) => { for (let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i)); };
    w(0, "RIFF"); v.setUint32(4, 36 + samples * 2, true); w(8, "WAVE"); w(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true);
    v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, samples * 2, true);
    return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
  }

  let sharedPlayer = null;
  // iOS only lets audio play after a tap; playing silence during the tap unlocks this element for
  // the rest of the reading.
  function unlockedPlayer() {
    if (!sharedPlayer) {
      sharedPlayer = new Audio();
      sharedPlayer.preload = "auto";
      sharedPlayer.setAttribute("playsinline", "");
    }
    sharedPlayer.onended = sharedPlayer.ontimeupdate = sharedPlayer.onerror = null;
    try {
      sharedPlayer.src = silentWavURL();
      const p = sharedPlayer.play();
      if (p && p.catch) p.catch(() => {});
    } catch (e) {}
    return sharedPlayer;
  }

  function audioFor(s, index) {
    if (!s.audio.has(index)) {
      const piece = s.pieces[index];
      const text = s.text.slice(piece.start, piece.end).replace(/\s+/g, " ").trim();
      const request = api.runtime
        .sendMessage({
          type: "tts",
          text,
          url: settings.serverURL,
          key: settings.serverKey,
          model: settings.serverModel,
          voice: settings.serverVoice
        })
        .then((res) => {
          if (!res || !res.ok) throw new Error((res && res.error) || "The speech server didn't answer.");
          return res.dataURL;
        });
      request.catch(() => {});
      s.audio.set(index, request);
    }
    return s.audio.get(index);
  }

  async function playServer(index) {
    const s = session;
    if (!s || !s.alive) return;
    if (index >= s.pieces.length) return finished();
    s.index = index;
    const piece = s.pieces[index];
    mark(piece.start, piece.start, piece.start, piece.end);
    // Ask for the next two pieces now so there's no gap between sentences.
    for (let i = index + 1; i < Math.min(index + 3, s.pieces.length); i++) audioFor(s, i);
    let url;
    try {
      ui.setBusy(true);
      url = await audioFor(s, index);
    } catch (err) {
      ui.setBusy(false);
      if (session !== s) return;
      ui.toast(String(err.message || err) + " Using the iPhone voice instead.");
      s.engine = "device";
      if (s.playing) speakDevice(index, 0);
      return;
    }
    ui.setBusy(false);
    if (session !== s || !s.playing || s.index !== index) return;
    const player = s.player;
    player.onended = () => {
      if (session === s && s.playing && s.index === index) playServer(index + 1);
    };
    player.onerror = () => {
      if (session === s && s.playing && s.index === index) playServer(index + 1);
    };
    // No word timings come back from the server, so the mark moves through the sentence in step
    // with the audio.
    player.ontimeupdate = () => {
      if (session !== s || s.index !== index || !player.duration) return;
      const frac = Math.min(player.currentTime / player.duration, 0.999);
      const g = piece.start + Math.floor(frac * (piece.end - piece.start));
      const w = wordAt(s.text, g);
      mark(w.start, w.end, piece.start, piece.end);
    };
    if (player.dataset.piece === String(index) && player.src === url && player.currentTime > 0) {
      // Resuming a paused piece.
    } else {
      player.src = url;
      player.dataset.piece = String(index);
    }
    player.playbackRate = settings.rate;
    try {
      await player.play();
      s.started = true;
    } catch (e) {
      if (session !== s) return;
      s.playing = false;
      render();
      ui.toast("Tap play to start reading.");
    }
  }

  // ---------------------------------------------------------------- on-page controls

  function zoomFactor() {
    const vv = window.visualViewport;
    const width = vv ? vv.width : window.innerWidth;
    const landscape = (screen.orientation && screen.orientation.type.startsWith("landscape")) ||
      Math.abs(window.orientation || 0) === 90;
    const device = landscape ? Math.max(screen.width, screen.height) : Math.min(screen.width, screen.height);
    const f = width / device;
    return f > 0.2 && f < 6 ? f : 1;
  }

  const ICONS = {
    speak: '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16 8.5a5 5 0 0 1 0 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M18.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l10.5-6.5z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><rect x="6.5" y="5.5" width="4" height="13" rx="1"/><rect x="13.5" y="5.5" width="4" height="13" rx="1"/></svg>',
    back: '<svg viewBox="0 0 24 24"><rect x="5" y="6" width="2.5" height="12" rx="1"/><path d="M19 6v12l-9-6z"/></svg>',
    next: '<svg viewBox="0 0 24 24"><rect x="16.5" y="6" width="2.5" height="12" rx="1"/><path d="M5 6v12l9-6z"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" fill="none"/></svg>'
  };

  const CSS_TEXT = `
    :host { all: initial; }
    * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
    .layer { position: absolute; inset: 0; pointer-events: none;
      font: 15px/1.35 -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; }
    button { font: inherit; border: 0; margin: 0; padding: 0; cursor: pointer; color: inherit;
      background: none; display: grid; place-items: center; touch-action: manipulation; }
    svg { width: 24px; height: 24px; fill: currentColor; }
    .fab { pointer-events: auto; position: absolute; right: 16px; bottom: 20px; width: 58px; height: 58px;
      border-radius: 50%; background: #0a84ff; color: #fff; box-shadow: 0 6px 20px rgba(0,0,0,.3);
      transform: scale(.6); opacity: 0; transition: transform .18s, opacity .18s; }
    .fab.on { transform: scale(1); opacity: 1; }
    .fab svg { width: 30px; height: 30px; }
    .panel { pointer-events: auto; position: absolute; left: 10px; right: 10px; bottom: 14px;
      border-radius: 20px; padding: 12px 12px 10px; color: #fff;
      background: rgba(28,28,30,.94); -webkit-backdrop-filter: blur(20px); backdrop-filter: blur(20px);
      box-shadow: 0 8px 30px rgba(0,0,0,.35); display: none; }
    .panel.on { display: block; }
    .caption { font-size: 15px; max-height: 2.7em; overflow: hidden; color: rgba(255,255,255,.7);
      margin: 0 4px 10px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
    .caption b { color: #fff; font-weight: 600; background: rgba(255,170,0,.45); border-radius: 4px; }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
    .row button { width: 46px; height: 46px; border-radius: 50%; }
    .row button:active { background: rgba(255,255,255,.12); }
    .row .main { width: 54px; height: 54px; background: #0a84ff; }
    .row .main svg { width: 28px; height: 28px; }
    .row .speed { width: auto; min-width: 54px; padding: 0 10px; border-radius: 23px; font-weight: 600;
      font-size: 15px; background: rgba(255,255,255,.12); }
    .busy .main { animation: pulse 1s ease-in-out infinite; }
    @keyframes pulse { 50% { opacity: .5; } }
    .toast { position: absolute; left: 16px; right: 16px; bottom: 150px; text-align: center;
      pointer-events: none; opacity: 0; transition: opacity .2s; }
    .toast span { display: inline-block; background: rgba(28,28,30,.94); color: #fff; padding: 9px 14px;
      border-radius: 14px; font-size: 14px; }
    .toast.on { opacity: 1; }
  `;

  const ui = (() => {
    let host, layer, fab, panel, caption, mainBtn, speedBtn, toastEl, toastTimer;

    function build() {
      if (host) return;
      host = document.createElement("div");
      host.id = "read-aloud-host";
      host.style.cssText =
        "position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;" +
        "transform-origin:0 0;margin:0;padding:0;border:0;";
      const root = host.attachShadow({ mode: "closed" });
      root.innerHTML = `<style>${CSS_TEXT}</style>
        <div class="layer">
          <button class="fab" aria-label="Read aloud">${ICONS.speak}</button>
          <div class="toast"><span></span></div>
          <div class="panel" role="region" aria-label="Read Aloud">
            <div class="caption"></div>
            <div class="row">
              <button class="speed" aria-label="Speed"></button>
              <button class="back" aria-label="Previous sentence">${ICONS.back}</button>
              <button class="main" aria-label="Play or pause"></button>
              <button class="next" aria-label="Next sentence">${ICONS.next}</button>
              <button class="close" aria-label="Stop">${ICONS.close}</button>
            </div>
          </div>
        </div>`;
      layer = root.querySelector(".layer");
      fab = root.querySelector(".fab");
      panel = root.querySelector(".panel");
      caption = root.querySelector(".caption");
      mainBtn = root.querySelector(".main");
      speedBtn = root.querySelector(".speed");
      toastEl = root.querySelector(".toast");

      // Keep the page's selection when a control is pressed.
      root.addEventListener("pointerdown", (e) => { if (e.target.closest("button")) e.preventDefault(); });
      root.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });

      fab.addEventListener("click", () => {
        const captured = currentSelection() || saved;
        if (!captured) return ui.toast("Highlight some text first.");
        hideFab();
        start(captured);
      });
      mainBtn.addEventListener("click", () => {
        if (!session) return;
        if (session.playing) pause();
        else {
          if (session.engine === "server" && !session.started) unlockedPlayer();
          play();
        }
      });
      root.querySelector(".back").addEventListener("click", () => skip(-1));
      root.querySelector(".next").addEventListener("click", () => skip(1));
      root.querySelector(".close").addEventListener("click", () => stop());
      speedBtn.addEventListener("click", () => {
        const i = SPEEDS.findIndex((v) => Math.abs(v - settings.rate) < 0.01);
        const rate = SPEEDS[(i + 1) % SPEEDS.length];
        settings.rate = rate;
        try { api.storage.local.set({ rate }); } catch (e) {}
        if (session) {
          if (session.engine === "server") session.player.playbackRate = rate;
          else if (session.playing) speakDevice(session.index, session.offset);
        }
        render();
      });

      (document.body || document.documentElement).appendChild(host);
      const vv = window.visualViewport;
      if (vv) {
        vv.addEventListener("resize", place);
        vv.addEventListener("scroll", place);
      }
      window.addEventListener("orientationchange", () => setTimeout(place, 300));
      place();
    }

    // Keep the controls the same size on screen however the page is zoomed.
    function place() {
      if (!host) return;
      const vv = window.visualViewport;
      const f = zoomFactor();
      const left = vv ? vv.offsetLeft : 0;
      const top = vv ? vv.offsetTop : 0;
      const w = vv ? vv.width : window.innerWidth;
      const h = vv ? vv.height : window.innerHeight;
      host.style.left = left + "px";
      host.style.top = top + "px";
      host.style.width = w / f + "px";
      host.style.height = h / f + "px";
      host.style.transform = `scale(${f})`;
    }

    function escape(t) {
      return t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
    }

    return {
      showFab() { build(); place(); fab.classList.add("on"); },
      hideFab() { if (fab) fab.classList.remove("on"); },
      showPanel() { build(); place(); panel.classList.add("on"); },
      hidePanel() { if (panel) { panel.classList.remove("on"); caption.textContent = ""; } },
      setCaption(sentence, wStart, wEnd) {
        if (!caption) return;
        if (wEnd > wStart) {
          caption.innerHTML = escape(sentence.slice(0, wStart)) + "<b>" + escape(sentence.slice(wStart, wEnd)) +
            "</b>" + escape(sentence.slice(wEnd));
        } else caption.textContent = sentence;
      },
      setBusy(on) { if (panel) panel.classList.toggle("busy", on); },
      toast(text) {
        build();
        toastEl.firstElementChild.textContent = text;
        toastEl.classList.add("on");
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toastEl.classList.remove("on"), 3200);
      },
      render() {
        if (!mainBtn) return;
        const playing = session && session.playing;
        mainBtn.innerHTML = playing ? ICONS.pause : ICONS.play;
        mainBtn.setAttribute("aria-label", playing ? "Pause" : "Play");
        speedBtn.textContent = (+settings.rate).toFixed(2).replace(/\.?0+$/, "") + "×";
      }
    };
  })();

  function render() { ui.render(); }
  function hideFab() { ui.hideFab(); }

  // ---------------------------------------------------------------- selection tracking

  function currentSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const anchor = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
    if (anchor && anchor.closest && anchor.closest("#read-aloud-host")) return null;
    return capture(sel.getRangeAt(0));
  }

  let selectionTimer = null;
  let hideTimer = null;
  document.addEventListener("selectionchange", () => {
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(() => {
      const sel = window.getSelection();
      const has = sel && !sel.isCollapsed && sel.toString().trim();
      if (has) {
        clearTimeout(hideTimer);
        const captured = currentSelection();
        if (!captured) return;
        saved = captured;
        if (settings.showButton && !session) ui.showFab();
      } else {
        // Wait a moment, so a tap on the button that clears the selection still lands.
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => ui.hideFab(), 600);
      }
    }, 150);
  });

  // ---------------------------------------------------------------- messages from the menu

  function readWholePage() {
    const root =
      document.querySelector("article") ||
      document.querySelector("main") ||
      document.querySelector("[role=main]") ||
      document.body;
    const range = document.createRange();
    range.selectNodeContents(root);
    return capture(range);
  }

  api.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return undefined;
    if (msg.type === "read") {
      const captured = currentSelection() || saved;
      if (!captured) return Promise.resolve({ ok: false, reason: "nothing-selected" });
      start(captured);
      return Promise.resolve({ ok: true });
    }
    if (msg.type === "readPage") {
      const captured = readWholePage();
      if (!captured) return Promise.resolve({ ok: false, reason: "no-text" });
      start(captured);
      return Promise.resolve({ ok: true });
    }
    if (msg.type === "stop") {
      stop();
      return Promise.resolve({ ok: true });
    }
    if (msg.type === "status") {
      return Promise.resolve({ ok: true, hasSelection: !!(currentSelection() || saved), reading: !!session });
    }
    return undefined;
  });

  window.addEventListener("pagehide", () => stop());
})();
