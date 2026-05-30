import React, { useRef, useState } from 'react';
import { View, Text, StyleSheet, PanResponder, LayoutChangeEvent } from 'react-native';
import * as Haptics from 'expo-haptics';
import { colors, radius, typography } from './theme';

type Props = {
  min: number;
  max: number;
  step?: number;
  lo: number;
  hi: number;
  onChange: (lo: number, hi: number) => void;
  ticks?: number[];
  formatTick?: (v: number) => string;
  formatValue?: (v: number) => string;
  testID?: string;
};

export const RangeSlider: React.FC<Props> = ({
  min,
  max,
  step = 1,
  lo,
  hi,
  onChange,
  ticks,
  formatTick,
  formatValue,
  testID,
}) => {
  const [trackWidth, setTrackWidth] = useState(0);
  const lastLoRef = useRef(lo);
  const lastHiRef = useRef(hi);

  const range = max - min;
  const pxPerUnit = trackWidth > 0 ? trackWidth / range : 0;

  const xToValue = (x: number) => {
    if (pxPerUnit === 0) return min;
    const raw = min + x / pxPerUnit;
    const snapped = Math.round(raw / step) * step;
    return Math.max(min, Math.min(max, snapped));
  };

  const loToX = (v: number) => (v - min) * pxPerUnit;

  const handleLoMove = (x: number) => {
    const v = Math.min(xToValue(x), hi - step);
    if (v !== lastLoRef.current) {
      Haptics.selectionAsync().catch(() => {});
      lastLoRef.current = v;
      onChange(v, hi);
    }
  };
  const handleHiMove = (x: number) => {
    const v = Math.max(xToValue(x), lo + step);
    if (v !== lastHiRef.current) {
      Haptics.selectionAsync().catch(() => {});
      lastHiRef.current = v;
      onChange(lo, v);
    }
  };

  const loPan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => handleLoMove(e.nativeEvent.locationX),
      onPanResponderMove: (_e, g) => handleLoMove(loToX(lastLoRef.current) + g.dx),
    }),
  ).current;

  const hiPan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => handleHiMove(e.nativeEvent.locationX + loToX(hi)),
      onPanResponderMove: (_e, g) => handleHiMove(loToX(lastHiRef.current) + g.dx),
    }),
  ).current;

  const onLayout = (e: LayoutChangeEvent) => setTrackWidth(e.nativeEvent.layout.width);

  const thumbSize = 26;
  const loLeft = loToX(lo) - thumbSize / 2;
  const hiLeft = loToX(hi) - thumbSize / 2;
  const fillLeft = loToX(lo);
  const fillWidth = loToX(hi) - loToX(lo);

  return (
    <View testID={testID} style={styles.wrap}>
      <Text style={styles.valueText}>
        {(formatValue || ((v) => String(v)))(lo)}
        {'  →  '}
        {(formatValue || ((v) => String(v)))(hi)}
      </Text>
      <View style={styles.trackContainer} onLayout={onLayout}>
        <View style={styles.track} />
        <View style={[styles.fill, { left: fillLeft, width: fillWidth }]} />
        <View
          {...loPan.panHandlers}
          style={[
            styles.thumb,
            { left: loLeft, width: thumbSize, height: thumbSize, borderRadius: thumbSize / 2 },
          ]}
        />
        <View
          {...hiPan.panHandlers}
          style={[
            styles.thumb,
            { left: hiLeft, width: thumbSize, height: thumbSize, borderRadius: thumbSize / 2 },
          ]}
        />
      </View>
      {ticks ? (
        <View style={styles.ticksRow}>
          {ticks.map((t) => {
            const left = loToX(t);
            return (
              <Text
                key={t}
                style={[
                  styles.tickLabel,
                  { left: left - 14, color: t >= lo && t <= hi ? colors.brand : colors.textSecondary },
                ]}
              >
                {formatTick ? formatTick(t) : String(t)}
              </Text>
            );
          })}
        </View>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: { width: '100%' },
  valueText: {
    ...typography.bodyLarge,
    color: colors.textPrimary,
    fontWeight: '700',
    marginBottom: 8,
  },
  trackContainer: {
    height: 44,
    justifyContent: 'center',
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
  thumb: {
    backgroundColor: colors.bgSecondary,
    borderWidth: 2,
    borderColor: colors.brand,
    position: 'absolute',
    top: 9,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.18,
    shadowRadius: 4,
    elevation: 4,
  },
  ticksRow: {
    height: 18,
    marginTop: 2,
    position: 'relative',
  },
  tickLabel: {
    position: 'absolute',
    width: 28,
    textAlign: 'center',
    ...typography.caption,
    fontSize: 10,
    fontWeight: '700',
  },
});
