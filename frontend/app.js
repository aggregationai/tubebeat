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
const Y = { player: null, ready: false, pending: null, timer: null };
const inYT = () => S.mode === "yt";
const curTime = () => (inYT() ? (Y.ready && Y.player.getCurrentTime ? Y.player.getCurrentTime() : 0) : audio.currentTime) || 0;
const curDur = () => (inYT() ? (Y.ready && Y.player.getDuration ? Y.player.getDuration() : 0) : audio.duration) || 0;
const seekTo = (sec) => { if (inYT()) { Y.ready && Y.player.seekTo(sec, true); } else audio.currentTime = sec; };
const isPaused = () => (inYT() ? !(Y.ready && Y.player.getPlayerState && Y.player.getPlayerState() === 1) : audio.paused);
const pauseAll = () => { if (inYT()) { Y.ready && Y.player.pauseVideo(); } else audio.pause(); };
const resumeAll = () => { if (inYT()) { Y.ready && Y.player.playVideo(); } else audio.play().catch(() => {}); };

function loadYTApi() {
  return new Promise((resolve, reject) => {
    if (window.YT && YT.Player) return resolve();
    window.onYouTubeIframeAPIReady = () => resolve();
    const sc = document.createElement("script");
    sc.src = "https://www.youtube.com/iframe_api"; sc.onerror = () => reject(new Error("YouTube player failed to load"));
    document.head.appendChild(sc);
  });
}
async function playViaYT(t) {
  if (!inYT()) {
    S.mode = "yt";
    audio.pause(); audio.removeAttribute("src"); audio.load();
    document.body.classList.add("yt-mode");
    toast("Using the YouTube player for this server (keeps playing while the screen is on)", 5000);
  }
  try { await loadYTApi(); } catch (e) { toast(e.message); return; }
  if (!Y.player) {
    Y.pending = t.videoId;
    Y.player = new YT.Player("yt-player", {
      width: "100%", height: "100%", videoId: t.videoId,
      playerVars: { playsinline: 1, autoplay: 1, rel: 0, origin: location.origin },
      events: {
        onReady: () => { Y.ready = true; if (Y.pending) { Y.player.loadVideoById(Y.pending); Y.pending = null; } },
        onStateChange: onYTState, onError: onYTError,
      },
    });
    Y.timer = setInterval(tickYT, 500);
  } else if (Y.ready) Y.player.loadVideoById(t.videoId);
  else Y.pending = t.videoId;
}
function onYTState(e) {
  if (e.data === 1) { S.failStreak = 0; setPlayIcon(true); setState("playing"); }
  else if (e.data === 2) { setPlayIcon(false); setState("paused"); }
  else if (e.data === 0) handleEnded();
}
function onYTError() { onAudioError(); }   // 100/101/150: removed or not embeddable -> skip
function tickYT() {
  if (!inYT() || !Y.ready) return;
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
  mode: "yt",       // iframe-only: YouTube plays the video directly in the browser; the server only does search + "what's next"
};
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
audio.addEventListener("play", () => { setPlayIcon(true); setState("playing"); });
audio.addEventListener("pause", () => { setPlayIcon(false); if (!audio.ended) setState("paused"); });
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
audio.addEventListener("timeupdate", () => { if (!inYT()) progress(audio.currentTime, audio.duration); });
let lastErrAt = 0;
function onStreamFailed() {
  const t = cur();
  if (!t || inYT()) return onAudioError();
  playViaYT(t);   // server couldn't fetch audio (often a blocked host IP): use YouTube's own player
}
function onAudioError() {
  if (Date.now() - lastErrAt < 1500) return;  // one skip per failure
  lastErrAt = Date.now();
  S.failStreak++;
  const t = cur();
  if (S.failStreak <= 3) {
    toast(`Couldn't play “${t?.title || "song"}” — skipping`);
    P.skipped.push(t?.videoId);
    setTimeout(() => next(), 400);
  } else { setPlayIcon(false); toast("Playback keeps failing — check the server / YouTube access."); }
}
audio.addEventListener("error", () => { if (audio.src && audio.error && !inYT()) onStreamFailed(); });
audio.addEventListener("stalled", () => { /* network hiccup: browser retries by itself */ });

/* ---------- UI wiring ---------- */
function setPlayIcon(playing) {
  const icon = playing ? "⏸" : "▶";
  $("#mini-play").textContent = icon; $("#play").textContent = icon;
  document.body.classList.toggle("paused", !playing);
}
function togglePlay() { if (!cur()) return; isPaused() ? resumeAll() : pauseAll(); }
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
function openSheet() { if (!cur()) return; $("#sheet").hidden = false; document.body.style.overflow = "hidden"; $("#sheet-close").focus(); }
function closeSheet() { $("#sheet").hidden = true; document.body.style.overflow = ""; $("#mini-open").focus(); }

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
  if (inYT()) return;
  const d = audio.duration;
  if (!d || !isFinite(d)) return;
  try { navigator.mediaSession.setPositionState({ duration: d, playbackRate: audio.playbackRate || 1, position: Math.min(audio.currentTime, d) }); } catch { /* ignore */ }
}
(function bindMediaKeys() {
  if (!("mediaSession" in navigator)) return;
  const set = (name, fn) => { try { navigator.mediaSession.setActionHandler(name, fn); } catch { /* unsupported action */ } };
  set("play", () => audio.play().catch(() => {}));
  set("pause", () => audio.pause());
  set("previoustrack", () => prev());
  set("nexttrack", () => next({ manual: true }));
  set("seekbackward", (d) => { audio.currentTime = Math.max(0, audio.currentTime - (d.seekOffset || 10)); });
  set("seekforward", (d) => { audio.currentTime = Math.min(audio.duration || 1e9, audio.currentTime + (d.seekOffset || 10)); });
  set("seekto", (d) => { if (d.fastSeek && "fastSeek" in audio) audio.fastSeek(d.seekTime); else audio.currentTime = d.seekTime; updatePosition(); });
  set("stop", () => { audio.pause(); audio.currentTime = 0; });
})();

/* ---------- boot ---------- */
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
document.body.classList.add("yt-mode");
toggle($("#autoplay"), "autoplay", S.autoplay);
loadChips();
renderHome();
const initialQ = new URLSearchParams(location.search).get("q");
if (initialQ) runSearch(initialQ);
