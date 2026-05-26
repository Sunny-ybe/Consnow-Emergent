import { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ChevronLeft, MapPin, Sparkles } from 'lucide-react-native';
import { colors, spacing, radius, typography, shadow } from '@/src/theme';
import { Avatar } from '@/src/Avatar';
import { AvailabilityBadge } from '@/src/AvailabilityBadge';
import { SnapSlider } from '@/src/SnapSlider';
import { getTimeline, listFriends, updateScope, getDayNarrative } from '@/src/api';
import { formatTimeAgo } from '../(tabs)/index';

const SCOPES = ['10m', '1h', '6h', '12h', '24h', 'off'];
const SCOPE_LABELS_SHORT = ['10m', '1h', '6h', '12h', '24h', 'Off'];
const SCOPE_LABELS: Record<string, string> = {
  '10m': '10 min',
  '1h': '1 hour',
  '6h': '6 hours',
  '12h': '12 hours',
  '24h': '24 hours',
  off: 'Off',
};

export default function FriendDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [friend, setFriend] = useState<any>(null);
  const [scope, setScope] = useState<string>('10m');
  const [theirScope, setTheirScope] = useState<string>('10m');
  const [visits, setVisits] = useState<any[]>([]);
  const [narrative, setNarrative] = useState<string>('');
  const [narrativeLoading, setNarrativeLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await listFriends();
      const f = d.friends.find((x: any) => x.user.id === id);
      if (f) {
        setFriend(f);
        setScope(f.scope_i_grant);
        setTheirScope(f.scope_they_grant);
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

  const onSelectScope = async (s: string) => {
    if (saving || s === scope) return;
    setSaving(true);
    setScope(s);
    try {
      await updateScope(id, s);
    } catch (e: any) {
      Alert.alert('Could not update', e?.response?.data?.detail || 'Try again');
    } finally {
      setSaving(false);
    }
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
                testID="friend-detail-availability"
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

        <Text style={styles.sectionHeader}>What you share with them</Text>
        <View style={styles.scopeCard}>
          <Text style={styles.scopeLabel}>
            Updates every <Text style={{ fontWeight: '800' }}>{SCOPE_LABELS[scope]}</Text>
          </Text>
          <SnapSlider
            testID="scope-slider"
            steps={SCOPES}
            labels={SCOPE_LABELS_SHORT}
            value={scope}
            onChange={onSelectScope}
          />
          <Text style={styles.scopeHint}>
            {scope === 'off'
              ? 'They will not see any new location updates from you.'
              : `They will see your location with a ${SCOPE_LABELS[scope].toLowerCase()} delay.`}
          </Text>
        </View>

        <Text style={styles.sectionHeader}>What they share with you</Text>
        <View style={styles.theirCard}>
          <Text style={styles.theirText}>
            {theirScope === 'off' ? (
              <>They have paused sharing with you.</>
            ) : (
              <>You see their updates every <Text style={{ fontWeight: '700' }}>{SCOPE_LABELS[theirScope]}</Text>.</>
            )}
          </Text>
        </View>

        <Text style={styles.sectionHeader}>Recent places</Text>
        {visits.length === 0 ? (
          <View style={styles.emptyCard}>
            <Text style={styles.empty}>
              {theirScope === 'off'
                ? 'Nothing to show — sharing is off.'
                : 'No visits visible yet.'}
            </Text>
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
  narrativeHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 6,
  },
  narrativeLabel: {
    ...typography.overline,
    color: colors.brand,
  },
  narrativeText: {
    ...typography.bodyLarge,
    color: colors.textPrimary,
    lineHeight: 24,
  },
  narrativeLoadingRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  narrativeLoadingText: { ...typography.body, color: colors.textSecondary },
  sectionHeader: { ...typography.overline, color: colors.textSecondary, marginTop: spacing.lg, marginBottom: spacing.sm },
  scopeCard: {
    backgroundColor: colors.bgSecondary,
    padding: spacing.md,
    borderRadius: radius.lg,
    ...shadow.subtle,
  },
  scopeLabel: { ...typography.bodyLarge, color: colors.textPrimary, marginBottom: spacing.md },
  scopeHint: { ...typography.caption, color: colors.textSecondary, marginTop: spacing.sm },
  theirCard: {
    backgroundColor: colors.bgTertiary,
    padding: spacing.md,
    borderRadius: radius.md,
  },
  theirText: { ...typography.body, color: colors.textPrimary },
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
  emptyCard: {
    backgroundColor: colors.bgTertiary,
    padding: spacing.lg,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  empty: { ...typography.body, color: colors.textSecondary },
  backText: { ...typography.body, color: colors.accent, marginTop: spacing.md, fontWeight: '600' },
});
