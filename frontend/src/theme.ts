// Consnow design tokens
export const colors = {
  bg: '#F9F9FB',
  bgSecondary: '#FFFFFF',
  bgTertiary: '#F2F2F7',
  textPrimary: '#1C1C1E',
  textSecondary: '#8E8E93',
  textTertiary: '#C7C7CC',
  textInverse: '#FFFFFF',
  brand: '#0A0A0A',
  accent: '#007AFF',
  accentMuted: '#E5F1FF',
  success: '#34C759',
  warning: '#FF9500',
  danger: '#FF3B30',
  dangerMuted: '#FFEBEB',
  transit: '#5AC8FA',
  border: '#E5E5EA',
  borderFocus: '#007AFF',
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
};

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  pill: 9999,
};

export const typography = {
  h1: { fontSize: 34, fontWeight: '800' as const, letterSpacing: -1, lineHeight: 41 },
  h2: { fontSize: 24, fontWeight: '700' as const, letterSpacing: -0.5, lineHeight: 28 },
  h3: { fontSize: 17, fontWeight: '600' as const, letterSpacing: -0.2, lineHeight: 22 },
  bodyLarge: { fontSize: 17, fontWeight: '400' as const, lineHeight: 24 },
  body: { fontSize: 15, fontWeight: '400' as const, lineHeight: 20 },
  caption: { fontSize: 13, fontWeight: '500' as const, letterSpacing: 0.2, lineHeight: 18 },
  overline: { fontSize: 11, fontWeight: '700' as const, letterSpacing: 1, lineHeight: 13 },
};

export const shadow = {
  subtle: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.04,
    shadowRadius: 8,
    elevation: 2,
  },
  card: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 16,
    elevation: 4,
  },
};
