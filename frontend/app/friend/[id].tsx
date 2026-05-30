import { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Alert,
  ActivityIndicator,
  Switch,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ChevronLeft, MapPin, Sparkles, Clock, Calendar } from 'lucide-react-native';
import { colors, spacing, radius, typography, shadow } from '@/src/theme';
import { Avatar } from '@/src/Avatar';
import { AvailabilityBadge } from '@/src/AvailabilityBadge';
import { SnapSlider } from '@/src/SnapSlider';
import { RangeSlider } from '@/src/RangeSlider';
import { getTimeline, listFriends, updateSharing, getDayNarrative } from '@/src/api';
import { formatTimeAgo } from '../(tabs)/index';

const FREQS = ['10m', '30m', '1h', '6h', '12h', '24h'];
const FREQ_LABELS_SHORT = ['10m', '30m', '1h', '6h', '12h', '24h'];
const FREQ_LABELS: Record<string, string> = {
  '10m': '10 min',
  '30m': '30 min',
  '1h': '1 hour',
  '6h': '6 hours',
  '12h': '12 hours',
  '24h': '24 hours',
};

function formatHour(h: number): string {
  if (h === 0 || h === 24) return '12am';
  if (h === 12) return '12pm';
  if (h < 12) return `${h}am`;
  return `${h - 12}pm`;
}

export default function FriendDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [friend, setFriend] = useState<any>(null);
  const [enabled, setEnabled] = useState(true);
  const [freq, setFreq] = useState<string>('10m');
  const [winStart, setWinStart] = useState(0);
  const [winEnd, setWinEnd] = useState(24);
  const [visits, setVisits] = useState<any[]>([]);
  const [narrative, setNarrative] = useState<string>('');
  const [narrativeLoading, setNarrativeLoading] = useState(true);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await listFriends();
      const f = d.friends.find((x: any) => x.user.id === id);
      if (f) {
        setFriend(f);
        const sg = f.sharing_i_grant || {};
        setEnabled(sg.enabled !== false);
        setFreq(sg.freq || '10m');
        setWinStart(typeof sg.window_start === 'number' ? sg.window_start : 0);
        setWinEnd(typeof sg.window_end === 'number' ? sg.window_end : 24);
      }
      const t = await getTimeline(id);
      setVisits(t.visits || []);
    } catch (e) {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [id]);

  const loadNarrative = useCallback(async () => {
    setNarrativeLoading(true);
    try {
      const n = await getDayNarrative(id);
      setNarrative(n.narrative || '');
    } catch {
      setNarrative('');
    } finally {
      setNarrativeLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
    loadNarrative();
  }, [load, loadNarrative]);

  const persist = async (next: { enabled?: boolean; freq?: string; winStart?: number; winEnd?: number }) => {
    const e = next.enabled !== undefined ? next.enabled : enabled;
    const fr = next.freq || freq;
    const ws = next.winStart !== undefined ? next.winStart : winStart;
    const we = next.winEnd !== undefined ? next.winEnd : winEnd;
    try {
      await updateSharing(id, e, fr, ws, we);
    } catch (err: any) {
      Alert.alert('Could not save', err?.response?.data?.detail || 'Try again');
    }
  };

  const onToggle = (v: boolean) => {
    setEnabled(v);
    persist({ enabled: v });
  };
  const onFreq = (f: string) => {
    setFreq(f);
    persist({ freq: f });
  };
  const onWindow = (lo: number, hi: number) => {
    setWinStart(lo);
    setWinEnd(hi);
  };
  // Persist window on release (cheap: persist every change since RangeSlider already throttles via snapping)
  // We persist on every snap change directly here:
  const onWindowChange = (lo: number, hi: number) => {
    const changed = lo !== winStart || hi !== winEnd;
    onWindow(lo, hi);
    if (changed) persist({ winStart: lo, winEnd: hi });
  };

  if (loading) {
    return (
      <SafeAreaView style={[styles.container, styles.center]}>
        <ActivityIndicator size="large" color={colors.brand} />
      </SafeAreaView>
    );
  }

  if (!friend) {
    return (
      <SafeAreaView style={[styles.container, styles.center]}>
        <Text style={styles.empty}>Friend not found</Text>
        <TouchableOpacity onPress={() => router.back()}>
          <Text style={styles.backText}>Back</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  const theirSharing: any = {};

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.topBar}>
        <TouchableOpacity testID="back-button" onPress={() => router.back()} style={styles.iconBtn}>
          <ChevronLeft size={24} color={colors.textPrimary} strokeWidth={2.2} />
        </TouchableOpacity>
        <Text style={styles.topTitle}>Friend</Text>
        <View style={{ width: 44 }} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.headerCard}>
          <Avatar name={friend.user.display_name} size={88} />
          <Text style={styles.name}>{friend.user.display_name}</Text>
          <Text style={styles.username}>@{friend.user.username}</Text>
          {friend.last_seen ? (
            <View style={styles.lastSeenRow}>
              <MapPin size={14} color={colors.textSecondary} strokeWidth={2.2} />
              <Text style={styles.lastSeen} numberOfLines={1}>
                {friend.last_seen.place_name} · {formatTimeAgo(friend.last_seen.timestamp)}
              </Text>
            </View>
          ) : null}
          {friend.last_seen?.availability ? (
            <View style={{ marginTop: spacing.sm }}>
              <AvailabilityBadge
                availability={friend.last_seen.availability}
                activity={friend.last_seen.activity}
                showActivity
                size="md"
              />
            </View>
          ) : null}
        </View>

        <View style={styles.narrativeCard}>
          <View style={styles.narrativeHeader}>
            <Sparkles size={14} color={colors.brand} strokeWidth={2.4} />
            <Text style={styles.narrativeLabel}>Last 12 hours</Text>
          </View>
          {narrativeLoading ? (
            <View style={styles.narrativeLoadingRow}>
              <ActivityIndicator size="small" color={colors.textSecondary} />
              <Text style={styles.narrativeLoadingText}>Reading the day…</Text>
            </View>
          ) : (
            <Text style={styles.narrativeText} testID="friend-narrative">
              {narrative || 'No story yet.'}
            </Text>
          )}
        </View>

        {/* Master toggle */}
        <View style={styles.toggleCard}>
          <View style={{ flex: 1 }}>
            <Text style={styles.toggleLabel}>Share my location with {friend.user.display_name.split(' ')[0]}</Text>
            <Text style={styles.toggleHint}>
              {enabled ? 'Sharing is on.' : 'Sharing is paused for this friend.'}
            </Text>
          </View>
          <Switch
            testID="sharing-toggle"
            value={enabled}
            onValueChange={onToggle}
            trackColor={{ true: colors.brand, false: colors.border }}
            thumbColor={'#fff'}
          />
        </View>

        {/* Time window (2-pointer range slider) */}
        <View style={[styles.settingCard, !enabled && styles.disabled]} pointerEvents={enabled ? 'auto' : 'none'}>
          <View style={styles.settingHeader}>
            <Calendar size={16} color={colors.brand} strokeWidth={2.2} />
            <Text style={styles.settingLabel}>Time window</Text>
          </View>
          <RangeSlider
            testID="time-window-slider"
            min={0}
            max={24}
            step={1}
            lo={winStart}
            hi={winEnd}
            onChange={onWindowChange}
            ticks={[0, 6, 12, 18, 24]}
            formatTick={formatHour}
            formatValue={formatHour}
          />
          <Text style={styles.settingHint}>
            {friend.user.display_name.split(' ')[0]} can see your location only between these hours.
          </Text>
        </View>

        {/* Frequency (1-pointer snap slider) */}
        <View style={[styles.settingCard, !enabled && styles.disabled]} pointerEvents={enabled ? 'auto' : 'none'}>
          <View style={styles.settingHeader}>
            <Clock size={16} color={colors.brand} strokeWidth={2.2} />
            <Text style={styles.settingLabel}>Update frequency</Text>
          </View>
          <Text style={styles.freqValue}>Every {FREQ_LABELS[freq]}</Text>
          <SnapSlider
            testID="freq-slider"
            steps={FREQS}
            labels={FREQ_LABELS_SHORT}
            value={freq}
            onChange={onFreq}
          />
          <Text style={styles.settingHint}>
            How fresh the data {friend.user.display_name.split(' ')[0]} sees should be.
          </Text>
        </View>

        {/* What they share with you (read-only display) */}
        {/* Removed: receiver doesn't see what the friend has configured. Privacy stays one-directional. */}

        {/* Recent visits */}
        <Text style={styles.sectionHeader}>Recent places</Text>
        {visits.length === 0 ? (
          <View style={styles.emptyCard}>
            <Text style={styles.empty}>No visits visible yet.</Text>
          </View>
        ) : (
          visits.slice(0, 10).map((v) => (
            <View key={v.id} style={styles.visitCard}>
              <MapPin size={16} color={colors.brand} strokeWidth={2.2} />
              <View style={{ flex: 1, marginLeft: spacing.sm }}>
                <Text style={styles.placeName} numberOfLines={1}>
                  {v.place_name}
                </Text>
                <Text style={styles.visitMeta}>
                  {formatTimeAgo(v.started_at)} · {formatDuration(v.started_at, v.ended_at)}
                </Text>
              </View>
            </View>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function formatDuration(start: string, end: string): string {
  const mins = Math.max(0, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60000));
  if (mins < 1) return 'Briefly';
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  center: { alignItems: 'center', justifyContent: 'center' },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
  },
  iconBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  topTitle: { ...typography.h3, color: colors.textPrimary },
  scroll: { padding: spacing.lg, paddingBottom: spacing.xxl },
  headerCard: {
    alignItems: 'center',
    paddingVertical: spacing.lg,
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.lg,
    ...shadow.card,
  },
  name: { ...typography.h2, color: colors.textPrimary, marginTop: spacing.md },
  username: { ...typography.body, color: colors.textSecondary },
  lastSeenRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: spacing.sm, maxWidth: '90%' },
  lastSeen: { ...typography.caption, color: colors.textSecondary, flexShrink: 1 },
  narrativeCard: {
    backgroundColor: colors.accentMuted,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginTop: spacing.md,
  },
  narrativeHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
  narrativeLabel: { ...typography.overline, color: colors.brand },
  narrativeText: { ...typography.bodyLarge, color: colors.textPrimary, lineHeight: 24 },
  narrativeLoadingRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  narrativeLoadingText: { ...typography.body, color: colors.textSecondary },

  toggleCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgSecondary,
    padding: spacing.md,
    borderRadius: radius.lg,
    marginTop: spacing.lg,
    gap: spacing.md,
    ...shadow.subtle,
  },
  toggleLabel: { ...typography.h3, color: colors.textPrimary },
  toggleHint: { ...typography.caption, color: colors.textSecondary, marginTop: 4 },

  settingCard: {
    backgroundColor: colors.bgSecondary,
    padding: spacing.md,
    borderRadius: radius.lg,
    marginTop: spacing.md,
    ...shadow.subtle,
  },
  disabled: { opacity: 0.45 },
  settingHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: spacing.sm },
  settingLabel: { ...typography.overline, color: colors.brand },
  settingHint: { ...typography.caption, color: colors.textSecondary, marginTop: 8 },
  freqValue: { ...typography.bodyLarge, color: colors.textPrimary, fontWeight: '700', marginBottom: 8 },

  sectionHeader: { ...typography.overline, color: colors.textSecondary, marginTop: spacing.lg, marginBottom: spacing.sm },
  theirCard: { backgroundColor: colors.bgTertiary, padding: spacing.md, borderRadius: radius.md },
  theirText: { ...typography.body, color: colors.textPrimary, lineHeight: 22 },

  visitCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgSecondary,
    padding: spacing.md,
    borderRadius: radius.md,
    marginBottom: spacing.sm,
    ...shadow.subtle,
  },
  placeName: { ...typography.h3, color: colors.textPrimary },
  visitMeta: { ...typography.caption, color: colors.textSecondary, marginTop: 2 },
  emptyCard: { backgroundColor: colors.bgTertiary, padding: spacing.lg, borderRadius: radius.md, alignItems: 'center' },
  empty: { ...typography.body, color: colors.textSecondary },
  backText: { ...typography.body, color: colors.accent, marginTop: spacing.md, fontWeight: '600' },
});
