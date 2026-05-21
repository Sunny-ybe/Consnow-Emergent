import { useCallback, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Alert, Switch, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useRouter } from 'expo-router';
import { LogOut, Shield, Power, ChevronRight, AtSign } from 'lucide-react-native';
import { useAuth } from '@/src/auth';
import { colors, spacing, radius, typography, shadow } from '@/src/theme';
import { Avatar } from '@/src/Avatar';
import {
  isBackgroundTrackingActive,
  startBackgroundTracking,
  stopBackgroundTracking,
  requestForegroundPermission,
  requestBackgroundPermission,
  backgroundTrackingUnsupported,
  backgroundUnsupportedReason,
} from '@/src/locationService';

export default function ProfileScreen() {
  const { user, logout } = useAuth();
  const router = useRouter();
  const [tracking, setTracking] = useState(false);

  const refreshTracking = useCallback(async () => {
    setTracking(await isBackgroundTrackingActive());
  }, []);

  useFocusEffect(
    useCallback(() => {
      refreshTracking();
    }, [refreshTracking]),
  );

  const toggleTracking = async (next: boolean) => {
    if (backgroundTrackingUnsupported) {
      Alert.alert('Not available here', backgroundUnsupportedReason());
      setTracking(false);
      return;
    }
    if (next) {
      const fg = await requestForegroundPermission();
      if (!fg) {
        Alert.alert('Permission needed', 'Allow "While Using" location first.');
        return;
      }
      if (Platform.OS !== 'web') {
        const bg = await requestBackgroundPermission();
        if (!bg) {
          Alert.alert('Allow Always', 'Background tracking requires "Always Allow" location permission.');
          return;
        }
      }
      const ok = await startBackgroundTracking();
      setTracking(ok);
      if (!ok) {
        Alert.alert('Could not start', backgroundUnsupportedReason() || 'Please retry.');
      }
    } else {
      await stopBackgroundTracking();
      setTracking(false);
    }
  };

  const onLogout = async () => {
    Alert.alert('Sign out', 'Are you sure?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign out',
        style: 'destructive',
        onPress: async () => {
          await stopBackgroundTracking();
          await logout();
          router.replace('/(auth)/login');
        },
      },
    ]);
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.headerCard}>
          <Avatar name={user?.display_name} size={88} />
          <Text style={styles.name} testID="profile-display-name">{user?.display_name}</Text>
          <View style={styles.usernameRow}>
            <AtSign size={14} color={colors.textSecondary} strokeWidth={2.2} />
            <Text style={styles.username}>{user?.username}</Text>
          </View>
          <Text style={styles.email}>{user?.email}</Text>
        </View>

        <Text style={styles.sectionHeader}>Privacy & Sharing</Text>

        <View style={styles.settingRow}>
          <View style={styles.settingIcon}>
            <Power size={20} color={colors.textPrimary} strokeWidth={2.2} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.settingLabel}>Background sharing</Text>
            <Text style={styles.settingHint}>
              {backgroundTrackingUnsupported
                ? backgroundUnsupportedReason()
                : 'Updates friends every ~10 min as you move'}
            </Text>
          </View>
          <Switch
            testID="profile-tracking-switch"
            value={tracking}
            onValueChange={toggleTracking}
            disabled={backgroundTrackingUnsupported}
            trackColor={{ true: colors.brand, false: colors.border }}
            thumbColor={'#fff'}
          />
        </View>

        <View style={styles.settingRow}>
          <View style={styles.settingIcon}>
            <Shield size={20} color={colors.textPrimary} strokeWidth={2.2} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.settingLabel}>Your data is yours</Text>
            <Text style={styles.settingHint}>
              We never sell, no ads. Friends only see what you allow.
            </Text>
          </View>
        </View>

        <Text style={styles.sectionHeader}>Account</Text>

        <TouchableOpacity
          testID="logout-button"
          style={styles.dangerRow}
          onPress={onLogout}
          activeOpacity={0.7}
        >
          <LogOut size={20} color={colors.danger} strokeWidth={2.2} />
          <Text style={styles.dangerLabel}>Sign out</Text>
          <ChevronRight size={18} color={colors.textTertiary} />
        </TouchableOpacity>

        <Text style={styles.footer}>Consnow · v1.0</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: spacing.lg, paddingBottom: spacing.xxl },
  headerCard: {
    alignItems: 'center',
    paddingVertical: spacing.lg,
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.lg,
    marginBottom: spacing.lg,
    ...shadow.card,
  },
  name: { ...typography.h2, color: colors.textPrimary, marginTop: spacing.md },
  usernameRow: { flexDirection: 'row', alignItems: 'center', gap: 2, marginTop: 4 },
  username: { ...typography.body, color: colors.textSecondary },
  email: { ...typography.caption, color: colors.textTertiary, marginTop: 6 },
  sectionHeader: { ...typography.overline, color: colors.textSecondary, marginTop: spacing.lg, marginBottom: spacing.sm },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgSecondary,
    padding: spacing.md,
    borderRadius: radius.md,
    marginBottom: spacing.sm,
    gap: spacing.md,
  },
  settingIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.bgTertiary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  settingLabel: { ...typography.h3, color: colors.textPrimary },
  settingHint: { ...typography.caption, color: colors.textSecondary, marginTop: 2 },
  dangerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgSecondary,
    padding: spacing.md,
    borderRadius: radius.md,
    gap: spacing.md,
  },
  dangerLabel: { ...typography.h3, color: colors.danger, flex: 1 },
  footer: { ...typography.caption, color: colors.textTertiary, textAlign: 'center', marginTop: spacing.xl },
});
