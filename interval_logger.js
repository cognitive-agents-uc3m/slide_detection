/**
 * Colapsa el flujo frame a frame del elemento señalado (ya estabilizado por
 * PointedElementTracker) en intervalos [inicio, fin] — pensado para
 * entregarle a un módulo externo (p.ej. el de detección de deixis por voz
 * de un compañero) un fichero con "de aquí a aquí, se señalaba esto en esta
 * diapositiva", en vez de un log crudo de 30 filas por segundo.
 *
 * Importante para quien consuma el CSV: los timestamps son relativos al
 * origen que tú elijas al llamar a update() (p.ej. segundos desde el inicio
 * del vídeo) — acuerda ese origen con quien vaya a cruzar este fichero con
 * el suyo, si no los intervalos no se van a alinear con nada.
 */
export class PointingIntervalLogger {
  constructor() {
    this._intervals = [];  // intervalos ya cerrados
    this._current = null;  // intervalo abierto: {start, slide, class, nivel2}
  }

  /**
   * Llamar una vez por "frame" (real o simulado) con el elemento YA
   * estabilizado (salida de PointedElementTracker.update()), el índice de
   * diapositiva activa, y el timestamp en segundos respecto al origen
   * acordado. Abre/cierra intervalos automáticamente cuando el elemento
   * confirmado (o la diapositiva) cambia.
   *
   * @param {number} timeSec
   * @param {number} slideIndex
   * @param {{class:string, nivel2?:string} | null} element
   */
  update(timeSec, slideIndex, element) {
    const key = element ? `${slideIndex}:${element.class}:${element.nivel2 ?? ''}` : null;
    const currentKey = this._current
      ? `${this._current.slide}:${this._current.class}:${this._current.nivel2 ?? ''}`
      : null;

    if (key === currentKey) return; // sin cambios, el intervalo abierto sigue igual

    this._closeCurrent(timeSec);

    if (element) {
      this._current = {
        start: timeSec,
        slide: slideIndex,
        class: element.class,
        nivel2: element.nivel2 ?? null,
      };
    }
  }

  _closeCurrent(timeSec) {
    if (this._current) {
      this._intervals.push({ ...this._current, end: timeSec });
      this._current = null;
    }
  }

  /** Cierra cualquier intervalo que hubiera quedado abierto al terminar la sesión. */
  finish(timeSec) {
    this._closeCurrent(timeSec);
  }

  /** Reinicia el registro por completo (nueva sesión). */
  reset() {
    this._intervals = [];
    this._current = null;
  }

  /** Copia de los intervalos ya cerrados (no incluye uno abierto sin cerrar). */
  getIntervals() {
    return this._intervals.map(iv => ({ ...iv }));
  }

  /** Exporta los intervalos cerrados como texto CSV. */
  toCSV() {
    const header = 'inicio_s,fin_s,diapositiva,elemento_nivel1,elemento_nivel2';
    const rows = this._intervals.map(iv => [
      iv.start.toFixed(2),
      iv.end.toFixed(2),
      iv.slide,
      iv.class,
      iv.nivel2 ?? '',
    ].join(','));
    return [header, ...rows].join('\n');
  }
}
