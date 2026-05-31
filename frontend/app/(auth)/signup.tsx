import { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Alert,
} from 'react-native';
import { Link, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '@/src/auth';
import { colors, spacing, radius, typography, shadow } from '@/src/theme';

export default function SignupScreen() {
  const router = useRouter();
  const { signup } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);

  const onSubmit = async () => {
    if (!email || !password || !displayName || !username) {
      Alert.alert('Missing fields', 'Please fill in all fields');
      return;
    }
    if (password.length < 6) {
      Alert.alert('Weak password', 'Password must be at least 6 characters');
      return;
    }
    setBusy(true);
    try {
      await signup({
        email: email.trim(),
        password,
        display_name: displayName.trim(),
        username: username.trim().toLowerCase(),
      });
      router.replace('/(tabs)');
    } catch (e: any) {
      const detail = e?.response?.data?.detail;
      const status = e?.response?.status;
      let title = 'Sign up failed';
      let body = detail || e.message || 'Please try again.';

      if (detail) {
        // Show the real reason as the title for clarity
        title = detail;
        body = 'Please adjust and try again.';
      } else if (!e?.response) {
        // No response = real network problem
        title = 'Network error';
        body = 'Could not reach the server. Check your connection and try again.';
      } else if (status) {
        title = `Sign up failed (${status})`;
      }

      Alert.alert(title, body);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Text style={styles.brand}>CONSNOW</Text>
          <Text style={styles.title} testID="signup-title">Create your account</Text>
          <Text style={styles.subtitle}>Private by design. Share only what you choose, with whom you choose.</Text>

          <View style={styles.form}>
            <Text style={styles.label}>Display name</Text>
            <TextInput
              testID="signup-name-input"
              style={styles.input}
              placeholder="Your name"
              placeholderTextColor={colors.textTertiary}
              value={displayName}
              onChangeText={setDisplayName}
            />
            <Text style={styles.label}>Username</Text>
            <TextInput
              testID="signup-username-input"
              style={styles.input}
              placeholder="username (letters, numbers, _)"
              placeholderTextColor={colors.textTertiary}
              autoCapitalize="none"
              value={username}
              onChangeText={setUsername}
            />
            <Text style={styles.label}>Email</Text>
            <TextInput
              testID="signup-email-input"
              style={styles.input}
              placeholder="you@example.com"
              placeholderTextColor={colors.textTertiary}
              autoCapitalize="none"
              keyboardType="email-address"
              autoComplete="email"
              value={email}
              onChangeText={setEmail}
            />
            <Text style={styles.label}>Password</Text>
            <TextInput
              testID="signup-password-input"
              style={styles.input}
              placeholder="At least 6 characters"
              placeholderTextColor={colors.textTertiary}
              secureTextEntry
              value={password}
              onChangeText={setPassword}
            />

            <TouchableOpacity
              testID="signup-submit-button"
              style={[styles.primaryBtn, busy && { opacity: 0.6 }]}
              disabled={busy}
              onPress={onSubmit}
              activeOpacity={0.85}
            >
              <Text style={styles.primaryBtnText}>{busy ? 'Creating…' : 'Create account'}</Text>
            </TouchableOpacity>

            <View style={styles.linkRow}>
              <Text style={styles.linkMuted}>Already have an account? </Text>
              <Link href="/(auth)/login" testID="goto-login-link">
                <Text style={styles.linkAccent}>Sign in</Text>
              </Link>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  scroll: { paddingHorizontal: spacing.lg, paddingTop: spacing.xl, paddingBottom: spacing.xxl },
  brand: { ...typography.overline, color: colors.textSecondary, marginBottom: spacing.lg },
  title: { ...typography.h1, color: colors.textPrimary, marginBottom: spacing.sm },
  subtitle: { ...typography.bodyLarge, color: colors.textSecondary, marginBottom: spacing.xl },
  form: { gap: spacing.sm },
  label: { ...typography.caption, color: colors.textSecondary, marginTop: spacing.sm, marginBottom: 4 },
  input: {
    backgroundColor: colors.bgSecondary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 14,
    fontSize: 16,
    color: colors.textPrimary,
  },
  primaryBtn: {
    backgroundColor: colors.brand,
    height: 56,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.lg,
    ...shadow.card,
  },
  primaryBtnText: { color: colors.textInverse, fontSize: 17, fontWeight: '600' },
  linkRow: { flexDirection: 'row', justifyContent: 'center', marginTop: spacing.lg },
  linkMuted: { color: colors.textSecondary, fontSize: 15 },
  linkAccent: { color: colors.accent, fontSize: 15, fontWeight: '600' },
});
