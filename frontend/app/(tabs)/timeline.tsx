import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  ScrollView,
  Linking,
  Animated,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from 'expo-router';
import { MapPin, Clock } from 'lucide-react-native';
import { colors, spacing, radius, typography, shadow } from '@/src/theme';
import { Avatar } from '@/src/Avatar';
import { AvailabilityBadge } from '@/src/AvailabilityBadge';
import { getTimeline, listFriends } from '@/src/api';
import { useAuth } from '@/src/auth';
import { formatTimeAgo } from './index';

type Visit = {
  type: 'visit';
  id: string;
  place_name: string;
  place_category?: string;
  neighborhood?: string;
  city?: string;
  formatted_address?: string;
  started_at: string;
  ended_at: string;
  center_lat?: number;
  center_lng?: number;
  activity?: string;
  availability?: string;
};

type Transport = {
  type: 'transport';
  duration: number;    // seconds
  distance_m: number;
  from_place?: string;
  to_place?: string;
};

type TimelineItem = Visit | Transport;

// Pulsing blue dot for ongoing visits
function PulsingDot() {
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.25, duration: 700, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 700, useNativeDriver: true }),
      ])
    ).start();
  }, [opacity]);
  return <Animated.View style={[styles.node, styles.nodeOngoing, { opacity }]} />;
}

export default function TimelineScreen() {
  const { user } = useAuth();
  const [selected, setSelected] = useState<string | null>(null);
  const [friends, setFriends] = useState<any[]>([]);
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [scopeOff, setScopeOff] = useState(false);

  const loadFriends = useCallback(async () => {
    try {
      const d = await listFriends();
      setFriends(d.friends);
    } catch {}
  }, []);

  const loadTimeline = useCallback(async (uid?: string | null) => {
    try {
      const res = await getTimeline(uid || undefined);
      setItems(res.visits || []);
      setScopeOff(res.scope === 'off');
    } catch (e: any) {
      setItems([]);
      if (e?.response?.status === 403) setScopeOff(true);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadFriends();
      loadTimeline(selected);
    }, [loadFriends, loadTimeline, selected]),
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadTimeline(selected);
    setRefreshing(false);
  }, [loadTimeline, selected]);

  const grouped = groupByDay(items);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.title}>Timeline</Text>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.avatarRow}
      >
        <TouchableOpacity
          testID="timeline-self"
          style={[styles.avatarTile, selected === null && styles.avatarTileActive]}
          onPress={() => setSelected(null)}
          activeOpacity={0.7}
        >
          <Avatar name={user?.display_name} size={56} />
          <Text style={styles.avatarLabel}>You</Text>
        </TouchableOpacity>
        {friends.map((f) => (
          <TouchableOpacity
            key={f.user.id}
            testID={`timeline-friend-${f.user.id}`}
            style={[styles.avatarTile, selected === f.user.id && styles.avatarTileActive]}
            onPress={() => setSelected(f.user.id)}
            activeOpacity={0.7}
          >
            <Avatar name={f.user.display_name} size={56} />
            <Text style={styles.avatarLabel} numberOfLines={1}>
              {f.user.display_name.split(' ')[0]}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <FlatList
        data={grouped}
        keyExtractor={(g) => g.day}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xxl }}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Clock size={48} color={colors.textTertiary} strokeWidth={1.5} />
            <Text style={styles.emptyTitle}>
              {scopeOff ? 'Sharing is off' : selected ? 'No visits yet' : 'No history yet'}
            </Text>
            <Text style={styles.emptyBody}>
              {scopeOff
                ? 'This friend has paused sharing with you.'
                : 'Visits will appear once you start sharing your location.'}
            </Text>
          </View>
        }
        renderItem={({ item: day }) => {
          const firstVisitId = (day.items.find((i) => i.type !== 'transport') as Visit | undefined)?.id;
          return (
            <View style={{ marginBottom: spacing.lg }}>
              <Text style={styles.dayHeader}>{day.label}</Text>
              {day.items.map((item, idx) => {
                // Transport segment
                if (item.type === 'transport') {
                  return (
                    <View key={`t-${idx}`} style={styles.visitRow}>
                      <View style={styles.axis}>
                        {idx < day.items.length - 1 && <View style={styles.line} />}
                      </View>
                      <View style={styles.transportCard}>
                        <Text style={styles.transportText}>
                          {[
                            formatTransportDistance(item.distance_m),
                            formatTransportDuration(item.duration),
                          ]
                            .filter(Boolean)
                            .join('  ·  ')}
                        </Text>
                      </View>
                    </View>
                  );
                }

                // Visit
                const v = item as Visit;
                const ongoing = isOngoing(v.ended_at);
                const isFirstVisit = v.id === firstVisitId;

                return (
                  <View key={v.id} style={styles.visitRow}>
                    <View style={styles.axis}>
                      {ongoing ? (
                        <PulsingDot />
                      ) : (
                        <View style={[styles.node, isFirstVisit && styles.nodeActive]} />
                      )}
                      {idx < day.items.length - 1 && <View style={styles.line} />}
                    </View>
                    <TouchableOpacity
                      testID={`visit-card-${v.id}`}
                      style={styles.card}
                      activeOpacity={0.75}
                      disabled={v.center_lat == null || v.center_lng == null}
                      onPress={() => openInMaps(v.center_lat!, v.center_lng!)}
                    >
                      <View style={styles.cardHeader}>
                        <MapPin size={16} color={colors.brand} strokeWidth={2.2} />
                        <Text style={styles.placeName} numberOfLines={1}>
                          {v.place_name}
                        </Text>
                      </View>
                      {v.place_category ? (
                        <Text style={styles.category}>
                          {v.place_category.replace(/_/g, ' ')}
                        </Text>
                      ) : null}
                      {v.formatted_address ? (
                        <Text style={styles.address} numberOfLines={1}>
                          {v.formatted_address}
                        </Text>
                      ) : null}
                      <View style={styles.metaRow}>
                        <Text style={styles.duration}>
                          {formatDuration(v.started_at, v.ended_at, ongoing)}
                        </Text>
                        <Text style={styles.timeAgo}>
                          {formatTimeRange(v.started_at, v.ended_at, ongoing)}
                        </Text>
                      </View>
                      {v.availability ? (
                        <View style={styles.badgeRow}>
                          <AvailabilityBadge
                            availability={v.availability as any}
                            activity={v.activity}
                            showActivity
                            size="sm"
                          />
                        </View>
                      ) : null}
                    </TouchableOpacity>
                  </View>
                );
              })}
            </View>
          );
        }}
      />
    </SafeAreaView>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function openInMaps(lat: number, lng: number) {
  Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${lat},${lng}`);
}

function isOngoing(endedAt: string): boolean {
  const ended = new Date(endedAt).getTime();
  const now = Date.now();
  // Guard against future ended_at (wrong device clock) treating every visit as ongoing
  return ended <= now && now - ended < 15 * 60 * 1000;
}

function groupByDay(items: TimelineItem[]): { day: string; label: string; items: TimelineItem[] }[] {
  const groups: { day: string; label: string; items: TimelineItem[] }[] = [];
  for (const item of items) {
    if (item.type === 'transport') {
      // Attach to current group; ignore if no group started yet
      if (groups.length > 0) groups[groups.length - 1].items.push(item);
      continue;
    }
    const d = new Date(item.started_at);
    const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    if (groups.length === 0 || groups[groups.length - 1].day !== key) {
      groups.push({ day: key, label: dayLabel(d), items: [] });
    }
    groups[groups.length - 1].items.push(item);
  }
  return groups;
}

function dayLabel(d: Date): string {
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const same = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (same(d, today)) return 'Today';
  if (same(d, yesterday)) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

function formatDuration(start: string, end: string, ongoing = false): string {
  const s = new Date(start).getTime();
  const e = ongoing ? Date.now() : new Date(end).getTime();
  const mins = Math.max(0, Math.round((e - s) / 60000));
  if (mins < 1) return 'Briefly';
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function formatTimeRange(start: string, end: string, ongoing = false): string {
  const fmt = (d: Date) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (ongoing) return `${fmt(new Date(start))} – now`;
  return `${fmt(new Date(start))} – ${fmt(new Date(end))}`;
}

function formatTransportDistance(m: number): string {
  if (m == null) return '';
  return m < 1000 ? `${Math.round(m)}m` : `${(m / 1000).toFixed(1)}km`;
}

function formatTransportDuration(secs: number): string {
  const mins = Math.round(secs / 60);
  if (mins < 1) return '<1 min';
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

// ─── Styles ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: { paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  title: { ...typography.h1, color: colors.textPrimary },
  avatarRow: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: 12 },
  avatarTile: { alignItems: 'center', gap: 6, padding: 4, borderRadius: radius.md },
  avatarTileActive: { backgroundColor: colors.bgTertiary },
  avatarLabel: { ...typography.caption, color: colors.textPrimary, maxWidth: 70 },
  dayHeader: { ...typography.overline, color: colors.textSecondary, marginBottom: spacing.md },
  visitRow: { flexDirection: 'row', minHeight: 80 },
  axis: { width: 24, alignItems: 'center' },
  node: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: colors.textSecondary,
    marginTop: spacing.md,
  },
  nodeActive: { backgroundColor: colors.accent },
  nodeOngoing: { backgroundColor: colors.accent },
  line: { width: 2, flex: 1, backgroundColor: colors.border, marginTop: 4 },
  card: {
    flex: 1,
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginBottom: spacing.sm,
    marginLeft: spacing.sm,
    ...shadow.subtle,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  placeName: { ...typography.h3, color: colors.textPrimary, flex: 1 },
  category: { ...typography.caption, color: colors.textTertiary, marginBottom: 4 },
  address: { ...typography.body, color: colors.textSecondary, marginBottom: 6 },
  metaRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  duration: { ...typography.caption, color: colors.textPrimary, fontWeight: '700' },
  timeAgo: { ...typography.caption, color: colors.textTertiary },
  badgeRow: { marginTop: 6 },
  transportCard: {
    flex: 1,
    marginLeft: spacing.sm,
    marginBottom: spacing.sm,
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.bgTertiary,
    borderRadius: radius.md,
    alignSelf: 'flex-start',
  },
  transportText: { ...typography.caption, color: colors.textSecondary },
  empty: { alignItems: 'center', paddingVertical: spacing.xxl, gap: spacing.sm },
  emptyTitle: { ...typography.h2, color: colors.textPrimary, marginTop: spacing.md },
  emptyBody: {
    ...typography.body,
    color: colors.textSecondary,
    textAlign: 'center',
    paddingHorizontal: spacing.lg,
  },
});
