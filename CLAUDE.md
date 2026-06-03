# ConSnow — Claude Code Context

## Coding Rules
- No features beyond what was asked
- No abstractions for single-use code
- Match existing style exactly
- Don't touch adjacent code that isn't part of the task
- Think before coding — state assumptions explicitly
- Simplest solution that works
- Every changed line must trace directly to the request

---

## What this app is

ConSnow is a **privacy-first location-sharing app** for iOS and Android. Users add trusted friends and choose exactly how much of their location history each friend can see — from "real-time" (10-minute delay) to fully off. The flagship feature is a beautiful vertical visit timeline that shows named places ("Starbucks", "Noble Library") instead of raw addresses.

Core value props: granular per-friend privacy controls, no ads, no data resale, battery-friendly background tracking.

---

## Monorepo layout

```
backend/        FastAPI + Motor (async MongoDB)
  server.py     Single-file backend — all routes, models, helpers
  requirements.txt
  tests/
    conftest.py
    test_consnow_api.py   Integration tests (hit real backend)
  Procfile       uvicorn server.py:app --host 0.0.0.0 --port $PORT

frontend/       Expo SDK 54, expo-router, React Native
  app/          expo-router file-based routes
    _layout.tsx        Root layout — AuthProvider + AuthGate
    index.tsx          Redirects to /(auth)/login or /(tabs)
    (auth)/            login.tsx, signup.tsx
    (tabs)/            index.tsx (Map), friends.tsx, timeline.tsx, profile.tsx
    friend/[id].tsx    Friend detail: avatar + scope slider + their visits
    search.tsx         User search modal
  src/
    api.ts             axios instance + every API call
    auth.tsx           AuthContext (JWT stored in SecureStore)
    locationService.ts Background task + foreground ping helpers
    activityService.ts Speed → activity → availability classification
    theme.ts           Design tokens (colors, spacing, radius, typography)
    AvailabilityBadge.tsx
    Avatar.tsx
    SnapSlider.tsx     Scope slider (6 snapping steps)
    RangeSlider.tsx
  app.json       Expo config (bundle IDs, permissions, EAS project ID)
  eas.json       EAS build profiles

memory/PRD.md          Product requirements (canonical source of truth)
design_guidelines.json Full design system spec
```

---

## Tech stack

| Layer | Choice |
|---|---|
| Frontend | Expo SDK 54, expo-router, React Native |
| Navigation | expo-router (file-based, Stack wrapping Tabs) |
| Icons | lucide-react-native (strokeWidth=2, size=24) |
| HTTP (frontend) | axios via `src/api.ts` |
| Auth storage | expo-secure-store (Keychain / EncryptedSharedPrefs) |
| Backend | FastAPI (single `server.py`), Python |
| DB driver | Motor 3.3.1 (async MongoDB) |
| Auth | JWT (PyJWT), bcrypt passwords, 30-day tokens |
| Place lookup | Google Places API (New) — Nearby Search |
| AI narrative | Anthropic SDK → `claude-haiku-4-5-20251001` |
| Deployment | Railway (backend), EAS (frontend) |

---

## Environment variables

### Backend (`backend/.env` or Railway env)
| Var | Purpose |
|---|---|
| `MONGO_URL` | MongoDB connection string |
| `DB_NAME` | Database name |
| `JWT_SECRET` | Token signing key |
| `JWT_ALGORITHM` | e.g. `HS256` |
| `JWT_EXPIRE_MINUTES` | e.g. `43200` (30 days) |
| `GOOGLE_GEOCODING_API_KEY` | Used for Google Places API (New) — must have Places API (New) enabled in GCP |
| `ANTHROPIC_API_KEY` | Claude narrative generation |
| `EMERGENT_LLM_KEY` | Legacy; checked as feature flag for narrative — if unset, narrative falls back to a simple string |

### Frontend
| Var | Purpose |
|---|---|
| `EXPO_PUBLIC_BACKEND_URL` | Baked into the build. Set in `.env` and `eas.json` per profile. Production: `https://consnow-emergent-production.up.railway.app` |

---

## MongoDB collections

| Collection | Key fields |
|---|---|
| `users` | `id` (UUID str), `email`, `username`, `display_name`, `password_hash`, `created_at` |
| `friendships` | `id`, `pair` (sorted [uid_a, uid_b]), `requester_id`, `target_id`, `status` (pending/accepted/rejected), `scope_{uid}`, `enabled_{uid}`, `freq_{uid}`, `window_start_{uid}`, `window_end_{uid}` |
| `locations` | `id`, `user_id`, `latitude`, `longitude`, `accuracy`, `speed`, `activity`, `availability`, `timestamp` (ISO), `place_name`, `formatted_address` |
| `visits` | `id`, `user_id`, `center_lat`, `center_lng`, `last_lat`, `last_lng`, `place_name`, `formatted_address`, `activity`, `availability`, `started_at`, `ended_at` |

Visits are auto-created/extended when a new ping lands within 100m of the current open visit (`haversine_m` check in `location_ping`).

---

## Backend API (`/api` prefix)

```
POST /auth/signup          { email, password, display_name, username }
POST /auth/login           { email, password }
GET  /auth/me              → current user (from JWT)

GET  /users/search?q=      Search by name/username/email (min 2 chars, excludes self)

POST /friends/request      { target_user_id }
POST /friends/respond      { friendship_id, accept: bool }
GET  /friends/list         → { friends, pending_incoming, pending_outgoing }
PUT  /friends/scope        { friend_user_id, scope }         (legacy)
PUT  /friends/sharing      { friend_user_id, enabled, freq, window_start, window_end }

POST /locations/ping       { latitude, longitude, accuracy?, speed?, activity?, availability? }
GET  /locations/latest     ?user_id=  → most recent ping doc
GET  /locations/recent     ?user_id=  → list of raw pings (for map)
GET  /locations/timeline   ?user_id=  → { visits: [...] }
GET  /locations/narrative/{user_id}   → { narrative: "..." } (AI-generated)
```

All routes except signup/login require `Authorization: Bearer <token>`.

---

## Sharing / scope system

Every friendship stores per-user grants. The current user controls what they share with each friend, keyed by `scope_{their_own_uid}`.

**New model** (takes precedence when keys exist):
- `enabled_{uid}` — bool master switch
- `freq_{uid}` — delay: `10m | 30m | 1h | 6h | 12h | 24h`
- `window_start_{uid}` / `window_end_{uid}` — hour range (UTC) when data is visible

**Legacy model** (fallback):
- `scope_{uid}` — `10m | 1h | 6h | 12h | 24h | off`

`get_sharing_filter(friendship, owner_id)` in `server.py` returns either a datetime cutoff or the sentinel `"BLOCKED"` / `"OUTSIDE_WINDOW"`. All timeline/latest/recent queries enforce this filter.

---

## Place lookup

`reverse_geocode(lat, lng)` in `server.py:183` hits **Google Places API (New) Nearby Search**:
- `POST https://places.googleapis.com/v1/places:searchNearby`
- Auth via `X-Goog-Api-Key` header (uses `GOOGLE_GEOCODING_API_KEY`)
- 200m radius, up to 10 results
- Prefers named establishments (coffee shops, libraries) over geo types (roads, postal codes, political boundaries)
- Falls back to raw `"lat, lng"` string if no results

The GCP key must have **Places API (New)** enabled (distinct from the legacy Geocoding API or the old Places API).

---

## AI narrative

`GET /locations/narrative/{user_id}` generates a 1–2 sentence plain-English summary of the last 12 hours of visits using `claude-haiku-4-5-20251001`. If `EMERGENT_LLM_KEY` env var is absent the feature is disabled and a fallback string is returned. If `ANTHROPIC_API_KEY` is absent the Anthropic client will throw and the route catches it, returning the fallback.

---

## Activity / availability classification

`src/activityService.ts` maps GPS speed to an activity type and then to availability:

| Speed (m/s) | Activity | Availability |
|---|---|---|
| < 0.5 | stationary | available |
| < 2.0 | walking | available |
| < 4.0 | running | busy |
| < 7.0 | cycling | busy |
| ≥ 7.0 | automotive | maybe |
| null | unknown | available |

---

## Background location tracking

`src/locationService.ts` registers a `TaskManager` task (`CONSNOW_BACKGROUND_LOCATION`) at module import time (imported in `app/_layout.tsx`). Settings: `Accuracy.Balanced`, 10-minute interval, 50m distance filter.

Background tracking is **disabled in Expo Go** (`isExpoGo` flag) — use a dev client or production build. On web it's also unavailable.

---

## Frontend auth flow

`AuthProvider` (in `src/auth.tsx`) wraps the entire app. On mount it loads the JWT from SecureStore and calls `GET /auth/me` to restore session. `AuthGate` (in `app/_layout.tsx`) redirects to `/(auth)/login` when unauthenticated, or to `/(tabs)` when authenticated.

JWT token is stored under key `consnow_auth_token` via `storage.secureSet` (cross-platform: SecureStore on native, AsyncStorage on web).

---

## Design system

Source of truth: `design_guidelines.json` and `src/theme.ts`.

**Palette:**
- Background: `#F9F9FB` (primary), `#FFFFFF` (secondary), `#F2F2F7` (tertiary)
- Text: `#1C1C1E` (primary), `#8E8E93` (secondary), `#C7C7CC` (tertiary)
- Brand/primary action: `#0A0A0A` (near-black)
- Accent: `#007AFF` (iOS blue)
- Success: `#34C759`, Warning: `#FF9500`, Danger: `#FF3B30`

**Typography:** Manrope for headings, system font for body, Space Mono for mono.

**Icons:** `lucide-react-native`, `strokeWidth={2}`, `size={24}` default.

**Buttons:** Primary = black bg + white text + 56px height + 16px radius. Secondary = `#F2F2F7` bg + black text. Danger = `#FFEBEB` bg + `#FF3B30` text.

**Testing IDs:** All interactive elements must have `testID` in kebab-case (e.g. `login-form-submit-button`).

---

## Running locally

**Backend:**
```bash
cd backend
pip install -r requirements.txt
# create backend/.env with required vars
uvicorn server:app --reload --port 8000
```

**Frontend:**
```bash
cd frontend
yarn install
# .env already has EXPO_PUBLIC_BACKEND_URL pointing at Railway production
# Change it to http://localhost:8000 for local backend dev
yarn start           # opens Expo dev tools
yarn ios / yarn android
```

**Tests:**
```bash
cd backend
# Set EXPO_PUBLIC_BACKEND_URL to the target backend
pytest tests/ -v
```
Tests are integration tests hitting the real API — they create real users, friendships, and pings.

---

## EAS / deployment

- EAS project ID: `5678600e-4d9f-418a-afd0-b16f0d916831`
- iOS bundle: `com.consnow.app`, Android package: `com.consnow.app`
- `eas build --profile preview` → internal TestFlight/APK with Railway backend URL baked in
- `eas build --profile production --auto-submit` → App Store / Play Store build
- Backend deploys to Railway via the `Procfile`

---

## Production URLs

| Service | URL |
|---|---|
| Backend (Railway) | `https://consnow-emergent-production.up.railway.app` |

---

## Key architectural decisions

- **Single-file backend** — `server.py` contains everything. Don't split unless it becomes a maintenance problem; the project is intentionally small.
- **Per-user keyed fields on friendships** — `scope_{uid}`, `enabled_{uid}`, etc. are dynamic keys on the friendship document rather than a sub-collection. This simplifies queries at the cost of a less clean schema.
- **Visit grouping is stateless** — the backend just checks the last visit by `started_at` desc and compares distance. No persistent "current visit" pointer.
- **Google Places API (New)** replaces the legacy Geocoding API — the existing `GOOGLE_GEOCODING_API_KEY` env var is reused but the GCP key must have "Places API (New)" enabled.
- **No real-time push** — the app polls on tab focus. Push notifications are on the roadmap.
