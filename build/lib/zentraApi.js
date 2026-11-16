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
var zentraApi_exports = {};
__export(zentraApi_exports, {
  DEFAULT_BASE_URL: () => DEFAULT_BASE_URL,
  ZentraApi: () => ZentraApi,
  ZentraApiError: () => ZentraApiError
});
module.exports = __toCommonJS(zentraApi_exports);
const DEFAULT_BASE_URL = "https://api.zentracloud.io/v5";
class ZentraApiError extends Error {
  constructor(status, message, retryAfterSeconds) {
    super(message);
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
    this.name = "ZentraApiError";
  }
}
class ZentraApi {
  constructor(apiKey, baseUrl = DEFAULT_BASE_URL, timeoutMs = 6e4) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
  }
  /**
   * Lists all devices accessible with the API key (all pages).
   */
  async listDevices() {
    const devices = [];
    let page = 1;
    let totalPages = 1;
    do {
      const res = await this.request(`${this.baseUrl}/devices?page_num=${page}&limit=1000`);
      devices.push(...res.devices);
      totalPages = res.pagination.total_pages;
      page++;
    } while (page <= totalPages);
    return devices;
  }
  /**
   * Fetches one page of device data.
   *
   * @param deviceId Device serial number, e.g. `z6-00930`
   * @param query Query options
   */
  async getDeviceData(deviceId, query) {
    var _a;
    const params = new URLSearchParams();
    if (query.sinceReadingId !== void 0) {
      params.set("since_reading_id", String(query.sinceReadingId));
    } else if (query.startTimestamp !== void 0 && query.endTimestamp !== void 0) {
      params.set("start_timestamp", String(query.startTimestamp));
      params.set("end_timestamp", String(query.endTimestamp));
    } else if (query.window) {
      params.set("window", query.window);
    }
    if (query.direction) {
      params.set("direction", query.direction);
    }
    params.set("units", (_a = query.units) != null ? _a : "metric");
    return this.request(
      `${this.baseUrl}/devices/${encodeURIComponent(deviceId)}/data?${params.toString()}`
    );
  }
  /**
   * Fetches a page by a `next_url` returned from a previous response.
   *
   * @param url Absolute URL from `pagination.next_url`
   */
  async getByUrl(url) {
    return this.request(url);
  }
  async request(url) {
    var _a;
    const res = await fetch(url, {
      headers: { "X-API-Key": this.apiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    if (!res.ok) {
      let detail = "";
      let retryAfter;
      try {
        const body = await res.json();
        detail = typeof body.detail === "string" ? body.detail : JSON.stringify((_a = body.detail) != null ? _a : body);
        retryAfter = body.retry_after_seconds;
      } catch {
      }
      if (res.status === 429) {
        const header = Number(res.headers.get("Retry-After"));
        retryAfter = Number.isFinite(header) && header > 0 ? header : retryAfter != null ? retryAfter : 60;
      }
      throw new ZentraApiError(res.status, describeStatus(res.status, detail), retryAfter);
    }
    return await res.json();
  }
}
function describeStatus(status, detail) {
  const suffix = detail ? `: ${detail}` : "";
  switch (status) {
    case 401:
      return `HTTP 401 - API key missing or invalid${suffix}`;
    case 403:
      return `HTTP 403 - not authorized${suffix}`;
    case 404:
      return `HTTP 404 - device not found${suffix}`;
    case 422:
      return `HTTP 422 - invalid request parameters${suffix}`;
    case 429:
      return `HTTP 429 - rate limit exceeded${suffix}`;
    default:
      return `HTTP ${status}${suffix}`;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DEFAULT_BASE_URL,
  ZentraApi,
  ZentraApiError
});
//# sourceMappingURL=zentraApi.js.map
