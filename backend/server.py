"""Consnow backend - FastAPI + MongoDB + JWT auth + location tracking."""
import logging
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import List, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import bcrypt
import httpx
import jwt
from dotenv import load_dotenv
from fastapi import APIRouter, Depends, FastAPI, HTTPException, Query, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, EmailStr, Field
from starlette.middleware.cors import CORSMiddleware
try:
    from timezonefinder import TimezoneFinder
except ImportError:
    TimezoneFinder = None

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

# ---------- Config ----------
MONGO_URL = os.environ["MONGO_URL"]
DB_NAME = os.environ["DB_NAME"]
JWT_SECRET = os.environ["JWT_SECRET"]
JWT_ALGORITHM = os.environ["JWT_ALGORITHM"]
JWT_EXPIRE_MINUTES = int(os.environ["JWT_EXPIRE_MINUTES"])
GOOGLE_GEOCODING_API_KEY = os.environ["GOOGLE_GEOCODING_API_KEY"]
EMERGENT_LLM_KEY = os.environ.get("EMERGENT_LLM_KEY", "")
timezone_finder = TimezoneFinder() if TimezoneFinder else None

VALID_SCOPES = ["10m", "1h", "6h", "12h", "24h", "off"]
SCOPE_TO_MINUTES = {
    "10m": 10,
    "1h": 60,
    "6h": 360,
    "12h": 720,
    "24h": 1440,
    "off": -1,
}

# New granular sharing model
VALID_FREQS = ["10m", "30m", "1h", "6h", "12h", "24h"]
FREQ_TO_MINUTES = {
    "10m": 10, "30m": 30, "1h": 60, "6h": 360, "12h": 720, "24h": 1440,
}


def get_sharing_filter(friendship: dict, owner_id: str):
    """Return either a datetime cutoff (only data ended <= cutoff is visible),
    or a sentinel string 'BLOCKED' / 'OUTSIDE_WINDOW' if nothing visible."""
    # New model has precedence
    if f"freq_{owner_id}" in friendship or f"enabled_{owner_id}" in friendship:
        enabled = friendship.get(f"enabled_{owner_id}", True)
        if not enabled:
            return "BLOCKED"
        freq = friendship.get(f"freq_{owner_id}", "10m")
        win_start = int(friendship.get(f"window_start_{owner_id}", 0))
        win_end = int(friendship.get(f"window_end_{owner_id}", 24))
        current_hour = datetime.now(timezone.utc).hour
        if not hour_in_window(current_hour, win_start, win_end):
            return "OUTSIDE_WINDOW"
        delay_min = FREQ_TO_MINUTES.get(freq, 10)
        return datetime.now(timezone.utc) - timedelta(minutes=delay_min)
    # Legacy scope_<uid>
    scope = friendship.get(f"scope_{owner_id}", "10m")
    if scope == "off":
        return "BLOCKED"
    delay_min = SCOPE_TO_MINUTES.get(scope, 10)
    return datetime.now(timezone.utc) - timedelta(minutes=delay_min)

client = AsyncIOMotorClient(MONGO_URL)
db = client[DB_NAME]

# Collections
users_col = db["users"]
friendships_col = db["friendships"]  # one row per pair


def hour_in_window(hour: int, start: int, end: int) -> bool:
    if start == 0 and end == 24:
        return True
    if start < end:
        return start <= hour < end
    return hour >= start or hour < end


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
    except Exception as e:
        logger.warning(f"Timezone lookup failed: {e}")
        return None


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


async def timezone_for_user(user_id: str, user_doc: Optional[dict] = None) -> str:
    user_timezone = normalize_timezone((user_doc or {}).get("timezone"))
    if user_timezone:
        return user_timezone

    latest = await locations_col.find_one(
        {"user_id": user_id}, {"_id": 0, "latitude": 1, "longitude": 1}, sort=[("timestamp", -1)]
    )
    if latest:
        user_timezone = timezone_for_coordinates(latest["latitude"], latest["longitude"])
        if user_timezone:
            await users_col.update_one({"id": user_id}, {"$set": {"timezone": user_timezone}})
            return user_timezone

    latest_visit = await visits_col.find_one(
        {"user_id": user_id}, {"_id": 0, "last_lat": 1, "last_lng": 1, "center_lat": 1, "center_lng": 1},
        sort=[("ended_at", -1)]
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


locations_col = db["locations"]
visits_col = db["visits"]

app = FastAPI(title="Consnow API")
api = APIRouter(prefix="/api")
security = HTTPBearer()

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger("consnow")


# ---------- Models ----------
class SignupReq(BaseModel):
    email: EmailStr
    password: str = Field(min_length=6, max_length=128)
    display_name: str = Field(min_length=1, max_length=60)
    username: str = Field(min_length=3, max_length=30, pattern=r"^[a-zA-Z0-9_]+$")


class LoginReq(BaseModel):
    email: EmailStr
    password: str


class AuthResp(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: dict


class FriendRequestReq(BaseModel):
    target_user_id: str


class FriendRespondReq(BaseModel):
    friendship_id: str
    accept: bool


class ScopeUpdateReq(BaseModel):
    friend_user_id: str
    scope: str  # 10m/1h/6h/12h/24h/off


class SharingUpdateReq(BaseModel):
    friend_user_id: str
    enabled: bool
    freq: str  # 10m/30m/1h/6h/12h/24h
    window_start: int = Field(ge=0, le=23)
    window_end: int = Field(ge=1, le=24)


class LocationPing(BaseModel):
    latitude: float
    longitude: float
    accuracy: Optional[float] = None
    speed: Optional[float] = None  # m/s
    activity: Optional[str] = None  # stationary|walking|running|cycling|automotive|unknown
    availability: Optional[str] = None  # available|maybe|busy
    timestamp: Optional[str] = None  # ISO; defaults to now


# ---------- Helpers ----------
def hash_password(plain: str) -> str:
    return bcrypt.hashpw(plain.encode(), bcrypt.gensalt()).decode()


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode(), hashed.encode())
    except Exception:
        return False


def create_token(user_id: str) -> str:
    payload = {
        "sub": user_id,
        "exp": datetime.now(timezone.utc) + timedelta(minutes=JWT_EXPIRE_MINUTES),
        "iat": datetime.now(timezone.utc),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


async def get_current_user(creds: HTTPAuthorizationCredentials = Depends(security)) -> dict:
    try:
        payload = jwt.decode(creds.credentials, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        user_id = payload.get("sub")
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")

    user = await users_col.find_one({"id": user_id}, {"_id": 0, "password_hash": 0})
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return user


def public_user(u: dict) -> dict:
    return {
        "id": u["id"],
        "email": u.get("email"),
        "username": u.get("username"),
        "display_name": u.get("display_name"),
    }


async def reverse_geocode(lat: float, lng: float) -> dict:
    """Use Google Places API (New) Nearby Search to get a nearby named place."""
    # Types that indicate geographic/road features rather than named establishments
    _GEO_TYPES = {"route", "political", "street_address", "intersection", "plus_code",
                  "administrative_area_level_1", "administrative_area_level_2",
                  "administrative_area_level_3", "locality", "sublocality",
                  "sublocality_level_1", "postal_code", "country"}
    try:
        async with httpx.AsyncClient(timeout=8.0) as cli:
            r = await cli.post(
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
            data = r.json()
            places = data.get("places", [])
            if not places:
                return {"place_name": f"{lat:.4f}, {lng:.4f}", "neighborhood": None, "city": None}

            # Prefer named establishments; fall back to the first result if all are geo types
            best = next(
                (p for p in places if not _GEO_TYPES.intersection(p.get("types", []))),
                places[0],
            )
            place_name = best.get("displayName", {}).get("text") or f"{lat:.4f}, {lng:.4f}"
            formatted = best.get("formattedAddress", "")
            # Pick the most specific type as the category, skipping geo and generic types
            _GENERIC_TYPES = {"establishment", "point_of_interest", "premise"}
            specific = [
                t for t in best.get("types", [])
                if t not in _GEO_TYPES and t not in _GENERIC_TYPES
            ]
            place_category = specific[0] if specific else None
            return {
                "place_name": place_name,
                "formatted_address": formatted,
                "neighborhood": None,
                "city": None,
                "place_category": place_category,
            }
    except Exception as e:
        logger.warning(f"Places lookup failed: {e}")
        return {"place_name": f"{lat:.4f}, {lng:.4f}", "neighborhood": None, "city": None, "place_category": None}


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Distance in meters between two coords."""
    from math import asin, cos, radians, sin, sqrt
    R = 6371000.0
    p1, p2 = radians(lat1), radians(lat2)
    dp = radians(lat2 - lat1)
    dl = radians(lon2 - lon1)
    a = sin(dp / 2) ** 2 + cos(p1) * cos(p2) * sin(dl / 2) ** 2
    return 2 * R * asin(sqrt(a))


def pair_key(a: str, b: str) -> List[str]:
    return sorted([a, b])


# ---------- Routes: Auth ----------
@api.get("/")
async def root():
    return {"app": "Consnow", "status": "ok"}


@api.post("/auth/signup", response_model=AuthResp)
async def signup(req: SignupReq):
    email = req.email.lower()
    if await users_col.find_one({"email": email}):
        raise HTTPException(status_code=400, detail="Email already registered")
    if await users_col.find_one({"username": req.username.lower()}):
        raise HTTPException(status_code=400, detail="Username already taken")

    import uuid
    user_id = str(uuid.uuid4())
    doc = {
        "id": user_id,
        "email": email,
        "username": req.username.lower(),
        "display_name": req.display_name,
        "password_hash": hash_password(req.password),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await users_col.insert_one(doc)
    token = create_token(user_id)
    return AuthResp(access_token=token, user=public_user(doc))


@api.post("/auth/login", response_model=AuthResp)
async def login(req: LoginReq):
    user = await users_col.find_one({"email": req.email.lower()})
    if not user or not verify_password(req.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    token = create_token(user["id"])
    return AuthResp(access_token=token, user=public_user(user))


@api.get("/auth/me")
async def me(current_user: dict = Depends(get_current_user)):
    return current_user


# ---------- Routes: Users / Search ----------
@api.get("/users/search")
async def search_users(q: str, current_user: dict = Depends(get_current_user)):
    if not q or len(q.strip()) < 2:
        return []
    q = q.strip().lower()
    cursor = users_col.find(
        {
            "$and": [
                {"id": {"$ne": current_user["id"]}},
                {
                    "$or": [
                        {"username": {"$regex": q, "$options": "i"}},
                        {"display_name": {"$regex": q, "$options": "i"}},
                        {"email": {"$regex": q, "$options": "i"}},
                    ]
                },
            ]
        },
        {"_id": 0, "password_hash": 0, "email": 0},
    ).limit(20)

    results = []
    async for u in cursor:
        # Check friendship status
        pair = pair_key(current_user["id"], u["id"])
        f = await friendships_col.find_one({"pair": pair}, {"_id": 0})
        status_val = "none"
        if f:
            status_val = f["status"]
        results.append({**u, "friendship_status": status_val})
    return results


# ---------- Routes: Friendships ----------
@api.post("/friends/request")
async def send_friend_request(req: FriendRequestReq, current_user: dict = Depends(get_current_user)):
    target = await users_col.find_one({"id": req.target_user_id})
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    if target["id"] == current_user["id"]:
        raise HTTPException(status_code=400, detail="Cannot friend yourself")

    pair = pair_key(current_user["id"], target["id"])
    existing = await friendships_col.find_one({"pair": pair})
    if existing:
        raise HTTPException(status_code=400, detail=f"Already {existing['status']}")

    import uuid
    f = {
        "id": str(uuid.uuid4()),
        "pair": pair,
        "requester_id": current_user["id"],
        "target_id": target["id"],
        "status": "pending",  # pending|accepted|rejected
        # scope granted by each user to the OTHER party
        f"scope_{current_user['id']}": "10m",
        f"scope_{target['id']}": "10m",
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await friendships_col.insert_one(f)
    return {"ok": True, "friendship_id": f["id"]}


@api.post("/friends/respond")
async def respond_friend_request(req: FriendRespondReq, current_user: dict = Depends(get_current_user)):
    f = await friendships_col.find_one({"id": req.friendship_id})
    if not f:
        raise HTTPException(status_code=404, detail="Request not found")
    if f["target_id"] != current_user["id"]:
        raise HTTPException(status_code=403, detail="Not authorized")
    if f["status"] != "pending":
        raise HTTPException(status_code=400, detail="Already responded")

    new_status = "accepted" if req.accept else "rejected"
    await friendships_col.update_one({"id": req.friendship_id}, {"$set": {"status": new_status}})
    return {"ok": True, "status": new_status}


@api.get("/friends/list")
async def list_friends(current_user: dict = Depends(get_current_user)):
    uid = current_user["id"]
    cursor = friendships_col.find({"pair": uid}, {"_id": 0})
    # actually filter by uid in pair array
    cursor = friendships_col.find({"pair": {"$in": [uid]}}, {"_id": 0})

    friends = []
    pending_incoming = []
    pending_outgoing = []
    async for f in cursor:
        other_id = f["pair"][0] if f["pair"][1] == uid else f["pair"][1]
        other = await users_col.find_one({"id": other_id}, {"_id": 0, "password_hash": 0, "email": 0})
        if not other:
            continue
        entry = {
            "friendship_id": f["id"],
            "user": other,
            "status": f["status"],
            "scope_i_grant": f.get(f"scope_{uid}", "10m"),  # legacy
            "sharing_i_grant": {
                "enabled": f.get(f"enabled_{uid}", True),
                "freq": f.get(f"freq_{uid}", "10m"),
                "window_start": f.get(f"window_start_{uid}", 0),
                "window_end": f.get(f"window_end_{uid}", 24),
            },
        }
        if f["status"] == "accepted":
            # last seen
            last = await locations_col.find_one(
                {"user_id": other_id}, {"_id": 0}, sort=[("timestamp", -1)]
            )
            if last:
                entry["last_seen"] = {
                    "place_name": last.get("place_name"),
                    "timestamp": last.get("timestamp"),
                    "activity": last.get("activity"),
                    "availability": last.get("availability"),
                }
            friends.append(entry)
        elif f["status"] == "pending":
            if f["requester_id"] == uid:
                pending_outgoing.append(entry)
            else:
                pending_incoming.append(entry)

    return {
        "friends": friends,
        "pending_incoming": pending_incoming,
        "pending_outgoing": pending_outgoing,
    }


@api.put("/friends/scope")
async def update_scope(req: ScopeUpdateReq, current_user: dict = Depends(get_current_user)):
    if req.scope not in VALID_SCOPES:
        raise HTTPException(status_code=400, detail="Invalid scope")
    pair = pair_key(current_user["id"], req.friend_user_id)
    f = await friendships_col.find_one({"pair": pair})
    if not f or f["status"] != "accepted":
        raise HTTPException(status_code=404, detail="Friendship not found")
    await friendships_col.update_one(
        {"pair": pair}, {"$set": {f"scope_{current_user['id']}": req.scope}}
    )
    return {"ok": True, "scope": req.scope}


@api.put("/friends/sharing")
async def update_sharing(req: SharingUpdateReq, current_user: dict = Depends(get_current_user)):
    if req.freq not in VALID_FREQS:
        raise HTTPException(status_code=400, detail="Invalid freq")
    pair = pair_key(current_user["id"], req.friend_user_id)
    f = await friendships_col.find_one({"pair": pair})
    if not f or f["status"] != "accepted":
        raise HTTPException(status_code=404, detail="Friendship not found")
    uid = current_user["id"]
    # Also derive legacy scope_<uid> for backward compat
    legacy_scope = "off" if not req.enabled else (
        req.freq if req.freq in VALID_SCOPES else "10m"
    )
    await friendships_col.update_one(
        {"pair": pair},
        {"$set": {
            f"enabled_{uid}": req.enabled,
            f"freq_{uid}": req.freq,
            f"window_start_{uid}": req.window_start,
            f"window_end_{uid}": req.window_end,
            f"scope_{uid}": legacy_scope,
        }},
    )
    return {"ok": True}


# ---------- Routes: Location ----------
@api.post("/locations/ping")
async def location_ping(ping: LocationPing, current_user: dict = Depends(get_current_user)):
    uid = current_user["id"]
    now_iso = ping.timestamp or datetime.now(timezone.utc).isoformat()

    # Reverse geocode
    geo = await reverse_geocode(ping.latitude, ping.longitude)
    user_timezone = timezone_for_coordinates(ping.latitude, ping.longitude)
    if user_timezone:
        await users_col.update_one({"id": uid}, {"$set": {"timezone": user_timezone}})

    import uuid
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

    # Update/create visit (group consecutive pings at same place)
    # Sort by ended_at so we find the most recently *active* visit, not just most recently started.
    last_visit = await visits_col.find_one(
        {"user_id": uid}, {"_id": 0}, sort=[("ended_at", -1)]
    )

    same_place = False
    if last_visit:
        dist = haversine_m(
            last_visit["center_lat"], last_visit["center_lng"], ping.latitude, ping.longitude
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

    if same_place:
        await visits_col.update_one(
            {"id": last_visit["id"]},
            {
                "$set": {
                    "ended_at": now_iso,
                    "place_name": geo["place_name"],  # refresh if changed
                    "place_category": geo.get("place_category"),
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
    limit: int = 50,
    current_user: dict = Depends(get_current_user),
):
    target_id = user_id or current_user["id"]
    target_timezone = "UTC"
    if target_id != current_user["id"]:
        pair = pair_key(current_user["id"], target_id)
        f = await friendships_col.find_one({"pair": pair})
        if not f or f["status"] != "accepted":
            raise HTTPException(status_code=403, detail="Not friends")
        target_user = await users_col.find_one({"id": target_id}, {"_id": 0, "timezone": 1})
        target_timezone = await timezone_for_user(target_id, target_user)
        share = get_sharing_filter(f, target_id)
        if share == "BLOCKED":
            return {"visits": [], "blocked": True, "reason": "off", "timezone": target_timezone}
        if share == "OUTSIDE_WINDOW":
            return {"visits": [], "blocked": True, "reason": "window", "timezone": target_timezone}
        cursor = visits_col.find({"user_id": target_id}, {"_id": 0}).sort("started_at", -1).limit(limit)
    else:
        target_timezone = await timezone_for_user(target_id, current_user)
        cursor = visits_col.find({"user_id": target_id}, {"_id": 0}).sort("started_at", -1).limit(limit)

    # Collect visits
    visits = []
    async for v in cursor:
        visits.append(v)

    # Reverse to chronological order, then interleave transport segments
    visits.reverse()
    items = []
    for i, v in enumerate(visits):
        items.append({**v, "type": "visit"})
        if i < len(visits) - 1:
            nxt = visits[i + 1]
            try:
                end_t = datetime.fromisoformat(v["ended_at"].replace("Z", "+00:00"))
                start_t = datetime.fromisoformat(nxt["started_at"].replace("Z", "+00:00"))
                duration_s = max(0, int((start_t - end_t).total_seconds()))
                dist_m = round(haversine_m(
                    v.get("last_lat", v["center_lat"]),
                    v.get("last_lng", v["center_lng"]),
                    nxt["center_lat"],
                    nxt["center_lng"],
                ))
                if dist_m >= 50:  # skip GPS-drift noise
                    items.append({
                        "type": "transport",
                        "duration": duration_s,
                        "distance_m": dist_m,
                        "from_place": v.get("place_name"),
                        "to_place": nxt.get("place_name"),
                    })
            except Exception:
                pass

    items.reverse()
    return {"visits": items, "timezone": target_timezone}


@api.get("/locations/latest")
async def get_latest_location(
    user_id: Optional[str] = None,
    current_user: dict = Depends(get_current_user),
):
    target_id = user_id or current_user["id"]
    if target_id != current_user["id"]:
        pair = pair_key(current_user["id"], target_id)
        f = await friendships_col.find_one({"pair": pair})
        if not f or f["status"] != "accepted":
            raise HTTPException(status_code=403, detail="Not friends")
        share = get_sharing_filter(f, target_id)
        if share == "BLOCKED" or share == "OUTSIDE_WINDOW":
            return None
        last = await locations_col.find_one(
            {"user_id": target_id, "timestamp": {"$lte": share.isoformat()}},
            {"_id": 0},
            sort=[("timestamp", -1)],
        )
    else:
        last = await locations_col.find_one(
            {"user_id": target_id}, {"_id": 0}, sort=[("timestamp", -1)]
        )
    return last


@api.get("/locations/recent")
async def recent_locations(
    user_id: Optional[str] = None,
    limit: int = 100,
    current_user: dict = Depends(get_current_user),
):
    """Recent raw pings for map display."""
    target_id = user_id or current_user["id"]
    if target_id != current_user["id"]:
        pair = pair_key(current_user["id"], target_id)
        f = await friendships_col.find_one({"pair": pair})
        if not f or f["status"] != "accepted":
            raise HTTPException(status_code=403, detail="Not friends")
        their_scope = f.get(f"scope_{target_id}", "10m")
        if their_scope == "off":
            return []
        max_age_min = SCOPE_TO_MINUTES[their_scope]
        cutoff = datetime.now(timezone.utc) - timedelta(minutes=max_age_min)
        cursor = locations_col.find(
            {"user_id": target_id, "timestamp": {"$lte": cutoff.isoformat()}},
            {"_id": 0},
        ).sort("timestamp", -1).limit(limit)
    else:
        cursor = locations_col.find({"user_id": target_id}, {"_id": 0}).sort("timestamp", -1).limit(limit)

    pings = []
    async for p in cursor:
        pings.append(p)
    return pings


def _format_duration_human(start_iso: str, end_iso: str) -> str:
    try:
        s = datetime.fromisoformat(start_iso.replace("Z", "+00:00"))
        e = datetime.fromisoformat(end_iso.replace("Z", "+00:00"))
        mins = max(0, int((e - s).total_seconds() // 60))
        if mins < 1:
            return "briefly"
        if mins < 60:
            return f"{mins} min"
        h = mins // 60
        m = mins % 60
        return f"{h}h" if m == 0 else f"{h}h {m}m"
    except Exception:
        return ""


def _format_time_human(iso: str, timezone_offset_minutes: int = 0) -> str:
    try:
        d = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        d = d - timedelta(minutes=timezone_offset_minutes)
        return d.strftime("%-I:%M %p")
    except Exception:
        return ""


@api.get("/locations/narrative/{user_id}")
async def get_day_narrative(
    user_id: str,
    timezone_offset_minutes: int = Query(0, ge=-840, le=840),
    current_user: dict = Depends(get_current_user),
):
    """Generate a warm, human, AI narrative of the last 12 hours of visits."""
    target_id = user_id

    # Fetch the target user's display name (so we can reference them by name in the prompt)
    target_user = await users_col.find_one({"id": target_id}, {"_id": 0, "display_name": 1})
    if not target_user:
        raise HTTPException(status_code=404, detail="User not found")
    target_name = target_user.get("display_name", "They")

    # Auth + scope check (same pattern as timeline)
    if target_id != current_user["id"]:
        pair = pair_key(current_user["id"], target_id)
        f = await friendships_col.find_one({"pair": pair})
        if not f or f["status"] != "accepted":
            raise HTTPException(status_code=403, detail="Not friends")
        their_scope = f.get(f"scope_{target_id}", "10m")
        if their_scope == "off":
            return {"narrative": f"{target_name} has sharing turned off right now."}
        max_age_min = SCOPE_TO_MINUTES[their_scope]
        cutoff_scope = datetime.now(timezone.utc) - timedelta(minutes=max_age_min)
        time_filter = {"ended_at": {"$lte": cutoff_scope.isoformat()}}
    else:
        time_filter = {}

    # Last 12 hours window
    twelve_hours_ago = (datetime.now(timezone.utc) - timedelta(hours=12)).isoformat()
    query = {
        "user_id": target_id,
        "started_at": {"$gte": twelve_hours_ago},
        **time_filter,
    }
    cursor = visits_col.find(query, {"_id": 0}).sort("started_at", 1)
    visits = []
    async for v in cursor:
        visits.append(v)

    # Build readable timeline string
    if not visits:
        timeline_text = "No visits in the last 12 hours."
    else:
        lines = []
        for v in visits:
            place = v.get("place_name", "an unknown place")
            duration = _format_duration_human(v.get("started_at", ""), v.get("ended_at", ""))
            time_str = _format_time_human(v.get("started_at", ""), timezone_offset_minutes)
            lines.append(f"- {time_str}: {place} ({duration})")
        timeline_text = "\n".join(lines)

    is_self = target_id == current_user["id"]

    if not EMERGENT_LLM_KEY:
        if not visits:
            return {"narrative": f"Nothing logged from {target_name} in the last 12 hours."}
        return {"narrative": f"{target_name} has been moving around — {len(visits)} stop(s) in the last 12 hours."}

    prompt = (
        f"Write 1-2 sentences about {target_name}'s last 12 hours based on these visits:\n"
        f"{timeline_text}\n\n"
        f"Be specific about where {target_name} was and how long. "
        f"Sound like a close friend observing {target_name}'s day, not a narrator. "
        f"Be warm but direct. No em dashes. "
        f"No filler phrases like 'sounds like' or 'keeping things low-key'. "
        f"If {target_name} barely moved, say that simply. Use the actual place names. "
        f"Always refer to the person by name ({target_name}). Never use pronouns like 'he', 'she', 'they', or 'you'."
    )

    try:
        import anthropic
        client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY", ""))
        message = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=150,
            system=(
                f"You write 1-2 sentence observations about {target_name}'s day based on location visits. "
                f"Always refer to {target_name} by name. Never use pronouns. "
                f"You sound like a close friend, not a narrator. Direct and warm. "
                f"No em dashes, no filler phrases, no padding. Use actual place names. "
                f"If {target_name} barely moved, say it simply."
            ),
            messages=[{"role": "user", "content": prompt}]
        )
        narrative = (message.content[0].text or "").strip()
        if not narrative:
            narrative = f"Quiet day so far for {target_name}."
        return {"narrative": narrative}
    except Exception as e:
        logger.warning(f"Narrative generation failed: {e}")
        if not visits:
            return {"narrative": f"Nothing logged from {target_name} in the last 12 hours."}
        return {"narrative": f"{target_name} has been moving around — {len(visits)} stop(s) in the last 12 hours."}


# Mount router
app.include_router(api)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
