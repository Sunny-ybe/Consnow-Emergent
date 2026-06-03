import { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, RefreshControl, ScrollView, Linking } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from 'expo-router';
import { MapPin, Clock } from 'lucide-react-native';
import { colors, spacing, radius, typography, shadow } from '@/src/theme';
import { Avatar } from '@/src/Avatar';
import { getTimeline, listFriends } from '@/src/api';
import { useAuth } from '@/src/auth';
import { formatTimeAgo } from './index';

type Visit = {
  id: string;
  place_name: string;
  neighborhood?: string;
  city?: string;
  formatted_address?: string;
  started_at: string;
  ended_at: string;
  center_lat?: number;
  center_lng?: number;
};

export default function TimelineScreen() {
  const { user } = useAuth();
  const [selected, setSelected] = useState<string | null>(null); // friend id or null=me
  const [friends, setFriends] = useState<any[]>([]);
  const [visits, setVisits] = useState<Visit[]>([]);
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
      setVisits(res.visits || []);
      setScopeOff(res.scope === 'off');
    } catch (e: any) {
      setVisits([]);
      if (e?.response?.status === 403) {
        setScopeOff(true);
      }
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

  const grouped = groupByDay(visits);

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
        renderItem={({ item: day }) => (
          <View style={{ marginBottom: spacing.lg }}>
            <Text style={styles.dayHeader}>{day.label}</Text>
            {day.visits.map((v, idx) => (
              <View key={v.id} style={styles.visitRow}>
                <View style={styles.axis}>
                  <View style={[styles.node, idx === 0 && styles.nodeActive]} />
                  {idx < day.visits.length - 1 && <View style={styles.line} />}
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
                  {v.formatted_address ? (
                    <Text style={styles.address} numberOfLines={1}>
                      {v.formatted_address}
                    </Text>
                  ) : null}
                  <View style={styles.metaRow}>
                    <Text style={styles.duration}>{formatDuration(v.started_at, v.ended_at)}</Text>
                    <Text style={styles.timeAgo}>{formatTimeRange(v.started_at, v.ended_at)}</Text>
                  </View>
                </TouchableOpacity>
              </View>
            ))}
          </View>
        )}
      />
    </SafeAreaView>
  );
}

function openInMaps(lat: number, lng: number) {
  Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${lat},${lng}`);
}

function groupByDay(visits: Visit[]): { day: string; label: string; visits: Visit[] }[] {
  const map = new Map<string, Visit[]>();
  visits.forEach((v) => {
    const d = new Date(v.started_at);
    const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(v);
  });
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const isSameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  return Array.from(map.entries()).map(([day, vs]) => {
    const dt = new Date(vs[0].started_at);
    let label = dt.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    if (isSameDay(dt, today)) label = 'Today';
    else if (isSameDay(dt, yesterday)) label = 'Yesterday';
    return { day, label, visits: vs };
  });
}

function formatDuration(start: string, end: string): string {
  const s = new Date(start).getTime();
  const e = new Date(end).getTime();
  const mins = Math.max(0, Math.round((e - s) / 60000));
  if (mins < 1) return 'Briefly';
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function formatTimeRange(start: string, end: string): string {
  const s = new Date(start);
  const e = new Date(end);
  const fmt = (d: Date) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${fmt(s)} – ${fmt(e)}`;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: { paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  title: { ...typography.h1, color: colors.textPrimary },
  avatarRow: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: 12 },
  avatarTile: {
    alignItems: 'center',
    gap: 6,
    padding: 4,
    borderRadius: radius.md,
  },
  avatarTileActive: { backgroundColor: colors.bgTertiary },
  avatarLabel: { ...typography.caption, color: colors.textPrimary, maxWidth: 70 },
  dayHeader: {
    ...typography.overline,
    color: colors.textSecondary,
    marginBottom: spacing.md,
  },
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
  address: { ...typography.body, color: colors.textSecondary, marginBottom: 6 },
  metaRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  duration: { ...typography.caption, color: colors.textPrimary, fontWeight: '700' },
  timeAgo: { ...typography.caption, color: colors.textTertiary },
  empty: { alignItems: 'center', paddingVertical: spacing.xxl, gap: spacing.sm },
  emptyTitle: { ...typography.h2, color: colors.textPrimary, marginTop: spacing.md },
  emptyBody: { ...typography.body, color: colors.textSecondary, textAlign: 'center', paddingHorizontal: spacing.lg },
});
