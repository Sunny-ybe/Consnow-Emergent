import json
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MAP_TAB_PATH = ROOT / "frontend/app/(tabs)/index.tsx"
TYPESCRIPT = ROOT / "frontend/node_modules/typescript"

MAP_POLLING_SCRIPT = r"""
const fs = require('fs');
const vm = require('vm');
const ts = require(process.argv[2]);

const source = fs.readFileSync(process.argv[1], 'utf8');
const scenario = process.argv[3];
const output = ts.transpileModule(source, {
  compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
    esModuleInterop: true,
  },
}).outputText;

const latestCalls = [];
const listFriendsCalls = [];
const intervals = [];
let focusCallback = null;

function createElement(type, props, key) {
  return { type, props: props || {}, key };
}

async function flushPromises() {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

async function runActiveIntervals() {
  const active = intervals.filter((timer) => !timer.cleared);
  for (const timer of active) {
    timer.callback();
  }
  await flushPromises();
}

const module = { exports: {} };
const context = {
  console,
  exports: module.exports,
  module,
  setInterval(callback, delay) {
    const timer = { callback, delay, cleared: false };
    intervals.push(timer);
    return timer;
  },
  clearInterval(timer) {
    timer.cleared = true;
  },
  require(name) {
    if (name === 'react') {
      return {
        useState: (initial) => [initial, () => {}],
        useCallback: (callback) => callback,
      };
    }
    if (name === 'react/jsx-runtime') {
      return { jsx: createElement, jsxs: createElement, Fragment: 'Fragment' };
    }
    if (name === 'react-native') {
      return {
        View: 'View',
        Text: 'Text',
        StyleSheet: { create: (styles) => styles },
        TouchableOpacity: 'TouchableOpacity',
        Alert: { alert: () => {} },
        Platform: { OS: 'ios' },
        ScrollView: 'ScrollView',
        RefreshControl: 'RefreshControl',
        Linking: { openURL: () => {} },
      };
    }
    if (name === 'react-native-safe-area-context') return { SafeAreaView: 'SafeAreaView' };
    if (name === 'lucide-react-native') {
      return { MapPin: 'MapPin', Power: 'Power', Loader: 'Loader', Activity: 'Activity' };
    }
    if (name === 'expo-router') {
      return { useFocusEffect: (callback) => { focusCallback = callback; } };
    }
    if (name === '@/src/theme') {
      return {
        colors: {
          bg: '#fff',
          bgSecondary: '#fff',
          bgTertiary: '#eee',
          brand: '#000',
          textPrimary: '#111',
          textSecondary: '#777',
          textTertiary: '#aaa',
          textInverse: '#fff',
          success: '#0f0',
          warning: '#f90',
        },
        spacing: { sm: 8, md: 12, lg: 16, xxl: 32 },
        radius: { lg: 16 },
        typography: { h1: {}, h2: {}, body: {}, caption: {} },
        shadow: { card: {} },
      };
    }
    if (name === '@/src/locationService') {
      return {
        requestForegroundPermission: async () => true,
        requestBackgroundPermission: async () => true,
        startBackgroundTracking: async () => true,
        stopBackgroundTracking: async () => {},
        isBackgroundTrackingActive: async () => false,
        backgroundTrackingUnsupported: false,
        backgroundUnsupportedReason: () => '',
      };
    }
    if (name === '@/src/api') {
      return {
        listFriends: async () => {
          listFriendsCalls.push(true);
          return {
            friends: [
              { user: { id: 'friend-a', display_name: 'Friend A' } },
              { user: { id: 'friend-b', display_name: 'Friend B' } },
              { user: { id: 'friend-c', display_name: 'Friend C' } },
            ],
          };
        },
        getLatestLocation: async (userId) => {
          latestCalls.push(userId === undefined ? null : userId);
          return {
            user_id: userId || 'self',
            latitude: 1,
            longitude: 2,
            timestamp: '2026-01-01T00:00:00+00:00',
          };
        },
      };
    }
    if (name === '@/src/auth') {
      return { useAuth: () => ({ user: { display_name: 'Tester' } }) };
    }
    if (name === '@/src/AvailabilityBadge') return { AvailabilityBadge: 'AvailabilityBadge' };
    throw new Error(`Unexpected require: ${name}`);
  },
};

vm.runInNewContext(output, context, { filename: 'mapTab.js' });
module.exports.default();

if (!focusCallback) {
  throw new Error('Map tab did not register focus callback');
}

(async () => {
  const cleanup = focusCallback();
  await flushPromises();

  if (scenario === 'focus_tick' || scenario === 'focus_blur_tick') {
    if (!intervals.some((timer) => timer.delay === 30000)) {
      throw new Error('Expected a 30 second polling interval');
    }
  }

  if (scenario === 'focus_tick') {
    await runActiveIntervals();
  }

  if (scenario === 'focus_blur_tick') {
    cleanup();
    await runActiveIntervals();
  }

  process.stdout.write(JSON.stringify({
    latestCalls,
    listFriendsCallCount: listFriendsCalls.length,
    intervalDelays: intervals.map((timer) => timer.delay),
    clearedIntervals: intervals.filter((timer) => timer.cleared).length,
  }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
"""


def run_map_polling_scenario(scenario):
    result = subprocess.run(
        [
            "node",
            "-e",
            MAP_POLLING_SCRIPT,
            str(MAP_TAB_PATH),
            str(TYPESCRIPT),
            scenario,
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout)


def friend_latest_calls(result):
    return [call for call in result["latestCalls"] if call is not None]


def test_map_focus_fetches_latest_locations_for_all_friends_immediately():
    result = run_map_polling_scenario("focus")

    assert friend_latest_calls(result) == ["friend-a", "friend-b", "friend-c"]
    assert result["intervalDelays"] == [30000]


def test_map_focus_polls_latest_locations_again_after_thirty_seconds():
    result = run_map_polling_scenario("focus_tick")

    assert friend_latest_calls(result) == [
        "friend-a",
        "friend-b",
        "friend-c",
        "friend-a",
        "friend-b",
        "friend-c",
    ]
    assert result["intervalDelays"] == [30000]


def test_map_blur_stops_latest_location_polling():
    result = run_map_polling_scenario("focus_blur_tick")

    assert friend_latest_calls(result) == ["friend-a", "friend-b", "friend-c"]
    assert result["clearedIntervals"] == 1
