# ioBroker.zentra – Adapter Concept

## Naming

- Adapter name (technical): `zentra`. ioBroker requires lowercase adapter names. This name is used for the package `iobroker.zentra`, the repository `ioBroker.zentra` and the instance IDs `zentra.0`.
- Display title (`common.titleLang`): **ZENTRA**
- Icon (`admin/zentra.png`, 512×512 px): the official METER Group logo mark, scaled down from `Docs/assets/meter-logo-1024.png`. That source file is not shipped in the package.

## Goal

An ioBroker adapter that pulls measurement data from devices in a ZENTRA Cloud 2.0 account (METER Group, <https://zentracloud.io>) into ioBroker states. It uses the ZENTRA Cloud API v5 (see [ZentraCloud-API-v5.md](ZentraCloud-API-v5.md)).

## Requirements

1. The adapter pulls data from the devices available in the account.
2. Users set the polling interval and the device selection in the adapter settings.
3. Users store the API access token in the adapter settings.
4. Users load the account's devices with the token and can select them.
   - Note: API v5 needs no username. The token alone identifies the user.

## Adapter Settings (Admin UI, jsonConfig)

| Setting | Type | Default | Notes |
|---|---|---|---|
| `apiKey` | password | – | Stored encrypted (`encryptedNative` / `protectedNative`) |
| `pollInterval` | number (minutes) | 15 | Minimum 5; data is uploaded by the loggers every 15–60 min anyway |
| `units` | select | `metric` | `metric` / `imperial` |
| `devices` | multi-select | [] | Filled from the account via button "Load devices" |

Device selection flow:

1. The user enters the API key.
2. The user clicks **Load devices**.
3. The admin UI sends a `sendTo` message (`getDevices`) to the running adapter instance.
4. The adapter calls `GET /devices`, iterating over all pages.
5. The adapter returns a list of `{ value: device_id, label: "name (device_id, model)" }`.
6. The admin UI shows these entries in a multi-select (`selectSendTo` with `multiple: true`).

Only devices with `can_read_data = true` are offered.

## Polling Logic

For each selected device, the adapter runs these steps sequentially, never in parallel:

1. **Initial run:** this applies when no reading ID is stored, or when the last successful poll is older than 3 days.
   - The adapter requests `GET /devices/{id}/data?window=24h&direction=descending` and takes the newest value of each series.
   - Older data is **not** backfilled. This was decided on 2026-11-16.
   - The cursor is set to `metadata.reading_id_max_available`.
2. **Subsequent runs:** the adapter requests `GET /devices/{id}/data?since_reading_id=<last>`.
   - It follows `next_reading_id`, at most 4 pages per cycle because the API burst is 5.
   - Remaining pages are fetched in the next cycle.
3. The adapter writes only the **newest value of each series** to its state, with `ts` set to the measurement timestamp.
   - A late-arriving older reading never overwrites a newer value.
   - History adapters (history, InfluxDB, SQL) record the values from the states.
4. **Computed values** such as Hourly/Daily Reference ET of ATMOS 41 have `reading_id = null`. Cursor requests do not deliver them, so the adapter fetches them separately:
   - **Detection:** the initial (24 h window) fetch detects whether a device delivers computed values. The result is stored with the device's UTC offset in the device object as `native.meta`.
   - **Hourly value:** each cycle, a time-range request covers `[previous local hour, current hour + 60 s]`. It returns the current hourly value and the completed previous one, about 280 values.
   - **Daily running total:** each cycle, a request covers `[local 00:00, 00:01]`, about 25 values. The daily row always has the timestamp 00:00 and grows during the day.
   - **Previous-day total:** a request covers `[00:00 of the previous day, +60 s]`. It is written to `<Measurement>_previous_day`, e.g. `Daily_Reference_ET_previous_day`.
     - The adapter fetches it once per day.
     - During the first 6 h after local midnight it refreshes it, so late uploads are included.
   - "Daily" series are recognized by the word "Daily" in the measurement name.
   - These steps add 2–3 requests per cycle for weather stations. With the per-device rate limit (burst 5, 1/min), a 5-minute interval works.
   - Verified on 2026-11-16: the Daily Reference ET equals the sum of the Hourly Reference ET values of that day (0.373 mm on 2026-11-15, 0.449 mm on 2026-11-16).
5. The adapter persists the highest `reading_id` to the `info.lastReadingId` state so a restart continues where it stopped.
   - This state is written on every successful poll, so its timestamp marks the last successful poll.
   - A device without any data gets `null`. It then stays in initial mode instead of reading the whole history from ID 0.

Rate-limit handling:

- On a 429 response, the adapter waits the number of seconds in `Retry-After` (at most 90 s) and retries once. Otherwise the device is skipped for this cycle.
- The polling interval is at least 5 minutes.
- The device list for the admin UI is cached for 60 s.

Error handling:

- `info.connection` is false when every device in a cycle fails, e.g. because of network errors or a 403/404.
- A 401 (invalid API key) is logged as an error and stops polling. Saving the settings restarts the instance.

## Object Tree

```
zentra.0
├── info.connection                         (boolean)
└── <device_id>                             (device, name from ZENTRA Cloud)
    ├── info
    │   ├── model                           (string)
    │   ├── lastReadingId                   (number, polling cursor)
    │   ├── lastMeasurement                 (timestamp of newest measurement)
    │   └── sensorErrors                    (JSON array of active sensor faults)
    ├── logger                              (channel: logger-level values, e.g. battery, signal)
    │   └── <Measurement>
    └── port<N>                             (channel, name "Port N: <sensor>")
        ├── <Measurement>                   (number, unit from API)
        └── <Measurement>_<position><unit>  (position-specific values, e.g. Water_Content_-15cm)
```

- Channels are named by port only, not by sensor, so replacing a sensor does not create new IDs.
- IDs are sanitized: spaces, dots and forbidden characters become `_`.
- The original measurement name is kept as `common.name`. Port, sensor, measurement and position are stored in `native`.
- A value with `error_code != 0` is written with quality `q = 0x44` ("device reports error"). There are no separate error states.
- The API returned positive positions for the depths of TEROS 11/12 sensors on an EM60G logger, e.g. `15`, although the docs describe negative values as below ground. IDs use the value as delivered.
- Position IDs contain the unit (`cm` or `in`). Switching the unit system therefore creates new states.
- The adapter creates objects on demand when a new series first appears.
- Objects of deselected devices are **not** deleted automatically, so their history is kept.
- The adapter assigns roles from the measurement name, e.g. `value.temperature` or `value.humidity`; everything else gets `value`.

## Source Layout

| File | Purpose |
|---|---|
| `src/main.ts` | Adapter: startup, polling loop, object/state handling, admin `getDevices` message |
| `src/lib/zentraApi.ts` | API v5 client (`fetch`, `X-API-Key`, error and 429 handling) |
| `src/lib/series.ts` | ID sanitizing, series identification, newest-value reduction, role mapping |
| `admin/jsonConfig.json` | Settings UI: API key, interval, units, device multi-select (`selectSendTo`) |

## Technology

- TypeScript, scaffolded with `@iobroker/create-adapter` v3.1.5.
- Node.js ≥ 22, js-controller ≥ 6.0.11, admin ≥ 7.0.23.
- HTTP client: built-in `fetch`, so no extra dependency is needed.
- Tests: mocha/chai unit tests (`npm run test:ts`) and the `@iobroker/testing` package tests.

## Open Points

- Whether to support the MQTT Push API later as an alternative to polling.
- Whether to evaluate the error-code descriptions (`error_codes` map) as text states.
- The author e-mail and GitHub account in `package.json` and `io-package.json` are still placeholders.

## Test Results (2026-11-16)

The adapter was tested against the live API with a test account of 11 devices. It ran in a local dev-server with js-controller 7.2.5 and admin 8.3.13.

| Device | Result |
|---|---|
| EM60G with TEROS 11/12 (06-01215) | 35 states, multi-depth IDs such as `port3.Water_Content_15cm` |
| ATMOS 41W (A4101104) | 23 states, roles for temperature, wind, pressure, radiation, battery |
| ZL6 without any data (z6-15844) | No states, cursor stays `null` |
| ZL6 without data in the last 24 h (z6-02375) | Cursor set to `reading_id_max_available` |

What was verified:

- **Incremental polling:** the second run uses `since_reading_id` and returns 0 new values while there is no new reading.
- **Computed ATMOS 41W values:** Hourly_Reference_ET, Daily_Reference_ET and Daily_Reference_ET_previous_day are written correctly.
- **Rate limit:** many test runs in a short time triggered HTTP 429. The adapter waited for `Retry-After` and continued.
- **Device list for the admin UI:** the `getDevices` message returns all 11 devices. An invalid key returns a readable 401 error entry.
