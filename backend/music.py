"""YouTube Music data access (no API key): search, radio ("watch next"), suggestions.

Primary source is `ytmusicapi` (YouTube Music's own web endpoints, unauthenticated).
If the radio call fails we fall back to YouTube's auto-generated Mix playlist
(`list=RD<videoId>`) read through yt-dlp.
"""
from __future__ import annotations

import re
import time
from collections import OrderedDict
from threading import Lock
from typing import Any

import yt_dlp
from ytmusicapi import YTMusic


class MusicError(RuntimeError):
    pass


_ytm: YTMusic | None = None
_ytm_lock = Lock()


def client() -> YTMusic:
    global _ytm
    with _ytm_lock:
        if _ytm is None:
            _ytm = YTMusic()
        return _ytm


class _TTLCache:
    def __init__(self, ttl: float, max_items: int = 256):
        self.ttl, self.max = ttl, max_items
        self._d: OrderedDict[Any, tuple[float, Any]] = OrderedDict()
        self._lock = Lock()

    def get(self, key):
        with self._lock:
            hit = self._d.get(key)
            if not hit:
                return None
            if time.monotonic() - hit[0] > self.ttl:
                del self._d[key]
                return None
            self._d.move_to_end(key)
            return hit[1]

    def set(self, key, value):
        with self._lock:
            self._d[key] = (time.monotonic(), value)
            self._d.move_to_end(key)
            while len(self._d) > self.max:
                self._d.popitem(last=False)


_search_cache = _TTLCache(300)
_radio_cache = _TTLCache(600)


def fmt_duration(seconds: int | None) -> str:
    if not seconds:
        return ""
    h, rem = divmod(int(seconds), 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def parse_duration(text: str | None) -> int:
    if not text:
        return 0
    try:
        parts = [int(p) for p in text.split(":")]
    except ValueError:
        return 0
    total = 0
    for p in parts:
        total = total * 60 + p
    return total


def _best_thumb(thumbs: list[dict] | None, video_id: str) -> str:
    if thumbs:
        best = max(thumbs, key=lambda t: (t.get("width") or 0))
        url = best.get("url")
        if url:
            # googleusercontent thumbs accept size suffix; ask for a crisp 544px square
            return re.sub(r"=w\d+-h\d+.*$", "=w544-h544-l90-rj", url) if "googleusercontent" in url else url
    return f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"


def normalize(raw: dict[str, Any]) -> dict[str, Any] | None:
    """Normalise ytmusicapi search/watch-playlist items into one track shape."""
    vid = raw.get("videoId")
    if not vid:
        return None
    artists_raw = raw.get("artists") or ([{"name": raw["artist"]}] if raw.get("artist") else [])
    artists = [a.get("name", "") for a in artists_raw if a and a.get("name")]
    album = raw.get("album")
    album_name = album.get("name") if isinstance(album, dict) else (album or "")
    seconds = raw.get("duration_seconds") or parse_duration(raw.get("duration") or raw.get("length"))
    thumbs = raw.get("thumbnails") or raw.get("thumbnail")
    return {
        "videoId": str(vid),
        "title": str(raw.get("title") or "Untitled"),
        "artist": ", ".join(artists) or "Unknown artist",
        "artists": artists,
        "album": album_name or "",
        "duration": int(seconds or 0),
        "durationText": fmt_duration(seconds),
        "thumbnail": _best_thumb(thumbs, str(vid)),
        "videoType": raw.get("videoType") or "",
    }


def search_songs(query: str, limit: int = 20) -> list[dict[str, Any]]:
    key = (query.casefold(), limit)
    cached = _search_cache.get(key)
    if cached is not None:
        return cached
    last: Exception | None = None
    for attempt in range(2):
        try:
            raw = client().search(query, filter="songs", limit=limit)
            if not raw:  # some queries return nothing with the songs filter; try videos
                raw = client().search(query, filter="videos", limit=limit)
            out = [t for t in (normalize(r) for r in raw) if t]
            _search_cache.set(key, out)
            return out
        except Exception as exc:  # network / parsing changes upstream
            last = exc
            time.sleep(0.6)
    raise MusicError(f"YouTube Music search failed: {last}") from last


def suggestions(query: str) -> list[str]:
    try:
        return list(client().get_search_suggestions(query))[:8]
    except Exception:
        return []


def _mix_via_ytdlp(video_id: str, limit: int) -> list[dict[str, Any]]:
    opts = {"quiet": True, "no_warnings": True, "skip_download": True,
            "extract_flat": True, "ignoreerrors": True, "socket_timeout": 15,
            "playlistend": limit + 1}
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}&list=RD{video_id}", download=False)
    out = []
    for e in (info or {}).get("entries") or []:
        if not e or not e.get("id"):
            continue
        out.append(normalize({
            "videoId": e["id"],
            "title": e.get("title"),
            "artists": [{"name": (e.get("channel") or e.get("uploader") or "").removesuffix(" - Topic")}],
            "duration_seconds": e.get("duration"),
        }))
    return [t for t in out if t]


def get_radio(video_id: str, limit: int = 30) -> list[dict[str, Any]]:
    """Tracks YouTube Music would play after `video_id` (its 'Start radio')."""
    key = (video_id, limit)
    cached = _radio_cache.get(key)
    if cached is not None:
        return cached
    tracks: list[dict[str, Any]] = []
    try:
        data = client().get_watch_playlist(videoId=video_id, radio=True, limit=limit)
        tracks = [t for t in (normalize(r) for r in data.get("tracks", [])) if t]
    except Exception:
        tracks = []
    if len(tracks) < 3:
        try:
            tracks = _mix_via_ytdlp(video_id, limit)
        except Exception as exc:
            raise MusicError(f"Could not load radio for {video_id}: {exc}") from exc
    _radio_cache.set(key, tracks)
    return tracks
