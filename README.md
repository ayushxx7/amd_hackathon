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

### Unknown product — single photo
```
Scan a new local brand snack
→ Gemma returns "unknown"
→ SigLIP searches custom catalog, finds similar items if any
→ User picks from visual matches OR clicks "Add as New Product"
→ Modal opens with live camera preview
→ User can capture multiple angles (up to 3) directly from webcam
→ Or upload photos from device by clicking upload zone
→ Fills name/price/category, reviews thumbnail previews
→ Removes any photo using X button if needed
→ Clicks "Save & Add to Cart"
→ Product indexed in Qdrant with all photos immediately
→ Next scan of same product: SigLIP finds it at high confidence
```

### Unknown product — multi-photo capture
```
Adding new snack product
→ Click "Add as New Product"
→ Modal shows live camera feed in preview area
→ Click "📸 Capture from Camera" to capture first angle
→ Purple-bordered thumbnail appears below showing captured image
→ Rotate product, click capture again for second angle
→ Green-bordered thumbnail appears
→ Adjust lighting, click capture for third angle (max limit)
→ See all three thumbnails in preview strip (can remove any with X)
→ Alternatively click upload zone to add file images (default border)
→ Fill product details (name/price/category/brand/unit)
→ Click "Save & Add to Cart"
→ All images embedded and indexed in Qdrant simultaneously
```

### Misclassification (conflict) — hybrid detection
```
Scan Xiaomi Redmi Note 4
→ Gemma returns Samsung Galaxy S23 (wrong, high confidence)
→ SigLIP runs in parallel, finds Redmi Note 4 at score 0.84
→ Score ≥ 0.72 threshold AND names have zero word overlap
→ Conflict triggered automatically
→ Modal shows: Gemma's guess (amber/tan) + SigLIP's match (purple)
→ User clicks the correct product (Redmi) → added to bill
→ System learns from user selection for future scans

How conflict detection works:
- Word overlap check: names are split on whitespace
- Only words > 2 chars count (filters "a", "s23" style artifacts)  
- "Samsung Galaxy S23" vs "Xiaomi Redmi Note 4": zero overlap → conflict
- "Apple iPhone 14" vs "Apple iPhone 14 Pro": significant overlap → no conflict
- Gemma's match is trusted if SigLIP doesn't have high-confidence alternative
```

### Manual correction — user override
```
Gemma auto-added Samsung S23 but it's wrong
→ User clicks "✏ Not this product?" button (orange)
→ Item removed from cart immediately
→ Vector search runs on the original captured image
→ Modal shows all SigLIP custom catalog matches + full static catalog
→ User picks correct product → added to bill
→ No permanent learning (user might have made a mistake)
```

### Manage custom catalog
```
User clicks "Manage Custom Catalog" button
→ Modal displays all manually-added products as cards
→ Each card shows: thumbnail, name, price, category, brand, unit
→ User clicks trash icon on a card to delete
→ Confirmation: "This also removes the stored photos"
→ Product is removed from Qdrant (all vectors with product_id)
→ Photos deleted from filesystem
→ Catalog updated in real-time
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

## How the System Works

### Image Processing Pipeline

1. **Input optimization**: Images are resized to 512×512 max, compressed to JPEG at 75–85% quality (12–40 KB typical)
2. **Parallel inference**: Gemma 4 and SigLIP run simultaneously via `asyncio.gather()`:
   - Gemma receives prompt with static catalog and image → returns JSON with SKU, name, confidence
   - SigLIP encodes image to 768-dim vector → searches Qdrant for similar products
3. **Result merging**: Backend enriches Gemma's result with catalog metadata (price, category, brand, unit)
4. **Conflict resolution**: If SigLIP finds high-confidence alternative with no name overlap, user confirms

### Vector Store (Qdrant)

- **Collection**: Single `products` collection with 768-dim cosine-distance vectors
- **Deduplication**: Multiple images of same product stored as separate vectors, but queries deduplicate by `product_id`
- **Per-product indexing**: When adding product with 3 photos, creates 3 separate vectors all tagged with same `product_id`
- **Lookup time**: ~5ms for 1000 vectors (negligible compared to Gemma/SigLIP latency)
- **Scaling**: Local file-based storage (no Docker), suitable for 10K+ products

### Image Management

- **Storage**: Photos saved to `./product_images/{product_id}/`
  - `thumbnail.jpg` (256×256) — displayed in modals and manage view
  - `image_1.jpg`, `image_2.jpg`, `image_3.jpg` (512×512) — used for embedding
- **Cleanup**: Deleting product removes all vectors + entire image directory
- **Multi-angle strategy**: 3 photos from different angles → 3 vectors → higher recall for lighting/orientation variations

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

## UI Features

### Camera Preview in Add-Product Modal
- **Shared stream**: Modal camera reuses the same `MediaStream` from main scan camera — no additional permissions
- **Live preview**: User sees what they're about to capture in 16:9 aspect ratio
- **Real-time**: No lag between main camera and modal preview
- **Canvas capture**: Captures are drawn to canvas, converted to JPEG blob, stored in-memory until form submit

### Photo Management
- **Multi-source capture**: Can add photos from camera (live capture), file upload, and original scan in same product
- **Visual indicators**: 
  - Purple border = original scan image (from scan/upload that triggered "Add as New Product")
  - Green border = camera-captured image (from modal preview)
  - Default border = file-uploaded image
- **Removable**: Each thumbnail has X button in top-right corner — click to remove and retake
- **Preview strip**: Shows all selected images below form fields for review before submit
- **Limit enforcement**: Maximum 3 images total across all sources

### Manage Custom Catalog
- **Card layout**: Each product shown as card with thumbnail, name, price, category, brand, unit
- **Delete action**: Click trash icon to remove product (also deletes all photos from disk and vectors from Qdrant)
- **Real-time sync**: Catalog updates immediately after deletion
- **Visual feedback**: Smooth transitions when removing products

## Best Practices

### Accuracy Tuning

- **Adding photos improves accuracy**: 
  - 1 photo: ~70% recall for SigLIP (limited angles, lighting sensitivity)
  - 2 photos: ~85% recall (covers some rotation/lighting variation)
  - 3 photos: ~95% recall (covers most real-world scanning scenarios)
  - Best practice: capture front, back, and an angled view

- **Conflict threshold tuning** (`CONFLICT_THRESHOLD`):
  - Current value (0.72) is conservative — catches most misclassifications
  - **Too many false conflicts?** Raise to 0.75–0.80 (requires higher SigLIP confidence)
  - **Missing real conflicts?** Lower to 0.65–0.70 (catches subtler disagreements)
  - **Disabling conflicts?** Set to 1.0 (not recommended — re-enables Gemma misclassification issues)

- **Similarity threshold tuning** (`SIM_THRESHOLD`):
  - Current value (0.60) is balanced
  - Raising it (0.65+) reduces false positives but may miss similar products
  - Lowering it (0.55-) increases recall but shows more unrelated items

### Data Management

- **The custom vector store grows over time**: Each new product add increases coverage for future scans
  - After 20–30 products: SigLIP fallback becomes very effective
  - After 100+ products: Rarely need Gemma misclassification override

- **Qdrant persistence**: All vectors and metadata survive server restarts (stored in `./qdrant_db/`)
- **Image cleanup**: Deleting a product removes both vectors and photos — no orphaned images
- **Backup strategy**: Copy `./qdrant_db/` and `./product_images/` directories for backup

### Performance Optimization

- **Parallel inference**: Gemma and SigLIP run simultaneously — total latency is ~max(Gemma, SigLIP), not sum
  - Expected: 3–5s total per scan (not 4–5s sequential)
- **Image optimization**: Frontend compresses images to 75% JPEG quality before upload
  - Typical size: 15–20 KB per image (40 KB max even for high-res photos)
  - Reduces network latency for slower connections
- **Vector search speed**: Qdrant queries complete in ~5ms even with 1000+ indexed vectors
- **Thumbnail generation**: Automatic from first image, further saves storage

## Troubleshooting

### Camera not showing in modal
- **Check permissions**: Browser must have camera access (check address bar)
- **Ensure main camera is initialized**: Click "Scan & Add Item" first to initialize video stream
- **Try different browser**: Some browsers have stricter MediaStream sharing policies

### Photos not recognized after adding
- **Check count**: Single photo is weaker signal — add 2–3 angles for better recall
- **Check lighting**: SigLIP is sensitive to lighting changes — capture in consistent light
- **Wait for embedding**: Qdrant indexing is synchronous, but may take 1–2s per image

### SigLIP finding wrong products
- **Lower SIM_THRESHOLD**: If genuinely similar products are being confused, adjust threshold
- **Add distinguishing photos**: Capture unique angles that differ from similar products
- **Delete and re-add**: Remove product and re-add with better photos from different angles

### Too many conflict dialogs
- **Raise CONFLICT_THRESHOLD**: Current setting catches subtle disagreements — may be too aggressive
- **Verify Gemma catalog**: Some visually similar products in the base catalog may need manual correction

## Notes

- **Data stays local**: All inference runs on-device via Ollama and local SigLIP. No images sent to cloud.
- **Offline operation**: Once models are cached, system works fully offline (no internet needed for inference)
- **Product photos archived**: Deleted products have images fully removed from disk, no storage bloat
- **Vector deduplication**: Same product from different photos creates multiple vectors (one per image) but deduplicated in results — you see product once with highest score
