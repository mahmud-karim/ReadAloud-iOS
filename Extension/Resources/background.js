// Fetches audio from the optional speech server. Content scripts can't make cross-site requests on
// their own in Safari, so they ask here. The server speaks OpenAI's /audio/speech API (speaches,
// Kokoro-FastAPI and OpenAI itself all do).
const api = typeof browser !== "undefined" ? browser : chrome;

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

function speechURL(base) {
  let url = (base || "").trim().replace(/\/+$/, "");
  if (!url) throw new Error("No speech server address is set.");
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  if (!/\/audio\/speech$/.test(url)) url += "/audio/speech";
  return url;
}

async function synthesize(msg) {
  const headers = { "content-type": "application/json" };
  if (msg.key) headers.authorization = "Bearer " + msg.key;
  const res = await fetch(speechURL(msg.url), {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: msg.model || "kokoro",
      voice: msg.voice || "af_heart",
      input: msg.text,
      response_format: "mp3",
      speed: 1
    })
  });
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.text()).slice(0, 200); } catch (e) {}
    throw new Error("The speech server answered " + res.status + (detail ? ": " + detail : ""));
  }
  const type = res.headers.get("content-type") || "audio/mpeg";
  const buffer = await res.arrayBuffer();
  if (!buffer.byteLength) throw new Error("The speech server sent no audio.");
  return "data:" + type.split(";")[0] + ";base64," + toBase64(buffer);
}

api.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== "tts") return undefined;
  return synthesize(msg).then(
    (dataURL) => ({ ok: true, dataURL }),
    (err) => ({ ok: false, error: String((err && err.message) || err) })
  );
});
