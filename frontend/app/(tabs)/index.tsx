import { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  Platform,
  ActivityIndicator,
  ScrollView,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MapPin, Navigation, Power, Loader } from 'lucide-react-native';
import { useFocusEffect } from 'expo-router';
import { colors, spacing, radius, typography, shadow } from '@/src/theme';
import {
  getCurrentLocation,
  requestForegroundPermission,
  requestBackgroundPermission,
  startBackgroundTracking,
  stopBackgroundTracking,
  isBackgroundTrackingActive,
  backgroundTrackingUnsupported,
  backgroundUnsupportedReason,
} from '@/src/locationService';
import { pingLocation, getLatestLocation } from '@/src/api';
import { useAuth } from '@/src/auth';

export default function MapTabScreen() {
  const { user } = useAuth();
  const [latest, setLatest] = useState<any>(null);
  const [tracking, setTracking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const loadLatest = useCallback(async () => {
    try {
      const data = await getLatestLocation();
      setLatest(data);
    } catch (e) {
      // ignore
    }
  }, []);

  const checkTracking = useCallback(async () => {
    const active = await isBackgroundTrackingActive();
    setTracking(active);
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadLatest();
      checkTracking();
    }, [loadLatest, checkTracking]),
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadLatest();
    setRefreshing(false);
  }, [loadLatest]);

  const sendNow = async () => {
    setBusy(true);
    try {
      const granted = await requestForegroundPermission();
      if (!granted) {
        Alert.alert('Permission needed', 'Enable location permission to share with friends.');
        return;
      }
      const loc = await getCurrentLocation();
      if (!loc) {
        Alert.alert('Could not get location', 'Please try again.');
        return;
      }
      const res = await pingLocation(loc.coords.latitude, loc.coords.longitude, loc.coords.accuracy ?? undefined);
      Alert.alert('Pinged!', `You are at ${res.place_name}`);
      await loadLatest();
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'Failed to send location');
    } finally {
      setBusy(false);
    }
  };

  const toggleBackground = async () => {
    if (backgroundTrackingUnsupported) {
      Alert.alert('Not available here', backgroundUnsupportedReason());
      return;
    }
    if (tracking) {
      await stopBackgroundTracking();
      setTracking(false);
      Alert.alert('Background sharing off', 'You can re-enable anytime.');
    } else {
      const fg = await requestForegroundPermission();
      if (!fg) {
        Alert.alert('Permission needed', 'Allow "While Using" location first.');
        return;
      }
      if (Platform.OS !== 'web') {
        const bg = await requestBackgroundPermission();
        if (!bg) {
          Alert.alert(
            'Allow Always',
            'Background tracking requires "Always Allow" location permission. You can change this in Settings.',
          );
          return;
        }
      }
      const ok = await startBackgroundTracking();
      if (ok) {
        setTracking(true);
        Alert.alert('Background sharing on', 'We will quietly update your friends as you move.');
      } else {
        Alert.alert('Could not start', backgroundUnsupportedReason() || 'Please retry.');
      }
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        <View style={styles.header}>
          <Text style={styles.greeting}>Hi {user?.display_name?.split(' ')[0] || ''}</Text>
          <Text style={styles.subhead}>Your latest location</Text>
        </View>

        <View style={styles.heroCard}>
          <View style={styles.pinWrap}>
            <MapPin size={32} color={colors.brand} strokeWidth={2.2} />
          </View>
          {latest ? (
            <>
              <Text style={styles.placeName} testID="latest-place-name">
                {latest.place_name || 'Unknown'}
              </Text>
              {latest.formatted_address ? (
                <Text style={styles.address} numberOfLines={2}>
                  {latest.formatted_address}
                </Text>
              ) : null}
              <Text style={styles.timeAgo}>{formatTimeAgo(latest.timestamp)}</Text>
            </>
          ) : (
            <>
              <Text style={styles.placeName}>No location yet</Text>
              <Text style={styles.address}>Tap "Ping now" to share your first location.</Text>
            </>
          )}
        </View>

        <TouchableOpacity
          testID="ping-now-button"
          style={[styles.primaryBtn, busy && { opacity: 0.6 }]}
          onPress={sendNow}
          disabled={busy}
          activeOpacity={0.85}
        >
          {busy ? (
            <ActivityIndicator color={colors.textInverse} />
          ) : (
            <>
              <Navigation size={20} color={colors.textInverse} strokeWidth={2.4} />
              <Text style={styles.primaryBtnText}>Ping now</Text>
            </>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          testID="toggle-background-button"
          style={[
            styles.secondaryBtn,
            tracking && styles.secondaryBtnActive,
            backgroundTrackingUnsupported && styles.secondaryBtnDisabled,
          ]}
          onPress={toggleBackground}
          activeOpacity={0.85}
        >
          <Power size={18} color={tracking ? colors.success : colors.textPrimary} strokeWidth={2.4} />
          <Text style={[styles.secondaryBtnText, tracking && { color: colors.success }]}>
            {backgroundTrackingUnsupported
              ? 'Background sharing (Expo Go: unavailable)'
              : tracking
              ? 'Background sharing: ON'
              : 'Turn on background sharing'}
          </Text>
        </TouchableOpacity>

        {backgroundTrackingUnsupported && (
          <Text style={styles.unsupportedHint}>{backgroundUnsupportedReason()}</Text>
        )}

        <View style={styles.infoCard}>
          <Loader size={18} color={colors.textSecondary} strokeWidth={2} />
          <Text style={styles.infoText}>
            Battery-friendly: we only update when you move 50+ meters, max every 10 minutes.
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

export function formatTimeAgo(iso?: string): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  const diff = (Date.now() - t) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: spacing.lg, paddingBottom: spacing.xxl },
  header: { marginBottom: spacing.lg },
  greeting: { ...typography.h1, color: colors.textPrimary },
  subhead: { ...typography.body, color: colors.textSecondary, marginTop: 4 },
  heroCard: {
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.md,
    ...shadow.card,
  },
  pinWrap: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.bgTertiary,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  placeName: { ...typography.h2, color: colors.textPrimary, marginBottom: 4 },
  address: { ...typography.body, color: colors.textSecondary, marginBottom: spacing.sm },
  timeAgo: { ...typography.caption, color: colors.textTertiary },
  primaryBtn: {
    backgroundColor: colors.brand,
    height: 56,
    borderRadius: radius.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: spacing.sm,
    ...shadow.card,
  },
  primaryBtnText: { color: colors.textInverse, fontSize: 17, fontWeight: '600' },
  secondaryBtn: {
    backgroundColor: colors.bgSecondary,
    borderWidth: 1,
    borderColor: colors.border,
    height: 52,
    borderRadius: radius.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: spacing.sm,
  },
  secondaryBtnActive: { borderColor: colors.success, backgroundColor: '#ECFFF1' },
  secondaryBtnDisabled: { opacity: 0.7 },
  secondaryBtnText: { color: colors.textPrimary, fontSize: 15, fontWeight: '600' },
  unsupportedHint: {
    ...typography.caption,
    color: colors.warning,
    paddingHorizontal: 4,
    marginTop: 6,
    lineHeight: 18,
  },
  infoCard: {
    flexDirection: 'row',
    gap: 10,
    backgroundColor: colors.bgTertiary,
    padding: spacing.md,
    borderRadius: radius.md,
    marginTop: spacing.lg,
    alignItems: 'flex-start',
  },
  infoText: { ...typography.caption, color: colors.textSecondary, flex: 1, lineHeight: 18 },
});
