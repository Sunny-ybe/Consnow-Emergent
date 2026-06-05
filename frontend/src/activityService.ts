/**
 * Activity recognition + availability mapping.
 *
 * Current implementation uses GPS speed (provided by expo-location on every
 * reading) as a battery-free proxy for activity classification. Mapping
 * matches the public iOS CMMotionActivityManager / Android
 * ActivityRecognitionClient activity types exactly.
 *
 * To upgrade to true native activity recognition in a production build,
 * swap detectActivityFromLocation() with a wrapper around CMMotionActivity
 * (iOS) / ActivityRecognitionClient (Android) via a custom Expo module.
 * The returned shape and downstream code stay identical.
 */

import * as Location from 'expo-location';
import { NativeModules, Platform } from 'react-native';

export type Activity =
  | 'stationary'
  | 'walking'
  | 'running'
  | 'cycling'
  | 'automotive'
  | 'unknown';

export type Availability = 'available' | 'maybe' | 'busy';

export type ActivityResult = {
  activity: Activity;
  availability: Availability;
  speed_mps: number | null;
};

type NativeActivityState = 'stationary' | 'moving' | 'unavailable';

type NativeActivityModule = {
  getCurrentActivity?: () => Promise<unknown> | unknown;
  getCurrentActivitySync?: () => unknown;
  isStationary?: () => Promise<unknown> | unknown;
  isStationarySync?: () => unknown;
};

let nativeActivityState: NativeActivityState = 'unavailable';

function nativeActivityModule(): NativeActivityModule | null {
  if (Platform.OS === 'ios') {
    return (NativeModules.CMMotionActivityManager as NativeActivityModule | undefined) || null;
  }
  if (Platform.OS === 'android') {
    return (NativeModules.ActivityRecognitionClient as NativeActivityModule | undefined) || null;
  }
  return null;
}

function normalizeNativeActivity(value: unknown): NativeActivityState {
  if (typeof value === 'boolean') return value ? 'stationary' : 'moving';
  if (typeof value === 'string') {
    const state = value.toLowerCase();
    if (state === 'stationary' || state === 'still') return 'stationary';
    if (
      state === 'moving' ||
      state === 'walking' ||
      state === 'running' ||
      state === 'cycling' ||
      state === 'automotive' ||
      state === 'in_vehicle' ||
      state === 'on_bicycle' ||
      state === 'on_foot'
    ) {
      return 'moving';
    }
  }
  if (value && typeof value === 'object') {
    const activity = value as Record<string, unknown>;
    if (activity.stationary === true || activity.still === true) return 'stationary';
    if (
      activity.moving === true ||
      activity.walking === true ||
      activity.running === true ||
      activity.cycling === true ||
      activity.automotive === true ||
      activity.inVehicle === true ||
      activity.onBicycle === true ||
      activity.onFoot === true
    ) {
      return 'moving';
    }
    return normalizeNativeActivity(activity.activity || activity.state || activity.type);
  }
  return 'unavailable';
}

function updateNativeActivityState(value: unknown) {
  nativeActivityState = normalizeNativeActivity(value);
}

function readNativeActivityState(): NativeActivityState {
  const nativeModule = nativeActivityModule();
  if (!nativeModule) return 'unavailable';

  try {
    if (typeof nativeModule.isStationarySync === 'function') {
      updateNativeActivityState(nativeModule.isStationarySync());
      return nativeActivityState;
    }
    if (typeof nativeModule.getCurrentActivitySync === 'function') {
      updateNativeActivityState(nativeModule.getCurrentActivitySync());
      return nativeActivityState;
    }
    if (typeof nativeModule.isStationary === 'function') {
      void Promise.resolve(nativeModule.isStationary()).then(updateNativeActivityState).catch(() => {
        nativeActivityState = 'unavailable';
      });
      return nativeActivityState;
    }
    if (typeof nativeModule.getCurrentActivity === 'function') {
      void Promise.resolve(nativeModule.getCurrentActivity()).then(updateNativeActivityState).catch(() => {
        nativeActivityState = 'unavailable';
      });
      return nativeActivityState;
    }
  } catch {
    nativeActivityState = 'unavailable';
  }

  return 'unavailable';
}

/**
 * Map activity → availability per product spec.
 *   cycling / running → busy
 *   automotive        → maybe
 *   walking / stationary / unknown → available
 */
export function availabilityFor(activity: Activity): Availability {
  switch (activity) {
    case 'cycling':
    case 'running':
      return 'busy';
    case 'automotive':
      return 'maybe';
    case 'stationary':
    case 'walking':
    case 'unknown':
    default:
      return 'available';
  }
}

/**
 * Classify activity from a LocationObject's speed.
 * Thresholds in m/s, tuned to overlap typical human / vehicle ranges.
 *   < 0.5  : stationary
 *   < 2.0  : walking
 *   < 4.0  : running
 *   < 7.0  : cycling
 *   >= 7.0 : automotive
 */
export function detectActivityFromLocation(loc: Location.LocationObject): ActivityResult {
  if (readNativeActivityState() === 'stationary') {
    const rawSpeed = loc.coords.speed;
    const speed = typeof rawSpeed === 'number' && rawSpeed >= 0 ? rawSpeed : null;
    return { activity: 'stationary', availability: availabilityFor('stationary'), speed_mps: speed };
  }

  const rawSpeed = loc.coords.speed;
  const speed = typeof rawSpeed === 'number' && rawSpeed >= 0 ? rawSpeed : null;

  if (speed === null) {
    return { activity: 'unknown', availability: availabilityFor('unknown'), speed_mps: null };
  }

  let activity: Activity;
  if (speed < 0.5) activity = 'stationary';
  else if (speed < 2.0) activity = 'walking';
  else if (speed < 4.0) activity = 'running';
  else if (speed < 7.0) activity = 'cycling';
  else activity = 'automotive';

  return { activity, availability: availabilityFor(activity), speed_mps: speed };
}

export function availabilityLabel(a: Availability): string {
  if (a === 'available') return 'Available';
  if (a === 'maybe') return 'Maybe';
  return 'Busy';
}

export function activityLabel(a: Activity): string {
  switch (a) {
    case 'stationary': return '🧍‍♂️ Still';
    case 'walking':    return '🚶‍♂️ Walking';
    case 'running':    return '🏃‍♂️ Running';
    case 'cycling':    return '🚴‍♂️ Cycling';
    case 'automotive': return '🚘 Driving';
    default:           return '';
  }
}
