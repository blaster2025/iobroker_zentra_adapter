# ZENTRA Cloud API v5 – Reference Summary

Summary of the parts of the ZENTRA Cloud API v5 that the adapter relies on.
Source: <https://docs.zentracloud.io/l/en/article/zjky832943-api-v5> (retrieved 2026-11-16).

## Base URL and Authentication

- Base URL: `https://api.zentracloud.io/v5`
- Authentication: header `X-API-Key: <API key>`. **No username or login call.** The user is resolved from the key.
- The key is created in the web UI: *Profile → Integrations → Show Token* (<https://app.zentracloud.io/profile/integrations>). "Regenerate" invalidates the old key immediately.
- No expiry is documented.
- Interactive OpenAPI reference: <https://api.zentracloud.io/>

## Endpoints

### `GET /devices` – List Devices

| Parameter | Type | Notes |
|---|---|---|
| `organization_id` | string | optional; returns 403 if the user is not a member |
| `page_num` | int | default 1, must be ≥ 1 |
| `limit` | int | default 50, range 1–1000 |
| `expand` | string | comma-separated: `max_min_timestamp`, `settings`, `ports`, `location`, `hardware`, `connectivity`, `subscription` |
| `units` | string | `metric` (default) or `imperial` |

Response:

- `devices[]` with the fields `device_id` (serial number, opaque string), `name`, `organization_id`, `organization_name`, `device_type` (int), `model` (string or null) and `can_read_data` (bool; when false, data reads return 403).
- `pagination` with `page_num`, `limit`, `num_devices` (count on this page) and `total_pages`.
- Expand groups:
  - `settings`: `logging_interval` and `upload_frequency` (minutes).
  - `ports[]`: `port_num`, `sensor_short_name`, `sensor_serial_number`, `position`, …
  - `location`: lat/lon and elevation.
  - `hardware`: firmware.
  - `connectivity`: cellular or wifi, SIM.
  - `subscription`: subscription status.
  - `max_min_timestamp`: `data_range.first_measurement` and `data_range.last_measurement`.

### `GET /devices/{device_id}/data` – Get Device Data

| Parameter | Notes |
|---|---|
| `start_datetime` / `end_datetime` | ISO 8601, both must carry the same offset |
| `start_timestamp` / `end_timestamp` | Unix seconds |
| `window` | relative, e.g. `24h`, `7d` (max `365d`) |
| `since_reading_id` | cursor (exclusive), ascending; overrides the time-range parameters and `direction` |
| `next_token` | time-range paging token |
| `direction` | `descending` (default) or `ascending` |
| `units` | `metric` or `imperial` |
| `aggregate` | `raw` (default), `hourly` or `daily`; cannot be combined with `since_reading_id` |

- Use only one time-range style per request. Mixing them returns 422.
- Without any time parameter the default is the last 14 days.

Response:

- `metadata`: `device_id`, `device_name`, `location`, `coordinates`, `elevation`, `reading_id_max_available`, `aggregate` and `timezone`.
- `values[]`: one entry per measurement per reading, with these fields:
  - `port_num` (null for logger-level values such as signal)
  - `measurement`, e.g. "Water Content"
  - `unit`
  - `sensor_name`, e.g. "TEROS 12"
  - `position` (depth; negative = below ground)
  - `value`
  - `timestamp` (Unix seconds)
  - `datetime`
  - `error_code` (0 = OK)
  - `reading_id`
- A series is identified by (`port_num`, `measurement`, `sensor_name`, `position`).
- `sensor_errors[]`: slow-moving status faults (codes 100–127, e.g. Sensor Offline).
- `error_codes`: a map from code to description.
- `pagination`: `num_readings`, `next_token`, `next_url` and `next_reading_id`.

Polling pattern recommended by the docs:

1. Store the highest `reading_id` received.
2. Request the next batch with `since_reading_id=<stored>`.
3. A response with no new data is a 200 with an empty `values` array.

## Rate Limits

GCRA with burst 5 and a steady rate of **1 request per minute**:

- `GET /devices`: the limit applies **per user**.
- `GET /devices/{id}/data`: the limit applies **per device**. All clients reading the same device share this budget.

A 429 response carries a `Retry-After` header in seconds and a `retry_after_seconds` field in the body.

## Status Codes

| Code | Meaning |
|---|---|
| 401 | Missing or invalid API key |
| 403 | Not authorized (organization or role) |
| 404 | Device not found for this key |
| 422 | Invalid parameters |
| 429 | Rate limit exceeded |

## Further Reading

- Device & sensor error codes: <https://docs.zentracloud.io/l/en/article/l1uopg3wo7-device-sensor-error-codes>
- MQTT Push API (alternative to polling): <https://docs.zentracloud.io/l/en/article/5n93isp6cm-mqtt-push-api>
