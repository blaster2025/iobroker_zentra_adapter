"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var utils = __toESM(require("@iobroker/adapter-core"));
var import_series = require("./lib/series");
var import_zentraApi = require("./lib/zentraApi");
const MIN_POLL_INTERVAL_MIN = 5;
const MAX_PAGES_PER_POLL = 4;
const RESYNC_AFTER_MS = 3 * 24 * 60 * 60 * 1e3;
const MAX_RETRY_WAIT_S = 90;
const DEVICE_LIST_CACHE_MS = 6e4;
const Q_DEVICE_ERROR = 68;
const PREVIOUS_DAY_REFRESH_S = 6 * 3600;
class Zentra extends utils.Adapter {
  api;
  pollTimer;
  stopped = false;
  /** Object IDs already created/updated in this run */
  knownObjects = /* @__PURE__ */ new Set();
  /** Timestamp (ms) of the value last written per state ID */
  lastValueTs = /* @__PURE__ */ new Map();
  /** Device metadata from the device list (by device_id) */
  deviceInfo = /* @__PURE__ */ new Map();
  /** Per-device metadata (by sanitized device ID), persisted in the device object's native.meta */
  deviceMeta = /* @__PURE__ */ new Map();
  deviceListCache;
  constructor(options = {}) {
    super({
      ...options,
      name: "zentra"
    });
    this.on("ready", this.onReady.bind(this));
    this.on("message", this.onMessage.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }
  get units() {
    return this.config.units === "imperial" ? "imperial" : "metric";
  }
  /**
   * Is called when databases are connected and adapter received configuration.
   */
  async onReady() {
    var _a;
    await this.setState("info.connection", false, true);
    const apiKey = ((_a = this.config.apiKey) != null ? _a : "").trim();
    if (!apiKey) {
      this.log.warn("No API key configured. Please enter the ZENTRA Cloud API key in the adapter settings.");
      return;
    }
    this.api = new import_zentraApi.ZentraApi(apiKey);
    const devices = this.selectedDevices();
    if (devices.length === 0) {
      this.log.warn("No devices selected. Please select devices in the adapter settings.");
      return;
    }
    try {
      const list = await this.api.listDevices();
      this.deviceInfo = new Map(list.map((d) => [d.device_id, d]));
      for (const id of devices) {
        const info = this.deviceInfo.get(id);
        if (!info) {
          this.log.warn(`Device ${id} is not accessible with this API key.`);
        } else if (!info.can_read_data) {
          this.log.warn(`Device ${id} does not allow reading data with this API key.`);
        }
      }
      await this.setState("info.connection", true, true);
    } catch (e) {
      if (e instanceof import_zentraApi.ZentraApiError && e.status === 401) {
        this.log.error(`ZENTRA Cloud rejected the API key (${e.message}). Polling is disabled.`);
        return;
      }
      this.log.warn(`Could not load device list: ${e.message}`);
    }
    const intervalMin = Math.max(MIN_POLL_INTERVAL_MIN, Number(this.config.pollInterval) || 15);
    this.log.info(`Polling ${devices.length} device(s) every ${intervalMin} min.`);
    await this.pollLoop(intervalMin * 6e4);
  }
  selectedDevices() {
    const raw = this.config.devices;
    const list = Array.isArray(raw) ? raw : typeof raw === "string" && raw ? [raw] : [];
    return [...new Set(list.map((d) => String(d).trim()).filter((d) => d))];
  }
  async pollLoop(intervalMs) {
    if (this.stopped) {
      return;
    }
    await this.pollAll();
    if (!this.stopped) {
      this.pollTimer = this.setTimeout(() => void this.pollLoop(intervalMs), intervalMs);
    }
  }
  /** Polls all selected devices sequentially. */
  async pollAll() {
    let anySuccess = false;
    let anyFailure = false;
    for (const deviceId of this.selectedDevices()) {
      if (this.stopped) {
        return;
      }
      try {
        await this.pollDevice(deviceId);
        anySuccess = true;
      } catch (e) {
        anyFailure = true;
        if (e instanceof import_zentraApi.ZentraApiError && e.status === 401) {
          this.log.error(`ZENTRA Cloud rejected the API key (${e.message}). Polling is stopped.`);
          this.stopped = true;
          await this.setState("info.connection", false, true);
          return;
        }
        this.log.warn(`Polling device ${deviceId} failed: ${e.message}`);
      }
    }
    if (anySuccess || !anyFailure) {
      await this.setState("info.connection", true, true);
    } else {
      await this.setState("info.connection", false, true);
    }
  }
  /**
   * Fetches new data of one device and writes the newest value of each series.
   *
   * @param deviceId Device serial number
   */
  async pollDevice(deviceId) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i;
    const devId = (0, import_series.sanitizeId)(deviceId);
    await this.ensureDeviceObjects(deviceId, devId);
    const lastState = await this.getStateAsync(`${devId}.info.lastReadingId`);
    const lastId = typeof (lastState == null ? void 0 : lastState.val) === "number" ? lastState.val : void 0;
    const stale = !lastState || Date.now() - lastState.ts > RESYNC_AFTER_MS;
    const values = [];
    let first;
    let newLastId;
    const meta = (_a = this.deviceMeta.get(devId)) != null ? _a : { checked: false, hasComputed: false };
    const initial = lastId === void 0 || stale || !meta.checked;
    if (initial) {
      this.log.debug(`${deviceId}: fetching newest values (window 24h)`);
      first = await this.call(
        () => this.api.getDeviceData(deviceId, { window: "24h", direction: "descending", units: this.units })
      );
      values.push(...first.values);
      let next = first.pagination.next_url;
      let pages = 1;
      while (next && pages < MAX_PAGES_PER_POLL && !this.stopped) {
        const url = next;
        const page = await this.call(() => this.api.getByUrl(url));
        values.push(...page.values);
        next = page.pagination.next_url;
        pages++;
      }
      newLastId = Math.max((_b = (0, import_series.maxReadingId)(values)) != null ? _b : 0, (_c = first.metadata.reading_id_max_available) != null ? _c : 0) || void 0;
    } else {
      this.log.debug(`${deviceId}: fetching readings after ID ${lastId}`);
      first = await this.call(
        () => this.api.getDeviceData(deviceId, { sinceReadingId: lastId, units: this.units })
      );
      values.push(...first.values);
      let nextId = first.pagination.next_reading_id;
      let pages = 1;
      while (nextId !== null && pages < MAX_PAGES_PER_POLL && !this.stopped) {
        const cursor = nextId;
        const page = await this.call(
          () => this.api.getDeviceData(deviceId, { sinceReadingId: cursor, units: this.units })
        );
        values.push(...page.values);
        nextId = page.pagination.next_reading_id;
        pages++;
      }
      newLastId = Math.max(lastId, (_d = (0, import_series.maxReadingId)(values)) != null ? _d : lastId);
    }
    const raw = values.filter((v) => v.reading_id !== null);
    const latest = (0, import_series.latestPerSeries)(raw);
    for (const v of latest) {
      await this.writeValue(devId, v);
    }
    let newestRaw;
    for (const v of latest) {
      if (!newestRaw || v.timestamp > newestRaw.timestamp) {
        newestRaw = v;
      }
    }
    if (newestRaw) {
      await this.setState(`${devId}.info.lastMeasurement`, newestRaw.timestamp * 1e3, true);
    }
    const offset = newestRaw ? (0, import_series.utcOffsetMinutes)(newestRaw.datetime) : void 0;
    const metaChanged = initial && (!meta.checked || meta.hasComputed !== values.some((v) => v.reading_id === null)) || offset !== void 0 && offset !== meta.offsetMin;
    if (initial) {
      meta.checked = true;
      meta.hasComputed = values.some((v) => v.reading_id === null);
    }
    if (offset !== void 0) {
      meta.offsetMin = offset;
    }
    this.deviceMeta.set(devId, meta);
    if (metaChanged) {
      await this.extendObjectAsync(devId, { native: { meta } });
    }
    if (initial) {
      await this.writeComputed(devId, values, (_e = meta.offsetMin) != null ? _e : 0);
    } else if (meta.hasComputed) {
      const lastMeas = (_f = newestRaw == null ? void 0 : newestRaw.timestamp) != null ? _f : await this.lastMeasurementSec(devId);
      if (lastMeas !== void 0) {
        await this.pollComputed(deviceId, devId, lastMeas, (_g = meta.offsetMin) != null ? _g : 0);
      }
    }
    await this.setState(`${devId}.info.sensorErrors`, JSON.stringify((_h = first.sensor_errors) != null ? _h : []), true);
    await this.setState(`${devId}.info.lastReadingId`, (_i = newLastId != null ? newLastId : lastId) != null ? _i : null, true);
    if (first.metadata.device_name) {
      await this.extendObjectAsync(devId, { common: { name: first.metadata.device_name } });
    }
    this.log.debug(`${deviceId}: ${values.length} values received, ${latest.length} states updated`);
  }
  async lastMeasurementSec(devId) {
    const st = await this.getStateAsync(`${devId}.info.lastMeasurement`);
    return typeof (st == null ? void 0 : st.val) === "number" ? Math.floor(st.val / 1e3) : void 0;
  }
  /**
   * Fetches computed values with minimal time-range requests around the newest measurement:
   * the previous and current hour (hourly values) and 00:00 of the current day (daily running total).
   * During the first hours of a day, 00:00 of the previous day is fetched as well (final daily total).
   *
   * @param deviceId Device serial number
   * @param devId Sanitized device ID
   * @param refTs Newest raw measurement (Unix seconds)
   * @param offsetMin UTC offset of the device in minutes
   */
  async pollComputed(deviceId, devId, refTs, offsetMin) {
    const day = (0, import_series.localDayStart)(refTs, offsetMin);
    const hour = (0, import_series.localHourStart)(refTs, offsetMin);
    const ranges = [[Math.max(hour - 3600, day), hour + 60]];
    if (hour - 3600 > day) {
      ranges.push([day, day + 60]);
    }
    const meta = this.deviceMeta.get(devId);
    const prevDay = day - 86400;
    const fetchPrevDay = (meta == null ? void 0 : meta.prevDayFetched) !== prevDay || refTs - day < PREVIOUS_DAY_REFRESH_S;
    if (fetchPrevDay) {
      ranges.push([prevDay, prevDay + 60]);
    }
    const values = [];
    for (const [start, end] of ranges) {
      if (this.stopped) {
        return;
      }
      const res = await this.call(
        () => this.api.getDeviceData(deviceId, { startTimestamp: start, endTimestamp: end, units: this.units })
      );
      values.push(...res.values);
    }
    const written = await this.writeComputed(devId, values, offsetMin);
    this.log.debug(`${deviceId}: ${ranges.length} request(s) for computed values, ${written} states updated`);
    if (fetchPrevDay && meta && meta.prevDayFetched !== prevDay) {
      meta.prevDayFetched = prevDay;
      await this.extendObjectAsync(devId, { native: { meta } });
    }
  }
  /**
   * Writes the newest value of each computed series (reading_id = null).
   * The daily total of the previous day additionally goes to `<id>_previous_day`.
   *
   * @param devId Sanitized device ID
   * @param values Values of one or more responses (raw values are ignored)
   * @param offsetMin UTC offset of the device in minutes
   */
  async writeComputed(devId, values, offsetMin) {
    const computed = values.filter((v) => v.reading_id === null);
    if (computed.length === 0) {
      return 0;
    }
    const latest = (0, import_series.latestPerSeries)(computed);
    for (const v of latest) {
      await this.writeValue(devId, v);
    }
    const daily = computed.filter((v) => (0, import_series.isDailySeries)(v));
    const newestDay = daily.reduce((max, v) => Math.max(max, (0, import_series.localDayStart)(v.timestamp, offsetMin)), 0);
    const prev = daily.filter((v) => (0, import_series.localDayStart)(v.timestamp, offsetMin) === newestDay - 86400);
    const prevLatest = (0, import_series.latestPerSeries)(prev);
    for (const v of prevLatest) {
      await this.writeValue(devId, v, { idSuffix: "_previous_day", nameSuffix: " (previous day)" });
    }
    return latest.length + prevLatest.length;
  }
  /**
   * Runs an API call, waiting once for the rate limit if needed.
   *
   * @param fn The API call
   */
  async call(fn) {
    var _a, _b;
    try {
      return await fn();
    } catch (e) {
      if (e instanceof import_zentraApi.ZentraApiError && e.status === 429 && ((_a = e.retryAfterSeconds) != null ? _a : 0) <= MAX_RETRY_WAIT_S) {
        const wait = (_b = e.retryAfterSeconds) != null ? _b : 60;
        this.log.debug(`Rate limit reached, retrying in ${wait} s`);
        await this.delay(wait * 1e3);
        return fn();
      }
      throw e;
    }
  }
  async ensureDeviceObjects(deviceId, devId) {
    var _a, _b;
    if (this.knownObjects.has(devId)) {
      return;
    }
    const info = this.deviceInfo.get(deviceId);
    const existing = await this.getObjectAsync(devId);
    const storedMeta = (_a = existing == null ? void 0 : existing.native) == null ? void 0 : _a.meta;
    if (storedMeta && typeof storedMeta === "object") {
      this.deviceMeta.set(devId, { ...storedMeta });
    }
    await this.extendObjectAsync(devId, {
      type: "device",
      common: { name: (info == null ? void 0 : info.name) || deviceId },
      native: { device_id: deviceId, model: (_b = info == null ? void 0 : info.model) != null ? _b : null }
    });
    await this.extendObjectAsync(`${devId}.info`, {
      type: "channel",
      common: { name: "Information" },
      native: {}
    });
    const infoStates = {
      model: { name: "Model", type: "string", role: "info.model", read: true, write: false },
      lastReadingId: {
        name: "Last processed reading ID",
        type: "number",
        role: "value",
        read: true,
        write: false
      },
      lastMeasurement: {
        name: "Time of newest measurement",
        type: "number",
        role: "value.time",
        read: true,
        write: false
      },
      sensorErrors: {
        name: "Active sensor errors (JSON)",
        type: "string",
        role: "json",
        read: true,
        write: false
      }
    };
    for (const [id, common] of Object.entries(infoStates)) {
      await this.extendObjectAsync(`${devId}.info.${id}`, { type: "state", common, native: {} });
    }
    if (info == null ? void 0 : info.model) {
      await this.setState(`${devId}.info.model`, info.model, true);
    }
    this.knownObjects.add(devId);
  }
  /**
   * Creates the object for a value on first sight and writes the value.
   *
   * @param devId Sanitized device ID
   * @param v The measurement value
   * @param opts Optional suffixes for ID and name (e.g. for the previous-day total)
   * @param opts.idSuffix Appended to the state ID
   * @param opts.nameSuffix Appended to the state name
   */
  async writeValue(devId, v, opts = {}) {
    var _a, _b, _c, _d;
    const chId = `${devId}.${(0, import_series.channelId)(v)}`;
    const positionUnit = this.units === "imperial" ? "in" : "cm";
    const id = `${chId}.${(0, import_series.stateId)(v, positionUnit)}${(_a = opts.idSuffix) != null ? _a : ""}`;
    if (!this.knownObjects.has(chId)) {
      await this.extendObjectAsync(chId, {
        type: "channel",
        common: { name: v.port_num === null ? "Logger" : `Port ${v.port_num}: ${v.sensor_name}` },
        native: { port_num: v.port_num, sensor_name: v.sensor_name }
      });
      this.knownObjects.add(chId);
    }
    if (!this.knownObjects.has(id)) {
      const name = (v.position === null ? v.measurement : `${v.measurement} (${v.position} ${positionUnit})`) + ((_b = opts.nameSuffix) != null ? _b : "");
      await this.extendObjectAsync(id, {
        type: "state",
        common: {
          name,
          type: "number",
          role: (0, import_series.roleFor)(v.measurement),
          unit: v.unit || void 0,
          read: true,
          write: false
        },
        native: {
          port_num: v.port_num,
          sensor_name: v.sensor_name,
          measurement: v.measurement,
          position: v.position
        }
      });
      this.knownObjects.add(id);
    }
    const ts = v.timestamp * 1e3;
    let lastTs = this.lastValueTs.get(id);
    if (lastTs === void 0) {
      lastTs = (_d = (_c = await this.getStateAsync(id)) == null ? void 0 : _c.ts) != null ? _d : 0;
    }
    if (ts < lastTs) {
      return;
    }
    this.lastValueTs.set(id, ts);
    await this.setState(id, {
      val: v.value,
      ack: true,
      ts,
      q: v.error_code === 0 ? 0 : Q_DEVICE_ERROR
    });
  }
  /**
   * Handles messages from the admin UI.
   * `getDevices` returns the account's devices for the device selection.
   *
   * @param obj The message
   */
  async onMessage(obj) {
    if (typeof obj !== "object" || obj.command !== "getDevices") {
      return;
    }
    const msg = typeof obj.message === "object" && obj.message || {};
    const apiKey = String(msg.apiKey || this.config.apiKey || "").trim();
    let response;
    if (!apiKey) {
      response = [{ value: "", label: "Please enter the API key first" }];
    } else {
      try {
        const devices = await this.getDeviceList(apiKey);
        response = devices.filter((d) => d.can_read_data).map((d) => {
          var _a;
          const details = [d.name && d.name !== d.device_id ? d.device_id : "", (_a = d.model) != null ? _a : ""].filter((x) => x).join(", ");
          const name = d.name || d.device_id;
          return { value: d.device_id, label: details ? `${name} (${details})` : name };
        });
        if (response.length === 0) {
          response = [{ value: "", label: "No readable devices found for this API key" }];
        }
      } catch (e) {
        response = [{ value: "", label: `Error: ${e.message}` }];
      }
    }
    if (obj.callback) {
      this.sendTo(obj.from, obj.command, response, obj.callback);
    }
  }
  async getDeviceList(apiKey) {
    const c = this.deviceListCache;
    if (c && c.apiKey === apiKey && Date.now() - c.time < DEVICE_LIST_CACHE_MS) {
      return c.devices;
    }
    const devices = await new import_zentraApi.ZentraApi(apiKey).listDevices();
    this.deviceListCache = { apiKey, time: Date.now(), devices };
    return devices;
  }
  /**
   * Is called when adapter shuts down - callback has to be called under any circumstances!
   *
   * @param callback - Callback function
   */
  onUnload(callback) {
    try {
      this.stopped = true;
      if (this.pollTimer) {
        this.clearTimeout(this.pollTimer);
        this.pollTimer = void 0;
      }
      callback();
    } catch (error) {
      this.log.error(`Error during unloading: ${error.message}`);
      callback();
    }
  }
}
if (require.main !== module) {
  module.exports = (options) => new Zentra(options);
} else {
  (() => new Zentra())();
}
//# sourceMappingURL=main.js.map
