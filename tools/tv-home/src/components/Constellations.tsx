import {useEffect, useRef} from 'react';

// Animated background — inspired by the Wallpaper Engine scene "Calm Space | Constellations
// | Minimalism" (workshop 3323607194): black bg, static colours (no hue shift), a red mouse
// trail, ~30fps. Composed as an explicit DEPTH STACK so each layer reads on its own:
//   • starfield  — dense tiny twinkling white stars (deepest texture)
//   • BACKGROUND — blue, small / dim / dense / slow   (far)
//   • MIDGROUND  — red, medium
//   • FOREGROUND — white, large / bright / sparse / fast (near, biggest parallax)
// + Magic-Remote hover (cursor joins the nearby network) + red pointer trail + the
// two-penguin constellation (the house mascot).
// PERF: 1080p canvas (1:1 with the panel), 30fps, and every layer is BATCHED into one
// path per bucket (a handful of fill/stroke calls per frame instead of ~750), with
// desynchronized rendering. Pauses off-home so it never competes with an app.

type P = {x: number; y: number; vx: number; vy: number; r: number; ph: number};
type Star = {x: number; y: number; r: number; ph: number; spd: number; base: number};
type Layer = {rgb: number[]; core: number[]; count: number; speed: number; rMin: number; rMax: number; link: number; dotA: number; lineA: number; halo: number; pts: P[]};

const BG = '#000000', TAU = 6.28319, REF = 1920;

// depth stack geometry, ordered back → front (also the draw order); colors come
// from the selected THEME (user config). Counts/links contenidos: la TV va más
// fluida con una red menos densa y se sigue leyendo igual de bonita.
const LAYER_GEO = [
	{count: 52, speed: 0.10, rMin: 0.8, rMax: 1.7, link: 130, dotA: 0.82, lineA: 0.34, halo: 0.14}, // BACKGROUND — small/dim/dense/slow
	{count: 36, speed: 0.17, rMin: 1.3, rMax: 2.4, link: 158, dotA: 0.92, lineA: 0.46, halo: 0.18}, // MIDGROUND
	{count: 24, speed: 0.28, rMin: 2.0, rMax: 3.8, link: 196, dotA: 1.0,  lineA: 0.6,  halo: 0.26}  // FOREGROUND — large/bright/sparse/fast
];

export type ConstellationTheme = 'classic' | 'mono' | 'ember' | 'aurora';
// [rgb, core] per depth layer (back → front) + pointer-trail color
const THEMES: Record<ConstellationTheme, {layers: [number[], number[]][]; trail: number[]}> = {
	classic: {layers: [[[95, 150, 205], [150, 197, 240]], [[206, 92, 92], [242, 156, 156]], [[216, 226, 238], [255, 255, 255]]], trail: [255, 50, 50]},
	mono:    {layers: [[[70, 120, 200], [120, 170, 240]], [[100, 150, 230], [160, 200, 255]], [[185, 210, 245], [235, 244, 255]]], trail: [120, 170, 255]},
	ember:   {layers: [[[190, 105, 55], [235, 165, 105]], [[215, 75, 55], [255, 140, 110]], [[242, 212, 170], [255, 242, 222]]], trail: [255, 120, 40]},
	aurora:  {layers: [[[55, 155, 135], [115, 215, 185]], [[85, 110, 215], [145, 170, 255]], [[190, 240, 220], [240, 255, 250]]], trail: [80, 230, 160]}
};

const STARS = {count: 220, rMin: 0.35, rMax: 1.7};      // dense faint twinkling starfield
const HOVER_REF = 300;

// ---- pingüinos-constelación (la pareja de la foto, hecha de estrellas) ----
// Silueta de una pieza (cabeza y cuerpo), barriga, aletín exterior, aletín
// interior (se dan la mano), patas, pico, ojos (él abiertos, ella cerrados),
// mejillas y corazones. Todo normalizado 0..1, en el cuadrado de cada pingüino.
const PENG_BODY: [number, number][] = [
	[0.50, 0.02], [0.63, 0.05], [0.73, 0.12], [0.79, 0.21], [0.86, 0.34],
	[0.90, 0.50], [0.88, 0.66], [0.80, 0.80], [0.66, 0.90], [0.50, 0.93],
	[0.34, 0.90], [0.20, 0.80], [0.12, 0.66], [0.10, 0.50], [0.14, 0.34],
	[0.21, 0.21], [0.27, 0.12], [0.37, 0.05]
];
const PENG_BELLY: [number, number][] = [
	[0.50, 0.30], [0.63, 0.36], [0.69, 0.53], [0.66, 0.72], [0.55, 0.85],
	[0.45, 0.85], [0.34, 0.72], [0.31, 0.53], [0.37, 0.36]
];
const PENG_FLIP_OUT: [number, number][] = [[0.16, 0.30], [-0.02, 0.53], [0.12, 0.63]];
const PENG_FLIP_IN: [number, number][] = [[0.84, 0.30], [0.96, 0.50], [0.87, 0.63]];
const PENG_FOOT_L: [number, number][] = [[0.37, 0.90], [0.30, 0.99], [0.46, 0.96]];
const PENG_FOOT_R: [number, number][] = [[0.54, 0.96], [0.70, 0.99], [0.63, 0.90]];
const PENG_BEAK: [number, number][] = [[0.50, 0.20], [0.55, 0.235], [0.50, 0.27], [0.45, 0.235]];
const PENG_EYES: [number, number][] = [[0.385, 0.20], [0.615, 0.20]];
const PENG_EYES_HAPPY: [number, number][][] = [
	[[0.330, 0.220], [0.385, 0.180], [0.440, 0.220]],
	[[0.560, 0.220], [0.615, 0.180], [0.670, 0.220]]
];
const PENG_BLUSH: [number, number][] = [[0.295, 0.235], [0.705, 0.235]];
const PENG_COLORS = {
	boy: {line: [175, 200, 245], core: [240, 246, 255]},   // azul suave
	girl: {line: [250, 185, 215], core: [255, 242, 249]}   // rosa suave
};
const PENG_ORANGE = [255, 185, 95];
const PENG_PINK = [255, 145, 185];
// corazón: contorno normalizado (centro 0,0; ~1 de ancho)
const HEART: [number, number][] = [
	[0, 0.30], [-0.34, -0.02], [-0.50, -0.28], [-0.46, -0.46], [-0.27, -0.52],
	[0, -0.34], [0.27, -0.52], [0.46, -0.46], [0.50, -0.28], [0.34, -0.02]
];
const HEARTS: {x: number; y: number; s: number; c: number[]}[] = [
	{x: 0.895, y: 0.110, s: 0.095, c: [255, 92, 112]},
	{x: 1.015, y: 0.045, s: 0.065, c: [255, 120, 140]},
	{x: 0.955, y: 0.205, s: 0.045, c: [255, 155, 172]}
];

function mk (count: number, speed: number, rMin: number, rMax: number, W: number, H: number): P[] {
	const pts: P[] = [];
	for (let i = 0; i < count; i++) { const a = Math.random() * TAU; pts.push({x: Math.random() * W, y: Math.random() * H, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, r: rMin + Math.random() * (rMax - rMin), ph: Math.random() * TAU}); }
	return pts;
}
function mkStars (W: number, H: number, SC: number, density = 1): Star[] {
	const s: Star[] = [];
	for (let i = 0; i < Math.round(STARS.count * density); i++) { s.push({x: Math.random() * W, y: Math.random() * H, r: (STARS.rMin + Math.random() * (STARS.rMax - STARS.rMin)) * SC, ph: Math.random() * TAU, spd: 0.001 + Math.random() * 0.004, base: 0.3 + Math.random() * 0.65}); }
	return s;
}

// density/speed/theme are user config (Settings overlay); animated=false
// draws ONE static frame and never schedules another — zero per-frame cost.
export default function Constellations ({active, animated = true, density = 1, speed = 1, theme = 'classic'}: {active: boolean; animated?: boolean; density?: number; speed?: number; theme?: ConstellationTheme}) {
	const ref = useRef<HTMLCanvasElement>(null);
	const S = useRef<{key: string; layers: Layer[]; stars: Star[]; trail: {x: number; y: number; life: number}[]; mx: number; my: number; seen: number} | null>(null);

	useEffect(() => {
		const canvas = ref.current;
		if (!canvas) return;
		const ctx = canvas.getContext('2d', {alpha: false});
		if (!ctx) return;
		const W = 1920;                                              // 1:1 con el panel
		const H = Math.round(W * window.innerHeight / window.innerWidth);
		const SC = W / REF;
		const HOVER = HOVER_REF * SC;
		canvas.width = W; canvas.height = H;

		// regenerate the field when the config knobs change (key mismatch)
		const colors = THEMES[theme] || THEMES.classic;
		const key = `${density}|${speed}|${theme}`;
		if (!S.current || S.current.key !== key) {
			S.current = {
				key,
				layers: LAYER_GEO.map((d, i) => ({...d, rgb: colors.layers[i][0], core: colors.layers[i][1], count: Math.round(d.count * density), link: d.link * SC, pts: mk(Math.round(d.count * density), d.speed * speed * SC, d.rMin * SC, d.rMax * SC, W, H)})),
				stars: mkStars(W, H, SC, density),
				trail: [], mx: -9999, my: -9999, seen: -99999
			};
		}
		const st = S.current;
		const TRAIL_RGB = colors.trail;

		// pareja de pingüinos, cogidos de la mano (el punto de unión es compartido)
		const PX = W * 0.035, PY = H * 0.025, PS = H * 0.29;
		const OFF = 0.92 * PS;
		const hands = {x: PX + 0.96 * PS, y: PY + 0.50 * PS};
		const boyX = (x: number) => PX + x * PS;
		const girlX = (x: number) => PX + OFF + (1 - x) * PS;
		const pY = (y: number) => PY + y * PS;

		const onMove = (e: MouseEvent) => {
			st.mx = e.clientX / window.innerWidth * W;
			st.my = e.clientY / window.innerHeight * H;
			st.seen = performance.now();
			st.trail.push({x: st.mx, y: st.my, life: 1});
			if (st.trail.length > 80) st.trail.shift();
		};
		window.addEventListener('mousemove', onMove);
		window.addEventListener('pointermove', onMove);

		let raf = 0, last = 0;
		const frame = (t: number) => {
			raf = requestAnimationFrame(frame);
			if (t - last < 32) return;                       // ~30fps (config rate 29)
			const dt = last ? Math.min(2.2, (t - last) / 16.67) : 1; last = t;

			ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H);
			ctx.lineJoin = 'round';

			// starfield: 4 buckets de brillo → 4 fills en vez de 300
			ctx.fillStyle = 'rgb(255,255,255)';
			for (let b = 0; b < 4; b++) {
				ctx.globalAlpha = (b + 1) * 0.16;
				ctx.beginPath();
				for (const s of st.stars) {
					const tw = 0.5 + 0.5 * Math.sin(t * s.spd + s.ph);
					if (Math.min(3, Math.floor(s.base * (0.35 + 0.65 * tw) * 4)) === b) {
						ctx.moveTo(s.x + s.r, s.y); ctx.arc(s.x, s.y, s.r, 0, TAU);
					}
				}
				ctx.fill();
			}

			const age = t - st.seen, pOn = age < 1400, pFade = pOn ? Math.max(0, 1 - age / 1400) : 0;

			// depth layers back → front (links + halos + cores, empaquetados)
			for (const L of st.layers) {
				const pts = L.pts;
				for (const p of pts) {
					p.x += p.vx * dt; p.y += p.vy * dt;
					if (pOn) { const dx = st.mx - p.x, dy = st.my - p.y, d2 = dx * dx + dy * dy; if (d2 < HOVER * HOVER) { const f = (1 - Math.sqrt(d2) / HOVER) * 0.05 * pFade; p.x += dx * f; p.y += dy * f; } }
					if (p.x < 0) p.x += W; else if (p.x > W) p.x -= W;
					if (p.y < 0) p.y += H; else if (p.y > H) p.y -= H;
				}
				// enlaces: un solo path y un solo stroke por capa
				ctx.strokeStyle = `rgb(${L.rgb[0]},${L.rgb[1]},${L.rgb[2]})`; ctx.lineWidth = SC;
				ctx.globalAlpha = L.lineA * 0.9;
				const l2 = L.link * L.link;
				ctx.beginPath();
				for (let i = 0; i < pts.length; i++) {
					const a = pts[i];
					for (let j = i + 1; j < pts.length; j++) {
						const c = pts[j];
						const dx = a.x - c.x, dy = a.y - c.y;
						if (dx * dx + dy * dy < l2) { ctx.moveTo(a.x, a.y); ctx.lineTo(c.x, c.y); }
					}
				}
				ctx.stroke();
				// halos: un fill por capa
				ctx.fillStyle = `rgb(${L.rgb[0]},${L.rgb[1]},${L.rgb[2]})`;
				ctx.globalAlpha = L.dotA * L.halo * 0.85;
				ctx.beginPath();
				for (const p of pts) { ctx.moveTo(p.x + p.r * 2.8, p.y); ctx.arc(p.x, p.y, p.r * 2.8, 0, TAU); }
				ctx.fill();
				// núcleos: 3 niveles de parpadeo → 3 fills por capa
				ctx.fillStyle = `rgb(${L.core[0]},${L.core[1]},${L.core[2]})`;
				for (let b = 0; b < 3; b++) {
					ctx.globalAlpha = L.dotA * (0.45 + b * 0.275);
					ctx.beginPath();
					for (const p of pts) {
						const tw = 0.72 + 0.28 * Math.sin(t * 0.002 + p.ph);
						if (Math.min(2, Math.floor((tw - 0.44) / 0.186)) === b) { ctx.moveTo(p.x + p.r, p.y); ctx.arc(p.x, p.y, p.r, 0, TAU); }
					}
					ctx.fill();
				}
			}

			// ---- pingüinos-constelación ----
			const ptw = 0.5 + 0.5 * Math.sin(t * 0.0012);
			const poly = (pts: [number, number][], tx: (x: number) => number, color: number[], alpha: number, w: number) => {
				ctx.strokeStyle = `rgb(${color[0]},${color[1]},${color[2]})`;
				ctx.lineWidth = w;
				ctx.globalAlpha = alpha;
				ctx.beginPath();
				ctx.moveTo(tx(pts[0][0]), pY(pts[0][1]));
				for (let i = 1; i < pts.length; i++) ctx.lineTo(tx(pts[i][0]), pY(pts[i][1]));
				ctx.closePath(); ctx.stroke();
			};
			const starsAt = (pts: [number, number][], tx: (x: number) => number, color: number[], r: number, alpha: number) => {
				ctx.fillStyle = `rgb(${color[0]},${color[1]},${color[2]})`;
				ctx.globalAlpha = alpha;
				ctx.beginPath();
				for (const [x, y] of pts) { ctx.moveTo(tx(x) + r, pY(y)); ctx.arc(tx(x), pY(y), r, 0, TAU); }
				ctx.fill();
			};
			const drawPeng = (tx: (x: number) => number, c: {line: number[]; core: number[]}, happy: boolean) => {
				const la = 0.46 + 0.16 * ptw;
				poly(PENG_BODY, tx, c.line, la, 1.4 * SC);
				// barriga: relleno blanco tenue (la mancha de la foto) + contorno
				ctx.fillStyle = `rgb(${c.core[0]},${c.core[1]},${c.core[2]})`;
				ctx.globalAlpha = 0.13;
				ctx.beginPath();
				ctx.moveTo(tx(PENG_BELLY[0][0]), pY(PENG_BELLY[0][1]));
				for (let i = 1; i < PENG_BELLY.length; i++) ctx.lineTo(tx(PENG_BELLY[i][0]), pY(PENG_BELLY[i][1]));
				ctx.closePath(); ctx.fill();
				poly(PENG_BELLY, tx, c.core, la * 0.62, SC);
				// estrellas interiores: la mancha clara de la barriga
				starsAt([[0.42, 0.44], [0.58, 0.44], [0.50, 0.52], [0.40, 0.62], [0.60, 0.62], [0.44, 0.72], [0.56, 0.72], [0.50, 0.79]], tx, c.core, 1.1 * SC, 0.45);
				poly(PENG_FLIP_OUT, tx, c.line, la, 1.3 * SC);
				poly(PENG_FLIP_IN, tx, c.line, la, 1.3 * SC);
				poly(PENG_FOOT_L, tx, PENG_ORANGE, 0.8, 1.2 * SC);
				poly(PENG_FOOT_R, tx, PENG_ORANGE, 0.8, 1.2 * SC);
				poly(PENG_BEAK, tx, PENG_ORANGE, 0.9, 1.3 * SC);
				// estrellas de los contornos (un fill por grupo de color)
				starsAt(PENG_BODY, tx, c.core, 1.8 * SC, 0.85);
				starsAt(PENG_BELLY, tx, c.core, 1.25 * SC, 0.4);
				starsAt(PENG_FLIP_OUT, tx, c.line, 1.7 * SC, 0.7);
				starsAt(PENG_FLIP_IN, tx, c.line, 1.7 * SC, 0.7);
				starsAt([...PENG_FOOT_L, ...PENG_FOOT_R], tx, PENG_ORANGE, 1.5 * SC, 0.8);
				starsAt(PENG_BEAK, tx, PENG_ORANGE, 1.5 * SC, 0.9);
				// mejillas
				starsAt(PENG_BLUSH, tx, PENG_PINK, 4.5 * SC, 0.7);
				// ojos: él abiertos; ella felices (cerrados)
				if (happy) {
					ctx.strokeStyle = `rgb(${c.core[0]},${c.core[1]},${c.core[2]})`;
					ctx.lineWidth = 2.4 * SC;
					ctx.globalAlpha = 0.95;
					for (const eye of PENG_EYES_HAPPY) {
						ctx.beginPath();
						ctx.moveTo(tx(eye[0][0]), pY(eye[0][1]));
						ctx.lineTo(tx(eye[1][0]), pY(eye[1][1]));
						ctx.lineTo(tx(eye[2][0]), pY(eye[2][1]));
						ctx.stroke();
					}
				} else {
					starsAt(PENG_EYES, tx, c.core, 6 * SC, 1);
				}
			};
			drawPeng(boyX, PENG_COLORS.boy, false);
			drawPeng(girlX, PENG_COLORS.girl, true);
			// manos: estrella compartida
			ctx.strokeStyle = 'rgb(235,240,255)';
			ctx.fillStyle = 'rgb(235,240,255)';
			ctx.globalAlpha = 0.25 + 0.12 * ptw;
			ctx.beginPath(); ctx.arc(hands.x, hands.y, 10 * SC, 0, TAU); ctx.stroke();
			ctx.globalAlpha = 0.92;
			ctx.beginPath(); ctx.arc(hands.x, hands.y, 3.2 * SC, 0, TAU); ctx.fill();
			// corazones flotando entre las cabezas
			for (const h of HEARTS) {
				const pulse = 0.72 + 0.2 * Math.sin(t * 0.0015 + h.x * 10);
				ctx.fillStyle = `rgb(${h.c[0]},${h.c[1]},${h.c[2]})`;
				ctx.strokeStyle = `rgb(${h.c[0]},${h.c[1]},${h.c[2]})`;
				ctx.beginPath();
				ctx.moveTo(boyX(h.x), pY(h.y + HEART[0][1] * h.s));
				for (let i = 1; i < HEART.length; i++) ctx.lineTo(boyX(h.x + HEART[i][0] * h.s), pY(h.y + HEART[i][1] * h.s));
				ctx.closePath();
				ctx.globalAlpha = 0.10 * pulse;
				ctx.fill();
				ctx.lineWidth = 1.4 * SC;
				ctx.globalAlpha = pulse;
				ctx.stroke();
				ctx.globalAlpha = 0.95;
				ctx.beginPath(); ctx.arc(boyX(h.x), pY(h.y + 0.28 * h.s), 2.1 * SC, 0, TAU); ctx.fill();
			}

			// magic hover — join the cursor into the nearby network + bright node
			if (pOn) {
				ctx.strokeStyle = 'rgb(190,215,240)'; ctx.lineWidth = SC;
				ctx.globalAlpha = 0.4 * pFade;
				ctx.beginPath();
				for (const L of st.layers) { for (const p of L.pts) { const dx = st.mx - p.x, dy = st.my - p.y; if (dx * dx + dy * dy < HOVER * HOVER) { ctx.moveTo(st.mx, st.my); ctx.lineTo(p.x, p.y); } } }
				ctx.stroke();
				ctx.globalAlpha = 0.95 * pFade; ctx.fillStyle = 'rgb(230,240,252)'; ctx.beginPath(); ctx.arc(st.mx, st.my, 3.4 * SC, 0, TAU); ctx.fill();
			}

			// red mouse trail
			if (st.trail.length) {
				ctx.fillStyle = `rgb(${TRAIL_RGB[0]},${TRAIL_RGB[1]},${TRAIL_RGB[2]})`;
				for (let i = st.trail.length - 1; i >= 0; i--) {
					const q = st.trail[i]; q.life -= 0.03 * dt;
					if (q.life <= 0) { st.trail.splice(i, 1); continue; }
					ctx.globalAlpha = q.life * 0.7; ctx.beginPath(); ctx.arc(q.x, q.y, (3 * q.life + 0.8) * SC, 0, TAU); ctx.fill();
				}
			}

			ctx.globalAlpha = 1;
		};

		// En segundo plano (otra app delante) el canvas se para: cero CPU y la
		// app que entra arranca con todos los recursos libres.
		const onVis = () => {
			if (document.hidden) { cancelAnimationFrame(raf); raf = 0; }
			else if (active && animated && !raf) { last = 0; raf = requestAnimationFrame(frame); }
		};
		document.addEventListener('visibilitychange', onVis);

		if (active && animated) { last = 0; raf = requestAnimationFrame(frame); }
		else if (active) {
			last = 0;
			raf = requestAnimationFrame((t) => { frame(t); cancelAnimationFrame(raf); });
		}
		return () => { cancelAnimationFrame(raf); document.removeEventListener('visibilitychange', onVis); window.removeEventListener('mousemove', onMove); window.removeEventListener('pointermove', onMove); };
	}, [active, animated, density, speed, theme]);

	return <canvas ref={ref} className="absolute inset-0 h-full w-full" style={{opacity: active ? 1 : 0, transition: 'opacity 0.55s ease-in-out', willChange: 'opacity'}} />;
}
