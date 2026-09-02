import { findPointedElement, PointedElementTracker } from './pointing_lookup.js';
import { PointingIntervalLogger } from './interval_logger.js';

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
const PDF_RENDER_SCALE = 2; // ~150dpi, mismo valor "Media" que dataset_slide_detection

const CLASS_COLORS = {
  'Title': '#4477EE', 'Heading': '#2255CC', 'Description': '#6699FF', 'Enumeration': '#33AAFF',
  'Equation': '#22BB66', 'Table': '#FFAA44', 'Chart': '#FF8800', 'Diagram': '#FF4D4D',
  'Code': '#AA66FF', 'Figure-Caption': '#88BBFF', 'Table-Caption': '#FFC966', 'Logo': '#444444',
  'Footer-Element': '#666666', 'SlideNr': '#888888', 'URL': '#AAAAAA', 'Natural-Image': '#FF00AA',
};
const colorFor = name => CLASS_COLORS[name] ?? '#9ab4f5';

const TICK_MS = 200; // ~5 "frames" simulados por segundo, deliberadamente lento para poder verlo

const uploadBtn     = document.getElementById('uploadBtn');
const uploadInput    = document.getElementById('uploadInput');
const uploadStatus    = document.getElementById('uploadStatus');
const emptyState       = document.getElementById('emptyState');

const slideNav      = document.getElementById('slideNav');
const canvasWrap      = document.getElementById('canvasWrap');
const resultsSection    = document.getElementById('resultsSection');
const configSection       = document.getElementById('configSection');
const logBar                = document.getElementById('logBar');

const prevBtn      = document.getElementById('prevBtn');
const nextBtn       = document.getElementById('nextBtn');
const slideLabel     = document.getElementById('slideLabel');
const canvas          = document.getElementById('canvas');
const ctx              = canvas.getContext('2d');
const rawResultEl     = document.getElementById('rawResult');
const stableResultEl   = document.getElementById('stableResult');
const progressBar       = document.getElementById('progressBar');
const progressText       = document.getElementById('progressText');
const framesSlider        = document.getElementById('framesSlider');
const framesValue          = document.getElementById('framesValue');
const downloadLogBtn        = document.getElementById('downloadLogBtn');
const logStatus              = document.getElementById('logStatus');

// Cada diapositiva: { name, src (ruta o blob: URL), detections }
let slides = [];
let currentIdx = 0;
let currentImage = null;
let lastClick = null; // {xn, yn} o null
const tracker = new PointedElementTracker(Number(framesSlider.value));

// Registro de intervalos de toda la sesión (persiste entre cambios de diapositiva)
const sessionLog = new PointingIntervalLogger();
const sessionStartMs = performance.now();
const elapsedSec = () => (performance.now() - sessionStartMs) / 1000;

init();

function init() {
  // Sin diapositivas precargadas: se empieza vacío, el usuario sube las suyas
  // (imágenes o un PDF) con el botón de arriba.
  updateEmptyState();

  prevBtn.addEventListener('click', () => loadSlide(currentIdx - 1));
  nextBtn.addEventListener('click', () => loadSlide(currentIdx + 1));
  canvas.addEventListener('click', onCanvasClick);
  framesSlider.addEventListener('input', () => {
    framesValue.textContent = framesSlider.value;
    tracker.setChangeFrames(Number(framesSlider.value));
  });
  uploadBtn.addEventListener('click', () => uploadInput.click());
  uploadInput.addEventListener('change', onFilesSelected);
  downloadLogBtn.addEventListener('click', downloadIntervalLog);

  setInterval(tick, TICK_MS);
}

/** Muestra el mensaje de "sin diapositivas" o las secciones de trabajo, según haya contenido. */
function updateEmptyState() {
  const hasSlides = slides.length > 0;
  emptyState.style.display = hasSlides ? 'none' : 'block';
  slideNav.style.display = hasSlides ? 'flex' : 'none';
  canvasWrap.style.display = hasSlides ? 'block' : 'none';
  resultsSection.style.display = hasSlides ? 'flex' : 'none';
  configSection.style.display = hasSlides ? 'flex' : 'none';
  logBar.style.display = hasSlides ? 'flex' : 'none';
}

function isPdf(file) {
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
}

/** Convierte un PDF en una lista de ficheros PNG, uno por página (en el propio navegador). */
async function pdfToPageFiles(pdfFile, onProgress) {
  const buffer = await pdfFile.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  const baseName = pdfFile.name.replace(/\.pdf$/i, '');
  const pageFiles = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    onProgress?.(i, pdf.numPages);
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: PDF_RENDER_SCALE });

    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    const name = `${baseName}_${String(i).padStart(String(pdf.numPages).length, '0')}.png`;
    pageFiles.push(new File([blob], name, { type: 'image/png' }));
  }
  return pageFiles;
}

async function onFilesSelected() {
  const rawFiles = Array.from(uploadInput.files ?? []);
  uploadInput.value = '';
  if (!rawFiles.length) return;

  uploadBtn.disabled = true;

  // Expandir cualquier PDF en sus paginas antes de analizar nada
  let files = [];
  for (const file of rawFiles) {
    if (isPdf(file)) {
      uploadStatus.textContent = `Convirtiendo ${file.name} a imágenes…`;
      uploadStatus.className = 'upload-status';
      try {
        const pages = await pdfToPageFiles(file, (i, total) => {
          uploadStatus.textContent = `Convirtiendo ${file.name}: página ${i}/${total}…`;
        });
        files.push(...pages);
      } catch (err) {
        console.error(`Error convirtiendo ${file.name}:`, err);
        uploadStatus.textContent = `Error convirtiendo ${file.name} (revisa la consola)`;
        uploadStatus.className = 'upload-status error';
      }
    } else {
      files.push(file);
    }
  }

  let ok = 0, fail = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    uploadStatus.textContent = `Analizando ${i + 1}/${files.length}: ${file.name}…`;
    uploadStatus.className = 'upload-status';
    try {
      const form = new FormData();
      form.append('image', file);
      const res = await fetch('/predict', { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? res.status);

      slides.push({
        name: file.name,
        src: URL.createObjectURL(file),
        detections: data.detections ?? [],
      });
      ok++;
    } catch (err) {
      console.error(`Error analizando ${file.name}:`, err);
      fail++;
    }
  }

  uploadStatus.textContent = fail
    ? `${ok} añadidas, ${fail} con error (revisa la consola) — ¿está corriendo serve_visual_test.py?`
    : `${ok} diapositiva(s) añadidas al final del pase.`;
  uploadStatus.className = fail ? 'upload-status error' : 'upload-status';
  uploadBtn.disabled = false;

  if (ok > 0) await loadSlide(slides.length - ok); // salta a la primera recién añadida
}

async function loadSlide(idx) {
  if (idx < 0 || idx >= slides.length) return;
  updateEmptyState();
  currentIdx = idx;
  const entry = slides[idx];
  lastClick = null;
  tracker.reset();

  currentImage = await loadImage(entry.src);
  canvas.width = currentImage.naturalWidth;
  canvas.height = currentImage.naturalHeight;

  slideLabel.textContent = `${idx + 1} / ${slides.length} — ${entry.name}`;
  prevBtn.disabled = idx === 0;
  nextBtn.disabled = idx === slides.length - 1;

  draw();
  updateResults(null);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function onCanvasClick(e) {
  const rect = canvas.getBoundingClientRect();
  const xn = (e.clientX - rect.left) / rect.width;
  const yn = (e.clientY - rect.top) / rect.height;
  lastClick = { xn, yn };
  tracker.reset(); // al mover el punto, se reinicia la estabilización, como en el pointing real
  draw();
}

function tick() {
  if (!lastClick) return;
  const detections = slides[currentIdx].detections;
  const stable = tracker.update(lastClick.xn, lastClick.yn, detections);
  const raw = findPointedElement(lastClick.xn, lastClick.yn, detections);
  updateResults(raw, stable);

  sessionLog.update(elapsedSec(), currentIdx, stable);
  logStatus.textContent = `${sessionLog.getIntervals().length} intervalo(s) registrado(s) en esta sesión`;
}

function downloadIntervalLog() {
  sessionLog.finish(elapsedSec());
  if (sessionLog.getIntervals().length === 0) {
    logStatus.textContent = 'Todavía no hay ningún intervalo que exportar — haz clic en una diapositiva primero.';
    return;
  }
  const csv = sessionLog.toCSV();
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'intervalos_pointing.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

function updateResults(raw, stable) {
  rawResultEl.textContent = raw ? (raw.nivel2 ? `${raw.class} · ${raw.nivel2}` : raw.class) : '—';
  rawResultEl.style.color = raw ? colorFor(raw.class) : '#d0d0e0';

  stableResultEl.textContent = stable ? (stable.nivel2 ? `${stable.class} · ${stable.nivel2}` : stable.class) : '—';
  stableResultEl.style.color = stable ? colorFor(stable.class) : '#7eef7e';

  const { count, total } = tracker.getPendingProgress();
  if (count > 0) {
    progressBar.style.width = `${Math.min(100, (count / total) * 100)}%`;
    progressText.textContent = `${count} / ${total} frames para confirmar`;
  } else {
    progressBar.style.width = '0%';
    progressText.textContent = '';
  }
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(currentImage, 0, 0, canvas.width, canvas.height);

  const W = canvas.width, H = canvas.height;
  slides[currentIdx].detections.forEach(det => {
    const [x1, y1, x2, y2] = det.box;
    const x = x1 * W, y = y1 * H, w = (x2 - x1) * W, h = (y2 - y1) * H;
    const color = colorFor(det.class);

    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(2, W / 400);
    ctx.strokeRect(x, y, w, h);

    ctx.font = `bold ${Math.max(11, W / 100)}px system-ui, sans-serif`;
    const label = det.nivel2 ? `${det.class} · ${det.nivel2}` : det.class;
    const padding = 4;
    const textW = ctx.measureText(label).width;
    const textH = Math.max(13, W / 80);
    ctx.fillStyle = color;
    ctx.fillRect(x, Math.max(0, y - textH), textW + padding * 2, textH);
    ctx.fillStyle = '#0d0d1a';
    ctx.fillText(label, x + padding, Math.max(textH - 3, y - 3));
  });

  if (lastClick) {
    const px = lastClick.xn * W, py = lastClick.yn * H;
    ctx.beginPath();
    ctx.arc(px, py, Math.max(6, W / 150), 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}
