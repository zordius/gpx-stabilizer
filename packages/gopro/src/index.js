// Public surface of gpx-from-gopro — the render-agnostic telemetry export
// contract (docs/export-contract.md). `stabilize` is re-exported from the core
// gpx-stabilizer package so the contract's "section A" surface stays reachable
// from this single entry.
export { stabilize } from "gpx-stabilizer";
export { extractGoproPoints, probeGoproMeta } from "./gopro.js";
export {
  readGoproTelemetry,
  recordingStartUtc,
  regressStartUtc,
  resolveStartUtc,
  timezoneAt,
  timezoneOfPoints,
} from "./telemetry.js";
