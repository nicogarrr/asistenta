import {memo} from 'react';
import {useConfig} from '../lib/config';
import {useGreeting} from '../lib/useGreeting';
import {PERIOD_LABEL, type Pick} from '../service/tmdb';

// Sección "Para ti" estilo free-my-tv: un póster grande (backdrop) + dos
// pequeños al lado. Foco con borde de acento; OK lanza la app del proveedor
// (lo gestiona App). Sin clave TMDB la sección no se renderiza (la decide el padre).
const ACCENT = '#7ca8ff';

const Card = memo(function Card ({pick, big, focused, launching}: {pick: Pick; big: boolean; focused: boolean; launching: boolean}) {
	return (
		<div
			className="relative shrink-0 overflow-hidden rounded-[28px]"
			style={{
				width: big ? 940 : 452,
				height: big ? 528 : 256,
				background: 'rgba(255,255,255,0.05)',
				border: `2px solid ${focused ? ACCENT : 'rgba(255,255,255,0.10)'}`,
				transform: focused ? 'scale(1.025)' : 'scale(1)',
				transition: 'transform var(--m3-dur-medium) var(--m3-ease-emphasized), border-color var(--m3-dur-short) var(--m3-ease-standard)',
				boxShadow: focused ? `0 0 28px -6px ${ACCENT}90, 0 22px 48px -24px rgba(0,0,0,0.9)` : '0 18px 40px -24px rgba(0,0,0,0.8)',
				animation: launching ? 'launch-pulse 0.55s var(--m3-ease-emphasized)' : 'none'
			}}
		>
			{pick.backdrop && (
				<img src={pick.backdrop} alt="" draggable={false} loading="lazy" className="absolute inset-0 h-full w-full object-cover" />
			)}
			<div
				className="absolute inset-0"
				style={{background: 'linear-gradient(to top, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.22) 50%, transparent 100%)'}}
			/>
			<div className="absolute bottom-0 left-0 right-0 px-6 pb-5">
				<div className={`truncate font-medium text-white/95 ${big ? 'text-[28px]' : 'text-xl'}`}>{pick.title}</div>
				<div className={`mt-1 font-normal text-white/60 ${big ? 'text-lg' : 'text-base'}`}>{pick.providerName}</div>
			</div>
		</div>
	);
});

export default function Hero ({picks, selected, active, launchingKey}: {picks: Pick[]; selected: number; active: boolean; launchingKey: string | null}) {
	const {userName} = useConfig();
	const {greeting, period} = useGreeting(userName);
	const shown = picks.slice(0, 3);
	if (!shown.length) return null;

	return (
		<div className="absolute left-[5vw] top-[9vh]">
			<div className="text-[13px] font-normal uppercase tracking-[0.32em] text-white/30">{greeting}</div>
			<h1 className="mt-3 font-extralight leading-none text-white/90" style={{fontSize: 46, letterSpacing: '-0.02em'}}>
				Para ti <span className="ml-3 align-middle text-xs font-medium uppercase tracking-[0.28em] text-white/35">{PERIOD_LABEL[period]}</span>
			</h1>
			<div className="mt-5 flex items-start gap-6">
				<Card pick={shown[0]} big focused={active && selected === 0} launching={launchingKey === `${shown[0].kind}-${shown[0].id}`} />
				<div className="flex flex-col gap-5">
					{shown.slice(1).map((p, i) => (
						<Card key={`${p.kind}-${p.id}`} pick={p} big={false} focused={active && selected === i + 1} launching={launchingKey === `${p.kind}-${p.id}`} />
					))}
				</div>
			</div>
		</div>
	);
}
