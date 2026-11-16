/*
 * ioBroker adapter for METER Group ZENTRA Cloud (API v5).
 * Created with @iobroker/create-adapter v3.1.5
 *
 * See Docs/Concept.md for the design.
 */

import * as utils from '@iobroker/adapter-core';
import {
	channelId,
	isDailySeries,
	latestPerSeries,
	localDayStart,
	localHourStart,
	maxReadingId,
	roleFor,
	sanitizeId,
	stateId,
	utcOffsetMinutes,
} from './lib/series';
import {
	type DeviceDataResponse,
	type Units,
	type ZentraDevice,
	type ZentraValue,
	ZentraApi,
	ZentraApiError,
} from './lib/zentraApi';

/** Minimum polling interval in minutes (API limit is 1 request/minute per device) */
const MIN_POLL_INTERVAL_MIN = 5;
/** Maximum number of cursor pages fetched per device and poll cycle (API burst is 5) */
const MAX_PAGES_PER_POLL = 4;
/** If the last successful poll is older than this, start over with the newest values only */
const RESYNC_AFTER_MS = 3 * 24 * 60 * 60 * 1000;
/** Maximum time to wait for a rate-limited request before skipping it */
const MAX_RETRY_WAIT_S = 90;
/** How long a device list fetched for the admin UI is cached */
const DEVICE_LIST_CACHE_MS = 60_000;
/** Quality code: "device reports error" */
const Q_DEVICE_ERROR = 0x44;
/** Within this time after local midnight, the final daily total of the previous day is refreshed */
const PREVIOUS_DAY_REFRESH_S = 6 * 3600;

/** Per-device metadata */
interface DeviceMeta {
	/** An initial (windowed) fetch has been done, so `hasComputed` is known */
	checked: boolean;
	/** The device delivers computed values (reading_id = null), e.g. Reference ET */
	hasComputed: boolean;
	/** UTC offset of the device's local time in minutes */
	offsetMin?: number;
	/** Start (Unix seconds) of the day whose final daily total was fetched last */
	prevDayFetched?: number;
}

class Zentra extends utils.Adapter {
	private api: ZentraApi | undefined;
	private pollTimer: ioBroker.Timeout | undefined;
	private stopped = false;
	/** Object IDs already created/updated in this run */
	private readonly knownObjects = new Set<string>();
	/** Timestamp (ms) of the value last written per state ID */
	private readonly lastValueTs = new Map<string, number>();
	/** Device metadata from the device list (by device_id) */
	private deviceInfo = new Map<string, ZentraDevice>();
	/** Per-device metadata (by sanitized device ID), persisted in the device object's native.meta */
	private readonly deviceMeta = new Map<string, DeviceMeta>();
	private deviceListCache: { apiKey: string; time: number; devices: ZentraDevice[] } | undefined;

	public constructor(options: Partial<utils.AdapterOptions> = {}) {
		super({
			...options,
			name: 'zentra',
		});
		this.on('ready', this.onReady.bind(this));
		this.on('message', this.onMessage.bind(this));
		this.on('unload', this.onUnload.bind(this));
	}

	private get units(): Units {
		return this.config.units === 'imperial' ? 'imperial' : 'metric';
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	private async onReady(): Promise<void> {
		await this.setState('info.connection', false, true);

		const apiKey = (this.config.apiKey ?? '').trim();
		if (!apiKey) {
			this.log.warn('No API key configured. Please enter the ZENTRA Cloud API key in the adapter settings.');
			return;
		}
		this.api = new ZentraApi(apiKey);

		const devices = this.selectedDevices();
		if (devices.length === 0) {
			this.log.warn('No devices selected. Please select devices in the adapter settings.');
			return;
		}

		// Load device metadata (name, model). Failure is not fatal; names also come with the data.
		try {
			const list = await this.api.listDevices();
			this.deviceInfo = new Map(list.map(d => [d.device_id, d]));
			for (const id of devices) {
				const info = this.deviceInfo.get(id);
				if (!info) {
					this.log.warn(`Device ${id} is not accessible with this API key.`);
				} else if (!info.can_read_data) {
					this.log.warn(`Device ${id} does not allow reading data with this API key.`);
				}
			}
			await this.setState('info.connection', true, true);
		} catch (e) {
			if (e instanceof ZentraApiError && e.status === 401) {
				this.log.error(`ZENTRA Cloud rejected the API key (${e.message}). Polling is disabled.`);
				return;
			}
			this.log.warn(`Could not load device list: ${(e as Error).message}`);
		}

		const intervalMin = Math.max(MIN_POLL_INTERVAL_MIN, Number(this.config.pollInterval) || 15);
		this.log.info(`Polling ${devices.length} device(s) every ${intervalMin} min.`);
		await this.pollLoop(intervalMin * 60_000);
	}

	private selectedDevices(): string[] {
		const raw = this.config.devices as unknown;
		const list = Array.isArray(raw) ? raw : typeof raw === 'string' && raw ? [raw] : [];
		return [...new Set(list.map(d => String(d).trim()).filter(d => d))];
	}

	private async pollLoop(intervalMs: number): Promise<void> {
		if (this.stopped) {
			return;
		}
		await this.pollAll();
		if (!this.stopped) {
			this.pollTimer = this.setTimeout(() => void this.pollLoop(intervalMs), intervalMs);
		}
	}

	/** Polls all selected devices sequentially. */
	private async pollAll(): Promise<void> {
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
				if (e instanceof ZentraApiError && e.status === 401) {
					this.log.error(`ZENTRA Cloud rejected the API key (${e.message}). Polling is stopped.`);
					this.stopped = true;
					await this.setState('info.connection', false, true);
					return;
				}
				this.log.warn(`Polling device ${deviceId} failed: ${(e as Error).message}`);
			}
		}
		if (anySuccess || !anyFailure) {
			await this.setState('info.connection', true, true);
		} else {
			await this.setState('info.connection', false, true);
		}
	}

	/**
	 * Fetches new data of one device and writes the newest value of each series.
	 *
	 * @param deviceId Device serial number
	 */
	private async pollDevice(deviceId: string): Promise<void> {
		const devId = sanitizeId(deviceId);
		await this.ensureDeviceObjects(deviceId, devId);

		const lastState = await this.getStateAsync(`${devId}.info.lastReadingId`);
		const lastId = typeof lastState?.val === 'number' ? lastState.val : undefined;
		const stale = !lastState || Date.now() - lastState.ts > RESYNC_AFTER_MS;

		const values: ZentraValue[] = [];
		let first: DeviceDataResponse;
		let newLastId: number | undefined;

		const meta = this.deviceMeta.get(devId) ?? { checked: false, hasComputed: false };
		const initial = lastId === undefined || stale || !meta.checked;

		if (initial) {
			// Initial run or long pause: only the newest values of the last 24 h, no backfill.
			this.log.debug(`${deviceId}: fetching newest values (window 24h)`);
			first = await this.call(() =>
				this.api!.getDeviceData(deviceId, { window: '24h', direction: 'descending', units: this.units }),
			);
			values.push(...first.values);
			// Pages are calendar months; at a month boundary the newest page can be empty.
			let next = first.pagination.next_url;
			let pages = 1;
			while (next && pages < MAX_PAGES_PER_POLL && !this.stopped) {
				const url = next;
				const page = await this.call(() => this.api!.getByUrl<DeviceDataResponse>(url));
				values.push(...page.values);
				next = page.pagination.next_url;
				pages++;
			}
			newLastId = Math.max(maxReadingId(values) ?? 0, first.metadata.reading_id_max_available ?? 0) || undefined;
		} else {
			// Incremental: everything after the last stored reading ID.
			this.log.debug(`${deviceId}: fetching readings after ID ${lastId}`);
			first = await this.call(() =>
				this.api!.getDeviceData(deviceId, { sinceReadingId: lastId, units: this.units }),
			);
			values.push(...first.values);
			let nextId = first.pagination.next_reading_id;
			let pages = 1;
			while (nextId !== null && pages < MAX_PAGES_PER_POLL && !this.stopped) {
				const cursor = nextId;
				const page = await this.call(() =>
					this.api!.getDeviceData(deviceId, { sinceReadingId: cursor, units: this.units }),
				);
				values.push(...page.values);
				nextId = page.pagination.next_reading_id;
				pages++;
			}
			// Remaining pages (if any) are fetched in the next cycle.
			newLastId = Math.max(lastId, maxReadingId(values) ?? lastId);
		}

		const raw = values.filter(v => v.reading_id !== null);
		const latest = latestPerSeries(raw);
		for (const v of latest) {
			await this.writeValue(devId, v);
		}

		// Reference time and device UTC offset from the newest raw measurement.
		let newestRaw: ZentraValue | undefined;
		for (const v of latest) {
			if (!newestRaw || v.timestamp > newestRaw.timestamp) {
				newestRaw = v;
			}
		}
		if (newestRaw) {
			await this.setState(`${devId}.info.lastMeasurement`, newestRaw.timestamp * 1000, true);
		}
		const offset = newestRaw ? utcOffsetMinutes(newestRaw.datetime) : undefined;
		const metaChanged =
			(initial && (!meta.checked || meta.hasComputed !== values.some(v => v.reading_id === null))) ||
			(offset !== undefined && offset !== meta.offsetMin);
		if (initial) {
			meta.checked = true;
			meta.hasComputed = values.some(v => v.reading_id === null);
		}
		if (offset !== undefined) {
			meta.offsetMin = offset;
		}
		this.deviceMeta.set(devId, meta);
		if (metaChanged) {
			await this.extendObjectAsync(devId, { native: { meta } });
		}

		// Computed values (e.g. Hourly/Daily Reference ET of ATMOS 41) have no reading ID.
		// Cursor requests do not deliver them, so they are fetched with small time-range requests.
		if (initial) {
			await this.writeComputed(devId, values, meta.offsetMin ?? 0);
		} else if (meta.hasComputed) {
			const lastMeas = newestRaw?.timestamp ?? (await this.lastMeasurementSec(devId));
			if (lastMeas !== undefined) {
				await this.pollComputed(deviceId, devId, lastMeas, meta.offsetMin ?? 0);
			}
		}
		await this.setState(`${devId}.info.sensorErrors`, JSON.stringify(first.sensor_errors ?? []), true);
		// Always written so that the state timestamp marks the last successful poll.
		// null (device without any data) keeps the adapter in initial mode instead of reading from ID 0.
		await this.setState(`${devId}.info.lastReadingId`, newLastId ?? lastId ?? null, true);

		if (first.metadata.device_name) {
			await this.extendObjectAsync(devId, { common: { name: first.metadata.device_name } });
		}
		this.log.debug(`${deviceId}: ${values.length} values received, ${latest.length} states updated`);
	}

	private async lastMeasurementSec(devId: string): Promise<number | undefined> {
		const st = await this.getStateAsync(`${devId}.info.lastMeasurement`);
		return typeof st?.val === 'number' ? Math.floor(st.val / 1000) : undefined;
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
	private async pollComputed(deviceId: string, devId: string, refTs: number, offsetMin: number): Promise<void> {
		const day = localDayStart(refTs, offsetMin);
		const hour = localHourStart(refTs, offsetMin);
		const ranges: [number, number][] = [[Math.max(hour - 3600, day), hour + 60]];
		if (hour - 3600 > day) {
			ranges.push([day, day + 60]);
		}
		const meta = this.deviceMeta.get(devId);
		const prevDay = day - 86400;
		const fetchPrevDay = meta?.prevDayFetched !== prevDay || refTs - day < PREVIOUS_DAY_REFRESH_S;
		if (fetchPrevDay) {
			ranges.push([prevDay, prevDay + 60]);
		}

		const values: ZentraValue[] = [];
		for (const [start, end] of ranges) {
			if (this.stopped) {
				return;
			}
			const res = await this.call(() =>
				this.api!.getDeviceData(deviceId, { startTimestamp: start, endTimestamp: end, units: this.units }),
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
	private async writeComputed(devId: string, values: ZentraValue[], offsetMin: number): Promise<number> {
		const computed = values.filter(v => v.reading_id === null);
		if (computed.length === 0) {
			return 0;
		}
		const latest = latestPerSeries(computed);
		for (const v of latest) {
			await this.writeValue(devId, v);
		}
		// Previous day = the day before the newest daily row.
		const daily = computed.filter(v => isDailySeries(v));
		const newestDay = daily.reduce((max, v) => Math.max(max, localDayStart(v.timestamp, offsetMin)), 0);
		const prev = daily.filter(v => localDayStart(v.timestamp, offsetMin) === newestDay - 86400);
		const prevLatest = latestPerSeries(prev);
		for (const v of prevLatest) {
			await this.writeValue(devId, v, { idSuffix: '_previous_day', nameSuffix: ' (previous day)' });
		}
		return latest.length + prevLatest.length;
	}

	/**
	 * Runs an API call, waiting once for the rate limit if needed.
	 *
	 * @param fn The API call
	 */
	private async call<T>(fn: () => Promise<T>): Promise<T> {
		try {
			return await fn();
		} catch (e) {
			if (e instanceof ZentraApiError && e.status === 429 && (e.retryAfterSeconds ?? 0) <= MAX_RETRY_WAIT_S) {
				const wait = e.retryAfterSeconds ?? 60;
				this.log.debug(`Rate limit reached, retrying in ${wait} s`);
				await this.delay(wait * 1000);
				return fn();
			}
			throw e;
		}
	}

	private async ensureDeviceObjects(deviceId: string, devId: string): Promise<void> {
		if (this.knownObjects.has(devId)) {
			return;
		}
		const info = this.deviceInfo.get(deviceId);
		// Restore persisted per-device metadata (computed-value detection, UTC offset).
		const existing = await this.getObjectAsync(devId);
		const storedMeta = existing?.native?.meta as DeviceMeta | undefined;
		if (storedMeta && typeof storedMeta === 'object') {
			this.deviceMeta.set(devId, { ...storedMeta });
		}
		await this.extendObjectAsync(devId, {
			type: 'device',
			common: { name: info?.name || deviceId },
			native: { device_id: deviceId, model: info?.model ?? null },
		});
		await this.extendObjectAsync(`${devId}.info`, {
			type: 'channel',
			common: { name: 'Information' },
			native: {},
		});
		const infoStates: Record<string, ioBroker.StateCommon> = {
			model: { name: 'Model', type: 'string', role: 'info.model', read: true, write: false },
			lastReadingId: {
				name: 'Last processed reading ID',
				type: 'number',
				role: 'value',
				read: true,
				write: false,
			},
			lastMeasurement: {
				name: 'Time of newest measurement',
				type: 'number',
				role: 'value.time',
				read: true,
				write: false,
			},
			sensorErrors: {
				name: 'Active sensor errors (JSON)',
				type: 'string',
				role: 'json',
				read: true,
				write: false,
			},
		};
		for (const [id, common] of Object.entries(infoStates)) {
			await this.extendObjectAsync(`${devId}.info.${id}`, { type: 'state', common, native: {} });
		}
		if (info?.model) {
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
	private async writeValue(
		devId: string,
		v: ZentraValue,
		opts: { idSuffix?: string; nameSuffix?: string } = {},
	): Promise<void> {
		const chId = `${devId}.${channelId(v)}`;
		const positionUnit = this.units === 'imperial' ? 'in' : 'cm';
		const id = `${chId}.${stateId(v, positionUnit)}${opts.idSuffix ?? ''}`;

		if (!this.knownObjects.has(chId)) {
			await this.extendObjectAsync(chId, {
				type: 'channel',
				common: { name: v.port_num === null ? 'Logger' : `Port ${v.port_num}: ${v.sensor_name}` },
				native: { port_num: v.port_num, sensor_name: v.sensor_name },
			});
			this.knownObjects.add(chId);
		}
		if (!this.knownObjects.has(id)) {
			const name =
				(v.position === null ? v.measurement : `${v.measurement} (${v.position} ${positionUnit})`) +
				(opts.nameSuffix ?? '');
			await this.extendObjectAsync(id, {
				type: 'state',
				common: {
					name,
					type: 'number',
					role: roleFor(v.measurement),
					unit: v.unit || undefined,
					read: true,
					write: false,
				},
				native: {
					port_num: v.port_num,
					sensor_name: v.sensor_name,
					measurement: v.measurement,
					position: v.position,
				},
			});
			this.knownObjects.add(id);
		}

		// Never overwrite a newer value with a late-arriving older reading.
		const ts = v.timestamp * 1000;
		let lastTs = this.lastValueTs.get(id);
		if (lastTs === undefined) {
			lastTs = (await this.getStateAsync(id))?.ts ?? 0;
		}
		if (ts < lastTs) {
			return;
		}
		this.lastValueTs.set(id, ts);

		await this.setState(id, {
			val: v.value,
			ack: true,
			ts,
			q: v.error_code === 0 ? 0 : Q_DEVICE_ERROR,
		});
	}

	/**
	 * Handles messages from the admin UI.
	 * `getDevices` returns the account's devices for the device selection.
	 *
	 * @param obj The message
	 */
	private async onMessage(obj: ioBroker.Message): Promise<void> {
		if (typeof obj !== 'object' || obj.command !== 'getDevices') {
			return;
		}
		const msg = (typeof obj.message === 'object' && obj.message) || {};
		const apiKey = String((msg as { apiKey?: string }).apiKey || this.config.apiKey || '').trim();
		let response: { value: string; label: string }[];
		if (!apiKey) {
			response = [{ value: '', label: 'Please enter the API key first' }];
		} else {
			try {
				const devices = await this.getDeviceList(apiKey);
				response = devices
					.filter(d => d.can_read_data)
					.map(d => {
						const details = [d.name && d.name !== d.device_id ? d.device_id : '', d.model ?? '']
							.filter(x => x)
							.join(', ');
						const name = d.name || d.device_id;
						return { value: d.device_id, label: details ? `${name} (${details})` : name };
					});
				if (response.length === 0) {
					response = [{ value: '', label: 'No readable devices found for this API key' }];
				}
			} catch (e) {
				response = [{ value: '', label: `Error: ${(e as Error).message}` }];
			}
		}
		if (obj.callback) {
			this.sendTo(obj.from, obj.command, response, obj.callback);
		}
	}

	private async getDeviceList(apiKey: string): Promise<ZentraDevice[]> {
		const c = this.deviceListCache;
		if (c && c.apiKey === apiKey && Date.now() - c.time < DEVICE_LIST_CACHE_MS) {
			return c.devices;
		}
		const devices = await new ZentraApi(apiKey).listDevices();
		this.deviceListCache = { apiKey, time: Date.now(), devices };
		return devices;
	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 *
	 * @param callback - Callback function
	 */
	private onUnload(callback: () => void): void {
		try {
			this.stopped = true;
			if (this.pollTimer) {
				this.clearTimeout(this.pollTimer);
				this.pollTimer = undefined;
			}
			callback();
		} catch (error) {
			this.log.error(`Error during unloading: ${(error as Error).message}`);
			callback();
		}
	}
}

if (require.main !== module) {
	// Export the constructor in compact mode
	module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Zentra(options);
} else {
	// otherwise start the instance directly
	(() => new Zentra())();
}
