# TubeBeat — YouTube Music-style player (no API key)

Search songs, tap one, and an endless **radio** keeps playing similar songs — **Telugu by default** — with
**background playback** (screen off) and lock-screen / Bluetooth / CarPlay-style Now Playing controls.
Everything runs from one FastAPI server that also serves the web app.

## Run it

```bash
cd backend
python -m venv venv && source venv/bin/activate      # Windows: venv\Scripts\Activate.ps1
pip install -r requirements.txt
cp .env.example .env                                  # Windows: copy .env.example .env
uvicorn main:app --host 0.0.0.0 --port 8000
```

Open <http://localhost:8000> on the computer. To use it on your phone, open `http://<computer-ip>:8000`
on the same Wi-Fi. For use away from home see **Using it on the phone / in the car** below.

Tests (no internet needed): `cd backend && python -m pytest -q tests`

## How autoplay works (what "YouTube Music radio" means here)

1. **Candidates** – `ytmusicapi` (YouTube Music's own keyless endpoints) returns the *radio* for the song you
   played, the same list "Start radio" gives. A second radio seeded from a recently played song is mixed in so a
   long session doesn't get stuck on one artist. If that call fails, YouTube's `RD<id>` Mix playlist (via yt-dlp) is used.
2. **Language top-up** – if too few candidates look Telugu, it searches e.g. `"<artist> telugu songs"`.
   Language comes from Telugu script, "telugu/tollywood" keywords and a list of well-known Telugu artists
   (`backend/languages.py`). Romanised titles with no signal count as *unknown*, not wrong; only songs clearly tagged
   as another language (Tamil, Hindi...) are dropped.
3. **Filtering** – no repeats (ids *and* same-title re-uploads), no clips under 60 s or over 9.5 min.
4. **Ranking** – YouTube's own order + language score + artists you liked/finished - artists you skipped -
   same-artist back-to-back, with slight randomness among near-ties.
5. **Always ahead** – the queue refills when 4 songs remain, so the next track starts instantly even in the background.

Your taste profile (history, likes, skips) lives only in your browser's storage and is sent with each "what's next" request.
Change the language in the top-right selector; the heart strongly steers the radio, skipping a song in the first 30 s steers it away.

## Background play and car controls

Audio goes through a normal `<audio>` element on our own origin (the server proxies the audio stream), with the
Media Session API providing title / artwork / seek / next / previous. That is what lets the browser keep playing
with the screen off and show controls on the lock screen, notification shade, Bluetooth stereos and CarPlay / Android Auto
"Now Playing". (The YouTube iframe player used before cannot do this; it pauses when the screen locks.)

Limits to know about:

- A website cannot appear as an *app icon* in CarPlay / Android Auto. You start playback on the phone; the car then shows
  Now Playing and the steering-wheel / touchscreen buttons should work.
- **iPhone:** use Safari, or Share -> *Add to Home Screen* (the app is an installable PWA). Start the first song with a tap;
  after that, songs advance on their own with the screen locked.
- **Android:** Chrome, or *Install app* from the menu.
- Browsers may still suspend a tab under aggressive battery saving. If music stops after a long time, exempt the browser
  / installed app from battery optimisation.

## Using it on the phone / in the car

The phone must reach the server. Options: same Wi-Fi (above); or leave the server running at home and expose it with a
tunnel such as Tailscale or Cloudflare Tunnel (gives HTTPS, which also enables install / service worker). YouTube often blocks
cloud / data-centre IPs, so a home connection is more reliable than a cheap VPS. If the server is reachable by others, **set
`ACCESS_KEY` in `.env`** — otherwise anyone who finds it can use your server as an audio proxy. The app asks for the key once.

## API

- `GET /api/search?q=...` · `GET /api/suggest?q=...` · `GET /api/config`
- `POST /api/next` – autoplay brain (seed + history/likes/skips -> next tracks)
- `GET /api/stream/{videoId}` – range-capable audio proxy · `GET /api/prewarm/{videoId}`

## Legal and reliability caveat

This app uses unofficial YouTube access (ytmusicapi, yt-dlp) and streams audio without YouTube's player or ads. That likely
violates YouTube's Terms of Service (<https://www.youtube.com/static?template=terms>) and can break whenever YouTube changes.
Keep it personal and private; don't run it as a public service. When something stops working, first run
`pip install --upgrade yt-dlp ytmusicapi` and restart.

## Troubleshooting

- **Search fails / 502:** upgrade the two libraries (above); check the server can reach music.youtube.com.
- **A song is skipped with "Couldn't play":** yt-dlp couldn't resolve that video's audio; upgrade yt-dlp.
- **Plays but stops when screen locks:** use Safari / the installed app, and check battery-saver settings.
- **Wrong-language songs:** pick the language in the top-right; like songs you enjoy and skip ones you don't.
