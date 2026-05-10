# KiranaAI — Visual Billing Counter with Vector-Powered Product Recognition

A local grocery store billing system that uses **multimodal AI** to recognize products from photos and automatically populate the bill. Built for offline-first operation in small Indian retail shops.

## 🎯 Why This System?

Traditional billing requires manual entry for every item. **KiranaAI** eliminates this:

1. **Primary Classifier (Gemma 4)**: Fast, accurate recognition for known products
2. **Fallback Vector Search (SigLIP + Qdrant)**: Handles unknown/new SKUs without retraining
3. **Correction Flow**: When Gemma misclassifies, users instantly find the right product
4. **Custom Catalog**: Shop staff can add new products as they arrive

## 🏗️ Architecture

```
User scans product with camera
    ↓
[Gemma 4 multimodal LLM via Ollama]
    ↓
    ├─ Recognized (confidence) → Add to bill ✓
    │
    └─ Unknown → Vector Search Fallback
        ↓
        [SigLIP image encoder + Qdrant vector DB]
        ↓
        ├─ Found similar products → User picks correct one or adds as new
        └─ Not found → Prompt user to add as new product
```

## 🛠️ Tech Stack

| Component | Choice | Why |
|-----------|--------|-----|
| **Backend** | FastAPI + Uvicorn | Async, lightweight, perfect for local deployment |
| **Primary Model** | Gemma 4 (via Ollama) | Local inference, no cloud API calls, privacy-first |
| **Image Embeddings** | SigLIP 2 (google/siglip-base-patch16-224) | Multilingual, 2025 SOTA for product retrieval, 768-dim vectors |
| **Vector DB** | Qdrant (local mode) | Persistent, metadata filtering, Python-friendly, no Docker needed |
| **Frontend** | Vanilla HTML/CSS/JS | Zero dependencies, glassmorphism dark theme, responsive |
| **Image Storage** | Filesystem + Qdrant metadata | Avoids DB bloat, enables HTTP serving, simple backup |

## 🚀 Features

### Core Billing
- **Camera-based product scanning** with live video overlay
- **File upload fallback** for sample images
- **Real-time cart management** with quantity tracking and total calculation
- **Bill generation** with item count and amount summary

### Intelligent Recognition
- **Gemma 4 classification** on known products (SKU-001 through SKU-012 in catalog)
- **Vector-store fallback** for unknown items — automatically searches custom catalog
- **Similarity scoring** — shows visual match % (60–100%) when multiple candidates exist

### Misclassification Recovery
- **"Not this product?" button** on every recognized item
- **One-click correction**: removes wrong item, opens similar products modal
- **Dual view**: shows both custom-catalog vector matches + full products.json for easy selection
- **No dead ends**: unknown items can always be added for next time

### Custom Catalog Management
- **Add new products** with 1–3 angle photos, name, price, category, brand, unit
- **Vector-indexed immediately** — next scan of similar item finds it
- **Manage Custom Catalog** button in sidebar
- **Delete products** with confirmation — removes both vectors and photos from disk

### Resilience
- **Local Ollama + SigLIP** — works without internet (after first model download)
- **Qdrant local DB** — no server dependency, persistent across restarts
- **Graceful unknown handling** — never stuck, always can add/search

## 📊 How It Works

### Scenario 1: Known Product (Happy Path)
```
Scan Samsung Galaxy S23 box
  → Gemma recognizes it (high confidence)
  → Shows price ₹97,000, SKU-011, category Electronics
  → User clicks "Add to Bill" (auto-added)
  → Item appears in cart
```

### Scenario 2: Unknown/New Product
```
Scan a brand-new snack brand
  → Gemma returns "unknown"
  → System runs vector search on captured image
  → Finds 2–3 visually similar products in custom catalog (if any)
  → Shows "Similar Products Found" modal
  → User picks closest match OR clicks "Add as New Product"
  → If new: enters name/price/category, uploads 1–3 photos
  → Product saved to vector DB immediately
```

### Scenario 3: Misclassification Correction
```
Scan Xiaomi Redmi Note 4
  → Gemma wrongly classifies as Samsung Galaxy S23
  → User clicks "Not this product?" button
  → Item removed from cart
  → Modal opens with vector-similar products + all catalog products
  → User finds and clicks "Xiaomi Redmi Note 4"
  → Correct product added to cart
```

## 🔧 Setup & Running

### Prerequisites
- Python 3.13+
- Ollama running locally with `gemma4:e4b` model
- ~2GB free disk (for SigLIP model cache + vector DB)

### Installation

```bash
cd /home/dedsec/Kirana/Plan2/amd_hackathon
bash run.sh
```

**What `run.sh` does:**
1. Creates virtual environment (venv)
2. Installs PyTorch CPU-only variant (faster download than CUDA)
3. Installs remaining dependencies (transformers, qdrant-client, fastapi, ollama, etc.)
4. Kills any process on port 6001
5. Starts FastAPI server on `http://0.0.0.0:6001`

**On first run:**
- SigLIP model (~400MB) downloads from HuggingFace (one-time)
- Qdrant collection created at `./qdrant_db/`
- Product images stored at `./product_images/`

### Usage

Open browser to `http://localhost:6001`

1. **Scan & Add Item** — Capture from webcam or upload image
2. **Handle results**:
   - ✅ Recognized → Auto-added to cart
   - ❓ Unknown → Vector search, pick similar or add new
   - ❌ Wrong → Click "Not this product?", find correct one
3. **Manage Custom Catalog** — View, review, delete added products
4. **Generate Bill** — Checkout with total amount

## 🗂️ Project Structure

```
amd_hackathon/
├── main.py              # FastAPI backend (291 lines)
│   ├── Gemma 4 inference endpoint
│   ├── Vector search (SigLIP + Qdrant)
│   ├── Product add/delete/list endpoints
│   └── Image serving
├── script.js            # Frontend logic (560+ lines)
│   ├── Webcam/upload handling
│   ├── Scan → classify flow
│   ├── Similar products modal
│   ├── Wrong product correction
│   ├── Custom catalog management
│   └── Cart management
├── index.html           # UI markup (177 lines)
│   ├── Sidebar (cart, checkout)
│   ├── Camera feed + overlay
│   ├── Last scanned item info
│   ├── Similar products modal
│   ├── Add product form
│   └── Manage catalog modal
├── style.css            # Glassmorphism dark theme (1150+ lines)
├── products.json        # Initial catalog (12 SKUs)
├── requirements.txt     # Dependencies
├── run.sh               # Startup script
└── .gitignore           # VCS exclusions
```

## 🔌 API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/inference` | Send image → Gemma classification + vector fallback |
| POST | `/api/vector-search` | Image → Vector search only (for corrections) |
| POST | `/api/add-product` | Add new product with images to vector DB |
| GET | `/api/catalog` | Fetch products.json |
| GET | `/api/vector-products` | List all custom products in vector DB |
| DELETE | `/api/delete-product/{id}` | Remove product + images from system |
| GET | `/api/images/{id}/{file}` | Serve product thumbnail/photos |
| GET | `/` | Serve UI |

## 📦 Dependencies

**Backend:**
- `fastapi` — Web framework
- `uvicorn` — ASGI server
- `ollama` — Gemma 4 client
- `transformers` — SigLIP processor + model
- `torch` — PyTorch (CPU)
- `qdrant-client` — Vector DB client
- `pillow` — Image processing
- `python-multipart` — Form data parsing

**Frontend:**
- Vanilla JavaScript (no npm, no bundler)
- Modern CSS3 (flexbox, grid, backdrop-filter)

## 🎨 UI/UX Features

- **Glassmorphism dark theme** — modern, readable, low CPU for mobile displays
- **Animated scanner overlay** — visual feedback that camera is scanning
- **Real-time status badge** — "Identifying..." during inference
- **Toast notifications** — success/warning/error messages fade in/out
- **Responsive design** — works on tablets and phones (tested 16:9 ratio)
- **Accessibility** — keyboard navigation on modals, semantic HTML

## ⚡ Performance

- **Gemma inference**: ~2–4s per image (CPU, local Ollama)
- **SigLIP encoding**: ~1s per image (CPU)
- **Qdrant vector search**: ~5ms for 1000 vectors
- **UI responsiveness**: <100ms interactions
- **Image optimization**: 512×512 JPEG @ 75% before inference

## 🛡️ Data Privacy & Security

- **All inference is local** — no images sent to cloud
- **No user accounts** — works offline, no tracking
- **Vector DB is persistent** — survives restarts, backed up locally
- **Image path validation** — prevents directory traversal attacks
- **CORS open for development** — should be locked to localhost in production

## 🔮 Future Enhancements

1. **OCR text matching** — use Tesseract to match packaging text (resolve similar-looking variants)
2. **Inventory tracking** — log scans to track stock depletion
3. **Batch operations** — scan 10 items at once, bulk bill generation
4. **Barcode fallback** — add barcode scanner for items with no visual distinctiveness
5. **Multi-language support** — Devanagari, Tamil, Telugu product names
6. **Mobile app** — React Native or Flutter for mobile checkout
7. **Analytics** — most-scanned items, misclassification rates
8. **Fine-tuning** — adapt SigLIP to your specific store's products after 100+ scans

## 📝 Notes

- **First run is slow**: SigLIP downloads ~400MB from HuggingFace. Cached after that.
- **Gemma must be running**: Start Ollama before starting the app.
- **Vector store grows over time**: Every new product added increases similarity search coverage.
- **Similarity threshold is tunable**: Edit `SIM_THRESHOLD` in `main.py` (default: 0.60) to control match strictness.

## 🤝 Contributing

To add features:
1. Sketch the flow (user interactions, API calls)
2. Add backend endpoint if needed
3. Update frontend modals/logic
4. Add CSS for new UI elements
5. Test with real scans in store conditions

## 📄 License

Built for Bharat's retailers. Use freely, improve it, share it.

---

**Questions?** Check the logs in `stdout` or add `print()` statements in `main.py` to debug inference results.
