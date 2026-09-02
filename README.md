# slide_detection — análisis por lotes + comparación de pointing

Prototipo del pipeline "PPT conocido de antemano" que evita la latencia de
Gemini en tiempo real: se analiza toda la presentación **antes** de la
clase, y durante la clase solo se hace una comparación geométrica barata
contra el resultado ya calculado.

Cubre las **fases 1 y 2** de ese pipeline (análisis por lotes + lógica de
comparación), verificadas de verdad con llamadas reales a Gemini y pruebas
automáticas. **No** incluye la fase 3 (captura de cámara + calibración +
pose/manos en vivo) — esa parte reutilizaría tal cual los módulos ya
existentes en `src/modules/` (ver más abajo cómo encajaría).

**Nivel 2 incluido**: cuando el Nivel 1 detecta `Diagram`/`Chart`, se recorta
esa región y se reclasifica contra las 28 categorías de DocFigure (ver
justificación completa en `dataset_slide_detection/gemini_detection/NIVEL1.md`).
Cada detección puede traer un campo `nivel2` además de `class`/`box`.

## Contenido

- **`batch_analyze.py`** — recorre una carpeta de imágenes de diapositivas
  (ya convertidas desde el PPT/PDF, con el conversor de `dataset_slide_detection/`)
  y llama a Gemini una vez por diapositiva, guardando todo en un único
  `analisis_ppt.json`. Mismo prompt y las mismas 16 clases que
  `dataset_slide_detection/gemini_detection/serve_gemini.py` — ver ese
  repositorio (`NIVEL1.md`) para la justificación completa del prompt y de
  por qué esas 16 clases.
- **`pointing_lookup.js`** — la lógica que se ejecutaría en el navegador
  durante la clase:
  - `findPointedElement(xn, yn, detections)` — punto contra cajas, con
    desempate por área menor cuando hay solape (pasa con frecuencia en las
    detecciones de Gemini, comprobado con datos reales en las pruebas).
  - `PointedElementTracker` — estabiliza el resultado en el tiempo con el
    mismo patrón de *debounce* que ya usa `BoardGrounding` para la rejilla
    3×3 (`REGION_CHANGE_FRAMES`, 5 frames por defecto).
- **`test_pointing_lookup.mjs`** — pruebas con datos sintéticos (esta carpeta
  no distribuye imágenes de diapositivas ni ningún `analisis_ppt.json`): las
  cajas usadas reproducen patrones reales observados con Gemini durante el
  desarrollo (solapes, desempates). Comprueba puntos dentro/fuera de caja, el
  desempate por área menor, y el comportamiento del debounce frame a frame.
  `node test_pointing_lookup.mjs` para ejecutarlas.
- **`interval_logger.js`** — `PointingIntervalLogger`: colapsa el flujo
  frame a frame del elemento estabilizado en intervalos `[inicio, fin]` por
  diapositiva/elemento, y los exporta a CSV. Pensado para entregarle a un
  módulo externo (p.ej. el de detección de deixis por voz de un compañero)
  "de aquí a aquí se señalaba esto", en vez de un log crudo a 30fps. El
  origen de los timestamps es el que tú decidas al llamar a `update()` —
  hay que acordarlo con quien vaya a cruzar este fichero con el suyo, o los
  intervalos no se alinearán con nada.
- **`test_interval_logger.mjs`** — pruebas del logger de intervalos, con
  datos sintéticos, incluida una integración con `PointedElementTracker`
  simulando una sesión completa. `node test_interval_logger.mjs`.
- **`visual_test.html` / `visual_test.js` / `visual_test.css`** — prueba
  visual e interactiva (sin terminal). **No trae ninguna diapositiva
  precargada** — arranca vacía, con un aviso de "sube tus propias
  diapositivas". Botón **"↑ Subir mis propias diapositivas"** — acepta
  imágenes sueltas o un PDF completo (se convierte a una imagen por página
  en el propio navegador), y cada una se analiza en vivo con Gemini. Una vez
  cargadas, navega entre ellas, haz clic para simular dónde apunta el dedo,
  y observa en vivo el resultado bruto vs. el estabilizado (con la barra de
  progreso del debounce). Usa `pointing_lookup.js` directamente, sin
  duplicar la lógica. Botón **"↓ Descargar CSV de intervalos"** — usa
  `PointingIntervalLogger` en vivo mientras haces clic por las diapositivas,
  y descarga el CSV con los intervalos de esa sesión de prueba.
- **`serve_visual_test.py`** — servidor que sirve `visual_test.html` y
  expone `/predict` para analizar en vivo las diapositivas que subas desde
  el navegador. Imprescindible ahora — sin él la página no tiene forma de
  cargar ninguna diapositiva.

## Cómo probarlo

Requiere un proyecto de **Google Cloud** con la **API de Vertex AI** habilitada. Configúralo
una vez:

```bash
pip install -r requirements.txt
cp .env.example .env            # y rellena GEMINI_PROJECT_ID con tu proyecto
gcloud auth application-default login   # si no lo tienes ya hecho
```

### Visualmente, sin terminal

```bash
python serve_visual_test.py
```

Abre `http://localhost:5055` y sube tus propias imágenes o un PDF con el botón de arriba.

### Por comando

```bash
python batch_analyze.py --images-dir ruta/a/tus/diapositivas --out analisis_ppt.json
node test_pointing_lookup.mjs
node test_interval_logger.mjs
```

## Cómo encajaría con la cámara en vivo (fase 3, no incluida aquí)

En el bucle de pointing real (`src/modules/grounding/grounding.js`,
`BoardGrounding.project()`), justo después de obtener el resultado:

```javascript
import { PointedElementTracker } from './pointing_lookup.js';
import { PointingIntervalLogger } from './interval_logger.js';

const tracker = new PointedElementTracker();
const sessionLog = new PointingIntervalLogger();       // para el módulo de voz de tu compañero
const videoStartMs = performance.now();                // origen de tiempo acordado con él
const analisisPPT = await fetch('analisis_ppt.json').then(r => r.json());
let currentSlideIndex = 0;  // se actualiza cuando el profesor cambia de diapositiva

// dentro del bucle de render, cada frame:
const result = boardGrounding.project(pointingResult, canvasWidth, canvasHeight, corners);
if (result) {
  const elemento = tracker.update(
    result.smoothed.x, result.smoothed.y,
    analisisPPT[currentSlideIndex]?.detections ?? []
  );
  // elemento?.class -> "Diagram", "Table", "Title"... o null

  const elapsedSec = (performance.now() - videoStartMs) / 1000;
  sessionLog.update(elapsedSec, currentSlideIndex, elemento);
}

// al terminar la sesión (o para exportar bajo demanda):
sessionLog.finish(elapsedSec);
const csv = sessionLog.toCSV();  // -> entregar a quien cruce esto con sus timestamps de voz
```

Ninguna de estas llamadas toca Gemini — todo el coste de red ya se pagó
antes de clase, en `batch_analyze.py`.

## Limitaciones ya conocidas (documentadas también en la conversación)

- Solo sirve para contenido **conocido de antemano** (un PPT ya cargado).
  Para pizarra física o contenido improvisado hace falta el enfoque
  complementario de análisis bajo demanda + caché por cambio detectado
  (no implementado aquí).
- Requiere que el punto de pointing (`xn, yn`) y las cajas de Gemini
  compartan el mismo sistema de coordenadas — solo se garantiza si la
  imagen usada para calibrar el plano rectificado es la misma que se envió
  a Gemini (ver la explicación de este problema en la conversación).
- Se ha observado alguna vez, en pruebas con imágenes reales, una caja que
  se sale ligeramente de `[0,1]` — inofensivo para la comparación (un punto
  de pointing nunca supera 1), pero recordatorio de que Gemini no es
  perfectamente preciso ni siquiera en el propio formato de salida.
- Las cajas de Gemini pueden ser imprecisas (demasiado grandes, mal
  ajustadas al contenido real) de forma no determinista — ver la discusión
  extensa sobre esto en la conversación. Cambiar de modelo (Flash, 2.5 Pro,
  3.1 Pro) no lo soluciona de forma fiable; cada uno falla de una manera
  distinta en los mismos casos difíciles.
