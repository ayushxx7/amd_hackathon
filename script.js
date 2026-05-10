document.addEventListener('DOMContentLoaded', () => {

    // ── DOM refs ─────────────────────────────────────────────────────────────
    const webcam              = document.getElementById('webcam');
    const captureCanvas       = document.getElementById('capture-canvas');
    const scanBtn             = document.getElementById('scan-btn');
    const lastItemInfo        = document.getElementById('last-item-info');
    const cartItemsContainer  = document.getElementById('cart-items');
    const emptyCartMsg        = document.getElementById('empty-cart');
    const itemCountSpan       = document.getElementById('item-count');
    const totalPriceSpan      = document.getElementById('total-price');
    const checkoutBtn         = document.getElementById('checkout-btn');
    const clearBtn            = document.getElementById('clear-btn');
    const uploadBtn           = document.getElementById('upload-btn');
    const fileInput           = document.getElementById('file-input');
    const detectionStatus     = document.getElementById('detection-status');
    const statusText          = document.getElementById('status-text');
    const notificationContainer = document.getElementById('notification-container');

    // Similar-products modal
    const similarModal        = document.getElementById('similar-modal');
    const similarGrid         = document.getElementById('similar-products-grid');
    const similarCloseBtn     = document.getElementById('similar-close-btn');
    const addNewFromSimilarBtn = document.getElementById('add-new-from-similar');

    // Add-product modal
    const addModal            = document.getElementById('add-modal');
    const addCloseBtn         = document.getElementById('add-close-btn');
    const addProductForm      = document.getElementById('add-product-form');
    const newImagesInput      = document.getElementById('new-images-input');
    const uploadZone          = document.getElementById('upload-zone');
    const imagePreviewStrip   = document.getElementById('image-preview-strip');
    const uploadPlaceholderText = document.getElementById('upload-placeholder-text');
    const saveBtn             = document.getElementById('save-btn');
    const saveLoader          = document.getElementById('save-loader');

    // ── State ─────────────────────────────────────────────────────────────────
    let cart = [];
    let isAnalyzing = false;
    let lastCapturedBlob = null;   // most recent camera/upload blob, reused in add-product form

    // ── Webcam ───────────────────────────────────────────────────────────────
    async function initWebcam() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }
            });
            webcam.srcObject = stream;
        } catch (err) {
            console.error('Camera error:', err);
            showNotification('Could not access camera. Check permissions.', 'error');
        }
    }
    initWebcam();

    // ── Scan ─────────────────────────────────────────────────────────────────
    scanBtn.addEventListener('click', async () => {
        if (isAnalyzing) return;
        setLoading(true);
        detectionStatus.classList.remove('hidden');
        statusText.textContent = 'Identifying...';

        const MAX = 256;
        let w = webcam.videoWidth, h = webcam.videoHeight;
        if (w > h) { if (w > MAX) { h = Math.round(h * MAX / w); w = MAX; } }
        else        { if (h > MAX) { w = Math.round(w * MAX / h); h = MAX; } }

        const ctx = captureCanvas.getContext('2d');
        captureCanvas.width = w;
        captureCanvas.height = h;
        ctx.drawImage(webcam, 0, 0, w, h);

        const blob = await new Promise(r => captureCanvas.toBlob(r, 'image/jpeg', 0.8));
        lastCapturedBlob = blob;

        const fd = new FormData();
        fd.append('file', blob, 'capture.jpg');

        try {
            const res = await fetch('/api/inference', { method: 'POST', body: fd });
            if (!res.ok) throw new Error('Scan failed');
            const data = await res.json();
            if (data.success && data.data.id !== 'unknown') {
                handleMatch(data.data);
            } else {
                handleNoMatch(data.data.description || 'Item not found in catalog.', data.vector_results || []);
            }
        } catch (err) {
            console.error(err);
            showNotification('Error connecting to server.', 'error');
        } finally {
            setLoading(false);
            detectionStatus.classList.add('hidden');
        }
    });

    // ── Upload ───────────────────────────────────────────────────────────────
    uploadBtn.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        lastCapturedBlob = file;

        setLoading(true);
        detectionStatus.classList.remove('hidden');
        statusText.textContent = 'Analyzing image...';

        const fd = new FormData();
        fd.append('file', file);

        try {
            const res = await fetch('/api/inference', { method: 'POST', body: fd });
            const data = await res.json();
            if (data.success && data.data.id !== 'unknown') {
                handleMatch(data.data);
            } else {
                handleNoMatch(data.data.description || 'Item not found in catalog.', data.vector_results || []);
            }
        } catch (err) {
            showNotification('Error scanning uploaded file.', 'error');
        } finally {
            setLoading(false);
            detectionStatus.classList.add('hidden');
            fileInput.value = '';
        }
    });

    // ── Result handlers ───────────────────────────────────────────────────────
    function handleMatch(item) {
        lastItemInfo.innerHTML = `
            <div class="product-result">
                <div class="product-main-info">
                    <div class="product-name">${item.name}</div>
                    <div class="product-meta">
                        <span class="sku-tag">${item.id}</span>
                        <span class="category-tag">${item.category}</span>
                        <span class="brand-tag">Brand: ${item.brand}</span>
                        <span class="unit-tag">Unit: ${item.unit}</span>
                    </div>
                </div>
                <div class="product-price-info">
                    <span class="price-label">Price</span>
                    <span class="price-value">&#x20B9;${item.price.toFixed(2)}</span>
                </div>
            </div>`;
        addToCart(item);
        showNotification(`Added ${item.name} to bill`);
    }

    function handleNoMatch(description, vectorResults) {
        const hasMatches = vectorResults && vectorResults.length > 0;
        lastItemInfo.innerHTML = `
            <div class="no-match">
                <p><strong>Unrecognized Item</strong></p>
                <p class="placeholder-text">${description}</p>
                <span class="vector-hint" id="open-modal-hint">
                    ${hasMatches
                        ? `&#x1F50D; ${vectorResults.length} similar product(s) found &mdash; click to view`
                        : '&#x2795; Item not in catalog &mdash; click to add it'}
                </span>
            </div>`;

        document.getElementById('open-modal-hint').addEventListener('click', () => {
            if (hasMatches) showSimilarModal(vectorResults);
            else showAddModal();
        });

        if (hasMatches) {
            showSimilarModal(vectorResults);
            showNotification(`Found ${vectorResults.length} similar product(s)`, 'warning');
        } else {
            showAddModal();
            showNotification('Item not recognized — add it to your catalog', 'error');
        }
    }

    // ── Cart ──────────────────────────────────────────────────────────────────
    function addToCart(item) {
        const existing = cart.find(i => i.id === item.id);
        if (existing) {
            existing.quantity += 1;
        } else {
            cart.push({ id: item.id, name: item.name, price: item.price, unit: item.unit || 'N/A', quantity: 1 });
        }
        renderCart();
    }

    function renderCart() {
        if (cart.length === 0) {
            emptyCartMsg.classList.remove('hidden');
            cartItemsContainer.querySelectorAll('.cart-item').forEach(el => el.remove());
            checkoutBtn.disabled = true;
            totalPriceSpan.textContent = '&#x20B9;0.00';
            itemCountSpan.textContent = '0 items';
            return;
        }

        emptyCartMsg.classList.add('hidden');
        cartItemsContainer.querySelectorAll('.cart-item').forEach(el => el.remove());

        let total = 0, totalQty = 0;
        cart.forEach(item => {
            const itemTotal = item.price * item.quantity;
            total += itemTotal;
            totalQty += item.quantity;

            const el = document.createElement('div');
            el.className = 'cart-item';
            el.innerHTML = `
                <div class="item-info">
                    <span class="item-name">${item.name} <small>(${item.unit})</small></span>
                    <div class="item-details">
                        <span class="item-sku">${item.id}</span>
                        <span class="item-qty">Qty: ${item.quantity}</span>
                    </div>
                </div>
                <div class="item-price">&#x20B9;${itemTotal.toFixed(2)}</div>`;
            cartItemsContainer.appendChild(el);
        });

        totalPriceSpan.textContent = `&#x20B9;${total.toFixed(2)}`;
        itemCountSpan.textContent  = `${totalQty} item${totalQty !== 1 ? 's' : ''}`;
        checkoutBtn.disabled = false;
    }

    clearBtn.addEventListener('click', () => {
        cart = [];
        renderCart();
        lastItemInfo.innerHTML = '<p class="placeholder-text">Scan an item to see details</p>';
        showNotification('Cart cleared');
    });

    checkoutBtn.addEventListener('click', () => {
        const total = cart.reduce((s, i) => s + i.price * i.quantity, 0);
        const qty   = cart.reduce((s, i) => s + i.quantity, 0);
        alert(`Bill Generated!\nTotal Items: ${qty}\nTotal Amount: ₹${total.toFixed(2)}`);
        cart = [];
        renderCart();
    });

    // ── Similar Products Modal ────────────────────────────────────────────────
    function showSimilarModal(results) {
        similarGrid.innerHTML = results.map(r => `
            <div class="similar-card">
                <div class="similar-thumb">
                    ${r.thumbnail_url
                        ? `<img src="${r.thumbnail_url}" alt="${r.name}" onerror="this.parentNode.innerHTML='&#x1F4E6;'">`
                        : '&#x1F4E6;'}
                </div>
                <div class="similar-card-body">
                    <div class="similar-name">${r.name}</div>
                    <div class="similar-meta">${[r.brand, r.unit].filter(Boolean).join(' &middot; ')}</div>
                    <div class="similar-score-bar">
                        <div class="score-label">
                            <span>Visual match</span>
                            <span>${Math.round(r.score * 100)}%</span>
                        </div>
                        <div class="score-track">
                            <div class="score-fill" style="width:${Math.round(r.score * 100)}%"></div>
                        </div>
                    </div>
                    <div class="similar-price">&#x20B9;${Number(r.price).toFixed(2)}</div>
                </div>
                <button class="btn-add-similar"
                        data-id="${r.product_id}"
                        data-name="${r.name.replace(/"/g, '&quot;')}"
                        data-price="${r.price}"
                        data-unit="${r.unit || 'N/A'}">
                    Add to Cart
                </button>
            </div>`).join('');

        similarGrid.querySelectorAll('.btn-add-similar').forEach(btn => {
            btn.addEventListener('click', () => {
                addToCart({
                    id:    btn.dataset.id,
                    name:  btn.dataset.name,
                    price: parseFloat(btn.dataset.price),
                    unit:  btn.dataset.unit,
                });
                closeSimilarModal();
                showNotification(`Added ${btn.dataset.name} to bill`);
            });
        });

        similarModal.classList.remove('hidden');
    }

    function closeSimilarModal() {
        similarModal.classList.add('hidden');
    }

    similarCloseBtn.addEventListener('click', closeSimilarModal);
    similarModal.addEventListener('click', e => { if (e.target === similarModal) closeSimilarModal(); });
    addNewFromSimilarBtn.addEventListener('click', () => { closeSimilarModal(); showAddModal(); });

    // ── Add Product Modal ─────────────────────────────────────────────────────
    function showAddModal() {
        addProductForm.reset();
        imagePreviewStrip.innerHTML = '';
        newImagesInput.value = '';

        // Pre-populate captured image as the first preview photo
        if (lastCapturedBlob) {
            addPreviewImage(URL.createObjectURL(lastCapturedBlob), true);
            uploadPlaceholderText.textContent = 'Click to add more photos';
        } else {
            uploadPlaceholderText.textContent = 'Click to add photos';
        }

        addModal.classList.remove('hidden');
    }

    function closeAddModal() {
        addModal.classList.add('hidden');
    }

    function addPreviewImage(src, isCaptured = false) {
        const img = document.createElement('img');
        img.src = src;
        img.className = `preview-thumb${isCaptured ? ' captured' : ''}`;
        img.title = isCaptured ? 'Captured photo' : 'Uploaded photo';
        imagePreviewStrip.appendChild(img);
    }

    addCloseBtn.addEventListener('click', closeAddModal);
    addModal.addEventListener('click', e => { if (e.target === addModal) closeAddModal(); });

    uploadZone.addEventListener('click', () => newImagesInput.click());

    newImagesInput.addEventListener('change', () => {
        const files = Array.from(newImagesInput.files).slice(0, 3);

        // Keep captured thumb if it exists, replace file-upload thumbs
        const capturedThumb = imagePreviewStrip.querySelector('.captured');
        imagePreviewStrip.innerHTML = '';
        if (capturedThumb) imagePreviewStrip.appendChild(capturedThumb);

        files.forEach(f => addPreviewImage(URL.createObjectURL(f)));
        const total = imagePreviewStrip.children.length;
        uploadPlaceholderText.textContent = `${total} photo${total !== 1 ? 's' : ''} selected`;
    });

    addProductForm.addEventListener('submit', async e => {
        e.preventDefault();

        const name     = document.getElementById('new-name').value.trim();
        const priceVal = document.getElementById('new-price').value;
        const category = document.getElementById('new-category').value.trim() || 'General';
        const brand    = document.getElementById('new-brand').value.trim()    || 'Unknown';
        const unit     = document.getElementById('new-unit').value.trim()     || 'N/A';

        if (!name || !priceVal) {
            showNotification('Please fill in Name and Price.', 'error');
            return;
        }

        const fd = new FormData();
        fd.append('name',     name);
        fd.append('price',    parseFloat(priceVal));
        fd.append('category', category);
        fd.append('brand',    brand);
        fd.append('unit',     unit);

        const userFiles = Array.from(newImagesInput.files).slice(0, 3);
        if (userFiles.length > 0) {
            userFiles.forEach(f => fd.append('images', f));
        } else if (lastCapturedBlob) {
            fd.append('images', lastCapturedBlob, 'captured.jpg');
        } else {
            showNotification('Please add at least one photo.', 'error');
            return;
        }

        setSaveLoading(true);
        try {
            const res = await fetch('/api/add-product', { method: 'POST', body: fd });
            const result = await res.json();
            if (result.success) {
                addToCart({ id: result.product_id, name, price: parseFloat(priceVal), unit });
                closeAddModal();
                showNotification(`"${name}" saved to catalog & added to cart`);
            } else {
                showNotification('Failed to save product.', 'error');
            }
        } catch (err) {
            showNotification('Server error while saving.', 'error');
        } finally {
            setSaveLoading(false);
        }
    });

    // ── Utilities ─────────────────────────────────────────────────────────────
    function setLoading(on) {
        isAnalyzing = on;
        scanBtn.disabled = on;
        scanBtn.querySelector('.loader').classList.toggle('hidden', !on);
        scanBtn.querySelector('.btn-text').textContent = on ? 'Analyzing...' : 'Scan & Add Item';
    }

    function setSaveLoading(on) {
        saveBtn.disabled = on;
        saveLoader.classList.toggle('hidden', !on);
        saveBtn.querySelector('.btn-text').textContent = on ? 'Saving...' : 'Save & Add to Cart';
    }

    function showNotification(message, type = 'success') {
        const toast = document.createElement('div');
        toast.className = `notification ${type}`;
        toast.textContent = message;
        notificationContainer.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateX(20px)';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }
});
