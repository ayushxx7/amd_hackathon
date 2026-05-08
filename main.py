import os
import base64
import io
import json
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
import ollama
from PIL import Image

MODEL_NAME = "gemma4:e4b"
OLLAMA_HOST = "http://127.0.0.1:11434"
client = ollama.AsyncClient(host=OLLAMA_HOST)

# Load product catalog
def load_products():
    with open("products.json", "r") as f:
        return json.load(f)

PRODUCTS = load_products()

from contextlib import asynccontextmanager

@asynccontextmanager
async def lifespan(app: FastAPI):
    print(f"🔍 Checking Ollama connection at {OLLAMA_HOST}...")
    try:
        models = await client.list()
        print("✅ Ollama is connected!")
        # Check if model exists
        if not any(m.model == MODEL_NAME for m in models.models):
            print(f"⚠️ Warning: Model {MODEL_NAME} not found in Ollama. Available models: {[m.model for m in models.models]}")
        else:
            print(f"✅ Model {MODEL_NAME} is available.")
    except Exception as e:
        print(f"❌ Error: Could not connect to Ollama at {OLLAMA_HOST}. Please ensure Ollama is running.")
        print(f"Details: {str(e)}")
    yield

app = FastAPI(title="Kirana Billing AI - Gemma 4", lifespan=lifespan)

# Enable CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.post("/api/inference")
async def inference(file: UploadFile = File(...)):
    try:
        contents = await file.read()
        
        # Optimize image for faster inference - down to 256x256
        image = Image.open(io.BytesIO(contents))
        image.thumbnail((256, 256))
        buf = io.BytesIO()
        image.save(buf, format="JPEG", quality=75)
        contents = buf.getvalue()
        
        # Prepare the product list for the prompt to guide the model
        product_names = [f"{p['id']}: {p['name']}" for p in PRODUCTS]
        catalog_str = "\n".join(product_names)
        
        prompt = f"""
        Identify the grocery item in this image.
        CATALOG:
        {catalog_str}
        
        Return ONLY a JSON object:
        {{"id": "Exact SKU from catalog or 'unknown'", "name": "Catalog Name", "description": "Short reason", "confidence": "High"}}
        """
        
        response = await client.generate(
            model=MODEL_NAME,
            prompt=prompt,
            images=[contents],
            stream=False,
            format="json",
            keep_alive="1h",
            options={
                "temperature": 0.0,
                "num_predict": 50
            }
        )
        
        # Parse the JSON response
        try:
            result = json.loads(response['response'])
        except:
            # Fallback if model doesn't return clean JSON
            result = {"id": "unknown", "name": "Unknown Item", "description": response['response']}
            
        # If matched, attach full product info
        if result.get("id") != "unknown":
            product_info = next((p for p in PRODUCTS if p["id"] == result["id"]), None)
            if product_info:
                result.update({
                    "price": product_info["price"],
                    "category": product_info["category"],
                    "brand": product_info.get("brand", "Unknown"),
                    "unit": product_info.get("unit", "N/A")
                })
        
        return {
            "success": True,
            "data": result,
            "model": MODEL_NAME
        }
    except Exception as e:
        error_msg = str(e)
        if "Failed to connect to Ollama" in error_msg:
            error_msg = f"Failed to connect to Ollama at {OLLAMA_HOST}. Is it running?"
        print(f"Error during inference: {error_msg}")
        raise HTTPException(status_code=500, detail=error_msg)

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
    # Use 6001 as agreed
    uvicorn.run(app, host="0.0.0.0", port=6001)
