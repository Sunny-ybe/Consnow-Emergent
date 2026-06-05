import json
import subprocess
from pathlib import Path


TIMELINE_PATH = Path(__file__).resolve().parents[2] / "frontend/app/(tabs)/timeline.tsx"
ACTIVITY_LABELS = ("Walking", "Running", "Cycling", "Driving")
ACTIVITY_EMOJIS = (
    "\U0001f6b6\u200d\u2642\ufe0f",
    "\U0001f3c3\u200d\u2642\ufe0f",
    "\U0001f6b4\u200d\u2642\ufe0f",
    "\U0001f698",
)

RENDER_TRANSIT_SCRIPT = r"""
const fs = require('fs');
const source = fs.readFileSync(process.argv[1], 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}`);
  if (start === -1) throw new Error(`Missing ${name}`);

  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') depth -= 1;
    if (depth === 0) {
      return source
        .slice(start, i + 1)
        .replace(/function (\w+)\((.*?)\): string \{/s, (_match, fnName, args) => {
          return `function ${fnName}(${args.replace(/:\s*number/g, '')}) {`;
        });
    }
  }
  throw new Error(`Unclosed ${name}`);
}

eval([
  extractFunction('formatTransportDistance'),
  extractFunction('formatTransportDuration'),
  extractFunction('formatTransportSpeed'),
].join('\n'));

function renderTransitSegment(distance_m, duration) {
  return [
    formatTransportDistance(distance_m),
    formatTransportDuration(duration),
    formatTransportSpeed(distance_m, duration),
  ].filter(Boolean).join(' \u00b7 ');
}

const transit = JSON.parse(process.argv[2]);
console.log(renderTransitSegment(transit.distance_m, transit.duration));
"""


def render_transit_segment(distance_m, duration):
    result = subprocess.run(
        [
            "node",
            "-e",
            RENDER_TRANSIT_SCRIPT,
            str(TIMELINE_PATH),
            json.dumps({"distance_m": distance_m, "duration": duration}),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def assert_no_activity_labels_or_emojis(rendered):
    for label in ACTIVITY_LABELS:
        assert label not in rendered
    for emoji in ACTIVITY_EMOJIS:
        assert emoji not in rendered


def test_transit_segment_displays_distance_duration_and_speed_without_activity():
    rendered = render_transit_segment(1700, 24 * 60)

    assert rendered == "1.7km \u00b7 24min \u00b7 4.3 km/h"
    assert_no_activity_labels_or_emojis(rendered)


def test_short_transit_segment_displays_calculated_speed_without_activity_labels():
    rendered = render_transit_segment(500, 5 * 60)

    assert rendered == "500m \u00b7 5min \u00b7 6.0 km/h"
    for label in ACTIVITY_LABELS:
        assert label not in rendered


def test_fast_transit_segment_displays_speed_without_activity_emoji():
    rendered = render_transit_segment(2400, 12 * 60)

    assert rendered == "2.4km \u00b7 12min \u00b7 12.0 km/h"
    for emoji in ACTIVITY_EMOJIS:
        assert emoji not in rendered
