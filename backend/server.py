"""Consnow backend - hardened FastAPI + MongoDB + JWT auth + location sharing.

Security-focused changes in this version:
- CORS is origin allow-list based, not wildcard with credentials.
- Friend location visibility is enforced consistently for latest, recent, timeline,
  narrative, and friend-list last_seen.
- User-controlled regex search is escaped.
- Location timestamps and coordinates are validated and normalized to UTC.
- Login/signup/location endpoints have simple in-memory rate limits.
- MongoDB unique/index constraints are created at startup.
- External AI narrative generation is disabled by default to avoid leaking
  sensitive location history to a third-party provider.
"""

from __future__ import annotations

import logging
import os
import re
import time
import uuid
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Deque, Dict, List, Literal, Optional, Tuple, Union
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import bcrypt
import httpx
import jwt
from dotenv import load_dotenv
from fastapi import APIRouter, Depends, FastAPI, HTTPException, Query, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, EmailStr, Field
from pymongo import ASCENDING, DESCENDING
from pymongo.errors import DuplicateKeyError
from starlette.middleware.cors import CORSMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.responses import Response

try:
    from timezonefinder import TimezoneFinder
except ImportError:  # optional dependency
    TimezoneFinder = None


# -----------------------------------------------------------------------------
# Config
# -----------------------------------------------------------------------------
ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")


def _required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def _int_env(name: str, default: int, min_value: int, max_value: int) -> int:
    raw = os.environ.get(name, str(default)).strip()
    try:
        value = int(raw)
    except ValueError as exc:
        raise RuntimeError(f"{name} must be an integer") from exc
    if value < min_value or value > max_value:
        raise RuntimeError(f"{name} must be between {min_value} and {max_value}")
    return value


def _bool_env(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _csv_env(name: str, default: str = "") -> List[str]:
    raw = os.environ.get(name, default)
    return [item.strip() for item in raw.split(",") if item.strip()]


MONGO_URL = _required_env("MONGO_URL")
DB_NAME = _required_env("DB_NAME")
JWT_SECRET = _required_env("JWT_SECRET")
JWT_ALGORITHM = os.environ.get("JWT_ALGORITHM", "HS256").strip() or "HS256"
JWT_EXPIRE_MINUTES = _int_env("JWT_EXPIRE_MINUTES", default=60 * 24 * 7, min_value=5, max_value=60 * 24 * 30)
JWT_ISSUER = os.environ.get("JWT_ISSUER", "consnow-api").strip() or "consnow-api"
GOOGLE_GEOCODING_API_KEY = os.environ.get("GOOGLE_GEOCODING_API_KEY", "").strip()

# External narrative AI is intentionally opt-in because it sends sensitive
# location timeline text to a third-party API.
ENABLE_EXTERNAL_NARRATIVE_AI = _bool_env("ENABLE_EXTERNAL_NARRATIVE_AI", False)
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "").strip()
ANTHROPIC_MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-3-haiku-20240307").strip()

ALLOWED_CORS_ORIGINS = _csv_env(
    "CORS_ORIGINS",
    "http://localhost:3000,http://127.0.0.1:3000",
)
ALLOWED_HOSTS = _csv_env("ALLOWED_HOSTS", "*")
MAX_LOCATION_BACKDATE_DAYS = _int_env("MAX_LOCATION_BACKDATE_DAYS", default=2, min_value=0, max_value=30)

if JWT_ALGORITHM not in {"HS256", "HS384", "HS512"}:
    raise RuntimeError("JWT_ALGORITHM must be one of HS256, HS384, HS512")
if len(JWT_SECRET) < 32:
    raise RuntimeError("JWT_SECRET must be at least 32 characters")
if "*" in ALLOWED_CORS_ORIGINS:
    raise RuntimeError("CORS_ORIGINS must not contain '*' when credentials are enabled")


# -----------------------------------------------------------------------------
# Constants / Globals
# -----------------------------------------------------------------------------
VALID_SCOPES = ["10m", "1h", "6h", "12h", "24h", "off"]
SCOPE_TO_MINUTES = {
    "10m": 10,
    "1h": 60,
    "6h": 360,
    "12h": 720,
    "24h": 1440,
    "off": -1,
}

VALID_FREQS = ["10m", "30m", "1h", "6h", "12h", "24h"]
FREQ_TO_MINUTES = {
    "10m": 10,
    "30m": 30,
    "1h": 60,
    "6h": 360,
    "12h": 720,
    "24h": 1440,
}

Activity = Literal["stationary", "walking", "running", "cycling", "automotive", "unknown"]
Availability = Literal["available", "maybe", "busy"]
SharingFilter = Union[datetime, Literal["BLOCKED", "OUTSIDE_WINDOW"]]

UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger("consnow")

timezone_finder = TimezoneFinder() if TimezoneFinder else None
security = HTTPBearer(auto_error=False)
_rate_buckets: Dict[Tuple[str, str], Deque[float]] = defaultdict(deque)


# -----------------------------------------------------------------------------
# Database
# -----------------------------------------------------------------------------
client = AsyncIOMotorClient(
    MONGO_URL,
    serverSelectionTimeoutMS=5000,
    uuidRepresentation="standard",
)
db = client[DB_NAME]

users_col = db["users"]
friendships_col = db["friendships"]
locations_col = db["locations"]
visits_col = db["visits"]


# -----------------------------------------------------------------------------
# App
# -----------------------------------------------------------------------------
app = FastAPI(title="Consnow API", debug=False)
api = APIRouter(prefix="/api")

if ALLOWED_HOSTS != ["*"]:
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=ALLOWED_HOSTS)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=ALLOWED_CORS_ORIGINS,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


@app.middleware("http")
async def security_headers_middleware(request: Request, call_next):
    response: Response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault("Permissions-Policy", "geolocation=(self)")
    # Enable HSTS only when the app is actually served over HTTPS.
    if request.url.scheme == "https":
        response.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
    return response


@app.on_event("startup")
async def startup_indexes() -> None:
    """Create indexes required for correctness and performance."""
    await users_col.create_index([("id", ASCENDING)], unique=True)
    await users_col.create_index([("email", ASCENDING)], unique=True)
    await users_col.create_index([("username", ASCENDING)], unique=True)
    await friendships_col.create_index([("id", ASCENDING)], unique=True)
    await friendships_col.create_index([("pair", ASCENDING)], unique=True)
    await friendships_col.create_index([("requester_id", ASCENDING), ("target_id", ASCENDING)])
    await locations_col.create_index([("user_id", ASCENDING), ("timestamp", DESCENDING)])
    await visits_col.create_index([("user_id", ASCENDING), ("started_at", DESCENDING)])
    await visits_col.create_index([("user_id", ASCENDING), ("ended_at", DESCENDING)])


@app.on_event("shutdown")
async def shutdown_db_client() -> None:
    client.close()


# -----------------------------------------------------------------------------
# Models
# -----------------------------------------------------------------------------
class SignupReq(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    display_name: str = Field(min_length=1, max_length=60)
    username: str = Field(min_length=3, max_length=30, pattern=r"^[a-zA-Z0-9_]+$")


class LoginReq(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=128)


class AuthResp(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: dict


class FriendRequestReq(BaseModel):
    target_user_id: str = Field(min_length=36, max_length=36)


class FriendRespondReq(BaseModel):
    friendship_id: str = Field(min_length=36, max_length=36)
    accept: bool


class ScopeUpdateReq(BaseModel):
    friend_user_id: str = Field(min_length=36, max_length=36)
    scope: str


class SharingUpdateReq(BaseModel):
    friend_user_id: str = Field(min_length=36, max_length=36)
    enabled: bool
    freq: str
    window_start: int = Field(ge=0, le=23)
    window_end: int = Field(ge=1, le=24)


class LocationPing(BaseModel):
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    accuracy: Optional[float] = Field(default=None, ge=0, le=10000)
    speed: Optional[float] = Field(default=None, ge=0, le=120)  # m/s
    activity: Optional[Activity] = "unknown"
    availability: Optional[Availability] = "available"
    timestamp: Optional[str] = None


# -----------------------------------------------------------------------------
# Small utilities
# -----------------------------------------------------------------------------
def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def utc_iso(value: Optional[datetime] = None) -> str:
    return (value or utc_now()).astimezone(timezone.utc).isoformat()


def validate_uuid(value: str, field_name: str = "id") -> str:
    value = (value or "").strip()
    if not UUID_RE.fullmatch(value):
        raise HTTPException(status_code=400, detail=f"Invalid {field_name}")
    return value.lower()


def parse_client_timestamp(value: Optional[str]) -> str:
    """Parse user-provided ISO timestamp, normalize to UTC, and bound it."""
    now = utc_now()
    if not value:
        return utc_iso(now)

    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid timestamp")

    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    parsed = parsed.astimezone(timezone.utc)

    if parsed > now + timedelta(minutes=5):
        raise HTTPException(status_code=400, detail="Timestamp cannot be in the future")
    if parsed < now - timedelta(days=MAX_LOCATION_BACKDATE_DAYS):
        raise HTTPException(status_code=400, detail="Timestamp is too old")

    return utc_iso(parsed)


def clean_display_name(value: str) -> str:
    value = " ".join((value or "").strip().split())
    if not value:
        raise HTTPException(status_code=400, detail="Display name is required")
    return value[:60]


def normalize_username(value: str) -> str:
    value = (value or "").strip().lower()
    if not re.fullmatch(r"[a-z0-9_]{3,30}", value):
        raise HTTPException(status_code=400, detail="Invalid username")
    return value


def normalize_email(value: str) -> str:
    return (value or "").strip().lower()


def hour_in_window(hour: int, start: int, end: int) -> bool:
    if start == 0 and end == 24:
        return True
    if start == end:
        return False
    if start < end:
        return start <= hour < end
    return hour >= start or hour < end


async def enforce_rate_limit(request: Request, bucket: str, limit: int, window_seconds: int) -> None:
    """Simple per-process rate limiter. Use Redis for multi-instance production."""
    client_ip = request.client.host if request.client else "unknown"
    key = (bucket, client_ip)
    now = time.monotonic()
    dq = _rate_buckets[key]

    while dq and dq[0] <= now - window_seconds:
        dq.popleft()

    if len(dq) >= limit:
        raise HTTPException(status_code=429, detail="Too many requests, try again later")

    dq.append(now)


def normalize_timezone(tz: Optional[str]) -> Optional[str]:
    if not tz:
        return None
    if tz == "Asia/Calcutta":
        tz = "Asia/Kolkata"
    try:
        ZoneInfo(tz)
        return tz
    except ZoneInfoNotFoundError:
        return None


def timezone_for_coordinates(lat: float, lng: float) -> Optional[str]:
    if not timezone_finder:
        return None
    try:
        tz = None
        for method_name in ("timezone_at", "certain_timezone_at"):
            method = getattr(timezone_finder, method_name, None)
            if callable(method):
                tz = method(lat=lat, lng=lng)
                if tz:
                    break
        if not tz:
            closest = getattr(timezone_finder, "closest_timezone_at", None)
            if callable(closest):
                try:
                    tz = closest(lat=lat, lng=lng, delta_degree=2)
                except TypeError:
                    tz = closest(lat=lat, lng=lng)
        return normalize_timezone(tz)
    except Exception as exc:
        logger.warning("Timezone lookup failed: %s", exc)
        return None


async def timezone_for_user(user_id: str, user_doc: Optional[dict] = None) -> str:
    user_timezone = normalize_timezone((user_doc or {}).get("timezone"))
    if user_timezone:
        return user_timezone

    latest = await locations_col.find_one(
        {"user_id": user_id},
        {"_id": 0, "latitude": 1, "longitude": 1},
        sort=[("timestamp", -1)],
    )
    if latest:
        user_timezone = timezone_for_coordinates(latest["latitude"], latest["longitude"])
        if user_timezone:
            await users_col.update_one({"id": user_id}, {"$set": {"timezone": user_timezone}})
            return user_timezone

    latest_visit = await visits_col.find_one(
        {"user_id": user_id},
        {"_id": 0, "last_lat": 1, "last_lng": 1, "center_lat": 1, "center_lng": 1},
        sort=[("ended_at", -1)],
    )
    if latest_visit:
        lat = latest_visit.get("last_lat", latest_visit.get("center_lat"))
        lng = latest_visit.get("last_lng", latest_visit.get("center_lng"))
        if lat is not None and lng is not None:
            user_timezone = timezone_for_coordinates(lat, lng)
            if user_timezone:
                await users_col.update_one({"id": user_id}, {"$set": {"timezone": user_timezone}})
                return user_timezone

    return "UTC"


async def get_sharing_filter(friendship: dict, owner_id: str, owner_doc: Optional[dict] = None) -> SharingFilter:
    """Return a UTC cutoff datetime for what the viewer can see from owner_id.

    If sharing is disabled or the current time is outside the owner's sharing
    window, return a sentinel string.
    """
    if f"freq_{owner_id}" in friendship or f"enabled_{owner_id}" in friendship:
        enabled = friendship.get(f"enabled_{owner_id}", True)
        if not enabled:
            return "BLOCKED"

        freq = friendship.get(f"freq_{owner_id}", "10m")
        delay_min = FREQ_TO_MINUTES.get(freq, 10)
        win_start = int(friendship.get(f"window_start_{owner_id}", 0))
        win_end = int(friendship.get(f"window_end_{owner_id}", 24))

        owner_timezone = await timezone_for_user(owner_id, owner_doc)
        current_hour = utc_now().astimezone(ZoneInfo(owner_timezone)).hour
        if not hour_in_window(current_hour, win_start, win_end):
            return "OUTSIDE_WINDOW"

        return utc_now() - timedelta(minutes=delay_min)

    scope = friendship.get(f"scope_{owner_id}", "10m")
    if scope == "off":
        return "BLOCKED"
    delay_min = SCOPE_TO_MINUTES.get(scope, 10)
    return utc_now() - timedelta(minutes=delay_min)


def hash_password(plain: str) -> str:
    return bcrypt.hashpw(plain.encode("utf-8"), bcrypt.gensalt(rounds=12)).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))
    except Exception:
        return False


def create_token(user_id: str) -> str:
    now = utc_now()
    payload = {
        "sub": user_id,
        "type": "access",
        "iss": JWT_ISSUER,
        "iat": now,
        "exp": now + timedelta(minutes=JWT_EXPIRE_MINUTES),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


async def get_current_user(creds: HTTPAuthorizationCredentials = Depends(security)) -> dict:
    if not creds or not creds.credentials:
        raise HTTPException(status_code=401, detail="Missing authorization token")
    try:
        payload = jwt.decode(
            creds.credentials,
            JWT_SECRET,
            algorithms=[JWT_ALGORITHM],
            issuer=JWT_ISSUER,
            options={"require": ["sub", "exp", "iat", "iss"]},
        )
        if payload.get("type") != "access":
            raise jwt.InvalidTokenError("Invalid token type")
        user_id = validate_uuid(str(payload.get("sub", "")), "token subject")
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")

    user = await users_col.find_one({"id": user_id}, {"_id": 0, "password_hash": 0})
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return user


def public_user(user: dict, include_email: bool = False) -> dict:
    data = {
        "id": user["id"],
        "username": user.get("username"),
        "display_name": user.get("display_name"),
        "timezone": user.get("timezone"),
    }
    if include_email:
        data["email"] = user.get("email")
    return data


def pair_key(a: str, b: str) -> List[str]:
    return sorted([a, b])


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Distance in meters between two coordinates."""
    from math import asin, cos, radians, sin, sqrt

    radius_m = 6371000.0
    p1, p2 = radians(lat1), radians(lat2)
    dp = radians(lat2 - lat1)
    dl = radians(lon2 - lon1)
    a = sin(dp / 2) ** 2 + cos(p1) * cos(p2) * sin(dl / 2) ** 2
    return 2 * radius_m * asin(sqrt(a))


def _format_duration_human(start_iso: str, end_iso: str) -> str:
    try:
        start = datetime.fromisoformat(start_iso.replace("Z", "+00:00"))
        end = datetime.fromisoformat(end_iso.replace("Z", "+00:00"))
        mins = max(0, int((end - start).total_seconds() // 60))
        if mins < 1:
            return "briefly"
        if mins < 60:
            return f"{mins} min"
        hours = mins // 60
        rem = mins % 60
        return f"{hours}h" if rem == 0 else f"{hours}h {rem}m"
    except Exception:
        return ""


def _format_time_human(iso_value: str, timezone_offset_minutes: int = 0) -> str:
    try:
        dt = datetime.fromisoformat(iso_value.replace("Z", "+00:00"))
        dt = dt - timedelta(minutes=timezone_offset_minutes)
        # %-I is not portable on Windows, but this API usually runs on Linux.
        return dt.strftime("%-I:%M %p")
    except Exception:
        return ""


# -----------------------------------------------------------------------------
# Geocoding
# -----------------------------------------------------------------------------
async def reverse_geocode(lat: float, lng: float) -> dict:
    """Use Google Places API Nearby Search to get a nearby named place."""
    fallback = {
        "place_name": f"{lat:.4f}, {lng:.4f}",
        "formatted_address": None,
        "neighborhood": None,
        "city": None,
        "place_category": None,
    }
    if not GOOGLE_GEOCODING_API_KEY:
        return fallback

    geo_types = {
        "route",
        "political",
        "street_address",
        "intersection",
        "plus_code",
        "administrative_area_level_1",
        "administrative_area_level_2",
        "administrative_area_level_3",
        "locality",
        "sublocality",
        "sublocality_level_1",
        "postal_code",
        "country",
    }
    generic_types = {"establishment", "point_of_interest", "premise"}

    try:
        async with httpx.AsyncClient(timeout=8.0) as cli:
            response = await cli.post(
                "https://places.googleapis.com/v1/places:searchNearby",
                headers={
                    "X-Goog-Api-Key": GOOGLE_GEOCODING_API_KEY,
                    "X-Goog-FieldMask": "places.displayName,places.types,places.formattedAddress",
                },
                json={
                    "locationRestriction": {
                        "circle": {
                            "center": {"latitude": lat, "longitude": lng},
                            "radius": 200.0,
                        }
                    },
                    "maxResultCount": 10,
                },
            )
            response.raise_for_status()
            data = response.json()
    except Exception as exc:
        logger.warning("Places lookup failed: %s", exc)
        return fallback

    places = data.get("places", [])
    if not places:
        return fallback

    best = next((p for p in places if not geo_types.intersection(p.get("types", []))), places[0])
    place_name = best.get("displayName", {}).get("text") or fallback["place_name"]
    specific = [
        item
        for item in best.get("types", [])
        if item not in geo_types and item not in generic_types
    ]

    return {
        "place_name": place_name[:160],
        "formatted_address": (best.get("formattedAddress") or "")[:300] or None,
        "neighborhood": None,
        "city": None,
        "place_category": specific[0] if specific else None,
    }


# -----------------------------------------------------------------------------
# Routes: health / auth
# -----------------------------------------------------------------------------
@api.get("/")
async def root() -> dict:
    return {"app": "Consnow", "status": "ok"}


@api.post("/auth/signup", response_model=AuthResp, status_code=status.HTTP_201_CREATED)
async def signup(req: SignupReq, request: Request) -> AuthResp:
    await enforce_rate_limit(request, "signup", limit=5, window_seconds=60 * 10)

    email = normalize_email(str(req.email))
    username = normalize_username(req.username)
    display_name = clean_display_name(req.display_name)

    doc = {
        "id": str(uuid.uuid4()),
        "email": email,
        "username": username,
        "display_name": display_name,
        "password_hash": hash_password(req.password),
        "created_at": utc_iso(),
    }

    try:
        await users_col.insert_one(doc)
    except DuplicateKeyError:
        # Avoid revealing exactly which field exists.
        raise HTTPException(status_code=400, detail="Email or username already registered")

    token = create_token(doc["id"])
    return AuthResp(access_token=token, user=public_user(doc, include_email=True))


@api.post("/auth/login", response_model=AuthResp)
async def login(req: LoginReq, request: Request) -> AuthResp:
    await enforce_rate_limit(request, "login", limit=10, window_seconds=60)

    user = await users_col.find_one({"email": normalize_email(str(req.email))})
    if not user or not verify_password(req.password, user.get("password_hash", "")):
        # Same message for both paths to avoid account enumeration.
        raise HTTPException(status_code=401, detail="Invalid email or password")

    token = create_token(user["id"])
    return AuthResp(access_token=token, user=public_user(user, include_email=True))


@api.get("/auth/me")
async def me(current_user: dict = Depends(get_current_user)) -> dict:
    return public_user(current_user, include_email=True)


# -----------------------------------------------------------------------------
# Routes: users / search
# -----------------------------------------------------------------------------
@api.get("/users/search")
async def search_users(
    q: str = Query(..., min_length=2, max_length=50),
    current_user: dict = Depends(get_current_user),
) -> List[dict]:
    q = q.strip()
    safe_regex = re.escape(q)

    cursor = users_col.find(
        {
            "$and": [
                {"id": {"$ne": current_user["id"]}},
                {
                    "$or": [
                        {"username": {"$regex": safe_regex, "$options": "i"}},
                        {"display_name": {"$regex": safe_regex, "$options": "i"}},
                        # Search by email can be useful, but never return email.
                        {"email": {"$regex": safe_regex, "$options": "i"}},
                    ]
                },
            ]
        },
        {"_id": 0, "password_hash": 0, "email": 0},
    ).limit(20)

    results: List[dict] = []
    async for user in cursor:
        pair = pair_key(current_user["id"], user["id"])
        friendship = await friendships_col.find_one({"pair": pair}, {"_id": 0, "status": 1})
        results.append({**user, "friendship_status": friendship.get("status", "none") if friendship else "none"})
    return results


# -----------------------------------------------------------------------------
# Routes: friendships
# -----------------------------------------------------------------------------
@api.post("/friends/request")
async def send_friend_request(req: FriendRequestReq, current_user: dict = Depends(get_current_user)) -> dict:
    target_id = validate_uuid(req.target_user_id, "target_user_id")
    if target_id == current_user["id"]:
        raise HTTPException(status_code=400, detail="Cannot friend yourself")

    target = await users_col.find_one({"id": target_id}, {"_id": 0, "id": 1})
    if not target:
        raise HTTPException(status_code=404, detail="User not found")

    pair = pair_key(current_user["id"], target_id)
    existing = await friendships_col.find_one({"pair": pair}, {"_id": 0, "status": 1})
    if existing:
        raise HTTPException(status_code=400, detail=f"Already {existing['status']}")

    friendship = {
        "id": str(uuid.uuid4()),
        "pair": pair,
        "requester_id": current_user["id"],
        "target_id": target_id,
        "status": "pending",
        # Legacy scope fields.
        f"scope_{current_user['id']}": "10m",
        f"scope_{target_id}": "10m",
        # New granular sharing defaults.
        f"enabled_{current_user['id']}": True,
        f"enabled_{target_id}": True,
        f"freq_{current_user['id']}": "10m",
        f"freq_{target_id}": "10m",
        f"window_start_{current_user['id']}": 0,
        f"window_start_{target_id}": 0,
        f"window_end_{current_user['id']}": 24,
        f"window_end_{target_id}": 24,
        "created_at": utc_iso(),
    }

    try:
        await friendships_col.insert_one(friendship)
    except DuplicateKeyError:
        raise HTTPException(status_code=400, detail="Friendship already exists")

    return {"ok": True, "friendship_id": friendship["id"]}


@api.post("/friends/respond")
async def respond_friend_request(req: FriendRespondReq, current_user: dict = Depends(get_current_user)) -> dict:
    friendship_id = validate_uuid(req.friendship_id, "friendship_id")
    friendship = await friendships_col.find_one({"id": friendship_id})
    if not friendship:
        raise HTTPException(status_code=404, detail="Request not found")
    if friendship["target_id"] != current_user["id"]:
        raise HTTPException(status_code=403, detail="Not authorized")
    if friendship["status"] != "pending":
        raise HTTPException(status_code=400, detail="Already responded")

    new_status = "accepted" if req.accept else "rejected"
    await friendships_col.update_one(
        {"id": friendship_id},
        {"$set": {"status": new_status, "responded_at": utc_iso()}},
    )
    return {"ok": True, "status": new_status}


@api.get("/friends/list")
async def list_friends(current_user: dict = Depends(get_current_user)) -> dict:
    uid = current_user["id"]
    cursor = friendships_col.find({"pair": {"$in": [uid]}}, {"_id": 0})

    friends: List[dict] = []
    pending_incoming: List[dict] = []
    pending_outgoing: List[dict] = []

    async for friendship in cursor:
        other_id = friendship["pair"][0] if friendship["pair"][1] == uid else friendship["pair"][1]
        other = await users_col.find_one({"id": other_id}, {"_id": 0, "password_hash": 0, "email": 0})
        if not other:
            continue

        entry = {
            "friendship_id": friendship["id"],
            "user": public_user(other, include_email=False),
            "status": friendship["status"],
            "scope_i_grant": friendship.get(f"scope_{uid}", "10m"),
            "sharing_i_grant": {
                "enabled": friendship.get(f"enabled_{uid}", True),
                "freq": friendship.get(f"freq_{uid}", "10m"),
                "window_start": friendship.get(f"window_start_{uid}", 0),
                "window_end": friendship.get(f"window_end_{uid}", 24),
            },
        }

        if friendship["status"] == "accepted":
            share = await get_sharing_filter(friendship, other_id, other)
            if share == "BLOCKED":
                entry["last_seen"] = None
                entry["sharing_status"] = "off"
            elif share == "OUTSIDE_WINDOW":
                entry["last_seen"] = None
                entry["sharing_status"] = "window"
            else:
                last = await locations_col.find_one(
                    {"user_id": other_id, "timestamp": {"$lte": utc_iso(share)}},
                    {"_id": 0, "latitude": 0, "longitude": 0},
                    sort=[("timestamp", -1)],
                )
                if last:
                    entry["last_seen"] = {
                        "place_name": last.get("place_name"),
                        "timestamp": last.get("timestamp"),
                        "activity": last.get("activity"),
                        "availability": last.get("availability"),
                    }
            friends.append(entry)
        elif friendship["status"] == "pending":
            if friendship["requester_id"] == uid:
                pending_outgoing.append(entry)
            else:
                pending_incoming.append(entry)

    return {
        "friends": friends,
        "pending_incoming": pending_incoming,
        "pending_outgoing": pending_outgoing,
    }


@api.put("/friends/scope")
async def update_scope(req: ScopeUpdateReq, current_user: dict = Depends(get_current_user)) -> dict:
    friend_user_id = validate_uuid(req.friend_user_id, "friend_user_id")
    if req.scope not in VALID_SCOPES:
        raise HTTPException(status_code=400, detail="Invalid scope")
    if friend_user_id == current_user["id"]:
        raise HTTPException(status_code=400, detail="Invalid friend_user_id")

    pair = pair_key(current_user["id"], friend_user_id)
    friendship = await friendships_col.find_one({"pair": pair})
    if not friendship or friendship["status"] != "accepted":
        raise HTTPException(status_code=404, detail="Friendship not found")

    uid = current_user["id"]
    update = {f"scope_{uid}": req.scope}
    if req.scope == "off":
        update[f"enabled_{uid}"] = False
    else:
        update[f"enabled_{uid}"] = True
        update[f"freq_{uid}"] = req.scope if req.scope in VALID_FREQS else "10m"

    await friendships_col.update_one({"pair": pair}, {"$set": update})
    return {"ok": True, "scope": req.scope}


@api.put("/friends/sharing")
async def update_sharing(req: SharingUpdateReq, current_user: dict = Depends(get_current_user)) -> dict:
    friend_user_id = validate_uuid(req.friend_user_id, "friend_user_id")
    if req.freq not in VALID_FREQS:
        raise HTTPException(status_code=400, detail="Invalid freq")
    if friend_user_id == current_user["id"]:
        raise HTTPException(status_code=400, detail="Invalid friend_user_id")
    if req.window_start == req.window_end and not (req.window_start == 0 and req.window_end == 24):
        raise HTTPException(status_code=400, detail="Invalid sharing window")

    pair = pair_key(current_user["id"], friend_user_id)
    friendship = await friendships_col.find_one({"pair": pair})
    if not friendship or friendship["status"] != "accepted":
        raise HTTPException(status_code=404, detail="Friendship not found")

    uid = current_user["id"]
    legacy_scope = "off" if not req.enabled else (req.freq if req.freq in VALID_SCOPES else "10m")

    await friendships_col.update_one(
        {"pair": pair},
        {
            "$set": {
                f"enabled_{uid}": req.enabled,
                f"freq_{uid}": req.freq,
                f"window_start_{uid}": req.window_start,
                f"window_end_{uid}": req.window_end,
                f"scope_{uid}": legacy_scope,
                f"sharing_updated_at_{uid}": utc_iso(),
            }
        },
    )
    return {"ok": True}


# -----------------------------------------------------------------------------
# Routes: location
# -----------------------------------------------------------------------------
@api.post("/locations/ping")
async def location_ping(
    ping: LocationPing,
    request: Request,
    current_user: dict = Depends(get_current_user),
) -> dict:
    await enforce_rate_limit(request, f"location:{current_user['id']}", limit=120, window_seconds=60)

    uid = current_user["id"]
    now_iso = parse_client_timestamp(ping.timestamp)

    geo = await reverse_geocode(ping.latitude, ping.longitude)
    user_timezone = timezone_for_coordinates(ping.latitude, ping.longitude)
    if user_timezone:
        await users_col.update_one({"id": uid}, {"$set": {"timezone": user_timezone}})

    loc_doc = {
        "id": str(uuid.uuid4()),
        "user_id": uid,
        "latitude": ping.latitude,
        "longitude": ping.longitude,
        "accuracy": ping.accuracy,
        "speed": ping.speed,
        "activity": ping.activity or "unknown",
        "availability": ping.availability or "available",
        "timestamp": now_iso,
        **geo,
    }
    await locations_col.insert_one(loc_doc)

    last_visit = await visits_col.find_one(
        {"user_id": uid},
        {"_id": 0},
        sort=[("ended_at", -1)],
    )

    same_place = False
    if last_visit:
        dist = haversine_m(
            last_visit["center_lat"],
            last_visit["center_lng"],
            ping.latitude,
            ping.longitude,
        )
        if dist <= 100:
            same_place = True
        else:
            out_of_range_ping_count = int(last_visit.get("out_of_range_ping_count", 0) or 0) + 1
            await visits_col.update_one(
                {"id": last_visit["id"]},
                {"$set": {"out_of_range_ping_count": out_of_range_ping_count}},
            )
            if out_of_range_ping_count < 3:
                return {"ok": True, "place_name": geo["place_name"]}

    if same_place and last_visit:
        await visits_col.update_one(
            {"id": last_visit["id"]},
            {
                "$set": {
                    "ended_at": now_iso,
                    "place_name": geo["place_name"],
                    "place_category": geo.get("place_category"),
                    "formatted_address": geo.get("formatted_address"),
                    "last_lat": ping.latitude,
                    "last_lng": ping.longitude,
                    "activity": ping.activity or last_visit.get("activity", "unknown"),
                    "availability": ping.availability or last_visit.get("availability", "available"),
                    "out_of_range_ping_count": 0,
                }
            },
        )
    else:
        new_visit = {
            "id": str(uuid.uuid4()),
            "user_id": uid,
            "center_lat": ping.latitude,
            "center_lng": ping.longitude,
            "last_lat": ping.latitude,
            "last_lng": ping.longitude,
            "place_name": geo["place_name"],
            "place_category": geo.get("place_category"),
            "formatted_address": geo.get("formatted_address"),
            "neighborhood": geo.get("neighborhood"),
            "city": geo.get("city"),
            "activity": ping.activity or "unknown",
            "availability": ping.availability or "available",
            "started_at": now_iso,
            "ended_at": now_iso,
            "out_of_range_ping_count": 0,
        }
        await visits_col.insert_one(new_visit)

    return {"ok": True, "place_name": geo["place_name"]}


@api.get("/locations/timeline")
async def get_timeline(
    user_id: Optional[str] = None,
    limit: int = Query(50, ge=1, le=200),
    current_user: dict = Depends(get_current_user),
) -> dict:
    target_id = validate_uuid(user_id, "user_id") if user_id else current_user["id"]
    target_user: Optional[dict] = None
    query: Dict[str, Any] = {"user_id": target_id}

    if target_id != current_user["id"]:
        pair = pair_key(current_user["id"], target_id)
        friendship = await friendships_col.find_one({"pair": pair})
        if not friendship or friendship["status"] != "accepted":
            raise HTTPException(status_code=403, detail="Not friends")

        target_user = await users_col.find_one({"id": target_id}, {"_id": 0, "timezone": 1})
        target_timezone = await timezone_for_user(target_id, target_user)
        share = await get_sharing_filter(friendship, target_id, target_user)
        if share == "BLOCKED":
            return {"visits": [], "blocked": True, "reason": "off", "timezone": target_timezone}
        if share == "OUTSIDE_WINDOW":
            return {"visits": [], "blocked": True, "reason": "window", "timezone": target_timezone}
        query["ended_at"] = {"$lte": utc_iso(share)}
    else:
        target_timezone = await timezone_for_user(target_id, current_user)

    cursor = visits_col.find(query, {"_id": 0}).sort("started_at", -1).limit(limit)
    visits: List[dict] = []
    async for visit in cursor:
        visits.append(visit)

    visits.reverse()
    items: List[dict] = []
    for index, visit in enumerate(visits):
        items.append({**visit, "type": "visit"})
        if index >= len(visits) - 1:
            continue
        nxt = visits[index + 1]
        try:
            end_t = datetime.fromisoformat(visit["ended_at"].replace("Z", "+00:00"))
            start_t = datetime.fromisoformat(nxt["started_at"].replace("Z", "+00:00"))
            duration_s = max(0, int((start_t - end_t).total_seconds()))
            dist_m = round(
                haversine_m(
                    visit.get("last_lat", visit["center_lat"]),
                    visit.get("last_lng", visit["center_lng"]),
                    nxt["center_lat"],
                    nxt["center_lng"],
                )
            )
            if dist_m >= 50:
                items.append(
                    {
                        "type": "transport",
                        "duration": duration_s,
                        "distance_m": dist_m,
                        "from_place": visit.get("place_name"),
                        "to_place": nxt.get("place_name"),
                    }
                )
        except Exception:
            continue

    items.reverse()
    return {"visits": items, "timezone": target_timezone}


@api.get("/locations/latest")
async def get_latest_location(
    user_id: Optional[str] = None,
    current_user: dict = Depends(get_current_user),
) -> Optional[dict]:
    target_id = validate_uuid(user_id, "user_id") if user_id else current_user["id"]
    query: Dict[str, Any] = {"user_id": target_id}

    if target_id != current_user["id"]:
        pair = pair_key(current_user["id"], target_id)
        friendship = await friendships_col.find_one({"pair": pair})
        if not friendship or friendship["status"] != "accepted":
            raise HTTPException(status_code=403, detail="Not friends")

        target_user = await users_col.find_one({"id": target_id}, {"_id": 0, "timezone": 1})
        share = await get_sharing_filter(friendship, target_id, target_user)
        if share in {"BLOCKED", "OUTSIDE_WINDOW"}:
            return None
        query["timestamp"] = {"$lte": utc_iso(share)}

    return await locations_col.find_one(query, {"_id": 0}, sort=[("timestamp", -1)])


@api.get("/locations/recent")
async def recent_locations(
    user_id: Optional[str] = None,
    limit: int = Query(100, ge=1, le=500),
    current_user: dict = Depends(get_current_user),
) -> List[dict]:
    target_id = validate_uuid(user_id, "user_id") if user_id else current_user["id"]
    query: Dict[str, Any] = {"user_id": target_id}

    if target_id != current_user["id"]:
        pair = pair_key(current_user["id"], target_id)
        friendship = await friendships_col.find_one({"pair": pair})
        if not friendship or friendship["status"] != "accepted":
            raise HTTPException(status_code=403, detail="Not friends")

        target_user = await users_col.find_one({"id": target_id}, {"_id": 0, "timezone": 1})
        share = await get_sharing_filter(friendship, target_id, target_user)
        if share in {"BLOCKED", "OUTSIDE_WINDOW"}:
            return []
        query["timestamp"] = {"$lte": utc_iso(share)}

    cursor = locations_col.find(query, {"_id": 0}).sort("timestamp", -1).limit(limit)
    return [ping async for ping in cursor]


@api.get("/locations/narrative/{user_id}")
async def get_day_narrative(
    user_id: str,
    timezone_offset_minutes: int = Query(0, ge=-840, le=840),
    current_user: dict = Depends(get_current_user),
) -> dict:
    target_id = validate_uuid(user_id, "user_id")
    query: Dict[str, Any] = {
        "user_id": target_id,
        "started_at": {"$gte": utc_iso(utc_now() - timedelta(hours=12))},
    }

    if target_id != current_user["id"]:
        pair = pair_key(current_user["id"], target_id)
        friendship = await friendships_col.find_one({"pair": pair})
        if not friendship or friendship["status"] != "accepted":
            raise HTTPException(status_code=403, detail="Not friends")

        target_user = await users_col.find_one({"id": target_id}, {"_id": 0, "display_name": 1, "timezone": 1})
        if not target_user:
            raise HTTPException(status_code=404, detail="User not found")

        share = await get_sharing_filter(friendship, target_id, target_user)
        if share == "BLOCKED":
            return {"narrative": f"{target_user.get('display_name', 'This friend')} has sharing turned off right now."}
        if share == "OUTSIDE_WINDOW":
            return {"narrative": f"{target_user.get('display_name', 'This friend')} is outside the sharing window right now."}
        query["ended_at"] = {"$lte": utc_iso(share)}
    else:
        target_user = await users_col.find_one({"id": target_id}, {"_id": 0, "display_name": 1, "timezone": 1})
        if not target_user:
            raise HTTPException(status_code=404, detail="User not found")

    target_name = clean_display_name(target_user.get("display_name") or "They")

    cursor = visits_col.find(query, {"_id": 0}).sort("started_at", 1)
    visits = [visit async for visit in cursor]

    if not visits:
        return {"narrative": f"Nothing logged from {target_name} in the last 12 hours."}

    lines: List[str] = []
    for visit in visits:
        place = str(visit.get("place_name") or "an unknown place")[:160]
        duration = _format_duration_human(visit.get("started_at", ""), visit.get("ended_at", ""))
        time_str = _format_time_human(visit.get("started_at", ""), timezone_offset_minutes)
        lines.append(f"- {time_str}: {place} ({duration})")
    timeline_text = "\n".join(lines)

    if not ENABLE_EXTERNAL_NARRATIVE_AI or not ANTHROPIC_API_KEY:
        return {"narrative": f"{target_name} has been moving around — {len(visits)} stop(s) in the last 12 hours."}

    prompt = (
        f"Write 1-2 sentences about {target_name}'s last 12 hours based on these visits:\n"
        f"{timeline_text}\n\n"
        f"Be specific about where {target_name} was and how long. "
        f"Sound like a close friend observing {target_name}'s day, not a narrator. "
        f"Be warm but direct. No em dashes. "
        f"No filler phrases. Use the actual place names. "
        f"Always refer to the person by name ({target_name}). Never use pronouns."
    )

    try:
        import anthropic

        anthropic_client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
        message = anthropic_client.messages.create(
            model=ANTHROPIC_MODEL,
            max_tokens=150,
            system=(
                f"You write 1-2 sentence observations about {target_name}'s day based on location visits. "
                f"Always refer to {target_name} by name. Never use pronouns. "
                f"Direct and warm. No em dashes, no filler phrases, no padding. Use actual place names."
            ),
            messages=[{"role": "user", "content": prompt}],
        )
        narrative = (message.content[0].text or "").strip()
        return {"narrative": narrative or f"{target_name} has been moving around — {len(visits)} stop(s) in the last 12 hours."}
    except Exception as exc:
        logger.warning("Narrative generation failed: %s", exc)
        return {"narrative": f"{target_name} has been moving around — {len(visits)} stop(s) in the last 12 hours."}


# -----------------------------------------------------------------------------
# Mount router
# -----------------------------------------------------------------------------
app.include_router(api)
