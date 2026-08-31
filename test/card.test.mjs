import test from "node:test";
import assert from "node:assert/strict";

const registry = new Map();
globalThis.HTMLElement = class {};
globalThis.customElements = {
  define(name, constructor) { registry.set(name, constructor); },
  get(name) { return registry.get(name); },
};
globalThis.window = {};

const module = await import("../src/sprinkler-sequence-card.js");
const {
  buildControlCall,
  buildPlan,
  buildStartCall,
  controlPresentation,
  deriveRuntime,
  formatCountdown,
  invokeService,
  normalizeDurationInput,
  parseDuration,
  resolveConfig,
} = module;

function config(overrides = {}) {
  return resolveConfig({
    type: "custom:sprinkler-sequence-card",
    preset: "wyzeapi",
    mode: "sequence",
    target: { device_id: "controller-device-id" },
    runtime: { status_entity: "sensor.controller_watering_status" },
    zones: [
      { id: "front", name: "Front", value: 1 },
      { id: "back", name: "Back", value: 2 },
    ],
    ...overrides,
  });
}

test("registers card and editor lifecycle surfaces", () => {
  assert.equal(typeof registry.get("sprinkler-sequence-card"), "function");
  assert.equal(typeof registry.get("sprinkler-sequence-card-editor"), "function");
  assert.equal(window.customCards.filter((item) => item.type === "sprinkler-sequence-card").length, 1);
  const stub = module.SprinklerSequenceCard.getStubConfig();
  assert.equal(stub.type, "custom:sprinkler-sequence-card");
  assert.equal(stub.preset, "wyzeapi");
});

test("duration parsing preserves leading decimals and whole-second safety", () => {
  const limits = config().limits;
  assert.equal(normalizeDurationInput(".2"), "0.2");
  assert.equal(parseDuration(".2", "minutes", limits), 12);
  assert.equal(parseDuration("45 sec", "minutes", limits), 45);
  assert.throws(() => parseDuration(".01", "minutes", limits), /whole seconds/);
  assert.throws(() => parseDuration("181", "minutes", limits), /Duration must be/);
});

test("sequence produces one bounded backend service call", () => {
  const resolved = config();
  const plan = buildPlan(resolved, ["front", "back"], 30);
  const call = buildStartCall(resolved, plan);
  assert.equal(call.domain, "wyzeapi");
  assert.equal(call.service, "run_sprinkler_sequence");
  assert.deepEqual(call.target, { device_id: "controller-device-id" });
  assert.deepEqual(call.data.zones, [
    { zone: 1, duration_seconds: 30 },
    { zone: 2, duration_seconds: 30 },
  ]);
  assert.equal(call.data.source, "dashboard");
  assert.match(call.data.command_id, /^sprinkler-card-/);
});

test("single-zone mode refuses client-side sequencing", () => {
  const resolved = config({ mode: "single_zone" });
  assert.throws(() => buildPlan(resolved, ["front", "back"], 60), /exactly one/);
  const call = buildStartCall(resolved, buildPlan(resolved, ["back"], 60));
  assert.equal(call.service, "run_sprinkler_zone");
  assert.equal(call.data.zone, 2);
  assert.equal(call.data.duration_seconds, 60);
  assert.equal(call.data.zones, undefined);
});

test("generic sequence adapter honors explicit service and field mappings", () => {
  const resolved = resolveConfig({
    type: "custom:sprinkler-sequence-card",
    mode: "sequence",
    target: { entity_id: "switch.irrigation_controller" },
    services: { start_sequence: "irrigation.run_sequence" },
    fields: { zones: "steps", zone: "zone_id", duration: "seconds", command_id: null, source: null },
    runtime: {
      status_entity: "sensor.irrigation_status",
      state_path: "state",
      idle_states: ["ready"],
      running_states: ["busy"],
      paused_states: ["held"],
      pending_states: ["starting"],
    },
    zones: [{ id: "bed-a", name: "Bed A", value: "bed_a" }],
  });
  const call = buildStartCall(resolved, buildPlan(resolved, ["bed-a"], 15));
  assert.equal(call.domain, "irrigation");
  assert.equal(call.service, "run_sequence");
  assert.deepEqual(call.data, { steps: [{ zone_id: "bed_a", seconds: 15 }] });
  assert.deepEqual(call.target, { entity_id: "switch.irrigation_controller" });
});

test("total runtime limits are enforced before submission", () => {
  const resolved = config({ limits: { max_duration_seconds: 100, max_total_seconds: 100 } });
  assert.throws(() => buildPlan(resolved, ["front", "back"], 60), /Total run time/);
});

test("unknown and unmapped states fail closed", () => {
  const resolved = config();
  const absent = deriveRuntime({}, resolved);
  assert.equal(absent.known, false);
  assert.equal(controlPresentation(resolved, absent, "stop").enabled, false);
  const unknown = deriveRuntime({ "sensor.controller_watering_status": { state: "mystery", attributes: {} } }, resolved);
  assert.equal(unknown.known, false);
  assert.equal(unknown.state, "unknown");
});

test("known idle, running, paused, and pending lifecycle states are distinct", () => {
  const resolved = config();
  const status = (state, extra = {}) => ({ "sensor.controller_watering_status": { state, attributes: { logical_run_state: state, ...extra } } });
  assert.equal(deriveRuntime(status("idle"), resolved).state, "idle");
  const running = deriveRuntime(status("running", { logical_run: { current_zone: { zone_number: 1, duration_seconds: 120 }, current_zone_remaining_seconds: 45 } }), resolved);
  assert.equal(running.zone_name, "Front");
  assert.equal(running.progress_percent, 63);
  assert.equal(controlPresentation(resolved, running, "pause_resume").action, "pause");
  const paused = deriveRuntime(status("paused"), resolved);
  assert.equal(controlPresentation(resolved, paused, "pause_resume").action, "resume");
  const pending = deriveRuntime(status("starting"), resolved);
  assert.equal(pending.pending, true);
  assert.equal(controlPresentation(resolved, pending, "stop").enabled, false);
});

test("control calls keep target and metadata bounded", () => {
  const call = buildControlCall(config(), "stop");
  assert.equal(call.domain, "wyzeapi");
  assert.equal(call.service, "stop_sprinkler");
  assert.deepEqual(call.target, { device_id: "controller-device-id" });
  assert.deepEqual(Object.keys(call.data).sort(), ["command_id", "source"]);
});

test("invokeService performs exactly one Home Assistant service call", async () => {
  const calls = [];
  const hass = { async callService(...args) { calls.push(args); return { ok: true }; } };
  const call = buildControlCall(config(), "pause");
  await invokeService(hass, call);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][3], { device_id: "controller-device-id" });
});

test("configuration rejects ambiguous targets and unsafe templates", () => {
  assert.throws(() => config({ target: { device_id: "one", entity_id: "two" } }), /exactly one/);
  assert.throws(() => config({ target: { device_id: "{{ unsafe }}" } }), /literal safe/);
  assert.throws(() => config({ runtime: { status_entity: "" } }), /status_entity is required/);
});

test("countdown formatting is deterministic", () => {
  assert.equal(formatCountdown(61.1), "1:02");
  assert.equal(formatCountdown(null), null);
  assert.equal(formatCountdown("not-a-number"), null);
});
