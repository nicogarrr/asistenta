import {useEffect, useMemo, useState} from 'react';
import {Analog} from './widgets/Clock';
import {useConfig} from '../lib/config';
import {fetchNextLaunch, formatNet, type NextLaunch} from '../service/launches';
import type {Pick} from '../service/tmdb';

// Fotos del salvapantallas (idea de free-my-tv, "a screensaver to match"):
// backdrops de los picks a pantalla completa con fundido de 2 s cada 24 s y
// un zoom Ken Burns muy lento. Solo dos capas <img> montadas a la vez (RAM).
const SLIDE_MS = 24_000;

// Ambient idle screen (60s of no input): the UI fades out, the screen dims a
// touch, and a big analog clock floats over the constellation field. The clock
// DRIFTS to a new spot every minute (OLED burn-in guard) and everything is
// semi-transparent — no bright static pixels. Any input exits (handled in App).
function PhotoLayer ({photos}: {photos: string[]}) {
	const [cur, setCur] = useState(0);
	const [hiddenSrc, setHiddenSrc] = useState(photos[1] ?? photos[0]);
	useEffect(() => {
		if (photos.length < 2) return;
		const id = setInterval(() => {
			setCur((c) => {
				const n = c + 1;
				// cuando acaba el fundido, el slot oculto precarga la siguiente
				window.setTimeout(() => setHiddenSrc(photos[(n + 1) % photos.length]), 2200);
				return n;
			});
		}, SLIDE_MS);
		return () => clearInterval(id);
	}, [photos]);
	if (!photos.length) return null;
	// Truco de fundido limpio: al cambiar, ambos slots muestran la foto entrante
	// (la saliente queda cubierta por la misma imagen mientras funde).
	const visSlot = cur % 2;
	const srcs = visSlot === 0 ? [photos[cur % photos.length], hiddenSrc] : [hiddenSrc, photos[cur % photos.length]];
	return (
		<div className="absolute inset-0 overflow-hidden">
			{[0, 1].map((slot) => {
				const visible = slot === visSlot;
				return (
					<img
						key={slot}
						src={srcs[slot]}
						alt=""
						draggable={false}
						className="absolute inset-0 h-full w-full object-cover"
						style={{
							opacity: visible ? 1 : 0,
							transition: 'opacity 2s ease-in-out',
							animation: visible ? `kenburns ${SLIDE_MS + 4000}ms linear both` : 'none'
						}}
					/>
				);
			})}
		</div>
	);
}

export default function Ambient ({picks = []}: {picks?: Pick[]}) {
	const {clock24, launchesEnabled, ambientPhotos} = useConfig();
	const photos = useMemo(
		() => (ambientPhotos ? [...new Set(picks.map((p) => p.backdrop).filter(Boolean))] : []),
		[picks, ambientPhotos]
	);
	const [launch, setLaunch] = useState<NextLaunch | null>(null);
	useEffect(() => {
		if (!launchesEnabled) return;
		let alive = true;
		fetchNextLaunch().then((l) => { if (alive) setLaunch(l); });
		return () => { alive = false; };
	}, [launchesEnabled]);
	const [now, setNow] = useState(() => new Date());
	// drift offset in vw/vh around center; new spot each minute, eased by CSS
	const [pos, setPos] = useState({x: 0, y: 0});

	useEffect(() => {
		const tick = setInterval(() => setNow(new Date()), 1000);
		const drift = setInterval(() => {
			setPos({x: (Math.random() * 2 - 1) * 7, y: (Math.random() * 2 - 1) * 6});
		}, 60_000);
		return () => { clearInterval(tick); clearInterval(drift); };
	}, []);

	const hh = now.getHours();
	const mm = String(now.getMinutes()).padStart(2, '0');
	const digital = clock24
		? `${String(hh).padStart(2, '0')}:${mm}`
		: `${((hh + 11) % 12) + 1}:${mm}${hh < 12 ? ' AM' : ' PM'}`;
	const dateLine = now.toLocaleDateString('es-ES', {weekday: 'long', month: 'long', day: 'numeric'});

	return (
		<div
			className="absolute inset-0 z-40"
			style={{animation: 'rise-in 1.2s ease both'}}
		>
			<PhotoLayer photos={photos} />
			<div className="absolute inset-0" style={{background: photos.length ? 'rgba(0,0,0,0.38)' : 'rgba(0,0,0,0.45)'}} />
			<div
				className="absolute left-1/2 top-1/2 flex flex-col items-center gap-6 rounded-[64px] px-16 py-12"
				style={{
					transform: `translate(calc(-50% + ${pos.x}vw), calc(-50% + ${pos.y}vh))`,
					transition: 'transform 3s ease-in-out',
					// reloj de cristal (como el "big glass clock" de free-my-tv):
					// legible sobre cualquier foto; blur estático salvo el drift de cada minuto
					background: 'rgba(10,12,18,0.34)',
					backdropFilter: 'blur(18px) saturate(1.15)',
					WebkitBackdropFilter: 'blur(18px) saturate(1.15)',
					border: '1px solid rgba(255,255,255,0.12)'
				}}
			>
				<div style={{opacity: 0.9}}>
					<Analog date={now} size={340} />
				</div>
				<div className="text-center">
					<div className="text-[40px] font-light leading-none tracking-tight text-white/70">{digital}</div>
					<div className="mt-3 text-lg font-normal tracking-[0.02em] text-white/35">{dateLine}</div>
				{launch && (
					<div className="mt-4 max-w-[520px] text-center text-base font-normal text-white/30">
						Próximo lanzamiento: {launch.name} · {formatNet(launch.net)}
						<span className="text-white/20"> · Fuente: Launch Library</span>
					</div>
				)}
				</div>
			</div>
		</div>
	);
}
