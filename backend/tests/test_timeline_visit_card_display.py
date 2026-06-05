import json
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
TIMELINE_PATH = ROOT / "frontend/app/(tabs)/timeline.tsx"
TYPESCRIPT = ROOT / "frontend/node_modules/typescript"

RENDER_VISIT_CARD_SCRIPT = r"""
const fs = require('fs');
const vm = require('vm');
const ts = require(process.argv[2]);

let source = fs.readFileSync(process.argv[1], 'utf8');
source = source.replace(
  'const FlatItemRow = memo(function FlatItemRow',
  'exports.FlatItemRow = memo(function FlatItemRow'
);

const output = ts.transpileModule(source, {
  compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
    esModuleInterop: true,
  },
}).outputText;

function createElement(type, props, key) {
  return { type, props: props || {}, key };
}

function flattenChildren(value) {
  if (value == null || value === false) return [];
  return Array.isArray(value) ? value.flatMap(flattenChildren) : [value];
}

function typeName(type) {
  if (typeof type === 'string') return type;
  return type?.displayName || type?.name || '';
}

function collectText(node) {
  if (node == null || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return flattenChildren(node.props?.children).map(collectText).join('');
}

function countType(node, name) {
  if (node == null || node === false) return 0;
  if (typeof node === 'string' || typeof node === 'number') return 0;
  const self = typeName(node.type) === name ? 1 : 0;
  return self + flattenChildren(node.props?.children).reduce((sum, child) => sum + countType(child, name), 0);
}

function AvailabilityBadge() {
  return createElement('AvailabilityBadge', {});
}
AvailabilityBadge.displayName = 'AvailabilityBadge';

const module = { exports: {} };
const context = {
  console,
  exports: module.exports,
  module,
  require(name) {
    if (name === 'react') {
      return {
        memo: (component) => component,
        useCallback: () => {},
        useEffect: () => {},
        useMemo: () => {},
        useRef: () => ({ current: null }),
        useState: () => [null, () => {}],
      };
    }
    if (name === 'react/jsx-runtime') {
      return { jsx: createElement, jsxs: createElement, Fragment: 'Fragment' };
    }
    if (name === 'react-native') {
      return {
        View: 'View',
        Text: 'Text',
        StyleSheet: { create: (styles) => styles, hairlineWidth: 1 },
        FlatList: 'FlatList',
        TouchableOpacity: 'TouchableOpacity',
        RefreshControl: 'RefreshControl',
        ScrollView: 'ScrollView',
        Linking: { openURL: () => {} },
        Animated: {
          Value: function Value() {},
          View: 'Animated.View',
          loop: () => ({ start: () => {} }),
          sequence: () => ({}),
          timing: () => ({}),
        },
      };
    }
    if (name === 'react-native-safe-area-context') return { SafeAreaView: 'SafeAreaView' };
    if (name === 'expo-router') return { useFocusEffect: () => {} };
    if (name === 'lucide-react-native') return { Clock: 'Clock' };
    if (name === '@/src/theme') {
      return {
        colors: {
          bg: '#fff',
          bgTertiary: '#eee',
          textPrimary: '#111',
          textSecondary: '#777',
          textTertiary: '#aaa',
          border: '#ddd',
          accent: '#007AFF',
          accentMuted: '#E5F0FF',
          brand: '#000',
        },
        spacing: { sm: 8, md: 12, lg: 16, xxl: 32 },
        radius: { lg: 16, pill: 999 },
        typography: { caption: {}, h3: {} },
        shadow: {},
      };
    }
    if (name === '@/src/Avatar') return { Avatar: 'Avatar' };
    if (name === '@/src/AvailabilityBadge') return { AvailabilityBadge };
    if (name === '@/src/api') return { getTimeline: () => {}, listFriends: () => {} };
    if (name === '@/src/auth') return { useAuth: () => ({ user: { display_name: 'Tester' } }) };
    throw new Error(`Unexpected require: ${name}`);
  },
};

vm.runInNewContext(output, context, { filename: 'timeline.js' });

const config = JSON.parse(process.argv[3]);
const rows = config.visits.map((visit, index) => module.exports.FlatItemRow({
  item: {
    type: 'visit',
    data: visit,
    showLineAbove: index > 0,
    showLineBelow: index < config.visits.length - 1,
    isFirstEver: index === 0,
  },
  minuteTick: config.minuteTick,
  timezone: 'UTC',
}));

process.stdout.write(JSON.stringify({
  badgeCounts: rows.map((row) => countType(row, 'AvailabilityBadge')),
  text: rows.map(collectText),
}));
"""


def render_visit_cards(visits, minute_tick):
    result = subprocess.run(
        [
            "node",
            "-e",
            RENDER_VISIT_CARD_SCRIPT,
            str(TIMELINE_PATH),
            str(TYPESCRIPT),
            json.dumps({"visits": visits, "minuteTick": minute_tick}),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout)


def visit(started_at, ended_at, visit_count=1):
    return {
        "type": "visit",
        "id": f"visit-{started_at}",
        "place_name": "Coffee Shop",
        "started_at": started_at,
        "ended_at": ended_at,
        "activity": "stationary",
        "availability": "available",
        "visit_count": visit_count,
        "center_lat": 1,
        "center_lng": 1,
    }


def test_availability_badge_only_appears_on_live_visit_card():
    minute_tick = 1764590400000
    rendered = render_visit_cards(
        [
            visit("2025-12-01T11:00:00+00:00", "2025-12-01T11:55:00+00:00"),
            visit("2025-12-01T10:00:00+00:00", "2025-12-01T10:30:00+00:00"),
            visit("2025-12-01T09:00:00+00:00", "2025-12-01T09:30:00+00:00"),
        ],
        minute_tick,
    )

    assert rendered["badgeCounts"] == [1, 0, 0]


def test_merged_visit_duration_hides_three_stops_text():
    rendered = render_visit_cards(
        [visit("2025-12-01T10:00:00+00:00", "2025-12-01T10:50:00+00:00", visit_count=3)],
        1764590400000,
    )
    text = "".join(rendered["text"])

    assert "50m" in text
    assert "3 stops \u00b7 50m" not in text
    assert "stops" not in text


def test_merged_visit_duration_hides_fifteen_stops_text():
    rendered = render_visit_cards(
        [visit("2025-12-01T06:13:00+00:00", "2025-12-01T10:00:00+00:00", visit_count=15)],
        1764590400000,
    )
    text = "".join(rendered["text"])

    assert "3h 47m" in text
    assert "15 stops \u00b7 3h 47m" not in text
    assert "stops" not in text
