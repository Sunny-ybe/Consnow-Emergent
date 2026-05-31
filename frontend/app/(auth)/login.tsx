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
  Image,
} from 'react-native';
import { Link, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '@/src/auth';
import { colors, spacing, radius, typography, shadow } from '@/src/theme';

export default function LoginScreen() {
  const router = useRouter();
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const onSubmit = async () => {
    if (!email || !password) {
      Alert.alert('Missing fields', 'Please enter email and password');
      return;
    }
    setBusy(true);
    try {
      await login(email.trim(), password);
      router.replace('/(tabs)');
    } catch (e: any) {
      const detail = e?.response?.data?.detail;
      const status = e?.response?.status;
      let title = 'Login failed';
      let body = detail || e.message || 'Please try again.';

      if (detail) {
        title = detail;
        body = 'Please check and try again.';
      } else if (!e?.response) {
        title = 'Network error';
        body = 'Could not reach the server. Check your connection and try again.';
      } else if (status) {
        title = `Login failed (${status})`;
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
          <Image
            source={{ uri: 'https://static.prod-images.emergentagent.com/jobs/fa21f578-eb5f-45e2-a851-23cf05e86db1/images/84f5eec326deff4fe8f8027794f79a6a95e92ef341cfe83b76dfce4374695dfb.png' }}
            style={styles.hero}
            resizeMode="contain"
          />
          <Text style={styles.title} testID="login-title">Welcome back</Text>
          <Text style={styles.subtitle}>Sign in to share what matters with people who matter.</Text>

          <View style={styles.form}>
            <Text style={styles.label}>Email</Text>
            <TextInput
              testID="login-email-input"
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
              testID="login-password-input"
              style={styles.input}
              placeholder="••••••••"
              placeholderTextColor={colors.textTertiary}
              secureTextEntry
              value={password}
              onChangeText={setPassword}
            />

            <TouchableOpacity
              testID="login-submit-button"
              style={[styles.primaryBtn, busy && { opacity: 0.6 }]}
              disabled={busy}
              onPress={onSubmit}
              activeOpacity={0.85}
            >
              <Text style={styles.primaryBtnText}>{busy ? 'Signing in…' : 'Sign in'}</Text>
            </TouchableOpacity>

            <View style={styles.linkRow}>
              <Text style={styles.linkMuted}>New to Consnow? </Text>
              <Link href="/(auth)/signup" testID="goto-signup-link">
                <Text style={styles.linkAccent}>Create account</Text>
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
  scroll: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg, paddingBottom: spacing.xxl },
  hero: { width: '100%', height: 180, marginBottom: spacing.lg },
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
