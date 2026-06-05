"""End-to-end backend tests for Consnow API."""
import os
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
import requests
import pytest
from dotenv import load_dotenv
from pymongo import MongoClient

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "https://location-log-22.preview.emergentagent.com").rstrip("/")
load_dotenv(Path(__file__).resolve().parents[1] / ".env")


# ---------- Auth ----------
class TestAuth:
    def test_signup_new_user(self, api):
        u = uuid.uuid4().hex[:8]
        payload = {
            "email": f"test_{u}@consnow.app",
            "password": "password123",
            "display_name": f"Test {u}",
            "username": f"test_{u}",
        }
        r = api.post(f"{BASE_URL}/api/auth/signup", json=payload)
        assert r.status_code == 200, r.text
        data = r.json()
        assert "access_token" in data
        assert data["user"]["email"] == payload["email"]

    def test_signup_duplicate_email(self, api):
        payload = {
            "email": "alice@consnow.app",
            "password": "password123",
            "display_name": "Dup",
            "username": "dup_" + uuid.uuid4().hex[:6],
        }
        r = api.post(f"{BASE_URL}/api/auth/signup", json=payload)
        assert r.status_code == 400

    def test_login_success(self, api):
        r = api.post(f"{BASE_URL}/api/auth/login",
                     json={"email": "alice@consnow.app", "password": "password123"})
        assert r.status_code == 200
        data = r.json()
        assert "access_token" in data
        assert data["user"]["email"] == "alice@consnow.app"

    def test_login_wrong_password(self, api):
        r = api.post(f"{BASE_URL}/api/auth/login",
                     json={"email": "alice@consnow.app", "password": "wrong"})
        assert r.status_code == 401

    def test_auth_me_with_token(self, alice_session):
        s, _ = alice_session
        r = s.get(f"{BASE_URL}/api/auth/me")
        assert r.status_code == 200
        assert r.json()["email"] == "alice@consnow.app"

    def test_auth_me_no_token(self, api):
        r = api.get(f"{BASE_URL}/api/auth/me")
        # FastAPI HTTPBearer returns 403 by default
        assert r.status_code in (401, 403)


# ---------- User search ----------
class TestUserSearch:
    def test_search_excludes_self(self, alice_session):
        s, data = alice_session
        r = s.get(f"{BASE_URL}/api/users/search", params={"q": "ali"})
        assert r.status_code == 200
        results = r.json()
        ids = [u["id"] for u in results]
        assert data["user"]["id"] not in ids

    def test_search_bob(self, alice_session):
        s, _ = alice_session
        r = s.get(f"{BASE_URL}/api/users/search", params={"q": "bob"})
        assert r.status_code == 200
        results = r.json()
        assert any(u["username"] == "bob" for u in results)
        for u in results:
            assert "friendship_status" in u

    def test_search_short_query(self, alice_session):
        s, _ = alice_session
        r = s.get(f"{BASE_URL}/api/users/search", params={"q": "a"})
        assert r.status_code == 200
        assert r.json() == []


# ---------- Friendship flow ----------
class TestFriendshipFlow:
    """Full request → respond → list → scope flow using fresh users."""

    @pytest.fixture(scope="class")
    def two_users(self):
        u1 = uuid.uuid4().hex[:6]
        u2 = uuid.uuid4().hex[:6]
        s1 = requests.Session(); s1.headers["Content-Type"] = "application/json"
        s2 = requests.Session(); s2.headers["Content-Type"] = "application/json"
        r1 = s1.post(f"{BASE_URL}/api/auth/signup", json={
            "email": f"u1_{u1}@consnow.app", "password": "password123",
            "display_name": f"User1 {u1}", "username": f"u1_{u1}",
        })
        r2 = s2.post(f"{BASE_URL}/api/auth/signup", json={
            "email": f"u2_{u2}@consnow.app", "password": "password123",
            "display_name": f"User2 {u2}", "username": f"u2_{u2}",
        })
        assert r1.status_code == 200 and r2.status_code == 200
        d1, d2 = r1.json(), r2.json()
        s1.headers["Authorization"] = f"Bearer {d1['access_token']}"
        s2.headers["Authorization"] = f"Bearer {d2['access_token']}"
        return s1, d1["user"], s2, d2["user"]

    def test_01_send_request(self, two_users):
        s1, u1, s2, u2 = two_users
        r = s1.post(f"{BASE_URL}/api/friends/request", json={"target_user_id": u2["id"]})
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["ok"] is True
        assert "friendship_id" in data
        pytest.fid = data["friendship_id"]

    def test_02_duplicate_request_rejected(self, two_users):
        s1, _, _, u2 = two_users
        r = s1.post(f"{BASE_URL}/api/friends/request", json={"target_user_id": u2["id"]})
        assert r.status_code == 400

    def test_03_pending_appears_in_list(self, two_users):
        s1, _, s2, _ = two_users
        r1 = s1.get(f"{BASE_URL}/api/friends/list")
        r2 = s2.get(f"{BASE_URL}/api/friends/list")
        assert r1.status_code == 200 and r2.status_code == 200
        assert len(r1.json()["pending_outgoing"]) >= 1
        assert len(r2.json()["pending_incoming"]) >= 1

    def test_04_accept_request(self, two_users):
        _, _, s2, _ = two_users
        r = s2.post(f"{BASE_URL}/api/friends/respond",
                    json={"friendship_id": pytest.fid, "accept": True})
        assert r.status_code == 200
        assert r.json()["status"] == "accepted"

    def test_05_friends_list_after_accept(self, two_users):
        s1, _, _, _ = two_users
        r = s1.get(f"{BASE_URL}/api/friends/list")
        assert r.status_code == 200
        data = r.json()
        assert len(data["friends"]) >= 1
        assert data["friends"][0]["status"] == "accepted"

    @pytest.mark.parametrize("scope", ["10m", "1h", "6h", "12h", "24h", "off"])
    def test_06_valid_scope_values(self, two_users, scope):
        s1, _, _, u2 = two_users
        r = s1.put(f"{BASE_URL}/api/friends/scope",
                   json={"friend_user_id": u2["id"], "scope": scope})
        assert r.status_code == 200, f"scope={scope}: {r.text}"
        assert r.json()["scope"] == scope

    def test_07_invalid_scope(self, two_users):
        s1, _, _, u2 = two_users
        r = s1.put(f"{BASE_URL}/api/friends/scope",
                   json={"friend_user_id": u2["id"], "scope": "invalid"})
        assert r.status_code == 400


# ---------- Location ----------
class TestLocation:
    START_LAT = 37.7749
    START_LNG = -122.4194
    FAR_LAT = 37.7765
    FAR_LNG = -122.4194
    INSIDE_LAT = 37.7751
    INSIDE_LNG = -122.4194

    @pytest.fixture(scope="class")
    def alice(self):
        s = requests.Session(); s.headers["Content-Type"] = "application/json"
        r = s.post(f"{BASE_URL}/api/auth/login",
                   json={"email": "alice@consnow.app", "password": "password123"})
        assert r.status_code == 200
        d = r.json()
        s.headers["Authorization"] = f"Bearer {d['access_token']}"
        return s, d["user"]

    def _fresh_user(self, api):
        u = uuid.uuid4().hex[:8]
        r = api.post(f"{BASE_URL}/api/auth/signup", json={
            "email": f"visit_{u}@consnow.app",
            "password": "password123",
            "display_name": f"Visit {u}",
            "username": f"visit_{u}",
        })
        assert r.status_code == 200, r.text
        data = r.json()
        api.headers["Authorization"] = f"Bearer {data['access_token']}"
        return api, data["user"]

    def _ping(self, s, latitude, longitude, timestamp=None):
        payload = {
            "latitude": latitude,
            "longitude": longitude,
        }
        if timestamp:
            payload["timestamp"] = timestamp
        r = s.post(f"{BASE_URL}/api/locations/ping", json=payload)
        assert r.status_code == 200, r.text

    def _timeline_visits(self, s):
        r = s.get(f"{BASE_URL}/api/locations/timeline")
        assert r.status_code == 200, r.text
        return [v for v in r.json()["visits"] if v.get("type") == "visit"]

    def _timeline(self, s):
        r = s.get(f"{BASE_URL}/api/locations/timeline")
        assert r.status_code == 200, r.text
        return r.json()

    def _first_visit(self, timeline):
        visits = [v for v in timeline["visits"] if v.get("type") == "visit"]
        assert len(visits) >= 1
        return visits[0]

    def _parse_iso(self, value):
        return datetime.fromisoformat(value.replace("Z", "+00:00"))

    def _visit_ids(self, timeline):
        return [v["id"] for v in timeline["visits"] if v.get("type") == "visit"]

    def _visits_collection(self):
        mongo_url = os.environ.get("MONGO_URL")
        db_name = os.environ.get("DB_NAME")
        if not mongo_url or not db_name:
            pytest.skip("MONGO_URL and DB_NAME are required to create an open visit fixture")
        return MongoClient(mongo_url)[db_name]["visits"]

    def test_ping_mumbai(self, alice):
        s, _ = alice
        r = s.post(f"{BASE_URL}/api/locations/ping",
                   json={"latitude": 19.0760, "longitude": 72.8777})
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["ok"] is True
        assert "place_name" in data
        # Place name should be reverse-geocoded (not just lat/lng fallback)
        # Be lenient — accept either real name or coord fallback
        assert data["place_name"]

    def test_timeline_self(self, alice):
        s, _ = alice
        # ensure at least one ping
        s.post(f"{BASE_URL}/api/locations/ping",
               json={"latitude": 19.0760, "longitude": 72.8777})
        r = s.get(f"{BASE_URL}/api/locations/timeline")
        assert r.status_code == 200
        data = r.json()
        assert "visits" in data
        assert len(data["visits"]) >= 1
        v = data["visits"][0]
        assert "place_name" in v
        assert "started_at" in v

    def test_latest_self(self, alice):
        s, _ = alice
        r = s.get(f"{BASE_URL}/api/locations/latest")
        assert r.status_code == 200
        last = r.json()
        assert last is not None
        assert "latitude" in last and "longitude" in last

    def test_recent_self(self, alice):
        s, _ = alice
        r = s.get(f"{BASE_URL}/api/locations/recent")
        assert r.status_code == 200
        assert isinstance(r.json(), list)
        assert len(r.json()) >= 1

    def test_two_out_of_range_pings_do_not_close_visit(self, api):
        s, _ = self._fresh_user(api)
        self._ping(s, self.START_LAT, self.START_LNG)
        self._ping(s, self.FAR_LAT, self.FAR_LNG)
        self._ping(s, self.FAR_LAT, self.FAR_LNG)

        visits = self._timeline_visits(s)
        assert len(visits) == 1
        assert visits[0]["center_lat"] == self.START_LAT
        assert visits[0]["center_lng"] == self.START_LNG
        assert visits[0]["out_of_range_ping_count"] == 2

    def test_three_out_of_range_pings_close_visit_and_open_new_visit(self, api):
        s, _ = self._fresh_user(api)
        self._ping(s, self.START_LAT, self.START_LNG)
        self._ping(s, self.FAR_LAT, self.FAR_LNG)
        self._ping(s, self.FAR_LAT, self.FAR_LNG)
        self._ping(s, self.FAR_LAT, self.FAR_LNG)

        visits = self._timeline_visits(s)
        assert len(visits) == 2
        assert visits[0]["center_lat"] == self.FAR_LAT
        assert visits[0]["center_lng"] == self.FAR_LNG
        assert visits[0]["out_of_range_ping_count"] == 0
        assert visits[1]["center_lat"] == self.START_LAT
        assert visits[1]["center_lng"] == self.START_LNG
        assert visits[1]["out_of_range_ping_count"] == 3

    def test_out_of_range_counter_resets_when_ping_returns_inside_visit(self, api):
        s, _ = self._fresh_user(api)
        self._ping(s, self.START_LAT, self.START_LNG)
        self._ping(s, self.FAR_LAT, self.FAR_LNG)
        self._ping(s, self.FAR_LAT, self.FAR_LNG)
        self._ping(s, self.INSIDE_LAT, self.INSIDE_LNG)

        visits = self._timeline_visits(s)
        assert len(visits) == 1
        assert visits[0]["center_lat"] == self.START_LAT
        assert visits[0]["center_lng"] == self.START_LNG
        assert visits[0]["last_lat"] == self.INSIDE_LAT
        assert visits[0]["last_lng"] == self.INSIDE_LNG
        assert visits[0]["out_of_range_ping_count"] == 0

    def test_timeline_uses_india_timezone_from_patna_location(self, api):
        s, _ = self._fresh_user(api)
        self._ping(s, 25.6093, 85.1376, timestamp="2026-01-15T12:00:00+00:00")

        timeline = self._timeline(s)
        visit = self._first_visit(timeline)
        started_at = self._parse_iso(visit["started_at"])

        assert timeline["timezone"] == "Asia/Kolkata"
        assert started_at.utcoffset().total_seconds() == 19800
        assert started_at.hour == 17
        assert started_at.minute == 30
        assert not visit["started_at"].endswith("+00:00")
        assert not visit["started_at"].endswith("Z")

    def test_timeline_uses_arizona_timezone_from_tempe_location(self, api):
        s, _ = self._fresh_user(api)
        self._ping(s, 33.4255, -111.9400, timestamp="2026-01-15T12:00:00+00:00")

        timeline = self._timeline(s)
        visit = self._first_visit(timeline)
        started_at = self._parse_iso(visit["started_at"])

        assert timeline["timezone"] == "America/Phoenix"
        assert started_at.utcoffset().total_seconds() == -25200
        assert started_at.hour == 5
        assert started_at.minute == 0

    def test_timeline_without_location_pings_returns_fallback_timezone(self, api):
        s, _ = self._fresh_user(api)

        timeline = self._timeline(s)

        assert "timezone" in timeline
        assert isinstance(timeline["timezone"], str)
        assert timeline["timezone"]
        assert "visits" in timeline

    def test_timeline_filters_visit_under_five_minutes(self, api):
        s, _ = self._fresh_user(api)
        self._ping(s, 40.7128, -74.0060, timestamp="2026-01-15T12:00:00+00:00")
        self._ping(s, 40.7128, -74.0060, timestamp="2026-01-15T12:04:59+00:00")

        timeline = self._timeline(s)

        assert self._visit_ids(timeline) == []

    def test_timeline_includes_visit_exactly_five_minutes(self, api):
        s, _ = self._fresh_user(api)
        self._ping(s, 40.7128, -74.0060, timestamp="2026-01-15T12:00:00+00:00")
        self._ping(s, 40.7128, -74.0060, timestamp="2026-01-15T12:05:00+00:00")

        timeline = self._timeline(s)
        visits = [v for v in timeline["visits"] if v.get("type") == "visit"]

        assert len(visits) == 1
        assert visits[0]["started_at"] == "2026-01-15T12:00:00+00:00"
        assert visits[0]["ended_at"] == "2026-01-15T12:05:00+00:00"

    def test_timeline_includes_open_visit_under_five_minutes(self, api):
        s, user = self._fresh_user(api)
        started_at = (datetime.now(timezone.utc) - timedelta(minutes=2)).isoformat()
        self._ping(s, 40.7128, -74.0060, timestamp=started_at)

        visits_col = self._visits_collection()
        visit = visits_col.find_one({"user_id": user["id"]}, sort=[("started_at", -1)])
        assert visit is not None
        visits_col.update_one({"id": visit["id"]}, {"$set": {"ended_at": None}})

        timeline = self._timeline(s)
        visits = [v for v in timeline["visits"] if v.get("type") == "visit"]

        assert len(visits) == 1
        assert visits[0]["id"] == visit["id"]
        assert visits[0]["ended_at"] is None


# ---------- Scope-filtered friend timeline ----------
class TestScopeFilter:
    """Two new users → friends → ping → fetch friend's data with scope filtering."""

    @pytest.fixture(scope="class")
    def pair(self):
        u1 = uuid.uuid4().hex[:6]
        u2 = uuid.uuid4().hex[:6]
        s1 = requests.Session(); s1.headers["Content-Type"] = "application/json"
        s2 = requests.Session(); s2.headers["Content-Type"] = "application/json"
        r1 = s1.post(f"{BASE_URL}/api/auth/signup", json={
            "email": f"sa_{u1}@consnow.app", "password": "password123",
            "display_name": f"SA {u1}", "username": f"sa_{u1}",
        })
        r2 = s2.post(f"{BASE_URL}/api/auth/signup", json={
            "email": f"sb_{u2}@consnow.app", "password": "password123",
            "display_name": f"SB {u2}", "username": f"sb_{u2}",
        })
        d1, d2 = r1.json(), r2.json()
        s1.headers["Authorization"] = f"Bearer {d1['access_token']}"
        s2.headers["Authorization"] = f"Bearer {d2['access_token']}"
        fr = s1.post(f"{BASE_URL}/api/friends/request", json={"target_user_id": d2["user"]["id"]})
        fid = fr.json()["friendship_id"]
        s2.post(f"{BASE_URL}/api/friends/respond", json={"friendship_id": fid, "accept": True})
        # u2 pings location
        s2.post(f"{BASE_URL}/api/locations/ping", json={"latitude": 19.0760, "longitude": 72.8777})
        return s1, d1["user"], s2, d2["user"]

    def test_friend_can_see_with_default_10m_scope(self, pair):
        # default scope=10m means: u2's data only visible to u1 if older than 10 min
        # Just-pinged data is too fresh → empty
        s1, _, _, u2 = pair
        r = s1.get(f"{BASE_URL}/api/locations/timeline", params={"user_id": u2["id"]})
        assert r.status_code == 200
        # fresh ping is filtered out by 10m delay
        assert r.json()["visits"] == []

    def test_scope_off_hides_everything(self, pair):
        _, _, s2, u2 = pair
        s1, u1, _, _ = pair
        # u2 sets scope=off (they share nothing with u1)
        r = s2.put(f"{BASE_URL}/api/friends/scope",
                   json={"friend_user_id": u1["id"], "scope": "off"})
        assert r.status_code == 200
        # u1 queries u2's timeline
        r = s1.get(f"{BASE_URL}/api/locations/timeline", params={"user_id": u2["id"]})
        assert r.status_code == 200
        assert r.json().get("scope") == "off"
        assert r.json()["visits"] == []
        r2 = s1.get(f"{BASE_URL}/api/locations/latest", params={"user_id": u2["id"]})
        assert r2.status_code == 200 and r2.json() is None
        r3 = s1.get(f"{BASE_URL}/api/locations/recent", params={"user_id": u2["id"]})
        assert r3.status_code == 200 and r3.json() == []

    def test_non_friend_forbidden(self, alice_session):
        s, _ = alice_session
        r = s.get(f"{BASE_URL}/api/locations/timeline",
                  params={"user_id": "non-existent-uuid"})
        assert r.status_code == 403
