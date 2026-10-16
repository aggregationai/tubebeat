"use strict";
/* TubeBeat — search, endless radio autoplay, background playback.
 *
 * Autoplay: the queue is kept topped up from /api/next (server-side radio + ranking).
 * Background playback: one persistent <audio> element + Media Session API, so the
 * OS keeps the audio session alive with the screen off and shows lock-screen / car controls.
 */
const API = (window.TUBEBEAT_API || new URLSearchParams(location.search).get("api") || "").replace(/\/$/, "");
const $ = (s) => document.querySelector(s);
const audio = $("#audio");


/* ---------- playback abstraction: server audio stream, or YouTube embed fallback ---------- */
const Y = { player: null, ready: false, pending: null, timer: null, box: null, unlocked: false, watch: 0, userPaused: false, lastPlayingAt: 0, visibleSince: Date.now() };
const inYT = () => S.mode === "yt";
const curTime = () => (inYT() ? (Y.ready && Y.player.getCurrentTime ? Y.player.getCurrentTime() : 0) : audio.currentTime) || 0;
const curDur = () => (inYT() ? (Y.ready && Y.player.getDuration ? Y.player.getDuration() : 0) : audio.duration) || 0;
const seekTo = (sec) => { if (inYT()) { Y.ready && Y.player.seekTo(sec, true); } else audio.currentTime = sec; };
const isPaused = () => (inYT() ? !(Y.ready && Y.player.getPlayerState && Y.player.getPlayerState() === 1) : audio.paused);
const pauseAll = () => { Y.userPaused = true; stopKeepAlive(); if (inYT()) { Y.ready && Y.player.pauseVideo(); } else audio.pause(); };
const resumeAll = () => { Y.userPaused = false; startKeepAlive(); if (inYT()) { Y.ready && Y.player.playVideo(); } else audio.play().catch(() => {}); };

// YouTube's embed needs the Referer header (without it: "Error 153"); make sure nothing strips it.
(function () { const m = document.createElement("meta"); m.name = "referrer"; m.content = "strict-origin-when-cross-origin"; document.head.appendChild(m); })();

function loadYTApi() {
  return new Promise((resolve, reject) => {
    if (window.YT && YT.Player) return resolve();
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prev && prev(); resolve(); };
    if (!document.getElementById("yt-api-script")) {
      const sc = document.createElement("script");
      sc.id = "yt-api-script"; sc.src = "https://www.youtube.com/iframe_api";
      sc.onerror = () => reject(new Error("YouTube player failed to load (blocked network?)"));
      document.head.appendChild(sc);
    }
  });
}

/* The player box is created here (no dependency on index.html/style.css). It stays rendered at all times,
   off-screen while the full player is closed, and is laid over the cover art while it is open. */
function ensureYTBox() {
  if (Y.box) return Y.box;
  const box = document.createElement("div");
  box.id = "tb-yt-box";
  box.style.cssText = "position:fixed;left:-9999px;top:0;width:320px;height:180px;z-index:31;background:#000;border-radius:14px;overflow:hidden";
  box.innerHTML = '<div id="tb-yt-player"></div>';
  document.body.appendChild(box);
  Y.box = box;
  const sc = document.querySelector(".sheet-scroll");
  if (sc) sc.addEventListener("scroll", layoutYT, { passive: true });
  window.addEventListener("resize", layoutYT);
  return box;
}
function layoutYT() {
  const box = Y.box; if (!box) return;
  const cover = $("#cover");
  if ($("#sheet").hidden) {
    box.style.cssText = "position:fixed;left:-9999px;top:0;width:320px;height:180px;z-index:31;background:#000;border-radius:14px;overflow:hidden";
    if (cover) cover.style.cssText = "";
    return;
  }
  const w = Math.min(window.innerWidth - 44, 420), h = Math.round((w * 9) / 16);
  if (cover) cover.style.cssText = `visibility:hidden;width:${w}px;height:${h}px;aspect-ratio:auto`;
  const r = cover.getBoundingClientRect();
  const visible = r.top > 56 && r.bottom < window.innerHeight;
  box.style.cssText = `position:fixed;left:${Math.round((window.innerWidth - w) / 2)}px;top:${Math.round(r.top)}px;width:${w}px;height:${h}px;z-index:31;background:#000;border-radius:14px;overflow:hidden;${visible ? "" : "opacity:0;pointer-events:none"}`;
}
const ytErrorText = { 152: "embed blocked (error 152)", 153: "embed config error 153 - page not sending a Referer", 2: "invalid video", 5: "player error", 100: "video removed/private", 101: "embedding disabled by the owner", 150: "embedding disabled by the owner" };

async function playViaYT(t) {
  startKeepAlive();   // first thing, while we are still inside the tap that started playback
  if (!inYT()) {
    S.mode = "yt";
    audio.pause(); audio.removeAttribute("src"); audio.load();
  }
  ensureYTBox();
  if (!(window.YT && YT.Player)) {
    try { await loadYTApi(); } catch (e) { toast(e.message, 6000); return; }
  }
  const watch = ++Y.watch;
  if (!Y.player) {
    Y.pending = t.videoId;
    Y.player = new YT.Player("tb-yt-player", {
      width: "100%", height: "100%", videoId: t.videoId,
      playerVars: { playsinline: 1, autoplay: 1, rel: 0, controls: 1, origin: location.origin },
      events: {
        onReady: () => { Y.ready = true; if (Y.pending) { Y.player.loadVideoById(Y.pending); Y.pending = null; } },
        onStateChange: onYTState, onError: onYTError,
      },
    });
    Y.timer = setInterval(tickYT, 500);
  } else if (Y.ready) Y.player.loadVideoById(t.videoId);
  else Y.pending = t.videoId;
  // iPhone/Safari only starts a video from a tap on the video itself. Until the first song has started,
  // show the player right away so one tap on its own ▶ unlocks everything (later songs then follow automatically).
  if (!Y.unlocked) {
    if ($("#sheet").hidden) openSheet();
    toast("Tap ▶ on the video once to start. After that, songs play on by themselves.", 9000);
    setTimeout(() => {
      if (watch !== Y.watch || Y.unlocked) return;
      const st = Y.ready && Y.player.getPlayerState ? Y.player.getPlayerState() : "not ready";
      toast(`Still waiting for the video. Tap the video's ▶. (player state: ${st}${Y.ready ? "" : " - YouTube player script may be blocked"})`, 9000);
    }, 5000);
  }
}
function onYTState(e) {
  if (e.data === 1) { Y.unlocked = true; Y.userPaused = false; Y.lastPlayingAt = Date.now(); startKeepAlive(); S.failStreak = 0; setPlayIcon(true); setState("playing"); }
  else if (e.data === 2) {
    // a pause while the page has been visible for a while = the user pressed pause on YouTube's own controls
    if (document.visibilityState === "visible" && Date.now() - Y.visibleSince > 3000) Y.userPaused = true;
    setPlayIcon(false); setState("paused");
  }
  else if (e.data === 0) { setState("none"); handleEnded(); }
}
function onYTError(e) {
  const why = ytErrorText[e && e.data] || `error ${e && e.data}`;
  onAudioError(`YouTube won't play this one here (${why})`);
}
function tickYT() {
  if (!inYT() || !Y.ready) return;
  if (Y.player.getPlayerState && Y.player.getPlayerState() === 1) Y.lastPlayingAt = Date.now();
  progress(curTime(), curDur());
}


/* ---------- storage (every access guarded: private mode / blocked storage) ---------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem("tb." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("tb." + k, JSON.stringify(v)); } catch { /* ignore */ } },
};

/* ---------- state ---------- */
const S = {
  queue: [], index: -1,
  autoplay: store.get("autoplay", true),
  repeat: false,
  lang: store.get("lang", "te"),
  loadingMore: false,
  failStreak: 0,
  moreFailed: 0,
  results: [], resultsTitle: "",
  key: store.get("key", ""),
  seeking: false,
  startedAt: 0,
  loadToken: 0,
  mode: "stream",   // "stream" = server audio (plays with screen locked); "yt" = YouTube player (screen must stay on)
};
// If the server recently failed to fetch audio (YouTube blocks many cloud hosts), go straight to the YouTube player.
// Open the site with ?stream=1 to clear that and try the audio stream again.
if (new URLSearchParams(location.search).get("stream")) store.set("streamBlockedUntil", 0);
if (store.get("streamBlockedUntil", 0) > Date.now()) S.mode = "yt";
// Taste profile: sent to the server so autoplay adapts to this listener.
const P = {
  history: store.get("history", []),            // played ids (newest last)
  recentTracks: store.get("recentTracks", []),  // for the Recently played list
  likes: store.get("likes", []),                // liked track objects
  likedArtists: store.get("likedArtists", {}),
  skipped: store.get("skipped", []),
  skippedArtists: store.get("skippedArtists", {}),
};
const saveProfile = () => {
  P.history = P.history.slice(-300); P.recentTracks = P.recentTracks.slice(0, 30); P.skipped = P.skipped.slice(-150);
  for (const k of Object.keys(P)) store.set(k === "recentTracks" ? "recentTracks" : k, P[k]);
};

/* ---------- Stay awake: the phone only pauses the YouTube player because the screen locks.
   Screen Wake Lock stops the auto-lock; a black "saver" overlay (OLED-friendly) hides the screen while
   the player keeps running underneath. Tap anywhere to bring the app back. Used only in YouTube-player mode. ---------- */
const WL = { lock: null, on: store.get("stayAwake", true), idle: null, saver: null, btn: null };
const IDLE_MS = window.TUBEBEAT_IDLE_MS || 15000;
async function acquireWL() {
  if (!WL.on || !inYT() || WL.lock || document.visibilityState !== "visible") return;
  if (!("wakeLock" in navigator)) { if (!WL.warned) { WL.warned = true; toast("This browser can't keep the screen on, so playback will stop when the phone locks."); } return; }
  try {
    WL.lock = await navigator.wakeLock.request("screen");
    WL.lock.addEventListener("release", () => { WL.lock = null; });
  } catch (e) { WL.lock = null; }
}
function releaseWL() { try { WL.lock && WL.lock.release(); } catch { /* ignore */ } WL.lock = null; }
function hideSaver() { if (WL.saver) { WL.saver.hidden = true; WL.saver.style.display = "none"; } }
function showSaver() {
  if (!WL.on || !inYT() || isPaused() || !WL.lock) return;   // only dim while actually playing and holding the wake lock
  if (!WL.saver) {
    const d = document.createElement("div");
    d.id = "tb-saver";
    d.style.cssText = "position:fixed;inset:0;z-index:60;background:#000;color:#555;display:none;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:24px;font:14px Inter,system-ui,sans-serif;touch-action:manipulation";
    d.innerHTML = '<div id="tb-saver-title" style="color:#777;font-size:16px;margin-bottom:6px"></div><div id="tb-saver-sub"></div><div style="margin-top:28px;font-size:12px;color:#444">Screen is kept awake while music plays. Tap anywhere to wake.</div>';
    d.addEventListener("pointerdown", (e) => { e.stopPropagation(); e.preventDefault(); hideSaver(); armIdle(); });
    document.body.appendChild(d);
    WL.saver = d;
  }
  const t = cur();
  $("#tb-saver-title").textContent = t ? t.title : "";
  $("#tb-saver-sub").textContent = t ? t.artist : "";
  WL.saver.hidden = false; WL.saver.style.display = "flex";
}
function armIdle() {
  clearTimeout(WL.idle);
  if (WL.on && inYT() && !isPaused()) WL.idle = setTimeout(showSaver, IDLE_MS);
}
function onPlayingChanged(playing) {
  if (playing && inYT()) { acquireWL(); armIdle(); }
  else { clearTimeout(WL.idle); hideSaver(); if (!playing) releaseWL(); }
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && !isPaused()) { acquireWL(); armIdle(); } });
["pointerdown", "keydown", "touchstart"].forEach((ev) => document.addEventListener(ev, () => { if (!isPaused()) acquireWL(); if (!WL.saver || WL.saver.hidden) armIdle(); }, { capture: true, passive: true }));
function bindStayAwakeButton() {
  const top = document.querySelector(".sheet-top"); if (!top || WL.btn) return;
  const b = document.createElement("button");
  b.className = "icon"; b.id = "stay-awake"; b.textContent = "☀"; b.title = "Keep screen on while playing";
  b.setAttribute("aria-label", "Keep screen on while playing"); b.setAttribute("aria-pressed", String(WL.on));
  b.addEventListener("click", () => {
    WL.on = !WL.on; store.set("stayAwake", WL.on); b.setAttribute("aria-pressed", String(WL.on));
    if (WL.on) { acquireWL(); armIdle(); toast("Screen stays on while music plays (dims to black after a few seconds)"); }
    else { releaseWL(); hideSaver(); toast("Screen can lock again. The YouTube player pauses when it does."); }
  });
  top.insertBefore(b, document.querySelector("#sheet-share")); WL.btn = b;
}


/* ---------- helpers ---------- */
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (s) => { s = Math.max(0, Math.floor(s || 0)); const m = Math.floor(s / 60); return `${m}:${String(s % 60).padStart(2, "0")}`; };
const cur = () => S.queue[S.index];
let toastTimer;
function toast(msg, ms = 3200) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), ms); }

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (S.key) headers["x-access-key"] = S.key;
  if (opts.body) headers["content-type"] = "application/json";
  const r = await fetch(API + path, { ...opts, headers });
  if (r.status === 401) { askKey(); throw new Error("access key required"); }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
function askKey() {
  const k = prompt("This server needs an access key:");
  if (k) { S.key = k.trim(); store.set("key", S.key); location.reload(); }
}
const streamUrl = (id) => `${API}/api/stream/${encodeURIComponent(id)}${S.key ? `?key=${encodeURIComponent(S.key)}` : ""}`;

/* ---------- track list rendering ---------- */
function rowHtml(t, i, { remove = false } = {}) {
  const playing = cur() && cur().videoId === t.videoId;
  return `<li class="track${playing ? " current" : ""}" data-i="${i}" data-id="${esc(t.videoId)}" tabindex="0" role="button" aria-label="Play ${esc(t.title)} by ${esc(t.artist)}">
    <img loading="lazy" src="${esc(t.thumbnail)}" alt="" onerror="this.src='https://i.ytimg.com/vi/${esc(t.videoId)}/hqdefault.jpg';this.onerror=null">
    <div class="t-main"><div class="t-title">${playing ? '<span class="eq"><i></i><i></i><i></i></span>' : ""}${esc(t.title)}</div>
    <div class="t-sub">${esc(t.artist)}${t.album ? " · " + esc(t.album) : ""}</div></div>
    <span class="t-dur">${esc(t.durationText || "")}</span>
    <button class="t-btn" data-act="${remove ? "remove" : "queue"}" aria-label="${remove ? "Remove from queue" : "Add to queue"}">${remove ? "✕" : "＋"}</button>
  </li>`;
}
function bindList(ul, tracks, onPlay, opts = {}) {
  ul.innerHTML = tracks.map((t, i) => rowHtml(t, i, opts)).join("");
  const handle = (li, ev) => {
    const t = tracks[Number(li.dataset.i)];
    const btn = ev.target.closest?.(".t-btn");
    if (btn) { ev.stopPropagation(); (opts.onAction || addToQueue)(t, Number(li.dataset.i), btn.dataset.act); return; }
    onPlay(t, Number(li.dataset.i));
  };
  ul.querySelectorAll(".track").forEach((li) => {
    li.addEventListener("click", (e) => handle(li, e));
    li.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handle(li, e); } });
  });
}

/* ---------- home / search ---------- */
function showView(name) { $("#home").hidden = name !== "home"; $("#results").hidden = name !== "results"; window.scrollTo({ top: 0 }); }

async function loadChips() {
  let discover = {};
  try { discover = (await (await fetch(API + "/api/config")).json()).discover || {}; } catch { /* offline */ }
  const list = discover[S.lang] || discover.any || ["Top hits"];
  $("#chips").innerHTML = list.map((q) => `<button class="chip" data-q="${esc(q)}">${esc(q)}</button>`).join("");
  $("#chips").querySelectorAll(".chip").forEach((b) => b.addEventListener("click", () => runSearch(b.dataset.q)));
}

function renderHome() {
  const recent = P.recentTracks;
  $("#recent-block").hidden = !recent.length;
  if (recent.length) bindList($("#recent-list"), recent.slice(0, 8), (t) => startRadio(t));
  $("#liked-block").hidden = !P.likes.length;
  if (P.likes.length) bindList($("#liked-list"), P.likes.slice(0, 8), (t) => startRadio(t));
}

async function runSearch(q) {
  q = (q || "").trim();
  if (!q) return;
  $("#q").value = q; hideSuggest();
  $("#results-title").textContent = `Results for “${q}”`;
  showView("results");
  $("#results-list").innerHTML = Array.from({ length: 7 }, () => '<li class="skeleton"></li>').join("");
  try {
    const data = await api(`/api/search?q=${encodeURIComponent(q)}&limit=25`);
    S.results = data.results;
    if (!data.results.length) { $("#results-list").innerHTML = '<li class="empty">No songs found. Try another spelling or an artist name.</li>'; return; }
    bindList($("#results-list"), S.results, (t) => startRadio(t));
  } catch (e) {
    console.error(e);
    $("#results-list").innerHTML = '<li class="empty">Search failed — the server could not reach YouTube Music.<br><button class="pill primary" id="retry">Retry</button></li>';
    $("#retry")?.addEventListener("click", () => runSearch(q));
  }
}

let suggestTimer;
function hideSuggest() { const s = $("#suggest"); s.hidden = true; s.innerHTML = ""; }
$("#q").addEventListener("input", (e) => {
  clearTimeout(suggestTimer);
  const v = e.target.value.trim();
  if (v.length < 2) return hideSuggest();
  suggestTimer = setTimeout(async () => {
    try {
      const { suggestions } = await api(`/api/suggest?q=${encodeURIComponent(v)}`);
      if ($("#q").value.trim() !== v || !suggestions.length) return hideSuggest();
      const s = $("#suggest");
      s.innerHTML = suggestions.map((x) => `<li><button type="button" data-q="${esc(x)}">${esc(x)}</button></li>`).join("");
      s.hidden = false;
      s.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => runSearch(b.dataset.q)));
    } catch { hideSuggest(); }
  }, 220);
});
document.addEventListener("click", (e) => { if (!e.target.closest(".search")) hideSuggest(); });
$("#search-form").addEventListener("submit", (e) => { e.preventDefault(); runSearch($("#q").value); });
$("#brand").addEventListener("click", (e) => { e.preventDefault(); renderHome(); showView("home"); });

/* ---------- queue & autoplay engine ---------- */
function startRadio(track) {
  // YouTube Music behaviour: tapping a song = play it, then the radio takes over.
  S.queue = [track]; S.index = -1; S.moreFailed = 0;
  playIndex(0);
}
function playList(tracks, shuffle = false) {
  if (!tracks.length) return;
  const list = shuffle ? [...tracks].sort(() => Math.random() - 0.5) : [...tracks];
  S.queue = list; S.index = -1; S.moreFailed = 0;
  playIndex(0);
}
function addToQueue(track) {
  if (!S.queue.length) return startRadio(track);
  if (S.queue.some((t, i) => i > S.index && t.videoId === track.videoId)) return toast("Already in your queue");
  S.queue.push(track);
  renderQueue();
  toast(`Added “${track.title}”`);
}

function recordSkip(t) {
  if (!t) return;
  P.skipped.push(t.videoId);
  for (const a of t.artists || []) { const k = a.toLowerCase(); P.skippedArtists[k] = Math.min(4, (P.skippedArtists[k] || 0) + 1); }
}
function recordLiked(t, w) {
  for (const a of t.artists || []) { const k = a.toLowerCase(); P.likedArtists[k] = Math.min(8, (P.likedArtists[k] || 0) + w); P.skippedArtists[k] = Math.max(0, (P.skippedArtists[k] || 0) - 1); }
}
function recordFinished(t) { if (t) { recordLiked(t, 0.5); saveProfile(); } }

async function playIndex(i, { manualSkip = false } = {}) {
  if (i < 0 || i >= S.queue.length) return;
  const prev = cur();
  if (manualSkip && prev && curTime() < 30 && curDur() > 60) recordSkip(prev);
  const token = ++S.loadToken;
  S.index = i;
  const t = cur();
  P.history = P.history.filter((id) => id !== t.videoId); P.history.push(t.videoId);
  P.recentTracks = [t, ...P.recentTracks.filter((x) => x.videoId !== t.videoId)];
  saveProfile();
  S.startedAt = Date.now();
  updateNowPlaying();
  if (inYT()) { playViaYT(t); ensureQueue(); return; }
  audio.src = streamUrl(t.videoId);
  audio.load();
  try { await audio.play(); }
  catch (e) {
    if (token !== S.loadToken) return;
    if (e.name === "NotAllowedError") { toast("Tap play to start"); setPlayIcon(false); }
    // other failures (bad stream) also raise the audio "error" event, which handles the skip
  }
  ensureQueue();
  prewarmNext();
}

function next({ manual = false } = {}) {
  if (S.index + 1 < S.queue.length) return playIndex(S.index + 1, { manualSkip: manual });
  if (!S.autoplay) { pauseAll(); toast("End of queue. Turn on ∞ autoplay to keep going."); return; }
  return fetchMore().then(() => {
    if (S.index + 1 < S.queue.length) playIndex(S.index + 1, { manualSkip: manual });
    else toast("Couldn't find more songs right now");
  });
}
function prev() {
  if (curTime() > 4 || S.index <= 0) { seekTo(0); return; }
  playIndex(S.index - 1);
}

function ensureQueue() {
  if (S.autoplay && S.queue.length - S.index - 1 <= 4) fetchMore();
}
function prewarmNext() { /* iframe-only: nothing to prepare on the server */ }

async function fetchMore() {
  if (S.loadingMore || !S.queue.length) return;
  S.loadingMore = true; $("#radio-hint").textContent = "Finding more songs…";
  const seed = S.queue[S.queue.length - 1];  // the radio evolves from the end of the queue
  const played = P.recentTracks.slice(0, 5);
  try {
    const body = {
      seed: seed.videoId, language: S.lang, limit: 12,
      history: P.history, recent: P.history.slice(-10), queued: S.queue.map((t) => t.videoId),
      skipped: P.skipped, likedArtists: P.likedArtists, skippedArtists: P.skippedArtists,
      recentArtists: played.map((t) => (t.artists || [])[0] || "").reverse(),
      seedTitle: seed.title, seedArtist: seed.artist,
    };
    const { tracks } = await api("/api/next", { method: "POST", body: JSON.stringify(body) });
    const have = new Set(S.queue.map((t) => t.videoId));
    const fresh = tracks.filter((t) => !have.has(t.videoId));
    S.queue.push(...fresh);
    S.moreFailed = fresh.length ? 0 : S.moreFailed + 1;
    $("#radio-hint").textContent = "Radio keeps adding songs";
    renderQueue();
    if (!fresh.length && S.moreFailed < 3 && S.autoplay) { S.loadingMore = false; return fetchMore(); }
  } catch (e) {
    console.error(e); S.moreFailed++;
    $("#radio-hint").textContent = "Couldn't load more — will retry";
  } finally { S.loadingMore = false; }
}

/* ---------- audio events ---------- */
function handleEnded() {
  const t = cur();
  if (t && !t._counted) { t._counted = true; recordFinished(t); }
  S.failStreak = 0;
  if (S.repeat) { seekTo(0); resumeAll(); return; }
  next();
}
audio.addEventListener("ended", () => { if (!inYT()) handleEnded(); });
audio.addEventListener("play", () => { if (!inYT()) Y.userPaused = false; setPlayIcon(true); setState("playing"); });
audio.addEventListener("pause", () => {
  if (!inYT() && !audio.ended && document.visibilityState === "visible" && Date.now() - Y.visibleSince > 3000) Y.userPaused = true;
  setPlayIcon(false); if (!audio.ended) setState("paused");
});
audio.addEventListener("playing", () => { S.failStreak = 0; });
audio.addEventListener("loadedmetadata", () => { $("#t-dur").textContent = fmt(audio.duration); updatePosition(); });
audio.addEventListener("durationchange", updatePosition);
audio.addEventListener("seeked", updatePosition);
let lastPos = 0;
function progress(c, d) {
  if (d && isFinite(d)) {
    const pct = (c / d) * 100;
    $("#mini-bar").style.width = pct + "%";
    $("#t-dur").textContent = fmt(d);
    if (!S.seeking) { $("#seek").value = (c / d) * 1000; $("#seek").style.setProperty("--p", pct + "%"); $("#t-cur").textContent = fmt(c); }
    // Count a track as "listened to" once most of it has played (positive signal even if user skips after)
    const t = cur();
    if (t && !t._counted && c / d > 0.7) { t._counted = true; recordFinished(t); }
  }
  if (Date.now() - lastPos > 4000) { lastPos = Date.now(); updatePosition(); }
}
audio.addEventListener("timeupdate", () => { if (!inYT()) { Y.lastPlayingAt = Date.now(); progress(audio.currentTime, audio.duration); } });
let lastErrAt = 0;
function onStreamFailed() {
  const t = cur();
  if (!t || inYT()) return onAudioError();
  store.set("streamBlockedUntil", Date.now() + 6 * 3600 * 1000);   // remember for 6 hours
  toast("This server can't fetch audio (YouTube blocks it), so the YouTube player is used. It stops when the screen locks.", 7000);
  playViaYT(t);   // server couldn't fetch audio (often a blocked host IP): use YouTube's own player
}
function onAudioError(reason) {
  if (Date.now() - lastErrAt < 1500) return;  // one skip per failure
  lastErrAt = Date.now();
  S.failStreak++;
  const t = cur();
  if (S.failStreak <= 3) {
    toast(reason ? `${reason} — skipping` : `Couldn't play “${t?.title || "song"}” — skipping`);
    P.skipped.push(t?.videoId);
    setTimeout(() => next(), 400);
  } else { setPlayIcon(false); toast(reason ? `${reason}. Stopped after 4 failures in a row.` : "Playback keeps failing — check the server / YouTube access.", 8000); }
}
audio.addEventListener("error", () => { if (audio.src && audio.error && !inYT()) onStreamFailed(); });
audio.addEventListener("stalled", () => { /* network hiccup: browser retries by itself */ });

/* ---------- UI wiring ---------- */
function setPlayIcon(playing) {
  const icon = playing ? "⏸" : "▶";
  $("#mini-play").textContent = icon; $("#play").textContent = icon;
  document.body.classList.toggle("paused", !playing);
  onPlayingChanged(playing);
}
function togglePlay() {
  if (!cur()) return;
  if (inYT() && !Y.unlocked) { openSheet(); toast("Tap ▶ on the video to start."); return; }
  isPaused() ? resumeAll() : pauseAll();
}
$("#mini-play").addEventListener("click", togglePlay);
$("#play").addEventListener("click", togglePlay);
$("#mini-next").addEventListener("click", () => next({ manual: true }));
$("#next").addEventListener("click", () => next({ manual: true }));
$("#mini-prev").addEventListener("click", prev);
$("#prev").addEventListener("click", prev);
$("#mini-open").addEventListener("click", openSheet);
$("#sheet-close").addEventListener("click", closeSheet);
$("#sheet-share").addEventListener("click", () => { const t = cur(); if (t) window.open(`https://music.youtube.com/watch?v=${t.videoId}`, "_blank", "noopener"); });
$("#play-all").addEventListener("click", () => playList(S.results));
$("#shuffle-all").addEventListener("click", () => playList(S.results, true));
$("#play-liked").addEventListener("click", () => playList(P.likes));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#sheet").hidden) closeSheet();
  if (e.code === "Space" && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) && cur()) { e.preventDefault(); togglePlay(); }
});

const seek = $("#seek");
seek.addEventListener("input", () => { S.seeking = true; const d = curDur(); $("#t-cur").textContent = fmt((seek.value / 1000) * d); seek.style.setProperty("--p", seek.value / 10 + "%"); });
seek.addEventListener("change", () => { if (curDur()) seekTo((seek.value / 1000) * curDur()); S.seeking = false; });

function toggle(btn, key, on) { btn.setAttribute("aria-pressed", String(on)); }
$("#autoplay").addEventListener("click", () => {
  S.autoplay = !S.autoplay; store.set("autoplay", S.autoplay); toggle($("#autoplay"), "autoplay", S.autoplay);
  toast(S.autoplay ? "Autoplay on — radio keeps going" : "Autoplay off"); if (S.autoplay) ensureQueue();
});
$("#repeat").addEventListener("click", () => { S.repeat = !S.repeat; toggle($("#repeat"), "repeat", S.repeat); toast(S.repeat ? "Repeating this song" : "Repeat off"); });
$("#like").addEventListener("click", () => {
  const t = cur(); if (!t) return;
  const i = P.likes.findIndex((x) => x.videoId === t.videoId);
  if (i >= 0) P.likes.splice(i, 1); else { const { _counted, ...clean } = t; P.likes.unshift(clean); recordLiked(t, 2); toast("Liked — your radio will lean this way"); }
  saveProfile(); updateLike(); renderHome();
});
function updateLike() {
  const t = cur(); const liked = !!t && P.likes.some((x) => x.videoId === t.videoId);
  const b = $("#like"); b.setAttribute("aria-pressed", String(liked)); b.textContent = liked ? "♥" : "♡";
}
$("#lang").value = S.lang;
$("#lang").addEventListener("change", (e) => {
  S.lang = e.target.value; store.set("lang", S.lang); loadChips();
  // drop the not-yet-played auto queue so the new language takes effect right away
  if (S.queue.length) { S.queue = S.queue.slice(0, S.index + 1); renderQueue(); ensureQueue(); }
  toast(`Autoplay language: ${e.target.selectedOptions[0].text}`);
});

function renderQueue() {
  const upcoming = S.queue.slice(S.index + 1);
  const ul = $("#queue-list");
  if (!upcoming.length) { ul.innerHTML = '<li class="empty">Finding songs for you…</li>'; return; }
  bindList(ul, upcoming, (t, i) => playIndex(S.index + 1 + i), {
    remove: true,
    onAction: (t, i) => { S.queue.splice(S.index + 1 + i, 1); renderQueue(); ensureQueue(); },
  });
}

function updateNowPlaying() {
  const t = cur(); if (!t) return;
  $("#mini").hidden = false;
  document.body.style.setProperty("--mini-shown", "1");
  $("#mini-art").src = t.thumbnail; $("#mini-title").textContent = t.title; $("#mini-artist").textContent = t.artist;
  $("#cover").src = t.thumbnail; $("#now-title").textContent = t.title; $("#now-artist").textContent = t.artist;
  $("#sheet-bg").style.backgroundImage = `url("${t.thumbnail.replace(/"/g, "")}")`;
  $("#t-cur").textContent = "0:00"; $("#t-dur").textContent = t.durationText || "0:00";
  $("#seek").value = 0; $("#seek").style.setProperty("--p", "0%"); $("#mini-bar").style.width = "0";
  document.title = `${t.title} · ${t.artist}`;
  updateLike(); renderQueue();
  document.querySelectorAll("#results-list .track, #recent-list .track, #liked-list .track").forEach((li) => li.classList.toggle("current", li.dataset.id === t.videoId));
  setMediaSession(t);
}
function openSheet() { if (!cur()) return; $("#sheet").hidden = false; document.body.style.overflow = "hidden"; $("#sheet-close").focus(); layoutYT(); setTimeout(layoutYT, 300); }
function closeSheet() { $("#sheet").hidden = true; document.body.style.overflow = ""; $("#mini-open").focus(); layoutYT(); }

/* ---------- Media Session: lock screen, notification shade, Bluetooth / CarPlay / Android Auto ---------- */
function setState(s) { if ("mediaSession" in navigator) navigator.mediaSession.playbackState = s; }
function setMediaSession(t) {
  if (!("mediaSession" in navigator)) return;
  const art = t.thumbnail;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.title, artist: t.artist, album: t.album || "TubeBeat Radio",
    artwork: ["96x96", "192x192", "256x256", "384x384", "512x512"].map((sizes) => ({ src: art, sizes, type: "image/jpeg" })),
  });
}
function updatePosition() {
  if (!("mediaSession" in navigator) || !navigator.mediaSession.setPositionState) return;
  const d = curDur();
  if (!d || !isFinite(d)) return;
  try { navigator.mediaSession.setPositionState({ duration: d, playbackRate: inYT() ? 1 : audio.playbackRate || 1, position: Math.min(curTime(), d) }); } catch { /* ignore */ }
}
(function bindMediaKeys() {
  if (!("mediaSession" in navigator)) return;
  const set = (name, fn) => { try { navigator.mediaSession.setActionHandler(name, fn); } catch { /* unsupported action */ } };
  // These go through the playback layer, so they control whichever player is active (audio stream or YouTube iframe).
  set("play", () => resumeAll());
  set("pause", () => pauseAll());
  set("previoustrack", () => prev());
  set("nexttrack", () => next({ manual: true }));
  set("seekbackward", (d) => seekTo(Math.max(0, curTime() - (d.seekOffset || 10))));
  set("seekforward", (d) => { const dur = curDur(), pos = curTime() + (d.seekOffset || 10); seekTo(dur ? Math.min(dur, pos) : pos); });
  set("seekto", (d) => { if (Number.isFinite(d.seekTime)) { seekTo(d.seekTime); updatePosition(); } });
  set("stop", () => { pauseAll(); seekTo(0); });
})();



/* ---------- Background layer (experimental) ----------
   A silent looping <audio> runs underneath the YouTube iframe. It keeps the page's audio session alive, makes this page
   the "Now Playing" app on the lock screen / car display, and lets the page keep running while the screen is locked so it
   can nudge the iframe to play again. Whether the YouTube player itself agrees to keep playing is up to the phone and YouTube. */
const KA = { el: null, on: store.get("bgLayer", true), timer: null, btn: null };
function silentWavUrl() {
  const sr = 8000, n = sr, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o, str) => [...str].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVEfmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, n * 2, true);
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}
function startKeepAlive() {
  if (!KA.on || !inYT()) return;
  if (!KA.el) { const a = new Audio(silentWavUrl()); a.loop = true; a.setAttribute("playsinline", ""); KA.el = a; }
  if (KA.el.paused) KA.el.play().catch(() => { /* needs a tap first; retried on the next play */ });
  if (!KA.timer) KA.timer = setInterval(keepAliveTick, 1000);
}
function stopKeepAlive() { if (KA.el) KA.el.pause(); }
function keepAliveTick() {
  // While the page is in the background and the phone paused our video, keep asking the player to play.
  if (document.visibilityState === "hidden" && REC.wasPlaying && !Y.userPaused && inYT() && Y.ready && isPaused()) {
    try { Y.player.playVideo(); } catch { /* ignore */ }
  }
}
function bindBgLayerButton() {
  const top = document.querySelector(".sheet-top"); if (!top || KA.btn) return;
  const b = document.createElement("button");
  b.className = "icon"; b.id = "bg-layer"; b.textContent = "♪"; b.title = "Background layer (experimental)";
  b.setAttribute("aria-label", "Background layer, experimental"); b.setAttribute("aria-pressed", String(KA.on));
  b.addEventListener("click", () => {
    KA.on = !KA.on; store.set("bgLayer", KA.on); b.setAttribute("aria-pressed", String(KA.on));
    if (KA.on) { startKeepAlive(); toast("Background layer on (experimental): helps keep playing when you leave the page"); }
    else { stopKeepAlive(); toast("Background layer off"); }
  });
  top.insertBefore(b, document.querySelector("#stay-awake") || document.querySelector("#sheet-share")); KA.btn = b;
}

/* ---------- Recover after the phone paused us (screen lock / leaving the browser) ----------
   The OS decides to pause web video when the screen locks; a page can't prevent that. What we can do is notice it
   and fix it the moment the page is visible again: resume where it stopped, or move on if the song ended meanwhile. */
const REC = { wasPlaying: false, pos: 0, vid: null };
function onHidden() {
  REC.wasPlaying = !Y.userPaused && !!cur() && Date.now() - Y.lastPlayingAt < 2500;
  REC.pos = curTime(); REC.vid = cur() ? cur().videoId : null;
}
async function recoverPlayback() {
  const t = cur();
  if (!REC.wasPlaying || !t) return;
  REC.wasPlaying = false;
  if (inYT()) {
    if (!Y.ready) return;
    const st = Y.player.getPlayerState();
    if (st === 1) return;                                   // still playing: nothing to do
    if (st === 0) { handleEnded(); return; }                // finished while we were away: next song
    const loaded = Y.player.getVideoData ? Y.player.getVideoData().video_id : t.videoId;
    if (loaded && loaded !== t.videoId) Y.player.loadVideoById({ videoId: t.videoId, startSeconds: Math.max(0, REC.pos - 1) });
    else Y.player.playVideo();
    setTimeout(() => {                                      // phones may insist on a tap: bring the video into view
      if (isPaused() && !Y.userPaused) { if ($("#sheet").hidden) openSheet(); toast("Tap ▶ on the video to resume.", 6000); }
    }, 1500);
  } else if (audio.paused && !audio.ended) {
    audio.play().catch(() => toast("Tap ▶ to resume."));
  }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") onHidden();
  else { Y.visibleSince = Date.now(); recoverPlayback(); }
});
window.addEventListener("pagehide", onHidden);
window.addEventListener("pageshow", () => { Y.visibleSince = Date.now(); recoverPlayback(); });
window.addEventListener("focus", () => { if (REC.wasPlaying) recoverPlayback(); });

/* ---------- boot ---------- */
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
bindStayAwakeButton();
bindBgLayerButton();
loadYTApi().catch(() => {});   // preload so the first tap can start the player immediately
toggle($("#autoplay"), "autoplay", S.autoplay);
loadChips();
renderHome();
const initialQ = new URLSearchParams(location.search).get("q");
if (initialQ) runSearch(initialQ);
