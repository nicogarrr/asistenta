import {useEffect, useState} from 'react';
import {greetingFor, periodAt, watchPeriod, type Period} from './greeting';

/** Saludo y franja segun la hora local de la TV; se actualiza solo al cambiar de franja. */
export function useGreeting (userName?: string | null): {greeting: string; period: Period} {
	const [h, setH] = useState(() => new Date().getHours());
	useEffect(() => watchPeriod(() => setH(new Date().getHours())), []);
	return {greeting: greetingFor(h, userName), period: periodAt(h)};
}
