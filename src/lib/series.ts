/**
 * Helpers that map ZENTRA measurement values to ioBroker object IDs and roles.
 */
import type { ZentraValue } from './zentraApi';

/** Characters not allowed in ioBroker object IDs (same as adapter.FORBIDDEN_CHARS) */
const FORBIDDEN_CHARS = /[^._\-/ :!#$%&()+=@^{}|~\p{Ll}\p{Lu}\p{Nd}]+/gu;

/**
 * Turns an arbitrary name into a safe ioBroker ID segment.
 * Spaces, dots and forbidden characters become `_`.
 *
 * @param name The name to sanitize
 */
export function sanitizeId(name: string): string {
	return (
		name
			.trim()
			.replace(FORBIDDEN_CHARS, '_')
			.replace(/[.\s]+/g, '_')
			.replace(/_+/g, '_')
			.replace(/^_|_$/g, '') || 'unknown'
	);
}

/**
 * Relative ID of the channel a value belongs to: `port<N>` or `logger` for logger-level values.
 *
 * @param v The measurement value
 */
export function channelId(v: Pick<ZentraValue, 'port_num'>): string {
	return v.port_num === null ? 'logger' : `port${v.port_num}`;
}

/**
 * Relative ID of the state inside the channel.
 * Values with a position (e.g. depth of multi-depth sensors) get the position as suffix.
 *
 * @param v The measurement value
 * @param positionUnit Unit of the position (`cm` for metric, `in` for imperial)
 */
export function stateId(v: Pick<ZentraValue, 'measurement' | 'position'>, positionUnit: string): string {
	const base = sanitizeId(v.measurement);
	if (v.position === null || v.position === undefined) {
		return base;
	}
	return `${base}_${String(v.position).replace('.', '_')}${positionUnit}`;
}

/**
 * Unique key of a series: port, measurement, sensor and position.
 *
 * @param v The measurement value
 */
export function seriesKey(v: ZentraValue): string {
	return `${v.port_num ?? 'L'}|${v.measurement}|${v.sensor_name}|${v.position ?? ''}`;
}

/**
 * Reduces a list of values to the newest value per series.
 *
 * @param values All values of one or more API responses
 */
export function latestPerSeries(values: ZentraValue[]): ZentraValue[] {
	const latest = new Map<string, ZentraValue>();
	for (const v of values) {
		const key = seriesKey(v);
		const prev = latest.get(key);
		if (
			!prev ||
			v.timestamp > prev.timestamp ||
			(v.timestamp === prev.timestamp && (v.reading_id ?? 0) >= (prev.reading_id ?? 0))
		) {
			latest.set(key, v);
		}
	}
	return [...latest.values()];
}

/**
 * Highest reading ID in a list of values, or undefined if none has an ID.
 *
 * @param values The values to inspect
 */
export function maxReadingId(values: ZentraValue[]): number | undefined {
	let max: number | undefined;
	for (const v of values) {
		if (v.reading_id !== null && (max === undefined || v.reading_id > max)) {
			max = v.reading_id;
		}
	}
	return max;
}

const ROLE_MAP: [RegExp, string][] = [
	[/dew point/i, 'value.temperature.dewpoint'],
	[/temperature|\btemp\b/i, 'value.temperature'],
	[/relative humidity/i, 'value.humidity'],
	[/precipitation|rain/i, 'value.precipitation'],
	[/wind speed|gust/i, 'value.speed.wind'],
	[/wind direction/i, 'value.direction.wind'],
	[/pressure/i, 'value.pressure'],
	[/solar radiation/i, 'value.radiation'],
	[/battery percent/i, 'value.battery'],
	[/battery/i, 'value.voltage'],
];

/**
 * Best-effort ioBroker role for a measurement name.
 *
 * @param measurement Measurement name, e.g. "Air Temperature"
 */
export function roleFor(measurement: string): string {
	for (const [re, role] of ROLE_MAP) {
		if (re.test(measurement)) {
			return role;
		}
	}
	return 'value';
}

/**
 * UTC offset in minutes from an ISO 8601 datetime string, e.g. `-480` for `...-08:00`.
 *
 * @param datetime ISO 8601 string with offset or `Z`
 */
export function utcOffsetMinutes(datetime: string): number | undefined {
	if (/Z$/i.test(datetime)) {
		return 0;
	}
	const m = /([+-])(\d{2}):?(\d{2})$/.exec(datetime);
	if (!m) {
		return undefined;
	}
	const minutes = Number(m[2]) * 60 + Number(m[3]);
	return m[1] === '-' ? -minutes : minutes;
}

/**
 * Start of the local day (Unix seconds) that contains the given time.
 *
 * @param ts Unix seconds
 * @param offsetMin UTC offset of the device in minutes
 */
export function localDayStart(ts: number, offsetMin: number): number {
	const off = offsetMin * 60;
	return Math.floor((ts + off) / 86400) * 86400 - off;
}

/**
 * Start of the local hour (Unix seconds) that contains the given time.
 *
 * @param ts Unix seconds
 * @param offsetMin UTC offset of the device in minutes
 */
export function localHourStart(ts: number, offsetMin: number): number {
	const off = offsetMin * 60;
	return Math.floor((ts + off) / 3600) * 3600 - off;
}

/**
 * True for computed daily series such as "Daily Reference ET".
 *
 * @param v The measurement value
 */
export function isDailySeries(v: Pick<ZentraValue, 'measurement'>): boolean {
	return /\bdaily\b/i.test(v.measurement);
}
