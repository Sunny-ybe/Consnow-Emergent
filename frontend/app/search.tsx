import { useEffect, useState, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Search as SearchIcon, X, UserPlus, Check, Clock } from 'lucide-react-native';
import { colors, spacing, radius, typography, shadow } from '@/src/theme';
import { Avatar } from '@/src/Avatar';
import { searchUsers, sendFriendRequest } from '@/src/api';

export default function SearchModal() {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const debounceRef = useRef<any>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!q || q.length < 2) {
      setResults([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await searchUsers(q);
        setResults(r);
      } catch {
        // ignore
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(debounceRef.current);
  }, [q]);

  const send = async (user_id: string) => {
    try {
      await sendFriendRequest(user_id);
      setResults((prev) =>
        prev.map((u) => (u.id === user_id ? { ...u, friendship_status: 'pending' } : u)),
      );
    } catch (e: any) {
      Alert.alert('Could not send', e?.response?.data?.detail || 'Try again');
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.headerRow}>
        <View style={styles.searchBox}>
          <SearchIcon size={18} color={colors.textSecondary} strokeWidth={2.2} />
          <TextInput
            testID="search-input"
            style={styles.input}
            placeholder="Search by name or username"
            placeholderTextColor={colors.textTertiary}
            value={q}
            onChangeText={setQ}
            autoFocus
            autoCapitalize="none"
            returnKeyType="search"
          />
          {q.length > 0 && (
            <TouchableOpacity onPress={() => setQ('')}>
              <X size={18} color={colors.textSecondary} />
            </TouchableOpacity>
          )}
        </View>
        <TouchableOpacity testID="close-search" onPress={() => router.back()} style={{ marginLeft: 8 }}>
          <Text style={styles.cancel}>Cancel</Text>
        </TouchableOpacity>
      </View>

      {searching && (
        <ActivityIndicator color={colors.textSecondary} style={{ marginTop: spacing.md }} />
      )}

      <FlatList
        data={results}
        keyExtractor={(u) => u.id}
        contentContainerStyle={{ padding: spacing.lg }}
        ListEmptyComponent={
          !searching && q.length >= 2 ? (
            <Text style={styles.emptyText}>No users found</Text>
          ) : !searching && q.length === 0 ? (
            <Text style={styles.emptyText}>Type a name, username, or email to find friends.</Text>
          ) : null
        }
        renderItem={({ item }) => (
          <View style={styles.row}>
            <Avatar name={item.display_name} size={48} />
            <View style={{ flex: 1, marginLeft: spacing.md }}>
              <Text style={styles.name}>{item.display_name}</Text>
              <Text style={styles.username}>@{item.username}</Text>
            </View>
            {item.friendship_status === 'accepted' ? (
              <View style={[styles.actionBtn, styles.acceptedBtn]}>
                <Check size={16} color={colors.success} strokeWidth={2.4} />
                <Text style={[styles.actionText, { color: colors.success }]}>Friend</Text>
              </View>
            ) : item.friendship_status === 'pending' ? (
              <View style={[styles.actionBtn, styles.pendingBtn]}>
                <Clock size={16} color={colors.textSecondary} strokeWidth={2.4} />
                <Text style={[styles.actionText, { color: colors.textSecondary }]}>Pending</Text>
              </View>
            ) : (
              <TouchableOpacity
                testID={`add-friend-${item.id}`}
                style={[styles.actionBtn, styles.addBtn]}
                onPress={() => send(item.id)}
                activeOpacity={0.7}
              >
                <UserPlus size={16} color={colors.textInverse} strokeWidth={2.4} />
                <Text style={[styles.actionText, { color: colors.textInverse }]}>Add</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
  searchBox: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.bgTertiary,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    height: 44,
  },
  input: { flex: 1, fontSize: 16, color: colors.textPrimary },
  cancel: { ...typography.body, color: colors.accent, fontWeight: '600' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgSecondary,
    padding: spacing.md,
    borderRadius: radius.md,
    marginBottom: spacing.sm,
    ...shadow.subtle,
  },
  name: { ...typography.h3, color: colors.textPrimary },
  username: { ...typography.caption, color: colors.textSecondary, marginTop: 2 },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
  },
  addBtn: { backgroundColor: colors.brand },
  acceptedBtn: { backgroundColor: '#ECFFF1' },
  pendingBtn: { backgroundColor: colors.bgTertiary },
  actionText: { fontSize: 14, fontWeight: '700' },
  emptyText: { ...typography.body, color: colors.textSecondary, textAlign: 'center', marginTop: spacing.lg },
});
