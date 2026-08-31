const VERSION = "0.1.1";
const CARD_TAG = "sprinkler-sequence-card";
const EDITOR_TAG = "sprinkler-sequence-card-editor";
const SERVICE_RE = /^[a-z0-9_]+\.[a-z0-9_]+$/;
const FIELD_RE = /^[a-z][a-z0-9_]{0,63}$/;
const SAFE_VALUE_RE = /^[A-Za-z0-9_.:@/+-]{1,160}$/;
const TARGET_KEYS = new Set(["device_id", "entity_id"]);
const UNKNOWN_STATES = new Set(["", "unknown", "unavailable", "none", "null"]);

const WYZEAPI_PRESET = Object.freeze({
  services: {
    start_sequence: "wyzeapi.run_sprinkler_sequence",
    start_zone: "wyzeapi.run_sprinkler_zone",
    pause: "wyzeapi.pause_sprinkler",
    resume: "wyzeapi.resume_sprinkler",
    stop: "wyzeapi.stop_sprinkler",
  },
  fields: {
    zones: "zones",
    zone: "zone",
    duration: "duration_seconds",
    command_id: "command_id",
    source: "source",
  },
  runtime: {
    state_path: "attributes.logical_run_state",
    fallback_state_path: "state",
    active_zone_path: "attributes.logical_run.current_zone.zone_number",
    active_zone_name_path: "attributes.logical_run.current_zone.zone_name",
    remaining_path: "attributes.logical_run.current_zone_remaining_seconds",
    total_path: "attributes.logical_run.current_zone.duration_seconds",
    queue_path: "attributes.logical_run.remaining_queued_zones",
    command_pending_path: "attributes.command_pending",
    idle_states: ["idle", "off", "stopped", "complete", "past"],
    running_states: ["active", "on", "running", "watering"],
    paused_states: ["paused"],
    pending_states: ["starting", "pausing", "resuming", "stopping"],
  },
});

const GENERIC_DEFAULTS = Object.freeze({
  title: "Sprinkler sequence",
  mode: "sequence",
  default_duration: 5,
  duration_unit: "minutes",
  show_runtime: true,
  show_controls: true,
  limits: {
    min_duration_seconds: 1,
    max_duration_seconds: 10800,
    max_total_seconds: 10800,
    max_zones: 8,
  },
  fields: {
    zones: "zones",
    zone: "zone",
    duration: "duration_seconds",
    command_id: "command_id",
    source: "source",
  },
  runtime: {
    state_path: "state",
    idle_states: ["idle", "off", "stopped"],
    running_states: ["active", "on", "running", "watering"],
    paused_states: ["paused"],
    pending_states: ["starting", "pausing", "resuming", "stopping"],
  },
});

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function merge(base, override) {
  const output = clone(base) || {};
  for (const [key, value] of Object.entries(override || {})) {
    if (value && typeof value === "object" && !Array.isArray(value) && output[key] && typeof output[key] === "object" && !Array.isArray(output[key])) {
      output[key] = merge(output[key], value);
    } else {
      output[key] = clone(value);
    }
  }
  return output;
}

function asStateList(value, name) {
  if (!Array.isArray(value) || !value.length) throw new Error(`${name} must contain at least one state.`);
  const result = value.map((item) => String(item).trim().toLowerCase());
  if (result.some((item) => !item || item.length > 64)) throw new Error(`${name} contains an invalid state.`);
  return [...new Set(result)];
}

function validateField(value, name, required = true) {
  if ((value == null || value === "") && !required) return null;
  if (!FIELD_RE.test(String(value))) throw new Error(`${name} must be a lowercase Home Assistant field name.`);
  return String(value);
}

function validateService(value, name, required = false) {
  if ((value == null || value === "") && !required) return null;
  if (!SERVICE_RE.test(String(value))) throw new Error(`${name} must use domain.service format.`);
  return String(value);
}

function validatePath(value, name, required = false) {
  if ((value == null || value === "") && !required) return null;
  const text = String(value);
  if (!/^(state|attributes(?:\.[A-Za-z0-9_]+)*)$/.test(text)) throw new Error(`${name} must be state or an attributes.* path.`);
  return text;
}

function validateEntityId(value, name, required = false) {
  if ((value == null || value === "") && !required) return null;
  if (!/^[a-z0-9_]+\.[a-z0-9_]+$/.test(String(value))) throw new Error(`${name} must be a literal Home Assistant entity ID.`);
  return String(value);
}

function validateTarget(target) {
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    throw new Error("target must identify exactly one Home Assistant device or entity.");
  }
  const entries = Object.entries(target);
  if (entries.length !== 1 || !TARGET_KEYS.has(entries[0][0])) {
    throw new Error("target must contain exactly one of device_id or entity_id.");
  }
  const [key, raw] = entries[0];
  const values = Array.isArray(raw) ? raw : [raw];
  if (values.length !== 1 || typeof values[0] !== "string" || !SAFE_VALUE_RE.test(values[0]) || /{{|}}/.test(values[0])) {
    throw new Error("target must contain one literal safe identifier.");
  }
  return { [key]: values[0] };
}

function validateZone(zone, index) {
  if (!zone || typeof zone !== "object" || Array.isArray(zone)) throw new Error(`zones[${index}] must be an object.`);
  const id = String(zone.id ?? "").trim();
  const name = String(zone.name ?? zone.label ?? "").trim();
  const value = zone.value ?? zone.zone;
  if (!id || id.length > 64 || !/^[A-Za-z0-9_.-]+$/.test(id)) throw new Error(`zones[${index}].id is invalid.`);
  if (!name || name.length > 80) throw new Error(`zones[${index}].name is required and must be 80 characters or less.`);
  if (!(typeof value === "number" && Number.isInteger(value)) && !(typeof value === "string" && SAFE_VALUE_RE.test(value))) {
    throw new Error(`zones[${index}].value must be a safe string or integer.`);
  }
  return { id, name, value };
}

function normalizeLimits(limits) {
  const result = {};
  for (const key of ["min_duration_seconds", "max_duration_seconds", "max_total_seconds", "max_zones"]) {
    const value = Number(limits[key]);
    if (!Number.isInteger(value) || value < 1) throw new Error(`limits.${key} must be a positive integer.`);
    result[key] = value;
  }
  if (result.min_duration_seconds > result.max_duration_seconds) throw new Error("Minimum duration cannot exceed maximum duration.");
  if (result.max_duration_seconds > result.max_total_seconds) throw new Error("Per-zone maximum cannot exceed the total maximum.");
  if (result.max_zones > 32) throw new Error("A maximum of 32 zones is supported.");
  return result;
}

export function resolveConfig(input) {
  if (!input || typeof input !== "object") throw new Error("Card configuration is required.");
  const preset = input.preset == null ? null : String(input.preset).trim().toLowerCase();
  if (preset && preset !== "wyzeapi") throw new Error("preset must be wyzeapi or omitted.");
  let config = merge(GENERIC_DEFAULTS, preset === "wyzeapi" ? WYZEAPI_PRESET : {});
  config = merge(config, input);
  config.type = `custom:${CARD_TAG}`;
  config.preset = preset;
  config.mode = String(config.mode).trim().toLowerCase();
  if (!["sequence", "single_zone"].includes(config.mode)) throw new Error("mode must be sequence or single_zone.");
  config.target = validateTarget(config.target);
  config.limits = normalizeLimits(config.limits);
  if (!Array.isArray(config.zones) || !config.zones.length) throw new Error("Configure at least one zone.");
  if (config.zones.length > config.limits.max_zones) throw new Error(`Configure no more than ${config.limits.max_zones} zones.`);
  config.zones = config.zones.map(validateZone);
  if (new Set(config.zones.map((zone) => zone.id)).size !== config.zones.length) throw new Error("Zone IDs must be unique.");
  if (new Set(config.zones.map((zone) => String(zone.value))).size !== config.zones.length) throw new Error("Zone service values must be unique.");

  config.services = {
    start_sequence: validateService(config.services?.start_sequence, "services.start_sequence", config.mode === "sequence"),
    start_zone: validateService(config.services?.start_zone, "services.start_zone", config.mode === "single_zone"),
    pause: validateService(config.services?.pause, "services.pause"),
    resume: validateService(config.services?.resume, "services.resume"),
    stop: validateService(config.services?.stop, "services.stop"),
  };
  config.fields = {
    zones: validateField(config.fields?.zones, "fields.zones", config.mode === "sequence"),
    zone: validateField(config.fields?.zone, "fields.zone", true),
    duration: validateField(config.fields?.duration, "fields.duration", true),
    command_id: validateField(config.fields?.command_id, "fields.command_id", false),
    source: validateField(config.fields?.source, "fields.source", false),
  };

  const runtime = config.runtime || {};
  if (!runtime.status_entity) throw new Error("runtime.status_entity is required so unknown controller state fails closed.");
  config.runtime = {
    status_entity: validateEntityId(runtime.status_entity, "runtime.status_entity", true),
    active_zone_entity: validateEntityId(runtime.active_zone_entity, "runtime.active_zone_entity"),
    remaining_entity: validateEntityId(runtime.remaining_entity, "runtime.remaining_entity"),
    state_path: validatePath(runtime.state_path, "runtime.state_path", true),
    fallback_state_path: validatePath(runtime.fallback_state_path, "runtime.fallback_state_path"),
    active_zone_path: validatePath(runtime.active_zone_path, "runtime.active_zone_path"),
    active_zone_name_path: validatePath(runtime.active_zone_name_path, "runtime.active_zone_name_path"),
    remaining_path: validatePath(runtime.remaining_path, "runtime.remaining_path"),
    total_path: validatePath(runtime.total_path, "runtime.total_path"),
    queue_path: validatePath(runtime.queue_path, "runtime.queue_path"),
    command_pending_path: validatePath(runtime.command_pending_path, "runtime.command_pending_path"),
    idle_states: asStateList(runtime.idle_states, "runtime.idle_states"),
    running_states: asStateList(runtime.running_states, "runtime.running_states"),
    paused_states: asStateList(runtime.paused_states, "runtime.paused_states"),
    pending_states: asStateList(runtime.pending_states, "runtime.pending_states"),
    remaining_unit: String(runtime.remaining_unit || "seconds").toLowerCase(),
  };
  const stateGroups = [config.runtime.idle_states, config.runtime.running_states, config.runtime.paused_states, config.runtime.pending_states].flat();
  if (new Set(stateGroups).size !== stateGroups.length) throw new Error("Runtime state groups must not overlap.");
  if (!["seconds", "minutes"].includes(config.runtime.remaining_unit)) throw new Error("runtime.remaining_unit must be seconds or minutes.");
  config.default_duration = Number(config.default_duration);
  if (!Number.isFinite(config.default_duration) || config.default_duration <= 0) throw new Error("default_duration must be positive.");
  config.duration_unit = String(config.duration_unit || "minutes").toLowerCase();
  if (!["minutes", "seconds"].includes(config.duration_unit)) throw new Error("duration_unit must be minutes or seconds.");
  config.title = String(config.title || "Sprinkler sequence").slice(0, 100);
  config.show_controls = config.show_controls !== false;
  config.show_runtime = config.show_runtime !== false;
  return config;
}

export function normalizeDurationInput(value) {
  return String(value ?? "").trim().replace(/^\.(?=[0-9])/, "0.");
}

export function parseDuration(value, unit, limits) {
  const text = normalizeDurationInput(value).toLowerCase();
  const match = text.match(/^([0-9]+(?:\.[0-9]+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes)?$/);
  if (!match) throw new Error("Enter a numeric duration, such as 5 or 0.1.");
  const amount = Number(match[1]);
  const suffix = match[2];
  const useSeconds = suffix ? suffix.startsWith("s") : unit === "seconds";
  const seconds = useSeconds ? amount : amount * 60;
  const rounded = Math.round(seconds);
  if (!Number.isFinite(seconds) || Math.abs(seconds - rounded) > 1e-8) throw new Error("Duration must resolve to whole seconds.");
  if (rounded < limits.min_duration_seconds || rounded > limits.max_duration_seconds) {
    throw new Error(`Duration must be ${limits.min_duration_seconds}–${limits.max_duration_seconds} seconds.`);
  }
  return rounded;
}

export function buildPlan(config, selectedIds, durationSeconds) {
  const selected = [...selectedIds];
  if (!selected.length) throw new Error("Select at least one zone.");
  if (new Set(selected).size !== selected.length) throw new Error("A zone may only be selected once.");
  if (config.mode === "single_zone" && selected.length !== 1) throw new Error("Single-zone mode requires exactly one selected zone.");
  const lookup = new Map(config.zones.map((zone) => [zone.id, zone]));
  const zones = selected.map((id) => {
    const zone = lookup.get(id);
    if (!zone) throw new Error(`Unknown zone: ${id}`);
    return zone;
  });
  if (zones.length * durationSeconds > config.limits.max_total_seconds) throw new Error(`Total run time must not exceed ${config.limits.max_total_seconds} seconds.`);
  return zones.map((zone) => ({ ...zone, duration_seconds: durationSeconds }));
}

function splitService(value) {
  const [domain, service] = value.split(".");
  return { domain, service };
}

function commandId(action) {
  return `sprinkler-card-${Date.now().toString(36)}-${action}`.slice(0, 64);
}

function commandMetadata(config, action) {
  const data = {};
  if (config.fields.command_id) data[config.fields.command_id] = commandId(action);
  if (config.fields.source) data[config.fields.source] = "dashboard";
  return data;
}

export function buildStartCall(config, plan) {
  const serviceName = config.mode === "sequence" ? config.services.start_sequence : config.services.start_zone;
  const data = commandMetadata(config, config.mode === "sequence" ? "sequence" : "zone");
  if (config.mode === "sequence") {
    data[config.fields.zones] = plan.map((item) => ({
      [config.fields.zone]: item.value,
      [config.fields.duration]: item.duration_seconds,
    }));
  } else {
    data[config.fields.zone] = plan[0].value;
    data[config.fields.duration] = plan[0].duration_seconds;
  }
  return { ...splitService(serviceName), data, target: clone(config.target) };
}

export function buildControlCall(config, action) {
  if (!["pause", "resume", "stop"].includes(action)) throw new Error("Unsupported control action.");
  const serviceName = config.services[action];
  if (!serviceName) throw new Error(`${action} service is not configured.`);
  return { ...splitService(serviceName), data: commandMetadata(config, action), target: clone(config.target) };
}

export async function invokeService(hass, call) {
  if (!hass || typeof hass.callService !== "function") throw new Error("Home Assistant is unavailable.");
  return hass.callService(call.domain, call.service, call.data, call.target);
}

export function readPath(stateObject, path) {
  if (!stateObject || !path) return undefined;
  if (path === "state") return stateObject.state;
  let current = stateObject;
  for (const part of path.split(".")) {
    if (current == null || typeof current !== "object") return undefined;
    current = current[part];
  }
  return current;
}

function normalizedState(value) {
  return String(value ?? "").trim().toLowerCase();
}

function readExternalState(states, entityId) {
  const item = entityId ? states?.[entityId] : null;
  if (!item || UNKNOWN_STATES.has(normalizedState(item.state))) return undefined;
  return item.state;
}

function mapZoneName(config, rawValue, rawName) {
  if (rawName != null && !UNKNOWN_STATES.has(normalizedState(rawName))) return String(rawName);
  const match = config.zones.find((zone) => String(zone.value) === String(rawValue) || zone.id === String(rawValue));
  return match?.name || (rawValue == null ? "Selected zone" : String(rawValue));
}

export function deriveRuntime(states, config) {
  const runtime = config.runtime;
  const statusObject = states?.[runtime.status_entity];
  if (!statusObject) return { known: false, active: false, pending: false, state: "unknown", label: "Controller status unavailable" };
  let rawState = readPath(statusObject, runtime.state_path);
  if (UNKNOWN_STATES.has(normalizedState(rawState)) && runtime.fallback_state_path) rawState = readPath(statusObject, runtime.fallback_state_path);
  const state = normalizedState(rawState);
  if (UNKNOWN_STATES.has(state)) return { known: false, active: false, pending: false, state: "unknown", label: "Controller status unknown" };
  const explicitPending = runtime.command_pending_path ? readPath(statusObject, runtime.command_pending_path) === true : false;
  if (runtime.pending_states.includes(state) || explicitPending) {
    return { known: true, active: false, pending: true, state: "pending", label: "Controller command pending" };
  }
  if (runtime.idle_states.includes(state)) return { known: true, active: false, pending: false, state: "idle", label: "No active watering" };
  const running = runtime.running_states.includes(state);
  const paused = runtime.paused_states.includes(state);
  if (!running && !paused) return { known: false, active: false, pending: false, state: "unknown", label: `Unrecognized controller state: ${state}` };

  const externalZone = readExternalState(states, runtime.active_zone_entity);
  const zoneValue = readPath(statusObject, runtime.active_zone_path) ?? externalZone;
  const zoneNameValue = readPath(statusObject, runtime.active_zone_name_path);
  let remaining = readPath(statusObject, runtime.remaining_path);
  if (remaining == null) remaining = readExternalState(states, runtime.remaining_entity);
  remaining = Number(remaining);
  if (Number.isFinite(remaining) && runtime.remaining_unit === "minutes") remaining *= 60;
  remaining = Number.isFinite(remaining) ? Math.max(0, Math.ceil(remaining)) : null;
  let total = Number(readPath(statusObject, runtime.total_path));
  if (Number.isFinite(total) && runtime.remaining_unit === "minutes") total *= 60;
  total = Number.isFinite(total) && total > 0 ? Math.ceil(total) : null;
  const progress = remaining != null && total != null ? Math.max(0, Math.min(100, Math.round(((total - remaining) / total) * 100))) : null;
  const rawQueue = readPath(statusObject, runtime.queue_path);
  const queue = Array.isArray(rawQueue) ? rawQueue.map((item) => {
    if (item && typeof item === "object") return mapZoneName(config, item.zone_number ?? item.zone ?? item.id, item.zone_name ?? item.name);
    return mapZoneName(config, item, null);
  }).filter(Boolean) : [];
  return {
    known: true,
    active: true,
    pending: false,
    state: paused ? "paused" : "running",
    paused,
    zone_name: mapZoneName(config, zoneValue, zoneNameValue),
    remaining_seconds: remaining,
    total_seconds: total,
    progress_percent: progress,
    queued_zones: queue,
    label: paused ? "Watering paused" : "Watering active",
  };
}

export function controlPresentation(config, runtime, action) {
  if (!runtime.known || runtime.pending || !runtime.active) return { enabled: false, action, label: action === "stop" ? "Stop" : "Pause" };
  if (action === "pause_resume") {
    if (runtime.paused) return { enabled: Boolean(config.services.resume), action: "resume", label: "Resume", icon: "mdi:play-circle" };
    return { enabled: Boolean(config.services.pause), action: "pause", label: "Pause", icon: "mdi:pause-circle" };
  }
  if (action === "stop") return { enabled: Boolean(config.services.stop), action: "stop", label: "Stop", icon: "mdi:stop-circle" };
  throw new Error("Unknown control presentation action.");
}

export function formatCountdown(seconds) {
  if (seconds == null || seconds === "") return null;
  if (!Number.isFinite(Number(seconds))) return null;
  const normalized = Math.max(0, Math.ceil(Number(seconds)));
  return `${Math.floor(normalized / 60)}:${String(normalized % 60).padStart(2, "0")}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]);
}

export class SprinklerSequenceCard extends HTMLElement {
  static getConfigElement() {
    return document.createElement(EDITOR_TAG);
  }

  static getStubConfig() {
    return {
      type: `custom:${CARD_TAG}`,
      preset: "wyzeapi",
      mode: "sequence",
      target: { device_id: "replace_with_controller_device_id" },
      runtime: { status_entity: "sensor.replace_with_watering_status" },
      zones: [{ id: "zone-1", name: "Zone 1", value: 1 }],
    };
  }

  setConfig(input) {
    this._config = resolveConfig(input);
    this._selected = new Set();
    this._operation = null;
    this._runtime = { known: false, active: false, pending: false, state: "unknown" };
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._config) {
      this._runtime = deriveRuntime(hass?.states, this._config);
      this._sync();
    }
  }

  getCardSize() {
    return 5;
  }

  getGridOptions() {
    return { rows: 5, columns: 12, min_rows: 4, min_columns: 6 };
  }

  _render() {
    const config = this._config;
    const inputUnit = config.duration_unit === "seconds" ? "seconds" : "minutes";
    this.shadowRoot.innerHTML = `
      <style>
        :host{display:block;min-width:0;max-width:100%}ha-card{overflow:hidden;min-width:0;max-width:100%}.body{display:grid;gap:15px;padding:18px}.title{font-size:20px;font-weight:600}.runtime{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:11px;padding:13px;border:1px solid var(--divider-color);border-radius:13px;background:color-mix(in srgb,var(--primary-text-color) 4%,var(--card-background-color))}.runtime.unknown{border-color:var(--warning-color,#ffa726)}.runtime.running{border-color:var(--primary-color);background:color-mix(in srgb,var(--primary-color) 13%,var(--card-background-color))}.runtime.paused{border-color:#ffb300;background:color-mix(in srgb,#ffb300 12%,var(--card-background-color))}.runtime ha-icon{--mdc-icon-size:25px}.runtime-copy{min-width:0}.runtime-title{font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.runtime-detail{margin-top:2px;color:var(--secondary-text-color);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.timer{font-size:18px;font-weight:700;font-variant-numeric:tabular-nums}.progress{grid-column:2/4;height:5px;border-radius:10px;background:rgba(128,128,128,.22);overflow:hidden}.progress-fill{height:100%;width:0;background:var(--primary-color)}.field{display:grid;gap:6px;color:var(--secondary-text-color);font-size:13px}.duration{box-sizing:border-box;width:100%;min-height:44px;border:1px solid var(--divider-color);border-radius:10px;padding:9px 12px;background:var(--card-background-color);color:var(--primary-text-color);font:inherit;font-size:16px}.hint{font-size:12px;color:var(--secondary-text-color)}.zones{display:grid;grid-template-columns:repeat(auto-fit,minmax(105px,1fr));gap:9px}.zone{display:flex;align-items:center;justify-content:center;gap:8px;min-height:44px;border:1px solid var(--divider-color);border-radius:10px;padding:5px 8px;cursor:pointer}.zone.selected{border-color:var(--primary-color);background:color-mix(in srgb,var(--primary-color) 14%,transparent)}.zone input{width:19px;height:19px;margin:0;accent-color:var(--primary-color)}button{font:inherit;cursor:pointer}.start{min-height:48px;border:0;border-radius:12px;background:var(--primary-color);color:var(--text-primary-color,#fff);font-size:16px;font-weight:650}.controls{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.control{display:flex;align-items:center;justify-content:center;gap:7px;min-height:44px;border:1px solid var(--divider-color);border-radius:10px;background:var(--card-background-color);color:var(--primary-text-color);font-weight:600}.control.stop{color:var(--error-color)}button:disabled{opacity:.48;cursor:not-allowed}.status{min-height:18px;color:var(--secondary-text-color);font-size:13px;line-height:1.4}.status.error{color:var(--error-color)}@media(max-width:420px){.body{padding:14px 12px;gap:12px}.runtime{padding:11px}.zones{grid-template-columns:repeat(2,minmax(0,1fr))}}
      </style>
      <ha-card>
        <div class="body">
          <div class="title">${escapeHtml(config.title)}</div>
          ${config.show_runtime ? `<div class="runtime unknown" role="status" aria-live="polite"><ha-icon icon="mdi:help-circle"></ha-icon><div class="runtime-copy"><div class="runtime-title">Controller status unknown</div><div class="runtime-detail">Start and run controls are disabled</div></div><div class="timer">—</div><div class="progress"><div class="progress-fill"></div></div></div>` : ""}
          <label class="field">Duration (${inputUnit})<input class="duration" type="number" min="0" step="any" inputmode="decimal" value="${escapeHtml(config.default_duration)}"></label>
          <div class="hint">The backend owns all sequencing, timers, transitions, and stopping.</div>
          <div class="zones" role="group" aria-label="Sprinkler zones">${config.zones.map((zone) => `<label class="zone"><input type="${config.mode === "single_zone" ? "radio" : "checkbox"}" name="sprinkler-zone" data-zone-id="${escapeHtml(zone.id)}"><span>${escapeHtml(zone.name)}</span></label>`).join("")}</div>
          <button class="start" type="button" disabled>Start</button>
          ${config.show_controls ? `<div class="controls"><button class="control pause-resume" type="button" disabled><ha-icon icon="mdi:pause-circle"></ha-icon><span>Pause</span></button><button class="control stop" type="button" disabled><ha-icon icon="mdi:stop-circle"></ha-icon><span>Stop</span></button></div>` : ""}
          <div class="status" role="status" aria-live="polite">Waiting for a known idle controller state.</div>
        </div>
      </ha-card>`;
    for (const input of this.shadowRoot.querySelectorAll("[data-zone-id]")) input.addEventListener("change", () => this._selectionChanged());
    const duration = this.shadowRoot.querySelector("input.duration");
    duration.addEventListener("input", () => { duration.value = normalizeDurationInput(duration.value); this._sync(); });
    this.shadowRoot.querySelector("button.start").addEventListener("click", () => this._start());
    this.shadowRoot.querySelector("button.pause-resume")?.addEventListener("click", () => this._control("pause_resume"));
    this.shadowRoot.querySelector("button.stop")?.addEventListener("click", () => this._control("stop"));
  }

  _selectionChanged() {
    const checked = [...this.shadowRoot.querySelectorAll("[data-zone-id]:checked")].map((item) => item.dataset.zoneId);
    this._selected = new Set(checked);
    for (const label of this.shadowRoot.querySelectorAll("label.zone")) label.classList.toggle("selected", label.querySelector("input").checked);
    this._setStatus(this._selected.size ? "Ready when the controller is idle." : "Select a zone.");
    this._sync();
  }

  _sync() {
    if (!this.shadowRoot || !this._config) return;
    this._syncRuntime();
    const start = this.shadowRoot.querySelector("button.start");
    const validSelection = this._config.mode === "single_zone" ? this._selected.size === 1 : this._selected.size > 0;
    start.disabled = Boolean(this._operation) || !validSelection || !this._runtime.known || this._runtime.state !== "idle";
    start.textContent = this._operation === "start" ? "Submitting…" : "Start";
    if (this._config.show_controls) {
      const pause = controlPresentation(this._config, this._runtime, "pause_resume");
      const stop = controlPresentation(this._config, this._runtime, "stop");
      const pauseButton = this.shadowRoot.querySelector("button.pause-resume");
      pauseButton.disabled = Boolean(this._operation) || !pause.enabled;
      pauseButton.querySelector("ha-icon").setAttribute("icon", pause.icon || "mdi:pause-circle");
      pauseButton.querySelector("span").textContent = this._operation === pause.action ? "Submitting…" : pause.label;
      const stopButton = this.shadowRoot.querySelector("button.stop");
      stopButton.disabled = Boolean(this._operation) || !stop.enabled;
      stopButton.querySelector("span").textContent = this._operation === "stop" ? "Submitting…" : "Stop";
    }
  }

  _syncRuntime() {
    const panel = this.shadowRoot.querySelector(".runtime");
    if (!panel) return;
    const runtime = this._runtime;
    panel.className = `runtime ${runtime.known ? runtime.state : "unknown"}`;
    const icon = runtime.state === "running" ? "mdi:sprinkler-variant" : runtime.state === "paused" ? "mdi:pause-circle" : runtime.state === "idle" ? "mdi:sprinkler-off" : runtime.pending ? "mdi:progress-clock" : "mdi:help-circle";
    panel.querySelector("ha-icon").setAttribute("icon", icon);
    panel.querySelector(".runtime-title").textContent = runtime.active ? `${runtime.zone_name} ${runtime.paused ? "paused" : "watering"}` : runtime.label;
    panel.querySelector(".runtime-detail").textContent = runtime.queued_zones?.length ? `Next: ${runtime.queued_zones.join(", ")}` : runtime.known ? "Controller-reported state" : "Start and run controls are disabled";
    panel.querySelector(".timer").textContent = formatCountdown(runtime.remaining_seconds) || (runtime.state === "idle" ? "Idle" : runtime.paused ? "Paused" : runtime.pending ? "Pending" : "—");
    panel.querySelector(".progress-fill").style.width = runtime.progress_percent == null ? "0%" : `${runtime.progress_percent}%`;
  }

  async _start() {
    if (this._operation || !this._hass || !this._runtime.known || this._runtime.state !== "idle") return;
    try {
      const durationInput = this.shadowRoot.querySelector("input.duration");
      const seconds = parseDuration(durationInput.value, this._config.duration_unit, this._config.limits);
      const plan = buildPlan(this._config, this._selected, seconds);
      const call = buildStartCall(this._config, plan);
      this._operation = "start";
      this._sync();
      this._setStatus(`Submitting one backend-owned ${this._config.mode === "sequence" ? "sequence" : "zone"} request…`);
      await invokeService(this._hass, call);
      this._setStatus("Start request submitted once. Waiting for controller state.");
    } catch (error) {
      this._setStatus(error?.message || String(error), true);
    } finally {
      this._operation = null;
      this._sync();
    }
  }

  async _control(requested) {
    if (this._operation || !this._hass) return;
    const presentation = controlPresentation(this._config, this._runtime, requested);
    if (!presentation.enabled) return;
    try {
      this._operation = presentation.action;
      this._sync();
      this._setStatus(`Submitting ${presentation.label.toLowerCase()} request…`);
      await invokeService(this._hass, buildControlCall(this._config, presentation.action));
      this._setStatus(`${presentation.label} request submitted once. Waiting for controller state.`);
    } catch (error) {
      this._setStatus(error?.message || String(error), true);
    } finally {
      this._operation = null;
      this._sync();
    }
  }

  _setStatus(message, isError = false) {
    const status = this.shadowRoot.querySelector(".status");
    status.textContent = message;
    status.classList.toggle("error", isError);
  }
}

export class SprinklerSequenceCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = clone(config || SprinklerSequenceCard.getStubConfig());
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this._render();
  }

  set hass(hass) { this._hass = hass; }

  _render() {
    const config = this._config || {};
    const target = config.target || {};
    const targetKind = Object.keys(target)[0] || "device_id";
    const targetValue = target[targetKind] || "";
    this.shadowRoot.innerHTML = `<style>:host{display:grid;gap:12px;padding:12px}.field{display:grid;gap:5px}.field span{font-size:12px;color:var(--secondary-text-color)}input,select,textarea{box-sizing:border-box;width:100%;padding:9px;border:1px solid var(--divider-color);border-radius:8px;background:var(--card-background-color);color:var(--primary-text-color);font:inherit}textarea{min-height:105px;font-family:monospace}.row{display:grid;grid-template-columns:1fr 2fr;gap:8px}.check{display:flex;align-items:center;gap:8px}</style>
      <label class="field"><span>Title</span><input data-key="title" value="${escapeHtml(config.title || "Sprinkler sequence")}"></label>
      <div class="row"><label class="field"><span>Adapter preset</span><select data-key="preset"><option value="wyzeapi" ${config.preset === "wyzeapi" ? "selected" : ""}>WyzeAPI</option><option value="" ${!config.preset ? "selected" : ""}>Generic</option></select></label><label class="field"><span>Mode</span><select data-key="mode"><option value="sequence" ${config.mode !== "single_zone" ? "selected" : ""}>Sequence</option><option value="single_zone" ${config.mode === "single_zone" ? "selected" : ""}>Single zone</option></select></label></div>
      <div class="row"><label class="field"><span>Target kind</span><select data-key="target_kind"><option value="device_id" ${targetKind === "device_id" ? "selected" : ""}>Device</option><option value="entity_id" ${targetKind === "entity_id" ? "selected" : ""}>Entity</option></select></label><label class="field"><span>Target ID</span><input data-key="target_value" value="${escapeHtml(targetValue)}"></label></div>
      <label class="field"><span>Status entity (required)</span><input data-key="status_entity" value="${escapeHtml(config.runtime?.status_entity || "")}" placeholder="sensor.controller_watering_status"></label>
      <label class="field"><span>Default duration (${escapeHtml(config.duration_unit || "minutes")})</span><input data-key="default_duration" type="number" min="0" step="any" value="${escapeHtml(config.default_duration ?? 5)}"></label>
      <label class="field"><span>Zones (JSON)</span><textarea data-key="zones">${escapeHtml(JSON.stringify(config.zones || [], null, 2))}</textarea></label>
      <label class="check"><input data-key="show_controls" type="checkbox" ${config.show_controls !== false ? "checked" : ""}> Show pause/resume/stop controls when configured</label>`;
    for (const element of this.shadowRoot.querySelectorAll("input,select,textarea")) element.addEventListener("change", () => this._changed());
  }

  _changed() {
    const get = (key) => this.shadowRoot.querySelector(`[data-key="${key}"]`);
    const next = clone(this._config || {});
    next.type = `custom:${CARD_TAG}`;
    next.title = get("title").value;
    next.preset = get("preset").value || undefined;
    next.mode = get("mode").value;
    next.target = { [get("target_kind").value]: get("target_value").value.trim() };
    next.runtime = { ...(next.runtime || {}), status_entity: get("status_entity").value.trim() };
    next.default_duration = Number(get("default_duration").value);
    next.show_controls = get("show_controls").checked;
    try { next.zones = JSON.parse(get("zones").value); } catch { return; }
    this._config = next;
    this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: next }, bubbles: true, composed: true }));
  }
}

if (!customElements.get(CARD_TAG)) customElements.define(CARD_TAG, SprinklerSequenceCard);
if (!customElements.get(EDITOR_TAG)) customElements.define(EDITOR_TAG, SprinklerSequenceCardEditor);
window.customCards = window.customCards || [];
if (!window.customCards.some((card) => card.type === CARD_TAG)) window.customCards.push({
  type: CARD_TAG,
  name: "Sprinkler Sequence Card",
  description: "Provider-neutral sprinkler runs with backend-owned sequencing and fail-closed controls.",
  preview: true,
  documentationURL: "https://github.com/shogun301/sprinkler-sequence-card",
});
console.info(`%c SPRINKLER-SEQUENCE-CARD %c v${VERSION} `, "color:white;background:#2e7d32;font-weight:700", "color:#2e7d32;background:white;font-weight:700");
