/**
 * Comparación entre el punto de pointing (xn, yn — normalizado [0,1] sobre
 * el plano rectificado, el mismo que produce BoardGrounding.project() en
 * src/modules/grounding/grounding.js) y las cajas detectadas por Gemini
 * para la diapositiva activa (precalculadas por batch_analyze.py).
 *
 * Estabiliza el resultado en el tiempo con el mismo patrón de debounce que
 * ya usa BoardGrounding para la rejilla 3x3 (_pendingRegion/_pendingRegionCount,
 * por defecto 5 frames consecutivos antes de confirmar un cambio).
 */

const ELEMENT_CHANGE_FRAMES = 5; // mismo valor por defecto que REGION_CHANGE_FRAMES

/**
 * Encuentra la detección cuya caja contiene el punto (xn, yn).
 * Si varias cajas se solapan sobre el punto (ocurre con cierta frecuencia
 * en las detecciones de Gemini), gana la de área menor — la más específica.
 *
 * @param {number} xn - coordenada x normalizada [0,1]
 * @param {number} yn - coordenada y normalizada [0,1]
 * @param {Array<{class:string, box:[number,number,number,number]}>} detections
 * @returns {{class:string, box:number[]} | null}
 */
export function findPointedElement(xn, yn, detections) {
  let best = null;
  let bestArea = Infinity;

  for (const det of detections ?? []) {
    const [x1, y1, x2, y2] = det.box;
    const inside = xn >= x1 && xn <= x2 && yn >= y1 && yn <= y2;
    if (!inside) continue;

    const area = (x2 - x1) * (y2 - y1);
    if (area < bestArea) {
      bestArea = area;
      best = det;
    }
  }

  return best;
}

function keyOf(det) {
  return det ? `${det.class}:${det.box.join(',')}` : null;
}

/**
 * Estabiliza temporalmente el elemento señalado: exige N frames
 * consecutivos con el mismo resultado (incluido "nada") antes de
 * confirmar el cambio, para no parpadear cuando el punto ronda un borde
 * entre dos cajas.
 */
export class PointedElementTracker {
  constructor(changeFrames = ELEMENT_CHANGE_FRAMES) {
    this._changeFrames = Math.max(1, Math.round(changeFrames));
    this._current = null;
    this._pending = null;
    this._pendingCount = 0;
  }

  setChangeFrames(n) {
    this._changeFrames = Math.max(1, Math.round(n));
  }

  /**
   * Progreso del cambio pendiente de confirmar (para mostrar una barra de
   * progreso, por ejemplo). `count` es 0 si no hay ningún cambio pendiente.
   * @returns {{count: number, total: number}}
   */
  getPendingProgress() {
    return { count: this._pendingCount, total: this._changeFrames };
  }

  reset() {
    this._current = null;
    this._pending = null;
    this._pendingCount = 0;
  }

  /**
   * @param {number} xn
   * @param {number} yn
   * @param {Array} detections - detecciones de la diapositiva activa
   * @returns {{class:string, box:number[]} | null} elemento estabilizado
   */
  update(xn, yn, detections) {
    const raw = findPointedElement(xn, yn, detections);
    const rawKey = keyOf(raw);

    if (rawKey === keyOf(this._current)) {
      this._pending = null;
      this._pendingCount = 0;
      return this._current;
    }

    if (rawKey === keyOf(this._pending)) {
      this._pendingCount++;
    } else {
      this._pending = raw;
      this._pendingCount = 1;
    }

    if (this._pendingCount >= this._changeFrames) {
      this._current = raw;
      this._pending = null;
      this._pendingCount = 0;
    }

    return this._current;
  }
}
