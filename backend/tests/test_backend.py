import random
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import languages, music, recommender, stream  # noqa: E402
import main  # noqa: E402


def T(i, title, artist, album="", dur=240):
    return {"videoId": f"{i:011d}", "title": title, "artist": artist, "artists": [artist],
            "album": album, "duration": dur, "durationText": "4:00", "thumbnail": "", "videoType": ""}


RADIO = [
    T(1, "Butta Bomma", "Armaan Malik", "Ala Vaikunthapurramuloo"),
    T(2, "Samajavaragamana", "Sid Sriram", "Ala Vaikunthapurramuloo"),
    T(3, "Kesariya", "Arijit Singh", "Brahmastra Hindi"),
    T(4, "Naatu Naatu", "Rahul Sipligunj", "RRR"),
    T(5, "Vaathi Coming", "Anirudh", "Master Tamil"),
    T(6, "Oo Antava", "Indravathi Chauhan", "Pushpa Telugu"),
    T(7, "Tiny clip", "Someone", "", dur=20),
    T(8, "Podcast hour", "Someone", "", dur=4000),
    T(9, "Butta Bomma (Official Video)", "Armaan Malik", ""),   # duplicate of #1
    T(10, "తెలుగు పాట", "Singer X"),
]


@pytest.fixture(autouse=True)
def fake_music(monkeypatch):
    monkeypatch.setattr(music, "get_radio", lambda vid, limit=30: list(RADIO))
    monkeypatch.setattr(music, "search_songs", lambda q, n=15: [])


def ids(tracks):
    return [t["videoId"] for t in tracks]


def test_language_scores():
    assert languages.language_score(["తెలుగు"], [], "te") == 1.0
    assert languages.language_score(["x Telugu hits"], [], "te") >= 0.8
    assert languages.language_score(["x"], ["Sid Sriram"], "te") >= 0.5
    assert languages.language_score(["Butta Bomma"], ["Armaan Malik"], "te") == 0.0  # unknown, not wrong
    assert languages.other_language_signal(["Vaathi Tamil"], "te")
    assert not languages.other_language_signal(["Butta Bomma"], "te")


def test_filters_and_dedupes():
    p = recommender.Profile(language="te", history=[f"{2:011d}"], seed_title="Butta Bomma", seed_artist="Armaan Malik")
    out = recommender.recommend(f"{1:011d}", p, limit=15, rng=random.Random(1))
    got = ids(out)
    assert f"{1:011d}" not in got          # the seed itself
    assert f"{2:011d}" not in got          # already played
    assert f"{7:011d}" not in got and f"{8:011d}" not in got  # too short / too long
    assert f"{9:011d}" not in got          # re-upload of the seed song
    assert f"{3:011d}" not in got          # Hindi album keyword -> wrong language
    assert f"{5:011d}" not in got          # Tamil keyword
    assert {f"{4:011d}", f"{6:011d}", f"{10:011d}"} <= set(got)


def test_prefers_telugu_and_liked_artists():
    p = recommender.Profile(language="te", liked_artists={"armaan malik": 3.0})
    base = recommender.score_track(RADIO[0], 5, p)
    p2 = recommender.Profile(language="te")
    assert base > recommender.score_track(RADIO[0], 5, p2)
    # telugu-script title beats unknown at same radio position
    assert recommender.score_track(RADIO[9], 5, p2) > recommender.score_track(RADIO[0], 5, p2)


def test_skip_penalty_and_variety():
    p = recommender.Profile(language="te", skipped_artists={"sid sriram": 2}, recent_artists=["Rahul Sipligunj"])
    assert recommender.score_track(RADIO[1], 1, p) < recommender.score_track(RADIO[1], 1, recommender.Profile())
    assert recommender.score_track(RADIO[3], 1, p) < recommender.score_track(RADIO[3], 1, recommender.Profile())


def test_no_repeat_across_batches():
    p = recommender.Profile(language="any")
    first = recommender.recommend(f"{1:011d}", p, limit=3, rng=random.Random(2))
    p.queued = ids(first)
    second = recommender.recommend(f"{1:011d}", p, limit=3, rng=random.Random(2))
    assert not set(ids(first)) & set(ids(second))


def test_language_topup_called_when_pool_is_weak(monkeypatch):
    calls = []
    monkeypatch.setattr(music, "get_radio", lambda vid, limit=30: [T(1, "Song A", "A"), T(2, "Song B", "B")])
    monkeypatch.setattr(music, "search_songs", lambda q, n=15: calls.append(q) or [T(3, "తెలుగు", "C")])
    out = recommender.recommend(f"{99:011d}", recommender.Profile(language="te", seed_artist="Sid Sriram"), limit=5)
    assert calls and "telugu" in calls[0].lower()
    assert f"{3:011d}" in ids(out)


def test_next_endpoint():
    c = TestClient(main.app)
    r = c.post("/api/next", json={"seed": f"{1:011d}", "language": "te", "limit": 5})
    assert r.status_code == 200 and r.json()["count"] >= 1
    assert c.post("/api/next", json={"seed": "short"}).status_code == 422


def test_parse_range():
    assert stream.parse_range("bytes=0-") == (0, None)
    assert stream.parse_range("bytes=10-20") == (10, 20)
    assert stream.parse_range("bytes=-5") is None and stream.parse_range(None) is None


# ---- proxy against a local fake "googlevideo" -------------------------------------------------
DATA = bytes(range(256)) * 20000  # ~5 MB


class Up(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        rng = self.headers.get("Range")
        if rng:
            a, b = rng.split("=")[1].split("-")
            a = int(a); b = min(int(b) if b else len(DATA) - 1, len(DATA) - 1)
            body = DATA[a:b + 1]
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {a}-{b}/{len(DATA)}")
        else:
            body = DATA
            self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


@pytest.fixture()
def upstream(monkeypatch):
    srv = ThreadingHTTPServer(("127.0.0.1", 0), Up)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    src = stream.Source(url=f"http://127.0.0.1:{srv.server_port}/a", headers={}, expires=9e12, mime="audio/mp4")
    monkeypatch.setattr(stream, "resolve", lambda vid: src)
    stream._client = None
    yield
    srv.shutdown()


def test_stream_full_and_ranges(upstream):
    c = TestClient(main.app)
    vid = "A" * 11
    r = c.get(f"/api/stream/{vid}")
    assert r.status_code == 200 and r.content == DATA                      # chunked across >2MB
    r = c.get(f"/api/stream/{vid}", headers={"Range": "bytes=0-1"})
    assert r.status_code == 206 and r.content == DATA[:2]
    assert r.headers["content-range"] == f"bytes 0-1/{len(DATA)}"
    r = c.get(f"/api/stream/{vid}", headers={"Range": "bytes=3000000-"})
    assert r.status_code == 206 and r.content == DATA[3000000:]
    assert r.headers["content-range"] == f"bytes 3000000-{len(DATA)-1}/{len(DATA)}"
    assert c.get("/api/stream/bad").status_code == 400


def test_access_key(monkeypatch):
    monkeypatch.setattr(main, "ACCESS_KEY", "s3cret")
    monkeypatch.setattr(music, "search_songs", lambda q, n=20: [])
    c = TestClient(main.app)
    assert c.get("/api/search?q=x").status_code == 401
    assert c.get("/api/search?q=x", headers={"x-access-key": "s3cret"}).status_code == 200
    assert c.get("/api/search?q=x&key=s3cret").status_code == 200
