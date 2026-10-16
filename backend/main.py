import asyncio
import os
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import music
import recommender
import stream

load_dotenv()

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
ACCESS_KEY = os.getenv("ACCESS_KEY", "").strip()


def allowed_origins() -> list[str]:
    raw = os.getenv("CORS_ORIGINS", "*").strip()
    return [o.strip() for o in raw.split(",") if o.strip()] or ["*"]


def require_key(request: Request) -> None:
    """Optional shared secret so a public deployment isn't an open audio proxy."""
    if not ACCESS_KEY:
        return
    supplied = request.headers.get("x-access-key") or request.query_params.get("key")
    if supplied != ACCESS_KEY:
        raise HTTPException(status_code=401, detail="access key required")


@asynccontextmanager
async def lifespan(_: FastAPI):
    yield
    if stream._client is not None:
        await stream._client.aclose()


app = FastAPI(title="TubeBeat Music API", version="2.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins(),
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

DISCOVER = {
    "te": ["Telugu hit songs", "Telugu melody songs", "Telugu dance songs", "Sid Sriram Telugu",
           "Devi Sri Prasad", "Thaman S Telugu", "SP Balasubrahmanyam Telugu", "Telugu old classics",
           "Telugu love songs", "Telugu folk songs"],
    "hi": ["Hindi hit songs", "Arijit Singh", "Bollywood romantic songs", "Hindi retro classics"],
    "ta": ["Tamil hit songs", "Anirudh Ravichander", "Ilaiyaraaja Tamil", "Tamil melody songs"],
    "kn": ["Kannada hit songs", "Kannada melody songs"],
    "ml": ["Malayalam hit songs", "Malayalam melody songs"],
    "any": ["Top hits", "Chill", "Workout", "Throwbacks", "Focus"],
}


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/config")
def config() -> dict:
    return {"accessKeyRequired": bool(ACCESS_KEY), "discover": DISCOVER}


@app.get("/api/search", dependencies=[Depends(require_key)])
def search(q: str = Query(..., min_length=1, max_length=200), limit: int = Query(20, ge=1, le=40)):
    query = q.strip()
    if not query:
        return JSONResponse(status_code=422, content={"error": "query_required"})
    try:
        results = music.search_songs(query, limit)
    except music.MusicError as exc:
        return JSONResponse(status_code=502, content={"error": "search_failed", "detail": str(exc)})
    return {"query": query, "count": len(results), "results": results}


@app.get("/api/suggest", dependencies=[Depends(require_key)])
def suggest(q: str = Query(..., min_length=1, max_length=100)):
    return {"suggestions": music.suggestions(q.strip())}


class NextRequest(BaseModel):
    seed: str = Field(min_length=11, max_length=11)
    language: str = "te"
    limit: int = Field(15, ge=1, le=30)
    history: list[str] = Field(default_factory=list, max_length=400)
    recent: list[str] = Field(default_factory=list, max_length=30)
    queued: list[str] = Field(default_factory=list, max_length=100)
    skipped: list[str] = Field(default_factory=list, max_length=200)
    likedArtists: dict[str, float] = Field(default_factory=dict)
    skippedArtists: dict[str, int] = Field(default_factory=dict)
    recentArtists: list[str] = Field(default_factory=list, max_length=10)
    seedTitle: str = ""
    seedArtist: str = ""


@app.post("/api/next", dependencies=[Depends(require_key)])
async def next_tracks(body: NextRequest):
    """The autoplay brain: returns the next batch of songs to append to the queue."""
    profile = recommender.Profile(
        language=body.language if body.language in ("te", "hi", "ta", "kn", "ml", "any") else "te",
        history=body.history, recent=body.recent, queued=body.queued,
        liked_artists={k.lower(): v for k, v in body.likedArtists.items()},
        skipped=body.skipped,
        skipped_artists={k.lower(): v for k, v in body.skippedArtists.items()},
        recent_artists=body.recentArtists,
        seed_title=body.seedTitle, seed_artist=body.seedArtist,
    )
    try:
        tracks = await asyncio.to_thread(recommender.recommend, body.seed, profile, body.limit)
    except music.MusicError as exc:
        return JSONResponse(status_code=502, content={"error": "radio_failed", "detail": str(exc)})
    return {"seed": body.seed, "count": len(tracks), "tracks": tracks}


@app.get("/api/stream/{video_id}", dependencies=[Depends(require_key)])
async def stream_audio(video_id: str, request: Request):
    if not stream.valid_id(video_id):
        raise HTTPException(status_code=400, detail="bad video id")
    rng = stream.parse_range(request.headers.get("range"))
    for attempt in range(2):
        try:
            src = await asyncio.to_thread(stream.resolve, video_id)
            plan = await stream.open_stream(src, rng)
            break
        except stream.StreamError as exc:
            stream.drop(video_id)  # stale URL? re-resolve once
            if attempt == 1:
                raise HTTPException(status_code=502, detail=str(exc))
    headers = {**plan.headers, "Cache-Control": "private, max-age=0"}
    return StreamingResponse(plan.body, status_code=plan.status, headers=headers, media_type=headers["Content-Type"])


@app.get("/api/prewarm/{video_id}", dependencies=[Depends(require_key)])
async def prewarm(video_id: str):
    """Resolve the audio URL ahead of time so the next track starts instantly."""
    if not stream.valid_id(video_id):
        raise HTTPException(status_code=400, detail="bad video id")
    try:
        await asyncio.to_thread(stream.resolve, video_id)
    except stream.StreamError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    return {"ok": True}


# Serve the web app from the same origin (no CORS, works from a phone via one URL).
if FRONTEND_DIR.is_dir():
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
