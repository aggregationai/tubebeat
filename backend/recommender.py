"""Autoplay ("what plays next") engine.

Pipeline, modelled on how YouTube Music's radio behaves:
  1. CANDIDATES  - YouTube Music's own radio for the current song, plus the radio of
                   a recently liked/finished song (keeps long sessions from drifting
                   into one artist's catalogue).
  2. TOP-UP      - if too few candidates match the preferred language, search
                   "<artist> telugu songs" style queries for more.
  3. FILTER      - drop anything already played/queued/skipped, non-songs (too short /
                   too long), duplicates (same title+artist), clear wrong-language.
  4. RANK        - radio position (YT's relevance) + language score + artist affinity
                   from the listener's likes/finishes - artist-repeat penalty - skip
                   penalty, then a light shuffle of near-ties so it doesn't feel scripted.
"""
from __future__ import annotations

import random
import re
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any

import languages
import music

MIN_SECONDS = 60
MAX_SECONDS = 9 * 60 + 30


@dataclass
class Profile:
    language: str = "te"
    history: list[str] = field(default_factory=list)         # all played ids (exclude)
    recent: list[str] = field(default_factory=list)          # last played, oldest -> newest
    queued: list[str] = field(default_factory=list)          # already in the queue (exclude)
    liked_artists: dict[str, float] = field(default_factory=dict)  # artist -> weight
    skipped: list[str] = field(default_factory=list)         # ids skipped early
    skipped_artists: dict[str, int] = field(default_factory=dict)
    recent_artists: list[str] = field(default_factory=list)  # artists of last few plays
    seed_title: str = ""
    seed_artist: str = ""


def _key(title_in: str, first_artist: str) -> str:
    title = re.sub(r"\(.*?\)|\[.*?\]", "", title_in.lower())
    title = re.sub(r"[^a-z0-9ऀ-෿ ]+", "", title)
    title = re.sub(r"\b(official|video|audio|lyrical|lyric|full|song|hd|4k|from|movie)\b", "", title)
    return re.sub(r"\s+", " ", title).strip() + "|" + first_artist.lower()


def _norm_key(track: dict[str, Any]) -> str:
    return _key(track["title"], track["artists"][0] if track["artists"] else "")


def _text_parts(t: dict[str, Any]) -> list[str]:
    return [t["title"], t["artist"], t.get("album", "")]


def score_track(t: dict[str, Any], pos: int, p: Profile) -> float:
    s = 1.0 / (1.0 + 0.07 * pos)  # YouTube's own ordering is the base relevance

    lang = languages.language_score(_text_parts(t), t["artists"], p.language)
    s += 0.9 * lang

    # Affinity: artists the listener liked / finished before
    aff = max((p.liked_artists.get(a.lower(), 0.0) for a in t["artists"]), default=0.0)
    s += min(aff, 3.0) * 0.18

    # Variety: don't play the same artist back-to-back-to-back
    if t["artists"] and t["artists"][0].lower() in {a.lower() for a in p.recent_artists[-3:]}:
        s -= 0.25
    if t["artists"] and t["artists"][0].lower() in {a.lower() for a in p.recent_artists[-1:]}:
        s -= 0.15

    # Negative feedback
    s -= 0.35 * min(2, max((p.skipped_artists.get(a.lower(), 0) for a in t["artists"]), default=0))
    return s


def _gather(seed_id: str, p: Profile, want: int) -> list[tuple[int, dict[str, Any]]]:
    """Return (position, track) candidates from radio(s) + language top-up."""
    seeds = [seed_id]
    for rid in reversed(p.recent[:-1] if p.recent and p.recent[-1] == seed_id else p.recent):
        if rid != seed_id and rid not in seeds:
            seeds.append(rid)
            break  # one extra radio is enough

    def radio(sid: str):
        try:
            return music.get_radio(sid, limit=max(30, want * 2))
        except music.MusicError:
            return []

    with ThreadPoolExecutor(max_workers=2) as ex:
        results = list(ex.map(radio, seeds))

    cands: list[tuple[int, dict[str, Any]]] = []
    for lst in results:
        cands.extend(enumerate(lst))
    if not cands:
        raise music.MusicError("No radio results available")

    # Language top-up
    if p.language != "any":
        strong = sum(1 for _, t in cands if languages.language_score(_text_parts(t), t["artists"], p.language) >= 0.5)
        if strong < want:
            name = {"te": "telugu", "hi": "hindi", "ta": "tamil", "kn": "kannada", "ml": "malayalam", "pa": "punjabi"}.get(p.language, "")
            queries = []
            if p.seed_artist:
                queries.append(f"{p.seed_artist.split(',')[0]} {name} songs")
            queries.append(f"{name} songs like {p.seed_title}" if p.seed_title else f"{name} hit songs")
            top_liked = sorted(p.liked_artists.items(), key=lambda kv: -kv[1])[:1]
            if top_liked:
                queries.append(f"{top_liked[0][0]} {name} songs")
            for q in queries[:3]:
                try:
                    for i, t in enumerate(music.search_songs(q, 15)):
                        cands.append((i + 8, t))  # search hits rank below true radio hits
                except music.MusicError:
                    pass
    return cands


def recommend(seed_id: str, p: Profile, limit: int = 15, rng: random.Random | None = None) -> list[dict[str, Any]]:
    rng = rng or random.Random()
    cands = _gather(seed_id, p, limit)

    blocked_ids = set(p.history) | set(p.queued) | set(p.recent) | {seed_id}
    skipped = set(p.skipped)
    seen_keys: set[str] = set()
    if p.seed_title:  # a re-upload of the current song must not play right after it
        seen_keys.add(_key(p.seed_title, p.seed_artist.split(",")[0].strip()))

    scored: list[tuple[float, dict[str, Any]]] = []
    for pos, t in cands:
        if t["videoId"] in blocked_ids or t["videoId"] in skipped:
            continue
        if t["duration"] and not (MIN_SECONDS <= t["duration"] <= MAX_SECONDS):
            continue
        if languages.other_language_signal(_text_parts(t), p.language):
            continue
        key = _norm_key(t)
        if key in seen_keys:
            continue
        seen_keys.add(key)
        scored.append((score_track(t, pos, p), t))

    scored.sort(key=lambda x: -x[0])
    # If we have plenty of confident-language tracks, don't let unknowns crowd them out.
    if p.language != "any":
        strong = [x for x in scored if languages.language_score(_text_parts(x[1]), x[1]["artists"], p.language) >= 0.5]
        if len(strong) >= limit:
            scored = strong + [x for x in scored if x not in strong]

    head = scored[: limit * 2]
    # light jitter among near-ties so back-to-back sessions differ
    head = sorted(head, key=lambda x: -(x[0] + rng.uniform(-0.12, 0.12)))
    out: list[dict[str, Any]] = []
    last_artist = (p.recent_artists[-1].lower() if p.recent_artists else "")
    for _, t in head:
        a0 = t["artists"][0].lower() if t["artists"] else ""
        if a0 and a0 == last_artist and len(head) > limit:
            continue  # avoid immediate same-artist repeat if we have spare
        out.append(t)
        last_artist = a0
        if len(out) >= limit:
            break
    return out
