"""Audio stream resolver + range-aware proxy.

Why a proxy: the direct googlevideo URL is tied to the IP that resolved it and sends
no CORS headers, so a phone on another network can't use it. Serving the audio through
our own origin also lets the browser treat it as a normal <audio> source, which is what
keeps playing with the screen off and feeds the lock-screen / CarPlay controls.
"""
from __future__ import annotations

import re
import time
from dataclasses import dataclass
from threading import Lock
from typing import Any, AsyncIterator
from urllib.parse import parse_qs, urlparse

import httpx
import yt_dlp

CHUNK = 2 * 1024 * 1024  # googlevideo throttles unbounded ranges; fetch in chunks
_VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")


class StreamError(RuntimeError):
    pass


@dataclass
class Source:
    url: str
    headers: dict[str, str]
    expires: float
    mime: str


_cache: dict[str, Source] = {}
_lock = Lock()
_client: httpx.AsyncClient | None = None


def valid_id(video_id: str) -> bool:
    return bool(_VIDEO_ID.match(video_id))


def _expiry(url: str) -> float:
    try:
        exp = int(parse_qs(urlparse(url).query).get("expire", ["0"])[0])
    except ValueError:
        exp = 0
    return float(exp) if exp else time.time() + 3 * 3600


def resolve(video_id: str) -> Source:
    """Blocking: ask yt-dlp for the best audio-only URL (m4a preferred for iOS)."""
    if not valid_id(video_id):
        raise StreamError("bad video id")
    now = time.time()
    with _lock:
        hit = _cache.get(video_id)
        if hit and hit.expires - 120 > now:
            return hit
    opts = {
        "quiet": True, "no_warnings": True, "skip_download": True, "noplaylist": True,
        "format": "bestaudio[ext=m4a]/bestaudio[acodec^=mp4a]/bestaudio/best",
        "socket_timeout": 15, "extractor_retries": 1,
    }
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info: dict[str, Any] = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=False)
    except Exception as exc:
        raise StreamError(f"yt-dlp could not resolve audio: {exc}") from exc
    url = (info or {}).get("url")
    if not url:
        raise StreamError("no audio url in yt-dlp response")
    ext = info.get("ext", "m4a")
    mime = {"m4a": "audio/mp4", "mp4": "audio/mp4", "webm": "audio/webm", "opus": "audio/ogg"}.get(ext, "audio/mp4")
    src = Source(url=url, headers=dict(info.get("http_headers") or {}), expires=_expiry(url), mime=mime)
    with _lock:
        _cache[video_id] = src
        if len(_cache) > 200:
            for k in sorted(_cache, key=lambda k: _cache[k].expires)[:50]:
                _cache.pop(k, None)
    return src


def drop(video_id: str) -> None:
    with _lock:
        _cache.pop(video_id, None)


def client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=httpx.Timeout(20.0, read=30.0), follow_redirects=True)
    return _client


def parse_range(header: str | None) -> tuple[int, int | None] | None:
    """'bytes=100-' -> (100, None); 'bytes=0-1' -> (0, 1). Suffix ranges unsupported -> None."""
    if not header:
        return None
    m = re.match(r"^bytes=(\d+)-(\d*)$", header.strip())
    if not m:
        return None
    start = int(m.group(1))
    end = int(m.group(2)) if m.group(2) else None
    if end is not None and end < start:
        return None
    return start, end


@dataclass
class Plan:
    status: int
    headers: dict[str, str]
    body: AsyncIterator[bytes]


async def open_stream(src: Source, rng: tuple[int, int | None] | None) -> Plan:
    """Open the upstream and return status/headers/body for our response."""
    http = client()
    start = rng[0] if rng else 0
    end_req = rng[1] if rng else None
    first_end = start + CHUNK - 1 if end_req is None else min(end_req, start + CHUNK - 1)

    async def fetch(a: int, b: int) -> httpx.Response:
        req = http.build_request("GET", src.url, headers={**src.headers, "Range": f"bytes={a}-{b}"})
        return await http.send(req, stream=True)

    first = await fetch(start, first_end)
    if first.status_code not in (200, 206):
        code = first.status_code
        await first.aclose()
        raise StreamError(f"upstream returned {code}")

    if first.status_code == 200:
        # Upstream ignored Range; pass the body straight through.
        headers = {"Content-Type": src.mime, "Accept-Ranges": "none"}
        if "content-length" in first.headers:
            headers["Content-Length"] = first.headers["content-length"]

        async def passthrough():
            try:
                async for chunk in first.aiter_bytes():
                    yield chunk
            finally:
                await first.aclose()

        return Plan(200, headers, passthrough())

    m = re.search(r"/(\d+)$", first.headers.get("content-range", ""))
    if not m:
        await first.aclose()
        raise StreamError("upstream gave no total size")
    total = int(m.group(1))
    end = total - 1 if end_req is None else min(end_req, total - 1)
    if start > end:
        await first.aclose()
        raise StreamError("range not satisfiable")

    async def body():
        resp, pos = first, start
        try:
            while True:
                async for chunk in resp.aiter_bytes():
                    pos += len(chunk)
                    yield chunk
                await resp.aclose()
                resp = None
                if pos > end:
                    return
                resp = await fetch(pos, min(end, pos + CHUNK - 1))
                if resp.status_code not in (200, 206):
                    return
        finally:
            if resp is not None:
                await resp.aclose()

    headers = {"Content-Type": src.mime, "Accept-Ranges": "bytes", "Content-Length": str(end - start + 1)}
    if rng:
        headers["Content-Range"] = f"bytes {start}-{end}/{total}"
        return Plan(206, headers, body())
    return Plan(200, headers, body())
