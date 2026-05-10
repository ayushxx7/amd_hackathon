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
    let lastMatchedItem  = null;   // last item Gemma matched, used for wrong-product correction
    let catalogProducts  = [];     // products.json items, fetched once on load

    async function loadCatalog() {
        try {
            const res = await fetch('/api/catalog');
            catalogProducts = (await res.json()).products || [];
        } catch(e) { console.error('Failed to load catalog:', e); }
    }
    loadCatalog();

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
        lastMatchedItem = item;
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
                    <button class="btn-wrong-product" id="wrong-product-btn">&#x270F; Not this product?</button>
                </div>
                <div class="product-price-info">
                    <span class="price-label">Price</span>
                    <span class="price-value">&#x20B9;${item.price.toFixed(2)}</span>
                </div>
            </div>`;
        document.getElementById('wrong-product-btn').addEventListener('click', () => handleWrongProduct(item));
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
    function showSimilarModal(
        vectorResults,
        catalogItems = [],
        title    = 'Similar Products Found',
        subtitle = "The AI couldn't match this item exactly. Pick one or add it as new."
    ) {
        document.getElementById('similar-modal-title').textContent    = title;
        document.getElementById('similar-modal-subtitle').textContent = subtitle;

        let html = '';
        if (vectorResults.length > 0) {
            html += `<div class="modal-section-label">Visual matches from your custom catalog</div>
                     <div class="similar-grid">${vectorResults.map(renderVectorCard).join('')}</div>`;
        }
        if (catalogItems.length > 0) {
            const lbl = vectorResults.length > 0 ? 'Or pick from your product catalog' : 'Pick from your product catalog';
            html += `<div class="modal-section-label">${lbl}</div>
                     <div class="catalog-grid">${catalogItems.map(renderCatalogCard).join('')}</div>`;
        }
        if (!html) {
            html = `<p class="placeholder-text" style="text-align:center;padding:2rem 0">No matches found.</p>`;
        }

        similarGrid.innerHTML = html;

        similarGrid.querySelectorAll('.btn-add-similar, .btn-add-catalog').forEach(btn => {
            btn.addEventListener('click', () => {
                addToCart({ id: btn.dataset.id, name: btn.dataset.name, price: parseFloat(btn.dataset.price), unit: btn.dataset.unit });
                closeSimilarModal();
                showNotification(`Added ${btn.dataset.name} to bill`);
            });
        });

        similarModal.classList.remove('hidden');
    }

    function renderVectorCard(r) {
        return `
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
                        <div class="score-label"><span>Visual match</span><span>${Math.round(r.score * 100)}%</span></div>
                        <div class="score-track"><div class="score-fill" style="width:${Math.round(r.score * 100)}%"></div></div>
                    </div>
                    <div class="similar-price">&#x20B9;${Number(r.price).toFixed(2)}</div>
                </div>
                <button class="btn-add-similar"
                        data-id="${r.product_id}"
                        data-name="${r.name.replace(/"/g, '&quot;')}"
                        data-price="${r.price}"
                        data-unit="${r.unit || 'N/A'}">Add to Cart</button>
            </div>`;
    }

    function renderCatalogCard(p) {
        return `
            <div class="catalog-card">
                <div class="catalog-card-info">
                    <div class="catalog-card-name" title="${p.name}">${p.name}</div>
                    <div class="catalog-card-meta">${[p.brand, p.unit].filter(Boolean).join(' &middot; ')}</div>
                </div>
                <div class="catalog-card-right">
                    <div class="catalog-card-price">&#x20B9;${Number(p.price).toFixed(2)}</div>
                    <button class="btn-add-catalog"
                            data-id="${p.id}"
                            data-name="${p.name.replace(/"/g, '&quot;')}"
                            data-price="${p.price}"
                            data-unit="${p.unit || 'N/A'}">Add</button>
                </div>
            </div>`;
    }

    function closeSimilarModal() {
        similarModal.classList.add('hidden');
    }

    similarCloseBtn.addEventListener('click', closeSimilarModal);
    similarModal.addEventListener('click', e => { if (e.target === similarModal) closeSimilarModal(); });
    addNewFromSimilarBtn.addEventListener('click', () => { closeSimilarModal(); showAddModal(); });

    // ── Misclassification correction ──────────────────────────────────────────
    function removeLastFromCart(itemId) {
        const idx = cart.findIndex(i => i.id === itemId);
        if (idx === -1) return;
        if (cart[idx].quantity > 1) cart[idx].quantity -= 1;
        else cart.splice(idx, 1);
        renderCart();
    }

    async function handleWrongProduct(wrongItem) {
        removeLastFromCart(wrongItem.id);
        lastItemInfo.innerHTML = `<p class="placeholder-text">Removed &mdash; finding the correct product&hellip;</p>`;
        showNotification(`Removed ${wrongItem.name} — select the correct one`, 'warning');

        let vectorResults = [];
        if (lastCapturedBlob) {
            try {
                const fd = new FormData();
                fd.append('file', lastCapturedBlob, 'captured.jpg');
                vectorResults = (await (await fetch('/api/vector-search', { method: 'POST', body: fd })).json()).vector_results || [];
            } catch(e) { console.error('Correction vector search failed:', e); }
        }

        showSimilarModal(
            vectorResults,
            catalogProducts,
            'Select the Correct Product',
            'The item was misidentified. Pick the correct product from the list or add it as new.'
        );
    }

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

    // ── Manage Custom Catalog Modal ───────────────────────────────────────────
    const manageModal       = document.getElementById('manage-modal');
    const manageCloseBtn    = document.getElementById('manage-close-btn');
    const manageList        = document.getElementById('manage-products-list');
    const manageCatalogBtn  = document.getElementById('manage-catalog-btn');

    manageCatalogBtn.addEventListener('click', openManageModal);
    manageCloseBtn.addEventListener('click', closeManageModal);
    manageModal.addEventListener('click', e => { if (e.target === manageModal) closeManageModal(); });

    async function openManageModal() {
        manageList.innerHTML = '<p class="placeholder-text" style="text-align:center;padding:2rem">Loading&hellip;</p>';
        manageModal.classList.remove('hidden');
        try {
            const data = await (await fetch('/api/vector-products')).json();
            renderManageList(data.products || []);
        } catch(e) {
            manageList.innerHTML = '<p class="placeholder-text" style="text-align:center;padding:2rem">Failed to load.</p>';
        }
    }

    function closeManageModal() {
        manageModal.classList.add('hidden');
    }

    function renderManageList(products) {
        if (products.length === 0) {
            manageList.innerHTML = `
                <div class="manage-empty">
                    <p style="font-size:2rem">&#x1F4E6;</p>
                    <p>No custom products yet.</p>
                    <p class="placeholder-text">Scan an unknown item and add it to start building your catalog.</p>
                </div>`;
            return;
        }
        manageList.innerHTML = products.map(p => `
            <div class="manage-card" id="mc-${p.product_id}">
                <div class="manage-thumb">
                    ${p.thumbnail_url
                        ? `<img src="${p.thumbnail_url}" alt="${p.name}" onerror="this.parentNode.innerHTML='&#x1F4E6;'">`
                        : '&#x1F4E6;'}
                </div>
                <div class="manage-info">
                    <div class="manage-name">${p.name}</div>
                    <div class="manage-meta">${[p.category, p.brand, p.unit].filter(Boolean).join(' &middot; ')}</div>
                    <div class="manage-price">&#x20B9;${Number(p.price).toFixed(2)}</div>
                </div>
                <button class="btn-delete-product"
                        data-id="${p.product_id}"
                        data-name="${p.name.replace(/"/g, '&quot;')}">
                    &#x1F5D1; Delete
                </button>
            </div>`).join('');

        manageList.querySelectorAll('.btn-delete-product').forEach(btn => {
            btn.addEventListener('click', async () => {
                const id   = btn.dataset.id;
                const name = btn.dataset.name;
                if (!confirm(`Delete "${name}" from your catalog?\nThis will also remove all stored photos and cannot be undone.`)) return;

                btn.textContent = 'Deleting…';
                btn.disabled = true;

                try {
                    const res = await fetch(`/api/delete-product/${id}`, { method: 'DELETE' });
                    if ((await res.json()).success) {
                        document.getElementById(`mc-${id}`)?.remove();
                        showNotification(`Deleted "${name}" from catalog`);
                        if (!manageList.querySelector('.manage-card')) renderManageList([]);
                    }
                } catch(e) {
                    showNotification('Failed to delete.', 'error');
                    btn.textContent = '&#x1F5D1; Delete';
                    btn.disabled = false;
                }
            });
        });
    }

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
