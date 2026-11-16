import { expect } from 'chai';
import { describe, it } from 'mocha';
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
} from './series';
import type { ZentraValue } from './zentraApi';

function value(partial: Partial<ZentraValue>): ZentraValue {
	return {
		port_num: 1,
		measurement: 'Water Content',
		unit: 'm³/m³',
		sensor_name: 'TEROS 12',
		position: null,
		value: 0.25,
		timestamp: 1_700_000_000,
		datetime: '',
		error_code: 0,
		reading_id: 1,
		...partial,
	};
}

describe('series helpers', () => {
	it('sanitizeId replaces spaces, dots and forbidden characters', () => {
		expect(sanitizeId('Water Content')).to.equal('Water_Content');
		expect(sanitizeId('Soil Temp. *[x]')).to.equal('Soil_Temp_x');
		expect(sanitizeId('  ')).to.equal('unknown');
	});

	it('channelId uses port number or logger', () => {
		expect(channelId({ port_num: 3 })).to.equal('port3');
		expect(channelId({ port_num: null })).to.equal('logger');
	});

	it('stateId appends the position if present', () => {
		expect(stateId({ measurement: 'Water Content', position: null }, 'cm')).to.equal('Water_Content');
		expect(stateId({ measurement: 'Water Content', position: -15 }, 'cm')).to.equal('Water_Content_-15cm');
		expect(stateId({ measurement: 'Water Content', position: -7.5 }, 'in')).to.equal('Water_Content_-7_5in');
	});

	it('latestPerSeries keeps the newest value per series', () => {
		const values = [
			value({ timestamp: 100, value: 1, reading_id: 1 }),
			value({ timestamp: 200, value: 2, reading_id: 2 }),
			value({ timestamp: 150, value: 3, reading_id: 3 }),
			value({ timestamp: 100, value: 4, position: -30, reading_id: 1 }),
			value({ timestamp: 100, value: 5, port_num: 2, reading_id: 1 }),
		];
		const latest = latestPerSeries(values);
		expect(latest).to.have.length(3);
		expect(latest.find(v => v.port_num === 1 && v.position === null)?.value).to.equal(2);
	});

	it('maxReadingId ignores null IDs', () => {
		expect(
			maxReadingId([value({ reading_id: null }), value({ reading_id: 7 }), value({ reading_id: 3 })]),
		).to.equal(7);
		expect(maxReadingId([value({ reading_id: null })])).to.equal(undefined);
	});

	it('roleFor maps common measurements', () => {
		expect(roleFor('Air Temperature')).to.equal('value.temperature');
		expect(roleFor('Wind Direction')).to.equal('value.direction.wind');
		expect(roleFor('Water Content')).to.equal('value');
		expect(roleFor('Dew Point')).to.equal('value.temperature.dewpoint');
		expect(roleFor('RH Sensor Temp')).to.equal('value.temperature');
		expect(roleFor('Tilt Angle')).to.equal('value');
	});
});

describe('time helpers', () => {
	it('utcOffsetMinutes parses Z and offsets', () => {
		expect(utcOffsetMinutes('2026-11-16T18:40:00Z')).to.equal(0);
		expect(utcOffsetMinutes('2026-11-16T09:00:00-08:00')).to.equal(-480);
		expect(utcOffsetMinutes('2026-11-16T09:00:00+05:30')).to.equal(330);
		expect(utcOffsetMinutes('2026-11-16T09:00:00')).to.equal(undefined);
	});

	it('localDayStart and localHourStart respect the offset', () => {
		const ts = Date.UTC(2026, 10, 16, 17, 30) / 1000; // 09:30 at -08:00
		expect(localDayStart(ts, -480)).to.equal(Date.UTC(2026, 10, 16, 8, 0) / 1000);
		expect(localDayStart(ts, 0)).to.equal(Date.UTC(2026, 10, 16) / 1000);
		expect(localHourStart(ts, 330)).to.equal(Date.UTC(2026, 10, 16, 17, 30) / 1000);
		expect(localHourStart(ts, 0)).to.equal(Date.UTC(2026, 10, 16, 17, 0) / 1000);
	});

	it('isDailySeries detects daily computed series', () => {
		expect(isDailySeries({ measurement: 'Daily Reference ET' })).to.equal(true);
		expect(isDailySeries({ measurement: 'Hourly Reference ET' })).to.equal(false);
	});
});
