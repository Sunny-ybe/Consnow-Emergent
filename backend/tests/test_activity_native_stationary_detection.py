import json
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
ACTIVITY_SERVICE = ROOT / "frontend/src/activityService.ts"
TYPESCRIPT = ROOT / "frontend/node_modules/typescript"

DETECT_ACTIVITY_SCRIPT = r"""
const fs = require('fs');
const vm = require('vm');
const ts = require(process.argv[2]);

const source = fs.readFileSync(process.argv[1], 'utf8');
const config = JSON.parse(process.argv[3]);
const output = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
    esModuleInterop: true,
  },
}).outputText;

const nativeModules = {};
for (const [moduleName, moduleMock] of Object.entries(config.nativeModules || {})) {
  nativeModules[moduleName] = {};
  for (const [methodName, returnValue] of Object.entries(moduleMock)) {
    nativeModules[moduleName][methodName] = () => returnValue;
  }
}
const module = { exports: {} };
const context = {
  console,
  exports: module.exports,
  module,
  require(name) {
    if (name === 'expo-location') return {};
    if (name === 'react-native') {
      return {
        NativeModules: nativeModules,
        Platform: { OS: config.platform },
      };
    }
    throw new Error(`Unexpected require: ${name}`);
  },
};

vm.runInNewContext(output, context, { filename: 'activityService.js' });

const result = module.exports.detectActivityFromLocation({
  coords: { speed: config.speed },
});
process.stdout.write(JSON.stringify(result));
"""


def detect_activity(speed, platform="ios", native_modules=None):
    result = subprocess.run(
        [
            "node",
            "-e",
            DETECT_ACTIVITY_SCRIPT,
            str(ACTIVITY_SERVICE),
            str(TYPESCRIPT),
            json.dumps({
                "speed": speed,
                "platform": platform,
                "nativeModules": native_modules or {},
            }),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout)


def test_native_stationary_overrides_gps_speed():
    ios_result = detect_activity(
        3.0,
        platform="ios",
        native_modules={"CMMotionActivityManager": {"isStationarySync": True}},
    )
    android_result = detect_activity(
        3.0,
        platform="android",
        native_modules={"ActivityRecognitionClient": {"isStationarySync": True}},
    )

    assert ios_result["activity"] == "stationary"
    assert android_result["activity"] == "stationary"
    assert ios_result["activity"] != "walking"
    assert android_result["activity"] != "walking"


def test_native_moving_falls_back_to_stationary_gps_speed():
    result = detect_activity(
        0.3,
        platform="ios",
        native_modules={"CMMotionActivityManager": {"getCurrentActivitySync": "moving"}},
    )

    assert result["activity"] == "stationary"
    assert result["speed_mps"] == 0.3


def test_native_unavailable_falls_back_to_walking_gps_speed():
    result = detect_activity(1.5, platform="android")

    assert result["activity"] == "walking"
    assert result["speed_mps"] == 1.5
