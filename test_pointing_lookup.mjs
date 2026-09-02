import { findPointedElement, PointedElementTracker } from './pointing_lookup.js';

// Datos de prueba sinteticos (no se distribuyen imagenes de diapositivas con
// esta carpeta). Las coordenadas de las cajas reproducen dos patrones que sí
// se observaron con Gemini en la práctica y que interesa seguir cubriendo:
// - slide1: una caja "Title" grande que solapa con una "Description" mucho
//   más pequeña anidada dentro — para probar el desempate por área menor.
// - slide2: un "Diagram" y una "Equation" bien separados entre sí.
const slide1 = [
  { class: 'Title', box: [0.096, 0.096, 0.595, 0.595] },
  { class: 'Description', box: [0.193, 0.183, 0.816, 0.816] },
  { class: 'Description', box: [0.381, 0.096, 0.443, 0.217] }, // anidada, área menor
  { class: 'Diagram', box: [0.41, 0.265, 0.495, 0.663] },
  { class: 'Table', box: [0.665, 0.189, 0.862, 0.809] },
];

const slide2 = [
  { class: 'Title', box: [0.059, 0.114, 0.691, 0.222] },
  { class: 'Diagram', box: [0.375, 0.66, 0.813, 0.999] },
  { class: 'Equation', box: [0.149, 0.742, 0.333, 0.811] },
];

let pass = 0, fail = 0;
function check(desc, actual, expected) {
  const ok = actual === expected;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${desc} -> ${actual}${ok ? '' : ` (esperaba ${expected})`}`);
  ok ? pass++ : fail++;
}

// ── diapositiva sintética 1 ──
console.log('\n--- diapositiva sintética 1 ---');

// Punto claramente dentro de la Tabla
check('dentro de la Tabla', findPointedElement(0.75, 0.5, slide1)?.class, 'Table');

// Punto claramente dentro del Diagram
check('dentro del Diagram', findPointedElement(0.45, 0.4, slide1)?.class, 'Diagram');

// Punto fuera de cualquier caja detectada (esquina superior izquierda vacía)
check('fuera de todo', findPointedElement(0.02, 0.02, slide1), null);

// Punto de solape: cae dentro de "Title" y de la "Description" pequeña y anidada.
// Debe ganar la más pequeña (Description), no Title.
const solapado = findPointedElement(0.41, 0.15, slide1);
check('desempate por área menor en solape', solapado?.class, 'Description');

// ── diapositiva sintética 2 ──
console.log('\n--- diapositiva sintética 2 ---');
check('dentro del Diagram', findPointedElement(0.6, 0.85, slide2)?.class, 'Diagram');
check('dentro de Equation', findPointedElement(0.25, 0.78, slide2)?.class, 'Equation');

// ── PointedElementTracker: estabilización temporal ──
console.log('\n--- PointedElementTracker (debounce a 3 frames) ---');
const tracker = new PointedElementTracker(3);

// Frames 1-2 apuntando al Diagram: todavía no debe confirmarse (necesita 3)
let r = tracker.update(0.45, 0.4, slide1);
check('frame 1 -> aún null (no confirmado)', r, null);
check('frame 1 -> progreso 1/3', JSON.stringify(tracker.getPendingProgress()), JSON.stringify({ count: 1, total: 3 }));
r = tracker.update(0.45, 0.4, slide1);
check('frame 2 -> aún null (no confirmado)', r, null);
check('frame 2 -> progreso 2/3', JSON.stringify(tracker.getPendingProgress()), JSON.stringify({ count: 2, total: 3 }));
r = tracker.update(0.45, 0.4, slide1);
check('frame 3 -> confirmado Diagram', r?.class, 'Diagram');
check('frame 3 -> progreso vuelve a 0/3 (ya confirmado)', JSON.stringify(tracker.getPendingProgress()), JSON.stringify({ count: 0, total: 3 }));

// Un solo frame de "ruido" fuera de todo no debe tirar el estado ya confirmado
r = tracker.update(0.02, 0.02, slide1);
check('1 frame de ruido -> mantiene Diagram (no confirmado el cambio aún)', r?.class, 'Diagram');

// Pero si el punto vuelve al Diagram, el contador de "pending" se reinicia
// y sigue mostrando Diagram sin parpadear
r = tracker.update(0.45, 0.4, slide1);
check('vuelve al Diagram -> sigue Diagram', r?.class, 'Diagram');

console.log(`\n${pass} OK / ${fail} FAIL`);
process.exit(fail > 0 ? 1 : 0);
