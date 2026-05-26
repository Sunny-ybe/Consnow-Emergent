import { useCallback, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Search, Check, X, ChevronRight, UserPlus } from 'lucide-react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { colors, spacing, radius, typography, shadow } from '@/src/theme';
import { Avatar } from '@/src/Avatar';
import { AvailabilityBadge } from '@/src/AvailabilityBadge';
import { listFriends, respondToRequest } from '@/src/api';
import { formatTimeAgo } from './index';

export default function FriendsScreen() {
  const router = useRouter();
  const [data, setData] = useState<{ friends: any[]; pending_incoming: any[]; pending_outgoing: any[] }>({
    friends: [],
    pending_incoming: [],
    pending_outgoing: [],
  });
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await listFriends();
      setData(d);
    } catch (e: any) {
      console.warn(e?.message);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const respond = async (friendship_id: string, accept: boolean) => {
    try {
      await respondToRequest(friendship_id, accept);
      await load();
    } catch (e: any) {
      Alert.alert('Error', e?.response?.data?.detail || 'Try again');
    }
  };

  const sections: any[] = [];
  if (data.pending_incoming.length > 0) {
    sections.push({ type: 'header', label: 'Requests', key: 'h-in' });
    data.pending_incoming.forEach((p) => sections.push({ type: 'incoming', data: p, key: `in-${p.friendship_id}` }));
  }
  if (data.friends.length > 0) {
    sections.push({ type: 'header', label: 'Friends', key: 'h-fr' });
    data.friends.forEach((p) => sections.push({ type: 'friend', data: p, key: `fr-${p.friendship_id}` }));
  }
  if (data.pending_outgoing.length > 0) {
    sections.push({ type: 'header', label: 'Sent', key: 'h-out' });
    data.pending_outgoing.forEach((p) =>
      sections.push({ type: 'outgoing', data: p, key: `out-${p.friendship_id}` }),
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>Friends</Text>
        <TouchableOpacity
          testID="open-search-button"
          style={styles.iconBtn}
          onPress={() => router.push('/search')}
          activeOpacity={0.7}
        >
          <Search size={20} color={colors.textPrimary} strokeWidth={2.2} />
        </TouchableOpacity>
      </View>

      <FlatList
        data={sections}
        keyExtractor={(item) => item.key}
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xxl }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        ListEmptyComponent={
          <View style={styles.empty}>
            <UserPlus size={48} color={colors.textTertiary} strokeWidth={1.5} />
            <Text style={styles.emptyTitle}>No friends yet</Text>
            <Text style={styles.emptyBody}>Search for people you trust and send them a request.</Text>
            <TouchableOpacity
              testID="empty-search-button"
              style={styles.primaryBtn}
              onPress={() => router.push('/search')}
            >
              <Text style={styles.primaryBtnText}>Find friends</Text>
            </TouchableOpacity>
          </View>
        }
        renderItem={({ item }) => {
          if (item.type === 'header') {
            return <Text style={styles.sectionHeader}>{item.label}</Text>;
          }
          if (item.type === 'incoming') {
            const p = item.data;
            return (
              <View style={styles.row}>
                <Avatar name={p.user.display_name} size={48} />
                <View style={{ flex: 1, marginLeft: spacing.md }}>
                  <Text style={styles.rowName}>{p.user.display_name}</Text>
                  <Text style={styles.rowSub}>@{p.user.username}</Text>
                </View>
                <TouchableOpacity
                  testID={`accept-${p.friendship_id}`}
                  style={styles.acceptBtn}
                  onPress={() => respond(p.friendship_id, true)}
                >
                  <Check size={18} color="#fff" strokeWidth={2.5} />
                </TouchableOpacity>
                <TouchableOpacity
                  testID={`reject-${p.friendship_id}`}
                  style={styles.rejectBtn}
                  onPress={() => respond(p.friendship_id, false)}
                >
                  <X size={18} color={colors.danger} strokeWidth={2.5} />
                </TouchableOpacity>
              </View>
            );
          }
          if (item.type === 'outgoing') {
            const p = item.data;
            return (
              <View style={styles.row}>
                <Avatar name={p.user.display_name} size={48} />
                <View style={{ flex: 1, marginLeft: spacing.md }}>
                  <Text style={styles.rowName}>{p.user.display_name}</Text>
                  <Text style={styles.rowSub}>@{p.user.username} · request sent</Text>
                </View>
              </View>
            );
          }
          // friend
          const p = item.data;
          return (
            <TouchableOpacity
              testID={`friend-row-${p.user.id}`}
              style={styles.row}
              onPress={() => router.push(`/friend/${p.user.id}`)}
              activeOpacity={0.7}
            >
              <Avatar name={p.user.display_name} size={48} />
              <View style={{ flex: 1, marginLeft: spacing.md }}>
                <Text style={styles.rowName}>{p.user.display_name}</Text>
                <Text style={styles.rowSub} numberOfLines={1}>
                  {p.last_seen
                    ? `${p.last_seen.place_name} · ${formatTimeAgo(p.last_seen.timestamp)}`
                    : `@${p.user.username}`}
                </Text>
                {p.last_seen?.availability ? (
                  <View style={{ marginTop: 6 }}>
                    <AvailabilityBadge
                      testID={`friend-avail-${p.user.id}`}
                      availability={p.last_seen.availability}
                      activity={p.last_seen.activity}
                      showActivity
                      size="sm"
                    />
                  </View>
                ) : null}
              </View>
              <View style={styles.scopePill}>
                <Text style={styles.scopePillText}>{p.scope_i_grant}</Text>
              </View>
              <ChevronRight size={18} color={colors.textTertiary} />
            </TouchableOpacity>
          );
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  title: { ...typography.h1, color: colors.textPrimary },
  iconBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgSecondary,
    borderWidth: 1,
    borderColor: colors.border,
  },
  sectionHeader: { ...typography.overline, color: colors.textSecondary, marginTop: spacing.md, marginBottom: spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgSecondary,
    padding: spacing.md,
    borderRadius: radius.md,
    marginBottom: spacing.sm,
    gap: 4,
  },
  rowName: { ...typography.h3, color: colors.textPrimary },
  rowSub: { ...typography.caption, color: colors.textSecondary, marginTop: 2 },
  acceptBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.success,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: spacing.sm,
  },
  rejectBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.dangerMuted,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 4,
  },
  scopePill: {
    backgroundColor: colors.bgTertiary,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radius.pill,
    marginRight: 6,
  },
  scopePillText: { ...typography.caption, color: colors.textPrimary, fontWeight: '700' },
  empty: { alignItems: 'center', paddingVertical: spacing.xxl, gap: spacing.sm },
  emptyTitle: { ...typography.h2, color: colors.textPrimary, marginTop: spacing.md },
  emptyBody: { ...typography.body, color: colors.textSecondary, textAlign: 'center', paddingHorizontal: spacing.lg },
  primaryBtn: {
    backgroundColor: colors.brand,
    paddingVertical: 14,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.lg,
    marginTop: spacing.md,
    ...shadow.card,
  },
  primaryBtnText: { color: colors.textInverse, fontSize: 15, fontWeight: '600' },
});
