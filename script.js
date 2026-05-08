document.addEventListener('DOMContentLoaded', () => {
    const webcam = document.getElementById('webcam');
    const captureCanvas = document.getElementById('capture-canvas');
    const scanBtn = document.getElementById('scan-btn');
    const lastItemInfo = document.getElementById('last-item-info');
    const cartItemsContainer = document.getElementById('cart-items');
    const emptyCartMsg = document.getElementById('empty-cart');
    const itemCountSpan = document.getElementById('item-count');
    const totalPriceSpan = document.getElementById('total-price');
    const checkoutBtn = document.getElementById('checkout-btn');
    const clearBtn = document.getElementById('clear-btn');
    const uploadBtn = document.getElementById('upload-btn');
    const fileInput = document.getElementById('file-input');
    const detectionStatus = document.getElementById('detection-status');
    const statusText = document.getElementById('status-text');
    const notificationContainer = document.getElementById('notification-container');

    let cart = [];
    let isAnalyzing = false;

    // Initialize Webcam
    async function initWebcam() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ 
                video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } } 
            });
            webcam.srcObject = stream;
        } catch (err) {
            console.error("Error accessing webcam:", err);
            showNotification("Could not access camera. Please check permissions.");
        }
    }

    initWebcam();

    // Capture and Scan
    scanBtn.addEventListener('click', async () => {
        if (isAnalyzing) return;
        
        setLoading(true);
        detectionStatus.classList.remove('hidden');
        statusText.textContent = "Identifying...";

        // Capture frame and resize for faster inference
        const MAX_SIZE = 256;
        let width = webcam.videoWidth;
        let height = webcam.videoHeight;
        
        if (width > height) {
            if (width > MAX_SIZE) {
                height = Math.round(height * (MAX_SIZE / width));
                width = MAX_SIZE;
            }
        } else {
            if (height > MAX_SIZE) {
                width = Math.round(width * (MAX_SIZE / height));
                height = MAX_SIZE;
            }
        }
        
        const context = captureCanvas.getContext('2d');
        captureCanvas.width = width;
        captureCanvas.height = height;
        context.drawImage(webcam, 0, 0, width, height);
        
        const blob = await new Promise(resolve => captureCanvas.toBlob(resolve, 'image/jpeg', 0.8));
        const formData = new FormData();
        formData.append('file', blob, 'capture.jpg');

        try {
            const response = await fetch('/api/inference', {
                method: 'POST',
                body: formData
            });

            if (!response.ok) throw new Error('Scan failed');

            const result = await response.json();
            if (result.success && result.data.id !== "unknown") {
                handleMatch(result.data);
            } else {
                handleNoMatch(result.data.description || "Item not found in catalog.");
            }
        } catch (error) {
            console.error(error);
            showNotification("Error connecting to server.");
        } finally {
            setLoading(false);
            detectionStatus.classList.add('hidden');
        }
    });

    // Manual Upload
    uploadBtn.addEventListener('click', () => fileInput.click());
    
    fileInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        
        setLoading(true);
        detectionStatus.classList.remove('hidden');
        statusText.textContent = "Analyzing Image...";

        const formData = new FormData();
        formData.append('file', file);

        try {
            const response = await fetch('/api/inference', {
                method: 'POST',
                body: formData
            });
            const result = await response.json();
            if (result.success && result.data.id !== "unknown") {
                handleMatch(result.data);
            } else {
                handleNoMatch(result.data.description || "Item not found in catalog.");
            }
        } catch (error) {
            console.error(error);
            showNotification("Error scanning uploaded file.");
        } finally {
            setLoading(false);
            detectionStatus.classList.add('hidden');
            fileInput.value = '';
        }
    });

    function handleMatch(item) {
        // Show in Last Scanned
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
                    <span class="price-value">₹${item.price.toFixed(2)}</span>
                </div>
            </div>
        `;

        // Add to cart
        addToCart(item);
        showNotification(`Added ${item.name} to bill`);
    }

    function handleNoMatch(description) {
        lastItemInfo.innerHTML = `
            <div class="no-match">
                <p><strong>Unrecognized Item</strong></p>
                <p class="placeholder-text">${description}</p>
            </div>
        `;
        showNotification("Item not recognized", "error");
    }

    function addToCart(item) {
        const existingItem = cart.find(i => i.id === item.id);
        if (existingItem) {
            existingItem.quantity += 1;
        } else {
            cart.push({
                id: item.id,
                name: item.name,
                price: item.price,
                unit: item.unit,
                quantity: 1
            });
        }
        renderCart();
    }

    function renderCart() {
        if (cart.length === 0) {
            emptyCartMsg.classList.remove('hidden');
            cartItemsContainer.querySelectorAll('.cart-item').forEach(el => el.remove());
            checkoutBtn.disabled = true;
            totalPriceSpan.textContent = `₹0.00`;
            itemCountSpan.textContent = `0 items`;
        } else {
            emptyCartMsg.classList.add('hidden');
            
            // Clear existing and re-render
            cartItemsContainer.querySelectorAll('.cart-item').forEach(el => el.remove());
            
            let total = 0;
            let totalItems = 0;
            cart.forEach((item) => {
                const itemTotal = item.price * item.quantity;
                total += itemTotal;
                totalItems += item.quantity;

                const itemEl = document.createElement('div');
                itemEl.className = 'cart-item';
                itemEl.innerHTML = `
                    <div class="item-info">
                        <span class="item-name">${item.name} <small>(${item.unit})</small></span>
                        <div class="item-details">
                            <span class="item-sku">${item.id}</span>
                            <span class="item-qty">Qty: ${item.quantity}</span>
                        </div>
                    </div>
                    <div class="item-price">₹${itemTotal.toFixed(2)}</div>
                `;
                cartItemsContainer.appendChild(itemEl);
            });

            totalPriceSpan.textContent = `₹${total.toFixed(2)}`;
            itemCountSpan.textContent = `${totalItems} item${totalItems !== 1 ? 's' : ''}`;
            checkoutBtn.disabled = false;
        }
    }

    clearBtn.addEventListener('click', () => {
        cart = [];
        renderCart();
        lastItemInfo.innerHTML = '<p class="placeholder-text">Scan an item to see details</p>';
        showNotification("Cart cleared");
    });

    checkoutBtn.addEventListener('click', () => {
        const total = cart.reduce((sum, item) => sum + item.price, 0);
        alert(`Bill Generated Successfully!\nTotal Items: ${cart.length}\nTotal Amount: ₹${total.toFixed(2)}`);
        cart = [];
        renderCart();
    });

    function setLoading(isLoading) {
        isAnalyzing = isLoading;
        scanBtn.disabled = isLoading;
        const loader = scanBtn.querySelector('.loader');
        const btnText = scanBtn.querySelector('.btn-text');
        
        if (isLoading) {
            loader.classList.remove('hidden');
            btnText.textContent = 'Analyzing...';
        } else {
            loader.classList.add('hidden');
            btnText.textContent = 'Scan & Add Item';
        }
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

