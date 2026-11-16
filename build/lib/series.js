"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var series_exports = {};
__export(series_exports, {
  channelId: () => channelId,
  isDailySeries: () => isDailySeries,
  latestPerSeries: () => latestPerSeries,
  localDayStart: () => localDayStart,
  localHourStart: () => localHourStart,
  maxReadingId: () => maxReadingId,
  roleFor: () => roleFor,
  sanitizeId: () => sanitizeId,
  seriesKey: () => seriesKey,
  stateId: () => stateId,
  utcOffsetMinutes: () => utcOffsetMinutes
});
module.exports = __toCommonJS(series_exports);
const FORBIDDEN_CHARS = /[^._\-/ :!#$%&()+=@^{}|~\p{Ll}\p{Lu}\p{Nd}]+/gu;
function sanitizeId(name) {
  return name.trim().replace(FORBIDDEN_CHARS, "_").replace(/[.\s]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "") || "unknown";
}
function channelId(v) {
  return v.port_num === null ? "logger" : `port${v.port_num}`;
}
function stateId(v, positionUnit) {
  const base = sanitizeId(v.measurement);
  if (v.position === null || v.position === void 0) {
    return base;
  }
  return `${base}_${String(v.position).replace(".", "_")}${positionUnit}`;
}
function seriesKey(v) {
  var _a, _b;
  return `${(_a = v.port_num) != null ? _a : "L"}|${v.measurement}|${v.sensor_name}|${(_b = v.position) != null ? _b : ""}`;
}
function latestPerSeries(values) {
  var _a, _b;
  const latest = /* @__PURE__ */ new Map();
  for (const v of values) {
    const key = seriesKey(v);
    const prev = latest.get(key);
    if (!prev || v.timestamp > prev.timestamp || v.timestamp === prev.timestamp && ((_a = v.reading_id) != null ? _a : 0) >= ((_b = prev.reading_id) != null ? _b : 0)) {
      latest.set(key, v);
    }
  }
  return [...latest.values()];
}
function maxReadingId(values) {
  let max;
  for (const v of values) {
    if (v.reading_id !== null && (max === void 0 || v.reading_id > max)) {
      max = v.reading_id;
    }
  }
  return max;
}
const ROLE_MAP = [
  [/dew point/i, "value.temperature.dewpoint"],
  [/temperature|\btemp\b/i, "value.temperature"],
  [/relative humidity/i, "value.humidity"],
  [/precipitation|rain/i, "value.precipitation"],
  [/wind speed|gust/i, "value.speed.wind"],
  [/wind direction/i, "value.direction.wind"],
  [/pressure/i, "value.pressure"],
  [/solar radiation/i, "value.radiation"],
  [/battery percent/i, "value.battery"],
  [/battery/i, "value.voltage"]
];
function roleFor(measurement) {
  for (const [re, role] of ROLE_MAP) {
    if (re.test(measurement)) {
      return role;
    }
  }
  return "value";
}
function utcOffsetMinutes(datetime) {
  if (/Z$/i.test(datetime)) {
    return 0;
  }
  const m = /([+-])(\d{2}):?(\d{2})$/.exec(datetime);
  if (!m) {
    return void 0;
  }
  const minutes = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === "-" ? -minutes : minutes;
}
function localDayStart(ts, offsetMin) {
  const off = offsetMin * 60;
  return Math.floor((ts + off) / 86400) * 86400 - off;
}
function localHourStart(ts, offsetMin) {
  const off = offsetMin * 60;
  return Math.floor((ts + off) / 3600) * 3600 - off;
}
function isDailySeries(v) {
  return /\bdaily\b/i.test(v.measurement);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  channelId,
  isDailySeries,
  latestPerSeries,
  localDayStart,
  localHourStart,
  maxReadingId,
  roleFor,
  sanitizeId,
  seriesKey,
  stateId,
  utcOffsetMinutes
});
//# sourceMappingURL=series.js.map
