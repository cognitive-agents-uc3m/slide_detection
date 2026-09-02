/**
 * Comparación entre un punto de pointing (xn, yn — normalizado [0,1] sobre
 * la diapositiva, venga de donde venga: cámara calibrada, clic de ratón,
 * puntero…) y las cajas detectadas por Gemini para la diapositiva activa
 * (precalculadas por batch_analyze.py / serve_visual_test.py).
 *
 * Estabiliza el resultado en el tiempo con debounce: exige N frames
 * consecutivos con el mismo resultado antes de confirmar un cambio.
 */

const ELEMENT_CHANGE_FRAMES = 5; // frames consecutivos por defecto antes de confirmar un cambio

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
