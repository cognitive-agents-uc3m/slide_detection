"""
Sirve visual_test.html y expone /predict para analizar en vivo, con Gemini,
las diapositivas que el usuario suba desde el navegador.

Usa Vertex AI: necesitas un proyecto de Google Cloud con la API de Vertex AI
habilitada y `gcloud auth application-default login` hecho. El proyecto se
lee de GEMINI_PROJECT_ID (ver .env.example) — no hay ninguno cableado aquí.

Uso:
  pip install -r requirements.txt
  cp .env.example .env   # y rellena GEMINI_PROJECT_ID
  gcloud auth application-default login   # si no lo tienes ya hecho
  python serve_visual_test.py
  -> abre http://localhost:5055
"""
import io
import json
import os
import re
from pathlib import Path

from flask import Flask, request, jsonify, send_from_directory
from google import genai
from google.genai import types
from PIL import Image

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass  # python-dotenv es opcional; sin él, usa variables de entorno del sistema

APP_DIR = Path(__file__).parent

GEMINI_PROJECT_ID = os.environ.get('GEMINI_PROJECT_ID')
GEMINI_LOCATION = os.environ.get('GEMINI_LOCATION', 'global')
GEMINI_MODEL = os.environ.get('GEMINI_MODEL', 'gemini-3.6-flash')

GEMINI_CLASSES = [
    'Title', 'Heading', 'Description', 'Enumeration', 'Equation', 'Table',
    'Chart', 'Diagram', 'Code', 'Figure-Caption', 'Table-Caption', 'Logo',
    'Footer-Element', 'SlideNr', 'URL', 'Natural-Image',
]
GEMINI_PROMPT = f"""Analiza esta diapositiva de una presentación académica de Ingeniería.
Escanea visualmente el documento metódicamente de arriba a abajo y de izquierda a derecha.

Detecta TODAS las regiones visuales que pertenezcan a alguna de estas categorías:
{', '.join(GEMINI_CLASSES)}

Para cada región detectada, debes extraer sus coordenadas espaciales exactas usando el formato [ymin, xmin, ymax, xmax].
Las coordenadas deben estar normalizadas en una escala de 0 a 1000, donde [0, 0] es la esquina superior izquierda de la diapositiva y [1000, 1000] es la esquina inferior derecha.

Devuelve ÚNICAMENTE un arreglo JSON válido (sin formato Markdown). Sigue exactamente esta estructura:
[
  {{
    "descripcion": "Breve descripción del elemento para fijar la atención visual",
    "label": "categoria_exacta",
    "box_2d": [150, 50, 450, 900]
  }}
]"""

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

app = Flask(__name__, static_folder=None)

if not GEMINI_PROJECT_ID:
    raise RuntimeError(
        'Falta GEMINI_PROJECT_ID (tu proyecto de Google Cloud con Vertex AI habilitado) — '
        'copia .env.example a .env y rellénalo, y ejecuta '
        '`gcloud auth application-default login` si no lo has hecho ya.'
    )
client = genai.Client(vertexai=True, project=GEMINI_PROJECT_ID, location=GEMINI_LOCATION)


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


def classify_nivel2(crop_bytes):
    response = client.models.generate_content(
        model=GEMINI_MODEL,
        contents=[types.Part.from_bytes(data=crop_bytes, mime_type='image/png'), NIVEL2_PROMPT],
    )
    text = (response.text or '').strip()
    for c in NIVEL2_CLASSES:
        if c.lower() == text.lower():
            return c
    return text or None


@app.route('/')
def index():
    return send_from_directory(APP_DIR, 'visual_test.html')


@app.route('/<path:filename>')
def static_files(filename):
    return send_from_directory(APP_DIR, filename)


@app.route('/predict', methods=['POST'])
def predict():
    file = request.files.get('image')
    if file is None:
        return jsonify({'error': 'no se recibio ninguna imagen'}), 400

    image_bytes = file.read()
    mime = file.mimetype or 'image/png'

    try:
        response = client.models.generate_content(
            model=GEMINI_MODEL,
            contents=[types.Part.from_bytes(data=image_bytes, mime_type=mime), GEMINI_PROMPT],
        )
    except Exception as e:
        return jsonify({'error': f'Error llamando a Gemini: {e}'}), 502

    raw_text = response.text or ''
    try:
        detections_raw = extract_json(raw_text)
    except Exception as e:
        return jsonify({'error': f'No se pudo parsear el JSON de Gemini: {e}', 'raw': raw_text}), 502

    detections = []
    for d in detections_raw:
        box = d.get('box_2d')
        label = d.get('label')
        if not box or len(box) != 4 or not label:
            continue
        ymin, xmin, ymax, xmax = box
        det = {'class': label, 'box': [xmin / 1000, ymin / 1000, xmax / 1000, ymax / 1000]}
        if label in NIVEL1_CASCADE_CLASSES:
            try:
                crop_bytes = crop_and_upscale(image_bytes, det['box'])
                det['nivel2'] = classify_nivel2(crop_bytes)
            except Exception as e:
                det['nivel2'] = None
                det['nivel2_error'] = str(e)
        detections.append(det)

    return jsonify({'detections': detections})


if __name__ == '__main__':
    print('Abre http://127.0.0.1:5055')
    app.run(host='127.0.0.1', port=5055, debug=False)
