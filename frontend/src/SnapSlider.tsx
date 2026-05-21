import React, { useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  PanResponder,
  LayoutChangeEvent,
  TouchableWithoutFeedback,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { colors, radius, typography } from './theme';

type Props = {
  steps: string[];        // e.g. ['10m', '1h', '6h', '12h', '24h', 'off']
  labels?: string[];      // optional pretty labels for display under track
  value: string;
  onChange: (next: string) => void;
  testID?: string;
};

export const SnapSlider: React.FC<Props> = ({ steps, labels, value, onChange, testID }) => {
  const [trackWidth, setTrackWidth] = useState(0);
  const lastIdxRef = useRef(steps.indexOf(value));
  const currentIdx = Math.max(0, steps.indexOf(value));
  const stepCount = steps.length - 1;
  const stepW = trackWidth > 0 ? trackWidth / stepCount : 0;

  const computeIdx = (x: number): number => {
    if (stepW === 0) return 0;
    const clamped = Math.max(0, Math.min(trackWidth, x));
    return Math.round(clamped / stepW);
  };

  const handleSelect = (idx: number) => {
    if (idx !== lastIdxRef.current) {
      Haptics.selectionAsync().catch(() => {});
      lastIdxRef.current = idx;
      onChange(steps[idx]);
    }
  };

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => {
        const x = e.nativeEvent.locationX;
        handleSelect(computeIdx(x));
      },
      onPanResponderMove: (e) => {
        const x = e.nativeEvent.locationX;
        handleSelect(computeIdx(x));
      },
    }),
  ).current;

  const onLayout = (e: LayoutChangeEvent) => setTrackWidth(e.nativeEvent.layout.width);

  // Thumb pixel offset
  const thumbSize = 28;
  const thumbLeft = stepW > 0 ? currentIdx * stepW - thumbSize / 2 : -thumbSize / 2;
  const fillWidth = stepW > 0 ? currentIdx * stepW : 0;

  return (
    <View testID={testID} style={styles.wrap}>
      <View style={styles.trackContainer} onLayout={onLayout} {...panResponder.panHandlers}>
        {/* Track */}
        <View style={styles.track} />
        {/* Fill */}
        <View style={[styles.fill, { width: fillWidth }]} />
        {/* Tick marks */}
        {steps.map((_, i) => (
          <View
            key={i}
            style={[
              styles.tick,
              { left: i * stepW - 3 },
              i <= currentIdx && styles.tickActive,
            ]}
          />
        ))}
        {/* Thumb */}
        <View
          style={[
            styles.thumb,
            { left: thumbLeft, width: thumbSize, height: thumbSize, borderRadius: thumbSize / 2 },
          ]}
          pointerEvents="none"
        />
      </View>
      {/* Labels */}
      <View style={styles.labelsRow}>
        {steps.map((s, i) => {
          const isActive = i === currentIdx;
          return (
            <TouchableWithoutFeedback
              key={s}
              onPress={() => handleSelect(i)}
              testID={`snap-${s}`}
            >
              <View style={styles.labelWrap}>
                <Text style={[styles.label, isActive && styles.labelActive]}>
                  {labels ? labels[i] : s}
                </Text>
              </View>
            </TouchableWithoutFeedback>
          );
        })}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: { width: '100%' },
  trackContainer: {
    height: 44,
    justifyContent: 'center',
    paddingHorizontal: 0,
  },
  track: {
    height: 8,
    backgroundColor: colors.border,
    borderRadius: radius.pill,
    width: '100%',
    position: 'absolute',
  },
  fill: {
    height: 8,
    backgroundColor: colors.brand,
    borderRadius: radius.pill,
    position: 'absolute',
  },
  tick: {
    position: 'absolute',
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.textTertiary,
    top: 19,
  },
  tickActive: { backgroundColor: colors.textInverse },
  thumb: {
    backgroundColor: colors.bgSecondary,
    borderWidth: 2,
    borderColor: colors.brand,
    position: 'absolute',
    top: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
    elevation: 4,
  },
  labelsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 6,
    marginHorizontal: -8,
  },
  labelWrap: {
    paddingHorizontal: 4,
    paddingVertical: 4,
    minWidth: 36,
    alignItems: 'center',
  },
  label: { ...typography.caption, color: colors.textSecondary, fontWeight: '600' },
  labelActive: { color: colors.brand, fontWeight: '800' },
});
