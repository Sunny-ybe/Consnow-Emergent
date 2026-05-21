import os
import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "https://location-log-22.preview.emergentagent.com").rstrip("/")


@pytest.fixture(scope="session")
def base_url():
    return BASE_URL


@pytest.fixture
def api():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


def _login(s, email, password):
    r = s.post(f"{BASE_URL}/api/auth/login", json={"email": email, "password": password})
    assert r.status_code == 200, f"Login failed for {email}: {r.status_code} {r.text}"
    data = r.json()
    s.headers["Authorization"] = f"Bearer {data['access_token']}"
    return data


@pytest.fixture
def alice_session():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    data = _login(s, "alice@consnow.app", "password123")
    return s, data


@pytest.fixture
def bob_session():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    data = _login(s, "bob@consnow.app", "password123")
    return s, data
