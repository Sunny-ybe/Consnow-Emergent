import React from 'react';
import { View, Text, StyleSheet, Image } from 'react-native';
import { colors, radius, typography } from './theme';

const AVATAR_BG = 'https://static.prod-images.emergentagent.com/jobs/fa21f578-eb5f-45e2-a851-23cf05e86db1/images/c38be4299c1dece03f1fea67c6b524e36d82c27fd9dac0bed89b8894bb9a8656.png';

function initialsOf(name?: string): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0][0]?.toUpperCase() || '?';
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export const Avatar: React.FC<{ name?: string; size?: number; testID?: string }> = ({
  name,
  size = 44,
  testID,
}) => {
  return (
    <View
      testID={testID}
      style={[styles.wrap, { width: size, height: size, borderRadius: size / 2 }]}
    >
      <Image
        source={{ uri: AVATAR_BG }}
        style={{ width: size, height: size, borderRadius: size / 2, position: 'absolute' }}
      />
      <Text style={[styles.initials, { fontSize: size * 0.4 }]}>{initialsOf(name)}</Text>
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: colors.bgTertiary,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  initials: { color: colors.textInverse, fontWeight: '700', letterSpacing: 0.5 },
});
