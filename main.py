import io
import json
import uuid
import shutil
import asyncio
from pathlib import Path
from contextlib import asynccontextmanager
from typing import List

import torch
from fastapi import FastAPI, UploadFile, File, HTTPException, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from PIL import Image
from transformers import SiglipProcessor, SiglipModel
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, VectorParams, PointStruct, Filter, FieldCondition, MatchValue
import ollama

# ── Config ──────────────────────────────────────────────────────────────────
MODEL_NAME     = "gemma4:e4b"
OLLAMA_HOST    = "http://127.0.0.1:11434"
EMBED_MODEL    = "google/siglip-base-patch16-224"
VECTOR_DIM     = 768
QDRANT_PATH    = "./qdrant_db"
IMAGES_PATH    = "./product_images"
SIM_THRESHOLD  = 0.60   # minimum cosine similarity to return a result
TOP_K          = 5

ollama_client = ollama.AsyncClient(host=OLLAMA_HOST)

def load_products():
    with open("products.json") as f:
        return json.load(f)

PRODUCTS = load_products()

# ── Global ML state (populated during lifespan) ──────────────────────────────
_processor: SiglipProcessor = None
_model: SiglipModel         = None
_qdrant: QdrantClient       = None


def embed_image(image_bytes: bytes) -> list:
    """Return a normalised SigLIP image embedding as a Python list."""
    img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    inputs = _processor(images=img, return_tensors="pt")
    with torch.no_grad():
        # Use the vision encoder directly; .pooler_output is a plain tensor
        vision_out = _model.vision_model(pixel_values=inputs["pixel_values"])
        features = vision_out.pooler_output          # shape: [1, 768]
        features = features / features.norm(dim=-1, keepdim=True)
    return features[0].cpu().tolist()


def _run_vector_search(image_bytes: bytes) -> list:
    """Encode image, query Qdrant, return a deduplicated ranked list."""
    embedding = embed_image(image_bytes)
    hits = _qdrant.query_points(
        collection_name="products",
        query=embedding,
        limit=TOP_K,
        score_threshold=SIM_THRESHOLD,
        with_payload=True,
    ).points
    seen = {}
    for hit in hits:
        pid = hit.payload.get("product_id")
        if pid not in seen or hit.score > seen[pid]["score"]:
            seen[pid] = {
                "score": round(hit.score, 3),
                "product_id": pid,
                "name": hit.payload.get("name"),
                "price": hit.payload.get("price"),
                "category": hit.payload.get("category"),
                "brand": hit.payload.get("brand"),
                "unit": hit.payload.get("unit"),
                "thumbnail_url": hit.payload.get("thumbnail_url"),
            }
    return sorted(seen.values(), key=lambda x: x["score"], reverse=True)


# ── Lifespan ─────────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    global _processor, _model, _qdrant

    # Load SigLIP
    print(f"Loading embedding model {EMBED_MODEL} ...")
    _processor = SiglipProcessor.from_pretrained(EMBED_MODEL)
    _model     = SiglipModel.from_pretrained(EMBED_MODEL)
    _model.eval()
    print("Embedding model ready.")

    # Set up Qdrant local store
    Path(QDRANT_PATH).mkdir(parents=True, exist_ok=True)
    Path(IMAGES_PATH).mkdir(parents=True, exist_ok=True)
    _qdrant = QdrantClient(path=QDRANT_PATH)
    existing = {c.name for c in _qdrant.get_collections().collections}
    if "products" not in existing:
        _qdrant.create_collection(
            collection_name="products",
            vectors_config=VectorParams(size=VECTOR_DIM, distance=Distance.COSINE),
        )
        print("Qdrant collection 'products' created.")
    else:
        count = _qdrant.count("products").count
        print(f"Qdrant collection 'products' ready — {count} vectors indexed.")

    # Verify Ollama
    print(f"Checking Ollama at {OLLAMA_HOST} ...")
    try:
        models = await ollama_client.list()
        if not any(m.model == MODEL_NAME for m in models.models):
            print(f"Warning: {MODEL_NAME} not found. Available: {[m.model for m in models.models]}")
        else:
            print(f"Ollama model {MODEL_NAME} is ready.")
    except Exception as e:
        print(f"Ollama connection error: {e}")

    yield


# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI(title="KiranaAI", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── /api/inference ────────────────────────────────────────────────────────────
@app.post("/api/inference")
async def inference(file: UploadFile = File(...)):
    try:
        raw = await file.read()

        img = Image.open(io.BytesIO(raw))
        img.thumbnail((512, 512))
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=75)
        optimised = buf.getvalue()

        catalog_str = "\n".join(f"{p['id']}: {p['name']}" for p in PRODUCTS)
        prompt = (
            "Identify the grocery item or electronics item in this image.\n"
            f"CATALOG:\n{catalog_str}\n\n"
            'Return ONLY a JSON object:\n'
            '{"id": "Exact SKU from catalog or \'unknown\'", '
            '"name": "Catalog Name", "description": "Short reason", "confidence": "High"}'
        )

        # ── Run Gemma and SigLIP in parallel ──────────────────────────────────
        async def call_gemma() -> dict:
            resp = await ollama_client.generate(
                model=MODEL_NAME,
                prompt=prompt,
                images=[optimised],
                stream=False,
                format="json",
                keep_alive="1h",
                options={"temperature": 0.0, "num_predict": 200},
            )
            raw = resp["response"]
            try:
                return json.loads(raw)
            except Exception:
                # Gemma sometimes wraps JSON in markdown fences or adds prose — extract it
                import re
                m = re.search(r'\{.*\}', raw, re.DOTALL)
                if m:
                    try:
                        return json.loads(m.group())
                    except Exception:
                        pass
                return {"id": "unknown", "name": "Unknown Item", "description": raw}

        loop = asyncio.get_event_loop()
        result, vector_results = await asyncio.gather(
            call_gemma(),
            loop.run_in_executor(None, _run_vector_search, optimised),
        )

        # ── Enrich Gemma result with catalog metadata ─────────────────────────
        gemma_id = result.get("id", "unknown")
        product_info = None
        if gemma_id != "unknown":
            product_info = next((p for p in PRODUCTS if p["id"] == gemma_id), None)
            if product_info:
                result.update(
                    price=product_info["price"],
                    category=product_info["category"],
                    brand=product_info.get("brand", "Unknown"),
                    unit=product_info.get("unit", "N/A"),
                )

        # ── Conflict detection: Gemma matched, but SigLIP found something else ─
        # Any SigLIP result that already passed SIM_THRESHOLD is confident enough.
        # Use word-overlap on names as the real gate — not a second score threshold.
        has_conflict = False
        if gemma_id != "unknown" and product_info and vector_results:
            top = vector_results[0]
            g_words = set(product_info["name"].lower().split())
            v_words = set((top["name"] or "").lower().split())
            significant_overlap = {w for w in g_words & v_words if len(w) > 2}
            names_differ = len(significant_overlap) == 0
            print(
                f"Hybrid check: Gemma→'{product_info['name']}' "
                f"SigLIP→'{top['name']}' score={top['score']} "
                f"overlap={significant_overlap} conflict={names_differ}"
            )
            if names_differ:
                has_conflict = True

        return {
            "success":      True,
            "data":         result,
            "model":        MODEL_NAME,
            "vector_results": vector_results if (gemma_id == "unknown" or has_conflict) else [],
            "has_conflict": has_conflict,
        }

    except Exception as e:
        msg = str(e)
        if "connect" in msg.lower():
            msg = f"Failed to connect to Ollama at {OLLAMA_HOST}. Is it running?"
        print(f"Inference error: {msg}")
        raise HTTPException(status_code=500, detail=msg)


# ── /api/add-product ──────────────────────────────────────────────────────────
@app.post("/api/add-product")
async def add_product(
    name: str = Form(...),
    price: float = Form(...),
    category: str = Form(...),
    brand: str = Form(...),
    unit: str = Form(...),
    images: List[UploadFile] = File(...),
):
    product_id = f"vs-{uuid.uuid4().hex[:8]}"
    product_dir = Path(IMAGES_PATH) / product_id
    product_dir.mkdir(parents=True, exist_ok=True)
    thumbnail_url = f"/api/images/{product_id}/thumbnail.jpg"

    points = []
    for idx, img_file in enumerate(images[:3]):
        raw = await img_file.read()
        pil = Image.open(io.BytesIO(raw)).convert("RGB")

        # Persist full image
        pil.save(product_dir / f"image_{idx + 1}.jpg", format="JPEG", quality=85)

        # Thumbnail from the first image
        if idx == 0:
            thumb = pil.copy()
            thumb.thumbnail((256, 256))
            thumb.save(product_dir / "thumbnail.jpg", format="JPEG", quality=80)

        # Embed
        pil.thumbnail((512, 512))
        buf = io.BytesIO()
        pil.save(buf, format="JPEG", quality=85)
        embedding = embed_image(buf.getvalue())

        points.append(
            PointStruct(
                id=str(uuid.uuid4()),
                vector=embedding,
                payload=dict(
                    product_id=product_id,
                    name=name,
                    price=price,
                    category=category,
                    brand=brand,
                    unit=unit,
                    thumbnail_url=thumbnail_url,
                ),
            )
        )

    _qdrant.upsert(collection_name="products", points=points)
    print(f"Added '{name}' ({product_id}) with {len(points)} image(s) to vector store.")

    return {
        "success": True,
        "product_id": product_id,
        "name": name,
        "price": price,
        "category": category,
        "brand": brand,
        "unit": unit,
        "thumbnail_url": thumbnail_url,
        "message": f"'{name}' indexed with {len(points)} image(s).",
    }


# ── /api/vector-search ────────────────────────────────────────────────────────
@app.post("/api/vector-search")
async def vector_search_only(file: UploadFile = File(...)):
    """Vector-only search — used when correcting a Gemma misclassification."""
    raw = await file.read()
    img = Image.open(io.BytesIO(raw))
    img.thumbnail((512, 512))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=75)
    vector_results = []
    try:
        vector_results = _run_vector_search(buf.getvalue())
    except Exception as ve:
        print(f"Vector search error: {ve}")
    return {"success": True, "vector_results": vector_results}


# ── /api/catalog ──────────────────────────────────────────────────────────────
@app.get("/api/catalog")
async def get_catalog():
    return {"products": PRODUCTS}


# ── /api/vector-products ──────────────────────────────────────────────────────
@app.get("/api/vector-products")
async def list_vector_products():
    """Return all unique products stored in the vector catalog."""
    points, _ = _qdrant.scroll(
        collection_name="products",
        with_payload=True,
        limit=1000,
    )
    seen: dict = {}
    for pt in points:
        pid = pt.payload.get("product_id")
        if pid and pid not in seen:
            seen[pid] = {
                "product_id": pid,
                "name":          pt.payload.get("name"),
                "price":         pt.payload.get("price"),
                "category":      pt.payload.get("category"),
                "brand":         pt.payload.get("brand"),
                "unit":          pt.payload.get("unit"),
                "thumbnail_url": pt.payload.get("thumbnail_url"),
            }
    return {"success": True, "products": list(seen.values())}


# ── /api/delete-product ───────────────────────────────────────────────────────
@app.delete("/api/delete-product/{product_id}")
async def delete_product(product_id: str):
    safe_id = Path(product_id).name          # prevent path traversal
    # Remove all Qdrant vectors whose payload matches this product_id
    _qdrant.delete(
        collection_name="products",
        points_selector=Filter(
            must=[FieldCondition(key="product_id", match=MatchValue(value=safe_id))]
        ),
    )
    # Remove images from disk
    product_dir = Path(IMAGES_PATH) / safe_id
    if product_dir.exists():
        shutil.rmtree(product_dir)
    print(f"Deleted product {safe_id} from vector store and disk.")
    return {"success": True, "message": f"Product '{safe_id}' deleted."}


# ── /api/images ───────────────────────────────────────────────────────────────
@app.get("/api/images/{product_id}/{filename}")
async def get_product_image(product_id: str, filename: str):
    # Prevent path traversal
    safe_path = Path(IMAGES_PATH) / Path(product_id).name / Path(filename).name
    if not safe_path.is_file():
        raise HTTPException(status_code=404, detail="Image not found")
    return FileResponse(str(safe_path))


# ── Static ────────────────────────────────────────────────────────────────────
@app.get("/")
async def read_index():
    return FileResponse("index.html")

@app.get("/style.css")
async def read_style():
    return FileResponse("style.css")

@app.get("/script.js")
async def read_script():
    return FileResponse("script.js")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=6001)
