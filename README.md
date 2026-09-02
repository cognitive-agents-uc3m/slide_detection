# slide_detection — detección de elementos en diapositivas con Gemini

Analiza las diapositivas de una presentación con Gemini (Vertex AI) y devuelve, para cada
una, las cajas normalizadas `[0,1]²` de sus elementos (título, tabla, diagrama, código…).
Pensado para precalcularse **antes** de una clase o charla, de forma que averiguar a qué
elemento apunta alguien en directo sea después solo una comparación geométrica barata (punto
contra cajas), sin volver a llamar a Gemini en tiempo real.

**Nivel 2 incluido**: cuando el Nivel 1 detecta `Diagram`/`Chart`, recorta esa región y la
reclasifica contra las 28 categorías del dataset DocFigure (Jobin, Mondal y Jawahar, ICDARW
2019) — ver la lista completa y el prompt en `batch_analyze.py` / `serve_visual_test.py`. Cada
detección puede traer un campo `nivel2` además de `class`/`box`.

## Contenido

- **`batch_analyze.py`** — recorre una carpeta de imágenes de diapositivas (ya convertidas
  desde el PDF/PPT a PNG/JPG, una por página) y llama a Gemini una vez por diapositiva,
  guardando todo en un único `analisis_ppt.json`.
- **`serve_visual_test.py`** — servidor Flask que sirve `visual_test.html` y expone
  `/predict`, para analizar en vivo desde el navegador las diapositivas que subas.
- **`visual_test.html` / `visual_test.js` / `visual_test.css`** — prueba visual e interactiva
  (sin terminal). Arranca vacía, con un botón **"↑ Subir mis propias diapositivas"** que acepta
  imágenes sueltas o un PDF completo (convertido a una imagen por página en el propio
  navegador); cada una se analiza en vivo con Gemini. Una vez cargadas, navega entre ellas, haz
  clic para simular dónde apunta el dedo, y observa en vivo el resultado bruto vs. el
  estabilizado (con barra de progreso del debounce). Botón **"↓ Descargar CSV de
  intervalos"** para bajarte el registro de esa sesión de prueba.
- **`pointing_lookup.js`** — la lógica que se ejecutaría en el navegador durante la clase:
  - `findPointedElement(xn, yn, detections)` — punto contra cajas, con desempate por área
    menor cuando hay solape (pasa con frecuencia en las detecciones de Gemini).
  - `PointedElementTracker` — estabiliza el resultado en el tiempo, exigiendo N frames
    consecutivos con el mismo resultado antes de confirmar un cambio (debounce, 5 frames por
    defecto), para no parpadear cuando el punto ronda un borde entre dos cajas.
- **`interval_logger.js`** — `PointingIntervalLogger`: colapsa el flujo frame a frame del
  elemento estabilizado en intervalos `[inicio, fin]` por diapositiva/elemento, y los exporta a
  CSV. Pensado para entregarle a un módulo externo (p. ej. una detección de deixis por voz)
  "de aquí a aquí se señalaba esto", en vez de un log crudo a 30 fps. El origen de los
  timestamps es el que decidas al llamar a `update()` — hay que acordarlo con quien vaya a
  cruzar este fichero con el suyo, o los intervalos no se alinearán con nada.
- **`test_pointing_lookup.mjs`** / **`test_interval_logger.mjs`** — pruebas con datos
  sintéticos (esta carpeta no distribuye imágenes de diapositivas ni ningún
  `analisis_ppt.json`); las cajas usadas reproducen patrones reales observados con Gemini
  durante el desarrollo (solapes, desempates). `node test_pointing_lookup.mjs` /
  `node test_interval_logger.mjs` para ejecutarlas.

## Requisitos

- Python 3.10+ y Node.js (solo para las pruebas `.mjs`).
- Un proyecto de **Google Cloud** con la **API de Vertex AI** habilitada, y el SDK de
  `gcloud` instalado y autenticado localmente.

## Cómo probarlo

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

## Cómo encajaría con una captura de cámara en vivo

Este repositorio no incluye captura de cámara ni detección de hacia dónde apunta alguien —
solo el análisis de las diapositivas y la lógica de comparación. Si ya tienes, por tu lado, un
punto normalizado `(xn, yn)` sobre la diapositiva activa (de donde sea que venga: una cámara
calibrada, un puntero, lo que sea), el encaje sería así:

```javascript
import { PointedElementTracker } from './pointing_lookup.js';
import { PointingIntervalLogger } from './interval_logger.js';

const tracker = new PointedElementTracker();
const sessionLog = new PointingIntervalLogger();       // p.ej. para cruzar con audio/voz
const sessionStartMs = performance.now();              // origen de tiempo acordado
const analisisPPT = await fetch('analisis_ppt.json').then(r => r.json());
let currentSlideIndex = 0;  // se actualiza cuando cambia la diapositiva activa

// en cada frame / actualización, con (xn, yn) ya calculado por tu propio sistema:
const elemento = tracker.update(xn, yn, analisisPPT[currentSlideIndex]?.detections ?? []);
// elemento?.class -> "Diagram", "Table", "Title"... o null

const elapsedSec = (performance.now() - sessionStartMs) / 1000;
sessionLog.update(elapsedSec, currentSlideIndex, elemento);

// al terminar la sesión (o para exportar bajo demanda):
sessionLog.finish(elapsedSec);
const csv = sessionLog.toCSV();
```

Ninguna de estas llamadas toca Gemini — todo el coste de red ya se pagó antes, en
`batch_analyze.py` / `serve_visual_test.py`.

## Limitaciones conocidas

- Solo sirve para contenido **conocido de antemano** (un PDF/PPT ya cargado y analizado) — no
  para pizarra física o contenido improvisado.
- Requiere que el punto `(xn, yn)` y las cajas de Gemini compartan el mismo sistema de
  coordenadas normalizado `[0,1]²` respecto a la diapositiva: solo se garantiza si la imagen
  usada para calcular ese punto es exactamente la misma que se envió a Gemini (misma relación
  de aspecto, sin recortes ni barras negras).
- Se ha observado, en pruebas con imágenes reales, alguna caja que se sale ligeramente de
  `[0,1]` — inofensivo para la comparación (un punto de pointing nunca supera 1), pero
  recordatorio de que Gemini no es perfectamente preciso ni siquiera en su propio formato de
  salida.
- Las cajas de Gemini pueden ser imprecisas (demasiado grandes, mal ajustadas al contenido
  real) de forma no determinista; cambiar de modelo no lo soluciona de forma fiable — cada uno
  falla de una manera distinta en los mismos casos difíciles.
