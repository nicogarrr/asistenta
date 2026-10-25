import WidgetCluster from '../components/widgets/WidgetCluster';
import {useGreeting} from '../lib/useGreeting';
import Hero from '../components/Hero';
import Dock from '../components/Dock';
import type {AppItem} from '../lib/apps';
import type {Pick} from '../service/tmdb';
import {useConfig} from '../lib/config';

// Pantalla única estilo free-my-tv (referencia de Nico): arriba "Para ti" con
// las recomendaciones TMDB; abajo el dock de apps con colores de marca; reloj y
// tiempo arriba a la derecha. Sin textos explicativos ni adornos extra.
export default function Home ({picks, heroSel, dock, dockSel, zone, launchingKey}: {
	picks: Pick[];
	heroSel: number;
	dock: AppItem[];
	dockSel: number;
	zone: 'hero' | 'dock';
	launchingKey: string | null;
}) {
	const {userName, location} = useConfig();
	const {greeting} = useGreeting(userName);
	return (
		<div className="relative h-full w-full">
			<div className="absolute right-[5vw] top-[5vh]">
				<WidgetCluster />
			</div>
			{picks.length > 0 ? (
				<Hero picks={picks} selected={heroSel} active={zone === 'hero'} launchingKey={launchingKey} />
			) : (
				<div className="absolute left-1/2 top-[38%] -translate-x-1/2 -translate-y-1/2 text-center" style={{animation: 'rise-in 0.7s cubic-bezier(0.05,0.7,0.1,1) 0.1s both'}}>
					<h1 className="text-[64px] font-light leading-none tracking-tight text-white/95">{greeting}</h1>
					<p className="mt-4 text-lg font-normal tracking-[0.02em] text-white/45">{location.name}</p>
				</div>
			)}
			<Dock items={dock} selected={dockSel} active={zone === 'dock'} launchingId={launchingKey} />
		</div>
	);
}
