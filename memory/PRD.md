# Consnow — Product Requirements Document

## Vision
Consnow is a privacy-first location-sharing mobile app for iOS and Android (built with React Native + Expo). Users sign up, find people they trust, and grant them per-friend, granular access to their location history. Every sharing relationship is reversible and tunable from "real-time" to "off".

## Differentiator
- Granular per-friend scope slider (10 min / 1 hour / 6 hours / 12 hours / 24 hours / Off)
- Beautiful named-place visit timeline (powered by Google Geocoding)
- No ads, no data resale — privacy as a product
- Battery-friendly background tracking (50m distance + 10min interval)

## Tech Stack
- **Frontend**: Expo SDK 54, expo-router, react-native, lucide-react-native icons
- **Backend**: FastAPI + Motor (async MongoDB)
- **DB**: MongoDB (collections: users, friendships, locations, visits)
- **Auth**: JWT (bcrypt password hash, 30-day token expiry)
- **Geocoding**: Google Maps Geocoding API (worldwide place names)
- **Location**: expo-location with expo-task-manager background updates

## Core User Flows
1. **Signup / Login** → JWT stored in SecureStore
2. **Bottom tabs**: Map · Friends · Timeline · Profile
3. **Map tab**: Latest location card + "Ping now" + "Background sharing" toggle
4. **Friends tab**: List of friends (with last-seen), pending requests, search modal
5. **Search modal**: Search users by name/username/email → send friend request
6. **Friend detail (/friend/[id])**: Avatar + scope slider (6 levels) + their recent visits
7. **Timeline tab**: Vertical visit log; swipe avatars at top to view friends' timelines (scope-limited)
8. **Profile tab**: Profile card, background sharing toggle, sign out

## Backend API (all under `/api`)
- `POST /auth/signup`, `POST /auth/login`, `GET /auth/me`
- `GET /users/search?q=`
- `POST /friends/request`, `POST /friends/respond`, `GET /friends/list`, `PUT /friends/scope`
- `POST /locations/ping`, `GET /locations/timeline`, `GET /locations/latest`, `GET /locations/recent`

## Scope Logic
For each friendship, each user grants the OTHER party a scope value:
- `10m`: friend sees location/timeline (with 10-min delay)
- `1h` / `6h` / `12h` / `24h`: progressively longer delay
- `off`: friend sees nothing (until re-enabled)

Backend enforces scope by filtering visits/pings with `ended_at <= now - scope_minutes`.

## Privacy Guarantees
- Passwords bcrypt-hashed; no plaintext storage
- JWT tokens stored in expo-secure-store (Keychain / EncryptedSharedPrefs)
- Scope changes take effect immediately on next request
- "Off" hides all data — friendship persists but is muted
- No ads, no third-party analytics

## Future Roadmap (post-MVP)
- Map view with route polylines (react-native-maps already installed)
- Premium tier: unlimited history, multi-friend family plans, geofence alerts
- Expansion: share more data types (mood, fitness, expenses) with same scope system
- Push notifications when friend arrives at/leaves a place
