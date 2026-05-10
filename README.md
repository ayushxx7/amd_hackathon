# KiranaAI — Visual Billing Counter

A local grocery/retail billing system that uses multimodal AI to identify products from photos and populate the bill automatically. Built for offline-first operation in small Indian retail shops.

## The Problem

Manual billing is slow and error-prone. Barcode scanners require label infrastructure. KiranaAI instead scans a product photo and adds it to the bill — no barcodes needed.

The harder sub-problem: **AI models go stale**. Gemma 4 knows common products from training, but a new local brand or a recently launched SKU is invisible to it. The system must handle these gracefully without needing retraining.

## Architecture

```
Scan product image
        │
        ├──────────────────────────┐
        ▼                          ▼
  Gemma 4 (LLM)            SigLIP + Qdrant
  catalog lookup          vector similarity
  (known 12 SKUs)         (custom products)
        │                          │
        └──────────┬───────────────┘
                   ▼
         Three possible outcomes:
         
  1. Gemma matched, no SigLIP conflict
     → auto-add to cart
     
  2. Gemma says "unknown"
     → show SigLIP results from custom catalog
     → user picks or adds as new product
     
  3. Gemma matched BUT SigLIP found a different
     product at score ≥ 0.72 with no name overlap
     → conflict: user confirms which is correct
```

### Why two models?

| Model | Strength | Weakness |
|-------|----------|----------|
| **Gemma 4** (via Ollama) | Fast, reasons from training on millions of products | Can't learn new products without retraining; sometimes maps visually similar products to the wrong SKU |
| **SigLIP** (google/siglip-base-patch16-224) | Purely visual, reasons from actual photos you've added | Only knows products you've explicitly indexed |

SigLIP acts as both a fallback (when Gemma fails) and a validator (when Gemma misclassifies confidently). If SigLIP has a photo of the correct product and its cosine similarity score is high enough, it overrides Gemma's guess by triggering a human confirmation step.

### Conflict detection

When Gemma identifies a catalog item and SigLIP simultaneously finds a **different** product in the custom catalog at score ≥ 0.72 (with no significant word overlap in the names), the system stops and shows the user both candidates. Neither is auto-added. The user picks, and the correct item goes into the bill.

This catches the "Gemma confidently misidentifies visually similar products" failure mode — e.g., Gemma calling a Redmi Note 4 a Samsung Galaxy S23 because both are candybar smartphones.

## Tech Stack

| Component | Choice |
|-----------|--------|
| Backend | FastAPI + Uvicorn |
| Primary classifier | Gemma 4 (`gemma4:e4b`) via Ollama |
| Image embeddings | SigLIP (`google/siglip-base-patch16-224`, 768-dim) |
| Vector DB | Qdrant (local file mode, no Docker) |
| Frontend | Vanilla HTML/CSS/JS |
| Image storage | Filesystem (`./product_images/`) |

## User Flows

### Happy path — known product
```
Scan Samsung Galaxy S23 box
→ Gemma returns SKU-011, SigLIP has nothing conflicting
→ Product auto-added to bill with price
→ "Not this product?" button shown for manual override
```

### Unknown product
```
Scan a new local brand snack
→ Gemma returns "unknown"
→ SigLIP searches custom catalog, finds similar items if any
→ User picks from visual matches OR clicks "Add as New Product"
→ Fills name/price/category, uploads 1–3 photos
→ Product indexed in Qdrant immediately
→ Next scan of same product: SigLIP finds it
```

### Misclassification (conflict)
```
Scan Xiaomi Redmi Note 4
→ Gemma returns Samsung Galaxy S23 (wrong, high confidence)
→ SigLIP finds Redmi Note 4 at 0.84 (≥ 0.72 threshold)
→ Names have zero word overlap → conflict triggered
→ Modal shows: Gemma's guess (amber) + SigLIP's match (purple)
→ User clicks the correct product → added to bill
```

### Manual correction
```
Gemma auto-added Samsung S23 but it's wrong
→ User clicks "✏ Not this product?"
→ Item removed from cart
→ Vector search runs on same captured image
→ Modal shows SigLIP matches + full product catalog
→ User picks correct product
```

## Setup

### Prerequisites
- Python 3.10+
- Ollama running locally with `gemma4:e4b` pulled

### Run

```bash
cd /home/dedsec/Kirana/Plan2/amd_hackathon
bash run.sh
```

`run.sh` creates a venv, installs PyTorch CPU-only (to avoid a 2 GB CUDA download), installs remaining deps, kills anything on port 6001, and starts the server.

Open `http://localhost:6001` in a browser.

**First run:** SigLIP (~400 MB) downloads from HuggingFace once and caches. Qdrant collection is created empty.

## API

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/inference` | Image → Gemma + SigLIP parallel classification |
| `POST` | `/api/vector-search` | Image → SigLIP-only search (used by correction flow) |
| `POST` | `/api/add-product` | Add new product with photos to vector DB |
| `GET`  | `/api/catalog` | Fetch the static 12-SKU products.json |
| `GET`  | `/api/vector-products` | List all custom products in Qdrant |
| `DELETE` | `/api/delete-product/{id}` | Remove product vectors + photos from disk |
| `GET`  | `/api/images/{id}/{file}` | Serve product thumbnail/photos |

## Configuration (main.py)

| Variable | Default | Description |
|----------|---------|-------------|
| `SIM_THRESHOLD` | `0.60` | Minimum cosine similarity for SigLIP to return a result |
| `CONFLICT_THRESHOLD` | `0.72` | SigLIP score above which a name disagreement triggers user confirmation |
| `TOP_K` | `5` | Max results returned from vector search |
| `MODEL_NAME` | `gemma4:e4b` | Ollama model tag |

## Project Structure

```
amd_hackathon/
├── main.py           # FastAPI backend — inference, vector ops, file serving
├── script.js         # Frontend — scan flow, cart, modals, conflict UI
├── index.html        # UI markup
├── style.css         # Glassmorphism dark theme
├── products.json     # Static 12-SKU catalog (what Gemma is prompted with)
├── requirements.txt  # Python dependencies (torch installed separately)
├── run.sh            # One-command setup and start
├── qdrant_db/        # Qdrant persistent storage (gitignored)
└── product_images/   # Stored product photos (gitignored)
```

## Performance

- Gemma inference: ~2–4s per image (CPU, local Ollama)
- SigLIP encoding: ~1s per image (CPU)
- Qdrant search: ~5ms for 1000 vectors
- Both models run in parallel — total latency is max(Gemma, SigLIP), not sum

## Notes

- **Adding photos improves accuracy**: the more angles you add for a product (up to 3), the more vectors are indexed, improving SigLIP's recall for that product.
- **The custom vector store grows over time**: each new product add increases coverage for future misclassifications.
- **Threshold tuning**: if you're getting too many false conflicts (SigLIP flagging correctly-identified items), raise `CONFLICT_THRESHOLD`. If genuine conflicts are being missed, lower it.
- **Data stays local**: all inference runs on-device via Ollama and local SigLIP. No images sent to cloud.
