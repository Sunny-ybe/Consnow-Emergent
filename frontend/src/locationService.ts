import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { api, loadAuthToken } from './api';
import { detectActivityFromLocation } from './activityService';

// True when running inside Expo Go (which restricts background location)
export const isExpoGo = Constants.executionEnvironment === 'storeClient';

// True when background tracking is fundamentally not available
export const backgroundTrackingUnsupported =
  Platform.OS === 'web' || isExpoGo;

export function backgroundUnsupportedReason(): string {
  if (Platform.OS === 'web') {
    return 'Background tracking is mobile-only. Open Consnow on iOS or Android.';
  }
  if (isExpoGo) {
    return 'Background location is disabled in Expo Go. Use a production build (via Publish) for 24/7 sharing.';
  }
  return '';
}

const BACKGROUND_TASK_NAME = 'CONSNOW_BACKGROUND_LOCATION';

// Define the background task ONCE at module level
if (!TaskManager.isTaskDefined(BACKGROUND_TASK_NAME)) {
  TaskManager.defineTask(BACKGROUND_TASK_NAME, async ({ data, error }: any) => {
    if (error) {
      console.warn('BG location error:', error);
      return;
    }
    if (!data) return;
    const { locations } = data as { locations: Location.LocationObject[] };
    if (!locations || locations.length === 0) return;

    // Ensure token is loaded for this task context
    await loadAuthToken();

    for (const loc of locations) {
      try {
        const { activity, availability, speed_mps } = detectActivityFromLocation(loc);
        if (
          activity !== 'walking' &&
          activity !== 'running' &&
          activity !== 'cycling' &&
          activity !== 'automotive'
        ) {
          continue;
        }

        await api.post('/locations/ping', {
          latitude: loc.coords.latitude,
          longitude: loc.coords.longitude,
          accuracy: loc.coords.accuracy,
          speed: speed_mps,
          activity,
          availability,
        });
      } catch (e) {
        console.warn('BG ping fail:', e);
      }
    }
  });
}

export async function requestForegroundPermission(): Promise<boolean> {
  const { status } = await Location.requestForegroundPermissionsAsync();
  return status === 'granted';
}

export async function requestBackgroundPermission(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  const { status } = await Location.requestBackgroundPermissionsAsync();
  return status === 'granted';
}

export async function getCurrentLocation(): Promise<Location.LocationObject | null> {
  try {
    const loc = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
    });
    return loc;
  } catch (e) {
    console.warn('getCurrentLocation failed', e);
    return null;
  }
}

export async function startBackgroundTracking(): Promise<boolean> {
  if (backgroundTrackingUnsupported) return false;
  try {
    const isRunning = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_TASK_NAME);
    if (isRunning) return true;

    await Location.startLocationUpdatesAsync(BACKGROUND_TASK_NAME, {
      accuracy: Location.Accuracy.Balanced,
      timeInterval: 10 * 60 * 1000, // 10 min
      distanceInterval: 50, // 50m
      showsBackgroundLocationIndicator: true,
      foregroundService: {
        notificationTitle: 'Consnow is sharing your location',
        notificationBody: 'Updating your trusted friends every 10 minutes.',
        notificationColor: '#0A0A0A',
      },
      pausesUpdatesAutomatically: false,
    });
    return true;
  } catch (e) {
    console.warn('startBackgroundTracking failed', e);
    return false;
  }
}

export async function stopBackgroundTracking(): Promise<void> {
  if (backgroundTrackingUnsupported) return;
  try {
    const isRunning = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_TASK_NAME);
    if (isRunning) {
      await Location.stopLocationUpdatesAsync(BACKGROUND_TASK_NAME);
    }
  } catch (e) {
    console.warn('stopBackgroundTracking failed', e);
  }
}

export async function isBackgroundTrackingActive(): Promise<boolean> {
  if (backgroundTrackingUnsupported) return false;
  try {
    return await Location.hasStartedLocationUpdatesAsync(BACKGROUND_TASK_NAME);
  } catch {
    return false;
  }
}
