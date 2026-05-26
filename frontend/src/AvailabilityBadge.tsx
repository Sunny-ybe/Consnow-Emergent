import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import type { Availability } from './activityService';
import { activityLabel, availabilityLabel } from './activityService';
import { colors, radius } from './theme';

type Props = {
  availability?: Availability | null;
  activity?: string | null;
  size?: 'sm' | 'md';
  showActivity?: boolean;
  testID?: string;
};

const PALETTE: Record<Availability, { bg: string; fg: string; dot: string }> = {
  available: { bg: '#ECFFF1', fg: '#1F7A3E', dot: colors.success },
  maybe: { bg: '#FFF6E5', fg: '#8A5A00', dot: colors.warning },
  busy: { bg: colors.dangerMuted, fg: '#B0271E', dot: colors.danger },
};

export const AvailabilityBadge: React.FC<Props> = ({
  availability,
  activity,
  size = 'sm',
  showActivity,
  testID,
}) => {
  if (!availability) return null;
  const c = PALETTE[availability];
  const dotSize = size === 'sm' ? 6 : 8;
  const padV = size === 'sm' ? 3 : 5;
  const padH = size === 'sm' ? 8 : 10;
  const fontSize = size === 'sm' ? 11 : 13;

  const text = showActivity && activity
    ? `${availabilityLabel(availability)} · ${activityLabel(activity as any) || '—'}`
    : availabilityLabel(availability);

  return (
    <View
      testID={testID}
      style={[
        styles.badge,
        { backgroundColor: c.bg, paddingVertical: padV, paddingHorizontal: padH },
      ]}
    >
      <View
        style={[styles.dot, { width: dotSize, height: dotSize, borderRadius: dotSize / 2, backgroundColor: c.dot }]}
      />
      <Text style={[styles.text, { color: c.fg, fontSize }]}>{text}</Text>
    </View>
  );
};

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: radius.pill,
    alignSelf: 'flex-start',
  },
  dot: {},
  text: { fontWeight: '700', letterSpacing: 0.2 },
});
