"""Language detection heuristics used to bias the autoplay queue (default: Telugu).

YouTube Music metadata has no reliable "language" field, so we combine:
  * native-script characters in title / artist / album,
  * language keywords ("telugu", "tollywood"...),
  * a list of well-known artists.
Romanised Telugu titles (e.g. "Butta Bomma") often carry none of these, so a
score of 0 means "unknown", NOT "not Telugu". Only a clear *other*-language
signal is treated as a mismatch. Artist affinity learned from the listener's
own history fills the remaining gap (see recommender.py).
"""
from __future__ import annotations

import re

SCRIPTS: dict[str, re.Pattern[str]] = {
    "te": re.compile(r"[ఀ-౿]"),
    "hi": re.compile(r"[ऀ-ॿ]"),
    "ta": re.compile(r"[஀-௿]"),
    "kn": re.compile(r"[ಀ-೿]"),
    "ml": re.compile(r"[ഀ-ൿ]"),
    "pa": re.compile(r"[਀-੿]"),
}

KEYWORDS: dict[str, tuple[str, ...]] = {
    "te": ("telugu", "tollywood"),
    "hi": ("hindi", "bollywood"),
    "ta": ("tamil", "kollywood"),
    "kn": ("kannada", "sandalwood"),
    "ml": ("malayalam", "mollywood"),
    "pa": ("punjabi",),
}

# Mostly Telugu-industry singers / composers (lowercase). Not exhaustive.
KNOWN_ARTISTS: dict[str, set[str]] = {
    "te": {
        "sid sriram", "devi sri prasad", "thaman s", "s thaman", "m m keeravani",
        "mm keeravani", "keeravaani", "s. p. balasubrahmanyam", "s. p. balu", "sp balasubrahmanyam",
        "ghantasala", "p. susheela", "s. janaki", "k. s. chithra", "anurag kulkarni",
        "ramya behara", "mangli", "geetha madhuri", "hemachandra", "kaala bhairava", "rahul sipligunj",
        "ravi basrur", "anup rubens", "mickey j meyer", "gopi sundar", "hesham abdul wahab",
        "radhan", "vishal chandrashekhar", "bheems ceciroleo", "kalyani malik", "koti",
        "chandrabose", "ramajogayya sastry", "sirivennela seetharama sastry", "anantha sriram",
        "yazin nizar", "lipsika", "sunitha",
        "dhanunjay", "ranina reddy", "ananya bhat",
        "revanth", "sri krishna", "rahul nambiar",
        "m. m. srilekha", "mani sharma", "sandeep chowta",
    },
}


def script_hit(text: str, lang: str) -> bool:
    pat = SCRIPTS.get(lang)
    return bool(pat and pat.search(text))


def language_score(text_parts: list[str], artists: list[str], lang: str) -> float:
    """0..1 confidence that a track is in `lang`. 0 = unknown."""
    if lang == "any" or lang not in SCRIPTS:
        return 0.0
    blob = " ".join(text_parts)
    low = blob.lower()
    score = 0.0
    if script_hit(blob, lang):
        score = max(score, 1.0)
    if any(k in low for k in KEYWORDS.get(lang, ())):
        score = max(score, 0.85)
    known = KNOWN_ARTISTS.get(lang, set())
    if any(a.lower() in known for a in artists):
        score = max(score, 0.6)
    return score


def other_language_signal(text_parts: list[str], lang: str) -> bool:
    """True when the metadata clearly names a *different* language."""
    if lang == "any" or lang not in SCRIPTS:
        return False
    blob = " ".join(text_parts)
    low = blob.lower()
    for other, pat in SCRIPTS.items():
        if other != lang and pat.search(blob):
            return True
    for other, words in KEYWORDS.items():
        if other != lang and any(re.search(rf"\b{w}\b", low) for w in words):
            # "Tamil" in "Telugu (Tamil dub)" style titles is rare; keep it simple.
            if not any(k in low for k in KEYWORDS.get(lang, ())):
                return True
    return False
