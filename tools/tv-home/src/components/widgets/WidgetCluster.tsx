import {useEffect, useState} from 'react';
import Clock from './Clock';
import {cachedReadingFor, forecastCacheKey, forecastRetryDelayMs, writeForecastCache, staleLabel, FORECAST_FRESH_MS, FORECAST_SHOWN_MS,
	fetchForecast, type Forecast} from '../../service/weather';
import {useConfig} from '../../lib/config';

function DateLine () {
	const [d, setD] = useState(() => new Date());
	useEffect(() => {
		const id = setInterval(() => setD(new Date()), 60_000);
		return () => clearInterval(id);
	}, []);
	const weekday = d.toLocaleDateString('es-ES', {weekday: 'long'});
	const rest = d.toLocaleDateString('es-ES', {month: 'long', day: 'numeric'});
	return (
		<div className="text-right">
			<div className="text-[26px] font-medium leading-tight tracking-tight text-white/92">{weekday}</div>
			<div className="text-base font-normal text-white/55">{rest}</div>
		</div>
	);
}

function hourLabel (h: number, clock24: boolean): string {
	if (clock24) return String(h).padStart(2, '0');
	const h12 = ((h + 11) % 12) + 1;
	return `${h12}${h < 12 ? 'am' : 'pm'}`;
}

// Current conditions + next-5-hours strip + 3-day outlook, one Open-Meteo call.
// First paint comes from the saved copy (never waits for the network); the
// fetch refreshes it in the background. On failure the saved reading stays on
// screen and the retry backs off 2 → 10 → 30 min (pattern from Hearth, MIT).
function WeatherBlock () {
	const {tempUnit, clock24, location} = useConfig();
	const [fc, setFc] = useState<Forecast | null>(null);
	const [err, setErr] = useState(false);
	const [at, setAt] = useState(0); // cuando se leyo lo que se ve
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const id = window.setInterval(() => setNow(Date.now()), 60_000);
		return () => window.clearInterval(id);
	}, []);
	useEffect(() => {
		let alive = true;
		let timer = 0;
		let readAt = 0;
		let fails = 0;
		const loc = {...location, temperatureUnit: tempUnit};

		// show the saved reading for THIS place+unit right away, if still fresh enough
		const cached = cachedReadingFor(localStorage, loc, Date.now());
		if (cached) { readAt = cached.at; setFc(cached.forecast); setAt(cached.at); setErr(false); }

		const load = () => fetchForecast(loc)
			.then((f) => {
				if (!alive) return;
				fails = 0;
				readAt = Date.now();
				setFc(f);
				setAt(readAt);
				setErr(false);
				writeForecastCache(localStorage, forecastCacheKey(loc), f, readAt);
				timer = window.setTimeout(load, FORECAST_FRESH_MS);
			})
			.catch(() => {
				if (!alive) return;
				fails += 1;
				setErr(true); // only shown when there is no reading at all
				// una lectura guardada mas vieja que SHOWN ya no se muestra
				if (readAt && Date.now() - readAt > FORECAST_SHOWN_MS) { readAt = 0; setFc(null); }
				timer = window.setTimeout(load, forecastRetryDelayMs(fails));
			});
		load();
		return () => { alive = false; window.clearTimeout(timer); };
	}, [tempUnit, location]);

	if (err && !fc) return <div className="text-right text-base font-normal text-white/40">Weather —</div>;
	if (!fc) return <div className="text-right text-base font-normal text-white/40">Loading…</div>;

	const stale = staleLabel(at, now);
	return (
		<div className="flex w-full flex-col items-end gap-3">
			{/* now */}
			<div className="flex items-center justify-end gap-3">
				<span className="text-[32px] leading-none opacity-95">{fc.now.glyph}</span>
				<div className="text-right leading-tight">
					<div className="text-2xl font-medium text-white/92">{fc.now.temp}{fc.now.unit}</div>
					<div className="text-sm font-normal text-white/55">{fc.now.label}</div>
					{stale && <div className="text-base font-medium text-amber-200/90">{stale}</div>}
				</div>
			</div>

			{/* next 5 hours: con una copia vieja serian horas pasadas presentadas como futuras, no se muestran */}
			{!stale && <div className="flex justify-end gap-3">
				{fc.hours.map((h) => (
					<div key={h.hour} className="flex w-11 flex-col items-center gap-0.5">
						<span className="text-xs font-medium text-white/45">{hourLabel(h.hour, clock24)}</span>
						<span className="text-lg leading-tight opacity-90">{h.glyph}</span>
						<span className="text-sm font-medium text-white/80">{h.temp}°</span>
					</div>
				))}
			</div>}

			<div className="m3-divider" />

			{/* 3-day outlook — columns, not rows, to keep the card short */}
			<div className="flex w-full justify-between px-1">
				{fc.days.map((d) => (
					<div key={d.label} className="flex flex-col items-center gap-0.5">
						<span className="text-xs font-medium text-white/50">{d.label}</span>
						<span className="text-lg leading-tight opacity-90">{d.glyph}</span>
						<span className="text-sm font-medium tabular-nums">
							<span className="text-white/85">{d.hi}°</span>
							<span className="text-white/40">/{d.lo}°</span>
						</span>
					</div>
				))}
			</div>
		</div>
	);
}

// Top-right Material 3 elevated card: date · weather+forecast · clock, softly
// separated. No backdrop-blur — it re-rasterizes over the moving background each
// frame and tanks the TV GPU; the .m3-card tonal gradient fakes the surface for free.
export default function WidgetCluster () {
	const {showWeather} = useConfig();
	return (
		<div className="m3-card flex w-[340px] flex-col items-end gap-3 px-8 py-5">
			<DateLine />
			{showWeather && <div className="m3-divider" />}
			{showWeather && <WeatherBlock />}
			<div className="m3-divider" />
			<Clock compact />
		</div>
	);
}
