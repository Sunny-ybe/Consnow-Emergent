import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { Clock } from 'lucide-react-native';
import { colors, spacing, radius, typography, shadow } from '@/src/theme';
import { Avatar } from '@/src/Avatar';
import { AvailabilityBadge } from '@/src/AvailabilityBadge';
import { getTimeline, listFriends } from '@/src/api';
import { useAuth } from '@/src/auth';

// ─── Types ───────────────────────────────────────────────────────────────────

type Visit = {
  type: 'visit';
  id: string;
  place_name: string;
  place_category?: string;
  formatted_address?: string;
  started_at: string;
  ended_at: string | null;
  center_lat?: number;
  center_lng?: number;
  activity?: string;
  availability?: string;
  visit_count?: number;
  duration_minutes?: number | null;
};

type Transport = {
  type: 'transport';
  duration: number;   // seconds
  distance_m: number;
  from_place?: string;
  to_place?: string;
};

type TimelineItem = Visit | Transport;
type DayGroup = { day: string; label: string; items: TimelineItem[] };

type FlatVisit = {
  type: 'visit';
  data: Visit;
  showLineAbove: boolean;
  showLineBelow: boolean;
  isFirstEver: boolean;
};
type FlatTransport = { type: 'transport'; data: Transport };
type FlatSeparator = { type: 'daySeparator'; day: string; label: string };
type FlatItem = FlatVisit | FlatTransport | FlatSeparator;

// ─── Sub-components ──────────────────────────────────────────────────────────

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

// Pre-allocate dash segments so the array isn't recreated on every render
const DASHES = Array.from({ length: 8 });
function DashedLine() {
  return (
    <View style={styles.dashedLineWrap}>
      {DASHES.map((_, i) => (
        <View key={i} style={styles.dash} />
      ))}
    </View>
  );
}

const FlatItemRow = memo(function FlatItemRow({
  item,
  minuteTick,
  timezone,
}: {
  item: FlatItem;
  minuteTick: number;
  timezone: string;
}) {
  if (item.type === 'daySeparator') {
    return <View style={styles.daySep} />;
  }

  if (item.type === 'transport') {
    const t = item.data;
    return (
      <View style={styles.transportRow}>
        <View style={styles.axis}>
          <DashedLine />
        </View>
        <View style={styles.transportContent}>
          <View style={styles.transportPill}>
            <Text style={styles.transportText}>
              {[
                formatTransportDistance(t.distance_m),
                formatTransportDuration(t.duration),
                formatTransportSpeed(t.distance_m, t.duration),
              ]
                .filter(Boolean)
                .join(' · ')}
            </Text>
          </View>
        </View>
      </View>
    );
  }

  const { data: v, showLineAbove, showLineBelow, isFirstEver } = item;
  const ongoing = isOngoing(v.ended_at, minuteTick);
  const cat = categoryInfo(v.place_category);
  const isMerged = (v.visit_count || 1) > 1;

  return (
    <View style={styles.visitRow}>
      <View style={styles.axis}>
        {showLineAbove
          ? <View style={styles.lineAbove} />
          : <View style={styles.lineAboveSpacer} />}
        {ongoing ? <PulsingDot /> : (
          <View style={[styles.node, isMerged && styles.nodeMerged, isFirstEver && styles.nodeActive]} />
        )}
        {showLineBelow && <View style={styles.line} />}
      </View>

      <TouchableOpacity
        testID={`visit-card-${v.id}`}
        style={styles.card}
        activeOpacity={0.75}
        disabled={v.center_lat == null || v.center_lng == null}
        onPress={() => openInMaps(v.center_lat!, v.center_lng!)}
      >
        <View style={styles.cardInner}>
          <View style={[styles.catCircle, { backgroundColor: cat.bg }]}>
            <Text style={styles.catEmoji}>{cat.emoji}</Text>
          </View>
          <View style={styles.cardBody}>
            <Text style={styles.placeName} numberOfLines={1}>{v.place_name}</Text>
            {v.place_category ? (
              <Text style={styles.category}>{v.place_category.replace(/_/g, ' ')}</Text>
            ) : null}
            {v.formatted_address ? (
              <Text style={styles.address} numberOfLines={1}>{v.formatted_address}</Text>
            ) : null}
            <View style={styles.metaRow}>
              <Text style={styles.duration}>{formatVisitDuration(v, ongoing, minuteTick)}</Text>
              <Text style={styles.timeRange}>{formatTimeRange(v.started_at, v.ended_at, ongoing, timezone)}</Text>
            </View>
            {ongoing && v.availability ? (
              <View style={styles.badgeRow}>
                <AvailabilityBadge
                  availability={v.availability as any}
                  activity={v.activity}
                  showActivity
                  size="sm"
                />
              </View>
            ) : null}
          </View>
        </View>
      </TouchableOpacity>
    </View>
  );
});

// ─── Main screen ─────────────────────────────────────────────────────────────

export default function TimelineScreen() {
  const { user } = useAuth();
  const [selected, setSelected] = useState<string | null>(null);
  const [friends, setFriends] = useState<any[]>([]);
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [scopeOff, setScopeOff] = useState(false);
  const [visibleDayLabel, setVisibleDayLabel] = useState('Today');
  const [displayedDays, setDisplayedDays] = useState(3);
  const [timelineTimezone, setTimelineTimezone] = useState('UTC');

  // Tick every 60 s so ongoing-visit durations stay live
  const [minuteTick, setMinuteTick] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setMinuteTick(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const loadFriends = useCallback(async () => {
    try {
      const d = await listFriends();
      setFriends(d.friends);
    } catch {}
  }, []);

  const loadTimeline = useCallback(async (uid?: string | null) => {
    try {
      const res = await getTimeline(uid || undefined);
      const newItems: TimelineItem[] = filterShortVisits(res.visits || []);
      const timezone = res.timezone || 'UTC';
      setItems(newItems);
      setTimelineTimezone(timezone);
      setScopeOff(res.scope === 'off');
      setDisplayedDays(3);
      // Seed the sticky header immediately so it's correct before onViewableItemsChanged fires
      const firstGroup = groupByDay(newItems, timezone)[0];
      setVisibleDayLabel(firstGroup?.label ?? 'Today');
    } catch (e: any) {
      setItems([]);
      setTimelineTimezone('UTC');
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

  const grouped = useMemo(
    () => normalizeTodayGroups(groupByDay(collapseRepeatedVisits(items, timelineTimezone), timelineTimezone), timelineTimezone),
    [items, timelineTimezone],
  );
  const flatItems = useMemo(() => buildFlatItems(grouped.slice(0, displayedDays)), [displayedDays, grouped]);

  const onEndReached = useCallback(() => {
    setDisplayedDays((d) => Math.min(d + 3, grouped.length));
  }, [grouped.length]);

  const renderTimelineItem = useCallback(
    ({ item }: { item: FlatItem }) => (
      <FlatItemRow item={item} minuteTick={minuteTick} timezone={timelineTimezone} />
    ),
    [minuteTick, timelineTimezone],
  );

  // Both refs must be stable across renders — FlatList warns if they change
  const viewabilityConfig = useRef({ minimumViewTime: 0, itemVisiblePercentThreshold: 1 });
  const onViewableItemsChanged = useRef(({ viewableItems }: any) => {
    // Find the topmost visible day separator and update the sticky header
    const sep = viewableItems.find((vi: any) => vi.item?.type === 'daySeparator');
    if (sep) setVisibleDayLabel(sep.item.label);
  });

  return (
    <SafeAreaView style={styles.container} edges={['top']}>

      {/* Friend avatar picker — stays fixed above the date header */}
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
          <View style={[styles.avatarRing, selected === null && styles.avatarRingActive]}>
            <Avatar name={user?.display_name} size={48} />
          </View>
          <Text style={[styles.avatarLabel, selected === null && styles.avatarLabelActive]}>You</Text>
        </TouchableOpacity>
        {friends.map((f) => {
          const isSelected = selected === f.user.id;
          return (
            <TouchableOpacity
              key={f.user.id}
              testID={`timeline-friend-${f.user.id}`}
              style={[styles.avatarTile, isSelected && styles.avatarTileActive]}
              onPress={() => setSelected(f.user.id)}
              activeOpacity={0.7}
            >
              <View style={[styles.avatarRing, isSelected && styles.avatarRingActive]}>
                <Avatar name={f.user.display_name} size={48} />
              </View>
              <Text style={[styles.avatarLabel, isSelected && styles.avatarLabelActive]} numberOfLines={1}>
                {f.user.display_name.split(' ')[0]}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {/* Sticky date label — updates as user scrolls through days */}
      <View style={styles.stickyHeader}>
        <Text style={styles.stickyHeaderLabel}>{visibleDayLabel}</Text>
      </View>

      {/* Single continuously scrollable timeline */}
      <FlatList
        data={flatItems}
        keyExtractor={timelineItemKey}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        contentContainerStyle={styles.listContent}
        onEndReached={onEndReached}
        onEndReachedThreshold={0.3}
        onViewableItemsChanged={onViewableItemsChanged.current}
        viewabilityConfig={viewabilityConfig.current}
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
        renderItem={renderTimelineItem}
      />
    </SafeAreaView>
  );
}

function timelineItemKey(item: FlatItem, index: number): string {
  if (item.type === 'daySeparator') return `sep-${item.day}`;
  if (item.type === 'visit') {
    const v = item.data;
    return `visit-${v.id || 'missing'}-${v.started_at || index}-${index}`;
  }
  return `transport-${item.data.from_place || 'from'}-${item.data.to_place || 'to'}-${item.data.duration}-${index}`;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildFlatItems(groups: DayGroup[]): FlatItem[] {
  const flat: FlatItem[] = [];
  let isFirstEver = true;

  for (const group of groups) {
    flat.push({ type: 'daySeparator', day: group.day, label: group.label });

    for (let i = 0; i < group.items.length; i++) {
      const item = group.items[i];
      const prev = i > 0 ? group.items[i - 1] : null;
      const next = i < group.items.length - 1 ? group.items[i + 1] : null;

      if (item.type === 'transport') {
        flat.push({ type: 'transport', data: item });
      } else {
        flat.push({
          type: 'visit',
          data: item as Visit,
          showLineAbove: prev !== null,
          showLineBelow: next !== null,
          isFirstEver,
        });
        isFirstEver = false;
      }
    }
  }

  return flat;
}

function collapseRepeatedVisits(items: TimelineItem[], timezone: string): TimelineItem[] {
  const collapsed: TimelineItem[] = [];
  let run: Visit[] = [];
  let pendingTransport: Transport[] = [];

  const flushRun = () => {
    if (run.length > 0) {
      collapsed.push(mergeVisitRun(run));
      run = [];
    }
  };

  const flushPendingTransport = () => {
    if (pendingTransport.length > 0) {
      collapsed.push(...pendingTransport);
      pendingTransport = [];
    }
  };

  for (const item of items) {
    if (item.type === 'transport') {
      if (run.length > 0) {
        pendingTransport.push(item);
      } else {
        collapsed.push(item);
      }
      continue;
    }

    if (run.length === 0) {
      run = [item];
      continue;
    }

    const previous = run[run.length - 1];
    const previousPlace = normalizePlaceName(previous.place_name);
    const itemPlace = normalizePlaceName(item.place_name);
    const samePlace = previousPlace.length > 0 && previousPlace === itemPlace;
    const sameDay = dayKey(new Date(previous.started_at), timezone) === dayKey(new Date(item.started_at), timezone);

    if (samePlace && sameDay) {
      run.push(item);
      pendingTransport = [];
    } else {
      flushRun();
      flushPendingTransport();
      run = [item];
    }
  }

  flushRun();
  flushPendingTransport();
  return collapsed;
}

function mergeVisitRun(visits: Visit[]): Visit {
  if (visits.length === 1) return visits[0];

  let startedAt = visits[0].started_at;
  let endedAt = visits[0].ended_at;

  for (const visit of visits) {
    if (new Date(visit.started_at).getTime() < new Date(startedAt).getTime()) {
      startedAt = visit.started_at;
    }
    if (visit.ended_at === null) {
      endedAt = null;
    } else if (endedAt !== null && new Date(visit.ended_at).getTime() > new Date(endedAt).getTime()) {
      endedAt = visit.ended_at;
    }
  }

  return {
    ...visits[0],
    started_at: startedAt,
    ended_at: endedAt,
    visit_count: visits.length,
  };
}

function normalizePlaceName(place?: string): string {
  return (place || '').trim().toLowerCase();
}

function filterShortVisits(items: TimelineItem[]): TimelineItem[] {
  return items.filter((item) => item.type === 'transport' || !isShortClosedVisit(item));
}

function isShortClosedVisit(v: Visit): boolean {
  const durationMinutes = visitDurationMinutes(v);
  console.log(
    'Timeline visit duration filter:',
    v.id,
    v.place_name,
    'started_at=',
    v.started_at,
    'ended_at=',
    v.ended_at,
    'duration_minutes=',
    durationMinutes,
  );
  if (v.ended_at === null) return false;
  if (durationMinutes === null) return false;
  return durationMinutes < 5;
}

function visitDurationMinutes(v: Visit): number | null {
  if (v.ended_at === null) return null;
  const started = new Date(v.started_at).getTime();
  const ended = new Date(v.ended_at).getTime();
  if (!Number.isFinite(started) || !Number.isFinite(ended)) return null;
  return (ended - started) / 60000;
}

function normalizeTodayGroups(groups: DayGroup[], timezone: string): DayGroup[] {
  const today = dayKey(new Date(), timezone);
  const hasTodayVisit = groups.some((group) =>
    group.day === today && group.items.some((item) => item.type !== 'transport'),
  );
  if (hasTodayVisit) return groups;

  let latestGroupIndex = -1;
  let latestItemIndex = -1;
  let latestTime = -Infinity;

  groups.forEach((group, groupIndex) => {
    group.items.forEach((item, itemIndex) => {
      if (item.type === 'transport') return;
      const time = new Date(item.started_at).getTime();
      if (!Number.isFinite(time)) return;
      if (time > latestTime) {
        latestTime = time;
        latestGroupIndex = groupIndex;
        latestItemIndex = itemIndex;
      }
    });
  });

  if (latestGroupIndex === -1 || latestItemIndex === -1) return groups;

  const latestVisit = groups[latestGroupIndex].items[latestItemIndex];
  const remainingGroups = groups
    .map((group, groupIndex) => ({
      ...group,
      items: group.items.filter((_, itemIndex) => groupIndex !== latestGroupIndex || itemIndex !== latestItemIndex),
    }))
    .filter((group) => group.items.length > 0);

  return [{ day: today, label: 'Today', items: [latestVisit] }, ...remainingGroups];
}

function categoryInfo(cat?: string): { emoji: string; bg: string } {
  if (!cat) return { emoji: '📍', bg: colors.bgTertiary };
  const c = cat.toLowerCase();
  if (c.includes('gym') || c.includes('fitness') || c.includes('sport'))
    return { emoji: '💪', bg: '#FFE5E5' };
  if (c.includes('library'))
    return { emoji: '📚', bg: '#E5EBFF' };
  if (c.includes('restaurant') || c.includes('food') || c.includes('meal') || c.includes('bakery'))
    return { emoji: '🍴', bg: '#FFF0E5' };
  if (c.includes('coffee') || c.includes('cafe'))
    return { emoji: '☕', bg: '#F5EFE0' };
  if (c.includes('hotel') || c.includes('lodging'))
    return { emoji: '🏨', bg: '#F0E5FF' };
  if (c.includes('police'))
    return { emoji: '🚔', bg: '#E5F0FF' };
  if (c.includes('shop') || c.includes('store') || c.includes('mall'))
    return { emoji: '🛍️', bg: '#FFE5F5' };
  return { emoji: '📍', bg: colors.bgTertiary };
}

function openInMaps(lat: number, lng: number) {
  Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${lat},${lng}`);
}

function isOngoing(endedAt: string | null, now = Date.now()): boolean {
  if (endedAt === null) return true;
  const ended = new Date(endedAt).getTime();
  return ended <= now && now - ended < 15 * 60 * 1000;
}

function groupByDay(items: TimelineItem[], timezone: string): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const item of items) {
    if (item.type === 'transport') {
      if (groups.length > 0) groups[groups.length - 1].items.push(item);
      continue;
    }
    const d = new Date(item.started_at);
    const key = dayKey(d, timezone);
    if (groups.length === 0 || groups[groups.length - 1].day !== key) {
      groups.push({ day: key, label: dayLabel(d, timezone), items: [] });
    }
    groups[groups.length - 1].items.push(item);
  }
  return groups;
}

function dayKey(d: Date, timezone: string): string {
  const parts = dateParts(d, timezone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function dayLabel(d: Date, timezone: string): string {
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const same = (a: Date, b: Date) => dayKey(a, timezone) === dayKey(b, timezone);
  if (same(d, today)) return 'Today';
  if (same(d, yesterday)) return 'Yesterday';
  try {
    return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', timeZone: timezone });
  } catch {
    return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  }
}

function dateParts(d: Date, timezone: string): { year: string; month: string; day: string } {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      timeZone: timezone,
    }).formatToParts(d);
    const value = (type: string) => parts.find((part) => part.type === type)?.value || '';
    return { year: value('year'), month: value('month'), day: value('day') };
  } catch {
    return {
      year: String(d.getFullYear()),
      month: String(d.getMonth() + 1),
      day: String(d.getDate()),
    };
  }
}

function formatDuration(start: string, end: string | null, ongoing = false, now = Date.now()): string {
  const s = new Date(start).getTime();
  const e = ongoing ? now : new Date(end || start).getTime();
  const raw = Math.round((e - s) / 60000);
  // Math.max(0, NaN) === NaN in JS; guard explicitly
  const mins = isNaN(raw) ? 0 : Math.max(0, raw);
  if (mins < 1) return '<1 min';
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function formatVisitDuration(v: Visit, ongoing = false, now = Date.now()): string {
  return formatDuration(v.started_at, v.ended_at, ongoing, now);
}

function formatTimeRange(start: string, end: string | null, ongoing = false, timezone = 'UTC'): string {
  try {
    const fmt = (d: Date) =>
      d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: timezone });
    if (ongoing) return `${fmt(new Date(start))} – now`;
    return `${fmt(new Date(start))} – ${fmt(new Date(end || start))}`;
  } catch {
    try {
      const fmt = (d: Date) =>
        d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
      if (ongoing) return `${fmt(new Date(start))} – now`;
      return `${fmt(new Date(start))} – ${fmt(new Date(end || start))}`;
    } catch {
      return '';
    }
  }
}

function formatTransportDistance(m: number): string {
  if (m == null) return '';
  return m < 1000 ? `${Math.round(m)}m` : `${(m / 1000).toFixed(1)}km`;
}

function formatTransportDuration(secs: number): string {
  const mins = Math.round(secs / 60);
  if (mins < 1) return '<1 min';
  if (mins < 60) return `${mins}min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function formatTransportSpeed(distance_m: number, duration: number): string {
  if (!distance_m || !duration) return '';
  const distanceKm = distance_m / 1000;
  const durationMinutes = duration / 60;
  const speed = Math.round((distanceKm / durationMinutes) * 60 * 10) / 10;
  return `${speed.toFixed(1)} km/h`;
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const AXIS_WIDTH = 32;
const NODE_SIZE = 12;
const LINE_W = 2;
// Shorter connector keeps transport segments compact (was 14)
const LINE_ABOVE_H = 8;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },

  // Friend picker
  avatarRow: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, gap: 12 },
  avatarTile: {
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: radius.lg,
  },
  avatarTileActive: { backgroundColor: colors.accentMuted },
  avatarRing: {
    borderWidth: 2,
    borderColor: 'transparent',
    borderRadius: 28,
    padding: 2,
    opacity: 0.74,
  },
  avatarRingActive: {
    borderColor: colors.accent,
    opacity: 1,
  },
  avatarLabel: { ...typography.caption, color: colors.textSecondary, maxWidth: 64 },
  avatarLabelActive: { color: colors.brand, fontWeight: '800' },

  // Sticky date header (replaces the arrow nav bar)
  stickyHeader: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.bg,
  },
  stickyHeaderLabel: { ...typography.h3, color: colors.textPrimary },

  listContent: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xxl,
  },

  // ── Day separator (in-list anchor for viewability tracking) ──
  daySep: {
    height: 1,
    opacity: 0,
  },
  // ── Visit row ──
  visitRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
  },

  // Axis: narrow column that carries the continuous line
  axis: {
    width: AXIS_WIDTH,
    alignItems: 'center',
    flexDirection: 'column',
  },
  lineAboveSpacer: { width: LINE_W, height: LINE_ABOVE_H },
  lineAbove: { width: LINE_W, height: LINE_ABOVE_H, backgroundColor: colors.textTertiary },
  node: {
    width: NODE_SIZE,
    height: NODE_SIZE,
    borderRadius: NODE_SIZE / 2,
    backgroundColor: colors.textSecondary,
  },
  nodeActive: { backgroundColor: colors.accent },
  nodeOngoing: { backgroundColor: colors.accent },
  nodeMerged: {
    width: NODE_SIZE + 4,
    height: NODE_SIZE + 4,
    borderRadius: (NODE_SIZE + 4) / 2,
    borderWidth: 3,
    borderColor: colors.bg,
  },
  line: { width: LINE_W, flex: 1, backgroundColor: colors.textTertiary, marginTop: 2 },

  // ── Transport row — kept tight so it reads as a connector, not a card ──
  transportRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    height: 60,
  },
  dashedLineWrap: {
    width: LINE_W,
    flex: 1,
    overflow: 'hidden',
  },
  dash: {
    width: LINE_W,
    height: 4,
    backgroundColor: colors.textTertiary,
    marginBottom: 3,
  },
  transportContent: {
    flex: 1,
    justifyContent: 'center',
    paddingLeft: spacing.sm + 4,
    paddingVertical: 2,
  },
  transportPill: {
    alignSelf: 'flex-start',
    backgroundColor: colors.bgTertiary,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
  },
  transportText: {
    ...typography.caption,
    color: colors.textPrimary,
    fontStyle: 'italic',
    fontWeight: '700',
  },

  // ── Place card ──
  card: {
    flex: 1,
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginLeft: spacing.sm,
    marginBottom: spacing.xs,
    ...shadow.subtle,
  },
  cardInner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  catCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  catEmoji: { fontSize: 18 },
  cardBody: { flex: 1 },
  placeName: { ...typography.h3, color: colors.textPrimary, marginBottom: 1 },
  category: { ...typography.caption, color: colors.textTertiary, marginBottom: 3 },
  address: { ...typography.caption, color: colors.textSecondary, marginBottom: 4 },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 2,
  },
  duration: { ...typography.caption, color: colors.textPrimary, fontWeight: '700' },
  timeRange: { ...typography.caption, color: colors.textTertiary },
  badgeRow: { marginTop: 6 },

  // ── Empty state ──
  empty: { alignItems: 'center', paddingVertical: spacing.xxl, gap: spacing.sm },
  emptyTitle: { ...typography.h2, color: colors.textPrimary, marginTop: spacing.md },
  emptyBody: {
    ...typography.body,
    color: colors.textSecondary,
    textAlign: 'center',
    paddingHorizontal: spacing.lg,
  },
});
