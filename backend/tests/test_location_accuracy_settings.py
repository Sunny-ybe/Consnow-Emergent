import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
LOCATION_SERVICE = ROOT / "frontend/src/locationService.ts"
IOS_LOCATION_ACCURACY = ROOT / "frontend/node_modules/expo-location/ios/LocationAccuracy.swift"


def _read(path):
    return path.read_text()


def _call_options(source, call_name):
    call_start = source.find(f"{call_name}(")
    assert call_start != -1, f"Missing {call_name} options"
    options_start = source.find("{", call_start)
    assert options_start != -1, f"Missing {call_name} options object"

    depth = 0
    for index in range(options_start, len(source)):
        if source[index] == "{":
            depth += 1
        elif source[index] == "}":
            depth -= 1
            if depth == 0:
                return source[options_start + 1:index]

    raise AssertionError(f"Unclosed {call_name} options object")


def _swift_case_body(source, case_name):
    pattern = rf"case \.{case_name}:(?P<body>.*?)(?=\n\s*case \.|\n\s*\}})"
    match = re.search(pattern, source, re.DOTALL)
    assert match, f"Missing iOS accuracy case {case_name}"
    return match.group("body")


def test_location_service_does_not_set_desired_accuracy_to_ios_best():
    source = _read(LOCATION_SERVICE)

    assert "desiredAccuracy = kCLLocationAccuracyBest" not in source
    assert "kCLLocationAccuracyBest" not in source
    assert "Location.Accuracy.Highest" not in source
    assert "Location.Accuracy.BestForNavigation" not in source


def test_ios_location_accuracy_is_hundred_meters():
    service_source = _read(LOCATION_SERVICE)
    ios_source = _read(IOS_LOCATION_ACCURACY)
    background_options = _call_options(service_source, "Location.startLocationUpdatesAsync")
    balanced_body = _swift_case_body(ios_source, "balanced")

    assert "accuracy: Location.Accuracy.Balanced" in background_options
    assert "return kCLLocationAccuracyHundredMeters" in balanced_body


def test_android_accuracy_setting_remains_balanced():
    source = _read(LOCATION_SERVICE)
    foreground_options = _call_options(source, "Location.getCurrentPositionAsync")
    background_options = _call_options(source, "Location.startLocationUpdatesAsync")

    assert "accuracy: Location.Accuracy.Balanced" in foreground_options
    assert "accuracy: Location.Accuracy.Balanced" in background_options
