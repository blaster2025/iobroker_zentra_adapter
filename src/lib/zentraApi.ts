/**
 * Minimal client for the ZENTRA Cloud API v5.
 * See Docs/ZentraCloud-API-v5.md for the relevant parts of the API.
 */

export const DEFAULT_BASE_URL = 'https://api.zentracloud.io/v5';

/** Unit system supported by the API */
export type Units = 'metric' | 'imperial';

/** Device entry as returned by `GET /devices` */
export interface ZentraDevice {
	device_id: string;
	name: string;
	organization_id: string;
	organization_name: string;
	device_type: number;
	model: string | null;
	can_read_data: boolean;
}

interface DeviceListResponse {
	devices: ZentraDevice[];
	pagination: {
		page_num: number;
		limit: number;
		num_devices: number;
		total_pages: number;
	};
}

/** One measured value as returned by `GET /devices/{id}/data` */
export interface ZentraValue {
	port_num: number | null;
	measurement: string;
	unit: string;
	sensor_name: string;
	position: number | null;
	value: number | null;
	timestamp: number;
	datetime: string;
	error_code: number;
	reading_id: number | null;
}

/** Slow-moving sensor status fault */
export interface ZentraSensorError {
	port_num: number | null;
	sensor_name: string;
	error_code: number;
	timestamp: number;
	datetime: string;
}

/** Response of `GET /devices/{id}/data` */
export interface DeviceDataResponse {
	metadata: {
		device_id: string;
		device_name: string;
		location: string | null;
		coordinates: string | null;
		elevation: number | null;
		elevation_unit: string;
		reading_id_max_available: number | null;
	};
	values: ZentraValue[];
	pagination: {
		num_readings: number;
		next_token: string | null;
		next_url: string | null;
		next_reading_id: number | null;
	};
	sensor_errors: ZentraSensorError[];
	error_codes: Record<string, string>;
}

/** Error thrown for non-2xx HTTP responses */
export class ZentraApiError extends Error {
	constructor(
		public readonly status: number,
		message: string,
		/** Seconds to wait before retrying (only set for HTTP 429) */
		public readonly retryAfterSeconds?: number,
	) {
		super(message);
		this.name = 'ZentraApiError';
	}
}

/** Options for {@link ZentraApi.getDeviceData} */
export interface DeviceDataQuery {
	/** Relative time window, e.g. `24h` */
	window?: string;
	/** Cursor: only readings with a higher reading ID are returned */
	sinceReadingId?: number;
	/** Absolute range start (Unix seconds); used together with `endTimestamp` */
	startTimestamp?: number;
	/** Absolute range end (Unix seconds) */
	endTimestamp?: number;
	direction?: 'ascending' | 'descending';
	units?: Units;
}

/** Client for the ZENTRA Cloud API v5 */
export class ZentraApi {
	constructor(
		private readonly apiKey: string,
		private readonly baseUrl: string = DEFAULT_BASE_URL,
		private readonly timeoutMs: number = 60_000,
	) {}

	/**
	 * Lists all devices accessible with the API key (all pages).
	 */
	async listDevices(): Promise<ZentraDevice[]> {
		const devices: ZentraDevice[] = [];
		let page = 1;
		let totalPages = 1;
		do {
			const res = await this.request<DeviceListResponse>(`${this.baseUrl}/devices?page_num=${page}&limit=1000`);
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
	async getDeviceData(deviceId: string, query: DeviceDataQuery): Promise<DeviceDataResponse> {
		const params = new URLSearchParams();
		if (query.sinceReadingId !== undefined) {
			params.set('since_reading_id', String(query.sinceReadingId));
		} else if (query.startTimestamp !== undefined && query.endTimestamp !== undefined) {
			params.set('start_timestamp', String(query.startTimestamp));
			params.set('end_timestamp', String(query.endTimestamp));
		} else if (query.window) {
			params.set('window', query.window);
		}
		if (query.direction) {
			params.set('direction', query.direction);
		}
		params.set('units', query.units ?? 'metric');
		return this.request<DeviceDataResponse>(
			`${this.baseUrl}/devices/${encodeURIComponent(deviceId)}/data?${params.toString()}`,
		);
	}

	/**
	 * Fetches a page by a `next_url` returned from a previous response.
	 *
	 * @param url Absolute URL from `pagination.next_url`
	 */
	async getByUrl<T>(url: string): Promise<T> {
		return this.request<T>(url);
	}

	private async request<T>(url: string): Promise<T> {
		const res = await fetch(url, {
			headers: { 'X-API-Key': this.apiKey, Accept: 'application/json' },
			signal: AbortSignal.timeout(this.timeoutMs),
		});
		if (!res.ok) {
			let detail = '';
			let retryAfter: number | undefined;
			try {
				const body = (await res.json()) as { detail?: unknown; retry_after_seconds?: number };
				detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail ?? body);
				retryAfter = body.retry_after_seconds;
			} catch {
				// body is not JSON - ignore
			}
			if (res.status === 429) {
				const header = Number(res.headers.get('Retry-After'));
				retryAfter = Number.isFinite(header) && header > 0 ? header : (retryAfter ?? 60);
			}
			throw new ZentraApiError(res.status, describeStatus(res.status, detail), retryAfter);
		}
		return (await res.json()) as T;
	}
}

function describeStatus(status: number, detail: string): string {
	const suffix = detail ? `: ${detail}` : '';
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
