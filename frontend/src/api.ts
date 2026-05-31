import axios from 'axios';
import { storage } from '@/src/utils/storage';

const BASE_URL = process.env.EXPO_PUBLIC_BACKEND_URL || '';

// Defensive: warn loudly if env var didn't get baked into the build
if (!BASE_URL) {
  // eslint-disable-next-line no-console
  console.warn(
    '[Consnow] EXPO_PUBLIC_BACKEND_URL is not set! Network calls will fail. ' +
    'If you see this in a TestFlight build, rebuild with eas build --clear-cache.',
  );
}

export const api = axios.create({
  baseURL: `${BASE_URL}/api`,
  timeout: 15000,
});

// Log the baked-in URL once at startup so we can verify from device logs
// eslint-disable-next-line no-console
console.log('[Consnow] API base URL:', api.defaults.baseURL);

const TOKEN_KEY = 'consnow_auth_token';

export async function setAuthToken(token: string | null) {
  if (token) {
    await storage.secureSet(TOKEN_KEY, token);
    api.defaults.headers.common.Authorization = `Bearer ${token}`;
  } else {
    await storage.secureRemove(TOKEN_KEY);
    delete api.defaults.headers.common.Authorization;
  }
}

export async function loadAuthToken(): Promise<string | null> {
  const token = await storage.secureGet<string>(TOKEN_KEY, '');
  if (token && typeof token === 'string') {
    api.defaults.headers.common.Authorization = `Bearer ${token}`;
    return token;
  }
  return null;
}

// API helpers
export async function signup(payload: {
  email: string;
  password: string;
  display_name: string;
  username: string;
}) {
  const { data } = await api.post('/auth/signup', payload);
  return data;
}

export async function login(email: string, password: string) {
  const { data } = await api.post('/auth/login', { email, password });
  return data;
}

export async function fetchMe() {
  const { data } = await api.get('/auth/me');
  return data;
}

export async function searchUsers(q: string) {
  const { data } = await api.get('/users/search', { params: { q } });
  return data;
}

export async function sendFriendRequest(target_user_id: string) {
  const { data } = await api.post('/friends/request', { target_user_id });
  return data;
}

export async function respondToRequest(friendship_id: string, accept: boolean) {
  const { data } = await api.post('/friends/respond', { friendship_id, accept });
  return data;
}

export async function listFriends() {
  const { data } = await api.get('/friends/list');
  return data;
}

export async function updateScope(friend_user_id: string, scope: string) {
  const { data } = await api.put('/friends/scope', { friend_user_id, scope });
  return data;
}

export async function updateSharing(
  friend_user_id: string,
  enabled: boolean,
  freq: string,
  window_start: number,
  window_end: number,
) {
  const { data } = await api.put('/friends/sharing', {
    friend_user_id,
    enabled,
    freq,
    window_start,
    window_end,
  });
  return data;
}

export async function pingLocation(
  latitude: number,
  longitude: number,
  extras?: { accuracy?: number; speed?: number | null; activity?: string; availability?: string },
) {
  const { data } = await api.post('/locations/ping', {
    latitude,
    longitude,
    accuracy: extras?.accuracy,
    speed: extras?.speed ?? null,
    activity: extras?.activity,
    availability: extras?.availability,
  });
  return data;
}

export async function getTimeline(user_id?: string) {
  const { data } = await api.get('/locations/timeline', { params: user_id ? { user_id } : {} });
  return data;
}

export async function getLatestLocation(user_id?: string) {
  const { data } = await api.get('/locations/latest', { params: user_id ? { user_id } : {} });
  return data;
}

export async function getDayNarrative(user_id: string) {
  const { data } = await api.get(`/locations/narrative/${user_id}`);
  return data;
}

export async function getRecentLocations(user_id?: string) {
  const { data } = await api.get('/locations/recent', { params: user_id ? { user_id } : {} });
  return data;
}
