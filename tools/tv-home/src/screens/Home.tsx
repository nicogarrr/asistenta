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
	const {userName, location, showWeather} = useConfig();
	const {greeting} = useGreeting(userName);
	return (
		<div className="relative h-full w-full">
			{showWeather && (
				<div className="absolute right-[5vw] top-[5vh]">
					<WidgetCluster />
				</div>
			)}
			{picks.length > 0 ? (
				<Hero picks={picks} selected={heroSel} active={zone === 'hero'} launchingKey={launchingKey} />
			) : (
				<div className="absolute left-1/2 top-[37%] -translate-x-1/2 -translate-y-1/2 text-center" style={{animation: 'rise-in 0.7s cubic-bezier(0.05,0.7,0.1,1) 0.1s both'}}>
					<h1 className="font-extralight leading-none text-white/90" style={{fontSize: 58, letterSpacing: '-0.025em'}}>{greeting}</h1>
					<p className="mt-5 text-[13px] font-normal uppercase text-white/30" style={{letterSpacing: '0.34em'}}>{location.name}</p>
				</div>
			)}
			<Dock items={dock} selected={dockSel} active={zone === 'dock'} launchingId={launchingKey} />
		</div>
	);
}
