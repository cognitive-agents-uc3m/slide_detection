"""
Analiza todas las diapositivas de una carpeta con Gemini y guarda un JSON
unico con las detecciones de Nivel 1 por diapositiva (indexadas 0..N-1 en
el orden alfabetico de los ficheros), listo para consultar en tiempo real
sin volver a llamar a Gemini durante la clase.

Mismo prompt y clases que dataset_slide_detection/gemini_detection/serve_gemini.py
(ver ese repositorio para la justificacion completa de cada eleccion).

Usa Vertex AI: necesitas un proyecto de Google Cloud con la API de Vertex AI
habilitada y `gcloud auth application-default login` hecho. El proyecto se
lee de GEMINI_PROJECT_ID (ver .env.example) — no hay ninguno cableado aqui.

Uso:
  pip install -r requirements.txt
  cp .env.example .env   # y rellena GEMINI_PROJECT_ID
  gcloud auth application-default login   # si no lo tienes ya hecho
  python batch_analyze.py --images-dir ruta/a/tus/diapositivas --out analisis_ppt.json
"""
import argparse
import io
import json
import os
import re
import sys
from pathlib import Path

from google import genai
from google.genai import types
from PIL import Image

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass  # python-dotenv es opcional; sin el, usa variables de entorno del sistema

GEMINI_PROJECT_ID = os.environ.get('GEMINI_PROJECT_ID')
GEMINI_LOCATION = os.environ.get('GEMINI_LOCATION', 'global')
GEMINI_MODEL = os.environ.get('GEMINI_MODEL', 'gemini-2.5-flash')

GEMINI_CLASSES = [
    'Title', 'Heading', 'Description', 'Enumeration', 'Equation', 'Table',
    'Chart', 'Diagram', 'Code', 'Figure-Caption', 'Table-Caption', 'Logo',
    'Footer-Element', 'SlideNr', 'URL', 'Natural-Image',
]
GEMINI_PROMPT = f"""Analiza esta diapositiva de una presentacion academica de Ingenieria.
Detecta TODAS las regiones visuales que pertenezcan a alguna de estas categorias:
{', '.join(GEMINI_CLASSES)}

Devuelve UNICAMENTE un JSON valido (sin texto adicional, sin bloques markdown),
una lista de objetos con este formato exacto:
[{{"box_2d": [ymin, xmin, ymax, xmax], "label": "categoria"}}]

box_2d normalizado a una escala 0-1000 respecto al ancho/alto completos de la imagen.
label debe ser exactamente una de las categorias listadas arriba."""

# ── Nivel 2 — cascada sobre las cajas Diagram/Chart de Nivel 1 ────────────────
# 28 categorias literales de DocFigure (Jobin, Mondal y Jawahar, ICDARW 2019)
NIVEL2_CLASSES = [
    'Line graph', 'Natural image', 'Table', '3D object', 'Bar plot', 'Scatter plot',
    'Medical image', 'Sketch', 'Geographic map', 'Flow chart', 'Heat map', 'Mask',
    'Block diagram', 'Venn diagram', 'Confusion matrix', 'Histogram', 'Box plot',
    'Vector plot', 'Pie chart', 'Surface plot', 'Algorithm', 'Contour plot',
    'Tree diagram', 'Bubble chart', 'Polar plot', 'Area chart', 'Pareto chart', 'Radar chart',
]
NIVEL2_PROMPT = f"""Esta imagen es el recorte de un unico diagrama o grafico extraido de una diapositiva academica.
Clasificalo en EXACTAMENTE una de estas categorias (nomenclatura del dataset DocFigure):
{', '.join(NIVEL2_CLASSES)}

Devuelve UNICAMENTE la categoria exacta tal cual aparece en la lista, sin explicacion,
sin comillas, sin puntuacion adicional."""

NIVEL1_CASCADE_CLASSES = {'Diagram', 'Chart'}
CROP_PADDING = 0.05
CROP_MIN_SIDE = 768


def extract_json(text):
    text = text.strip()
    text = re.sub(r'^```(json)?', '', text.strip())
    text = re.sub(r'```$', '', text.strip())
    return json.loads(text)


def crop_and_upscale(image_bytes, box, padding=CROP_PADDING, min_side=CROP_MIN_SIDE):
    img = Image.open(io.BytesIO(image_bytes)).convert('RGB')
    W, H = img.size
    x1, y1, x2, y2 = box
    pw, ph = (x2 - x1) * padding, (y2 - y1) * padding
    x1, x2 = max(0.0, x1 - pw), min(1.0, x2 + pw)
    y1, y2 = max(0.0, y1 - ph), min(1.0, y2 + ph)
    crop = img.crop((int(x1 * W), int(y1 * H), int(x2 * W), int(y2 * H)))

    longest = max(crop.size)
    if longest < min_side and longest > 0:
        scale = min_side / longest
        crop = crop.resize((round(crop.width * scale), round(crop.height * scale)), Image.LANCZOS)

    buf = io.BytesIO()
    crop.save(buf, format='PNG')
    return buf.getvalue()


def classify_nivel2(client, crop_bytes):
    response = client.models.generate_content(
        model=GEMINI_MODEL,
        contents=[types.Part.from_bytes(data=crop_bytes, mime_type='image/png'), NIVEL2_PROMPT],
    )
    text = (response.text or '').strip()
    for c in NIVEL2_CLASSES:
        if c.lower() == text.lower():
            return c
    return text or None


def analyze_slide(client, image_path: Path):
    mime = 'image/png' if image_path.suffix.lower() == '.png' else 'image/jpeg'
    image_bytes = image_path.read_bytes()
    response = client.models.generate_content(
        model=GEMINI_MODEL,
        contents=[types.Part.from_bytes(data=image_bytes, mime_type=mime), GEMINI_PROMPT],
    )
    raw_text = response.text or ''
    detections_raw = extract_json(raw_text)

    detections = []
    for d in detections_raw:
        box = d.get('box_2d')
        label = d.get('label')
        if not box or len(box) != 4 or not label:
            continue
        ymin, xmin, ymax, xmax = box
        det = {
            'class': label,
            'box': [xmin / 1000, ymin / 1000, xmax / 1000, ymax / 1000],
        }
        if label in NIVEL1_CASCADE_CLASSES:
            try:
                crop_bytes = crop_and_upscale(image_bytes, det['box'])
                det['nivel2'] = classify_nivel2(client, crop_bytes)
            except Exception as e:
                det['nivel2'] = None
                det['nivel2_error'] = str(e)
        detections.append(det)
    return detections


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--images-dir', type=Path, required=True, help='carpeta con las imagenes de diapositivas')
    ap.add_argument('--out', type=Path, required=True, help='fichero JSON de salida')
    args = ap.parse_args()

    images = sorted(p for p in args.images_dir.iterdir() if p.suffix.lower() in ('.png', '.jpg', '.jpeg'))
    if not images:
        raise SystemExit(f'No se encontraron imagenes en {args.images_dir}')

    if not GEMINI_PROJECT_ID:
        raise SystemExit(
            'Falta GEMINI_PROJECT_ID (tu proyecto de Google Cloud con Vertex AI habilitado) — '
            'copia .env.example a .env y rellenalo, y ejecuta '
            '`gcloud auth application-default login` si no lo has hecho ya.'
        )
    client = genai.Client(vertexai=True, project=GEMINI_PROJECT_ID, location=GEMINI_LOCATION)

    resultado = {}
    for i, img_path in enumerate(images):
        print(f'[{i + 1}/{len(images)}] {img_path.name}...', end=' ', flush=True)
        try:
            detections = analyze_slide(client, img_path)
            print(f'{len(detections)} detecciones')
        except Exception as e:
            print(f'ERROR: {e}')
            detections = []
        resultado[str(i)] = {'file': img_path.name, 'detections': detections}

    with open(args.out, 'w', encoding='utf-8') as f:
        json.dump(resultado, f, ensure_ascii=False, indent=2)

    total_det = sum(len(v['detections']) for v in resultado.values())
    print(f'\nGuardado: {args.out} ({len(images)} diapositivas, {total_det} detecciones totales)')


if __name__ == '__main__':
    main()
