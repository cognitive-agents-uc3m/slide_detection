import { PointingIntervalLogger } from './interval_logger.js';
import { PointedElementTracker } from './pointing_lookup.js';

let pass = 0, fail = 0;
function check(desc, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${desc} -> ${JSON.stringify(actual)}${ok ? '' : ` (esperaba ${JSON.stringify(expected)})`}`);
  ok ? pass++ : fail++;
}

// ── 1. Comportamiento puro del logger (sin pointing real de por medio) ──────
console.log('--- Comportamiento del logger ---');

let log = new PointingIntervalLogger();
log.update(0.0, 0, { class: 'Title' });
log.update(1.0, 0, { class: 'Title' });      // mismo elemento -> no abre intervalo nuevo
log.update(2.0, 0, { class: 'Diagram', nivel2: 'Tree diagram' });  // cambia -> cierra el de Title
log.update(4.0, 0, { class: 'Diagram', nivel2: 'Tree diagram' });  // mismo -> sigue igual
log.update(5.0, 0, null);                     // deja de señalar -> cierra el de Diagram
log.finish(5.5);

check('2 intervalos cerrados', log.getIntervals().length, 2);
check('intervalo 1: Title 0.0-2.0', log.getIntervals()[0], { start: 0, slide: 0, class: 'Title', nivel2: null, end: 2 });
check('intervalo 2: Diagram/Tree diagram 2.0-5.0', log.getIntervals()[1],
  { start: 2, slide: 0, class: 'Diagram', nivel2: 'Tree diagram', end: 5 });

// Mismo Nivel1 pero distinto Nivel2 debe contar como cambio de intervalo
log = new PointingIntervalLogger();
log.update(0, 0, { class: 'Diagram', nivel2: 'Tree diagram' });
log.update(1, 0, { class: 'Diagram', nivel2: 'Block diagram' }); // mismo class, nivel2 distinto
log.finish(2);
check('Diagram con nivel2 distinto cuenta como cambio (2 intervalos: Tree y Block)', log.getIntervals().length, 2);
check('el primer intervalo cerrado es el de Tree diagram (0.0-1.0)', log.getIntervals()[0].nivel2, 'Tree diagram');
check('el segundo es Block diagram (1.0-2.0, cerrado por finish)', log.getIntervals()[1].nivel2, 'Block diagram');

// Cambiar de diapositiva con el mismo elemento también debe cerrar el intervalo
log = new PointingIntervalLogger();
log.update(0, 0, { class: 'Title' });
log.update(1, 1, { class: 'Title' }); // misma clase, diapositiva distinta
log.finish(2);
check('cambio de diapositiva fuerza nuevo intervalo (2: diapositiva 0 y 1)', log.getIntervals().length, 2);
check('el primer intervalo cerrado es de la diapositiva 0', log.getIntervals()[0].slide, 0);
check('el segundo es de la diapositiva 1 (cerrado por finish)', log.getIntervals()[1].slide, 1);

// CSV
log = new PointingIntervalLogger();
log.update(0, 3, { class: 'Table' });
log.finish(2.5);
const csv = log.toCSV();
check('cabecera CSV correcta', csv.split('\n')[0], 'inicio_s,fin_s,diapositiva,elemento_nivel1,elemento_nivel2');
check('fila CSV correcta', csv.split('\n')[1], '0.00,2.50,3,Table,');

// ── 2. Integración: PointedElementTracker + PointingIntervalLogger ──
console.log('\n--- Integración con datos sintéticos ---');

const tracker = new PointedElementTracker(3); // 3 "frames" para confirmar, igual que el otro test
const sessionLog = new PointingIntervalLogger();

// Simulamos una sesion: 5 "frames" señalando el Title de la diapositiva 0,
// luego cambiamos a la diapositiva 2 y señalamos el Diagram (Tree diagram).
// Coordenadas de caja sintéticas (mismo patrón visto con Gemini en la práctica).
const slide0 = [
  { class: 'Title', box: [0.297, 0.06, 0.72, 0.143] },
];
const slide2 = [
  { class: 'Diagram', nivel2: 'Tree diagram', box: [0.375, 0.66, 0.813, 0.999] },
];

let t = 0;
const TICK = 0.2; // 200ms por "frame", igual que TICK_MS en visual_test.js

// 5 frames en el Title de la diapositiva 0 (dentro de [0.297,0.06,0.72,0.143])
for (let i = 0; i < 5; i++) {
  const stable = tracker.update(0.5, 0.1, slide0);
  sessionLog.update(t, 0, stable);
  t += TICK;
}

// cambio de diapositiva: se resetea el tracker (igual que hace loadSlide() en visual_test.js)
tracker.reset();

// 5 frames en el Diagram de la diapositiva 2 (dentro de [0.375,0.66,0.813,0.999])
for (let i = 0; i < 5; i++) {
  const stable = tracker.update(0.6, 0.8, slide2);
  sessionLog.update(t, 2, stable);
  t += TICK;
}
sessionLog.finish(t);

const intervals = sessionLog.getIntervals();
console.log(sessionLog.toCSV());

check('2 intervalos en la sesión simulada', intervals.length, 2);
check('intervalo 1 es Title en diapositiva 0', [intervals[0]?.slide, intervals[0]?.class], [0, 'Title']);
check('intervalo 2 es Diagram/Tree diagram en diapositiva 2',
  [intervals[1]?.slide, intervals[1]?.class, intervals[1]?.nivel2], [2, 'Diagram', 'Tree diagram']);

console.log(`\n${pass} OK / ${fail} FAIL`);
process.exit(fail > 0 ? 1 : 0);
