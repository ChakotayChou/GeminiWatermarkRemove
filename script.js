/**
 * Gemini Watermark Remover - Batch Processing
 */

const STATE = {
    masks: {
        small: null, // { width: 48, height: 48, alphas: Float32Array }
        large: null  // { width: 96, height: 96, alphas: Float32Array }
    },
    worker: new Worker('worker.js'),
    processors: [], // Store active ImageProcessor instances
    customLogo: {
        image: null,     // HTMLImageElement - 使用者上傳的 Logo 圖片
        opacity: 0.8,    // 0.0 ~ 1.0 - Logo 透明度
        scale: 1.0       // 0.1 ~ 2.0 - Logo 縮放比例 (預設 1.0)
    }
};

// Global DOM Elements
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const resultsContainer = document.getElementById('resultsContainer');
const globalActions = document.getElementById('globalActions');
const downloadAllBtn = document.getElementById('downloadAllBtn');

// Logo 相關 DOM 元素
const logoInput = document.getElementById('logoInput');
const logoPreview = document.getElementById('logoPreview');
const logoUploadArea = document.getElementById('logoUploadArea');
const logoOpacity = document.getElementById('logoOpacity');
const logoOpacityValue = document.getElementById('logoOpacityValue');
const logoScale = document.getElementById('logoScale');
const logoScaleValue = document.getElementById('logoScaleValue');
const logoControls = document.getElementById('logoControls');
const clearLogoBtn = document.getElementById('clearLogoBtn');

// =============================================================================
// Localization Manager
// =============================================================================

const Localization = {
    lang: 'zh-TW', // Default

    init() {
        // Auto-detect browser language
        let userLang = navigator.language || navigator.userLanguage;

        if (userLang) {
            userLang = userLang.toLowerCase();
            if (userLang.includes('zh')) {
                // Determine Traditional vs Simplified
                // zh-TW, zh-HK -> zh-TW
                // zh-CN, zh-SG -> zh-CN
                if (userLang.includes('cn') || userLang.includes('sg')) {
                    this.lang = 'zh-CN';
                } else {
                    this.lang = 'zh-TW';
                }
            } else if (userLang.startsWith('ja')) {
                this.lang = 'ja';
            } else if (userLang.startsWith('ko')) {
                this.lang = 'ko';
            } else {
                this.lang = 'en';
            }
        } else {
            this.lang = 'en';
        }

        // Validate existence, fallback to en if missing
        if (!translations[this.lang]) {
            this.lang = 'en';
        }

        // Bind Switcher
        const selector = document.getElementById('languageSelect');
        if (selector) {
            selector.value = this.lang;
            selector.addEventListener('change', (e) => {
                this.setLanguage(e.target.value);
            });
        }

        this.apply();
    },

    setLanguage(langCode) {
        if (!translations[langCode]) return;
        this.lang = langCode;
        this.apply();

        // Refresh dynamic UI (like file cards)
        reprocessAllUIStrings();
    },

    get(key) {
        return translations[this.lang][key] || key;
    },

    apply() {
        document.documentElement.lang = this.lang;
        const elements = document.querySelectorAll('[data-i18n]');
        elements.forEach(el => {
            const key = el.getAttribute('data-i18n');
            const str = this.get(key);
            if (el.getAttribute('data-i18n-html') === 'true') {
                el.innerHTML = str;
            } else {
                el.textContent = str;
            }
        });
    }
};

function reprocessAllUIStrings() {
    // Re-render strings inside existing ImageProcessor cards
    STATE.processors.forEach(p => p.updateStrings());
    // Update Logo Upload Text if empty
    updateLogoPreviewUI();
}


// =============================================================================
// Initialization & Asset Loading
// =============================================================================

async function init() {
    // Init Localization first
    Localization.init();

    // Setup Worker Listener
    STATE.worker.onmessage = (e) => {
        const { type, payload, id } = e.data;
        if (type === 'PROCESS_COMPLETE') {
            const processor = STATE.processors.find(p => p.id === id);
            if (processor) {
                processor.handleWorkerResult(payload.imageData);
            }
        } else if (type === 'PROCESS_ERROR') {
            console.error('Worker error:', payload);
            const processor = STATE.processors.find(p => p.id === id);
            if (processor) {
                processor.elements.loading.style.display = 'none';
                alert(Localization.get('processingError') + payload);
            }
        }
    };

    try {
        await Promise.all([
            loadMask('assets/mask_48.png', 'small'),
            loadMask('assets/mask_96.png', 'large')
        ]);
        console.log('Masks loaded successfully');

        // Send masks to worker
        STATE.worker.postMessage({
            type: 'INIT_MASKS',
            payload: STATE.masks
        });

    } catch (e) {
        console.error('Failed to load masks:', e);
        alert(Localization.get('loadAssetsError'));
    }
}

function loadMask(url, type) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.src = url;
        img.onload = () => {
            const w = img.width;
            const h = img.height;
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = w;
            tempCanvas.height = h;
            const tCtx = tempCanvas.getContext('2d');
            tCtx.drawImage(img, 0, 0);

            const imageData = tCtx.getImageData(0, 0, w, h);
            const data = imageData.data;
            const alphas = new Float32Array(w * h);

            for (let i = 0; i < w * h; i++) {
                const r = data[i * 4];
                const g = data[i * 4 + 1];
                const b = data[i * 4 + 2];
                const maxVal = Math.max(r, Math.max(g, b));
                alphas[i] = maxVal / 255.0;
            }

            STATE.masks[type] = { width: w, height: h, alphas };
            resolve();
        };
        img.onerror = reject;
    });
}

// =============================================================================
// Image Processor Class (Per Image Logic)
// =============================================================================

class ImageProcessor {
    constructor(file) {
        this.file = file;
        this.id = Math.random().toString(36).substr(2, 9);
        this.config = {
            forceMode: 'auto',
            alphaGain: 1.0
        };
        this.state = {
            originalImage: null,
            processedImageData: null,
            isProcessing: false
        };

        // UI Elements
        this.elements = {};

        this.init();
    }

    init() {
        this.createUI();
        this.loadImage();
    }

    createUI() {
        const card = document.createElement('div');
        card.className = 'image-card';
        // Note: Using data-i18n attributes where possible or injecting strings
        card.innerHTML = `
            <div class="image-wrapper">
                <canvas></canvas>
                <div class="loading-overlay">
                    <div class="spinner"></div>
                </div>
                <div class="comparison-overlay" data-i18n="compareTitle">${Localization.get('compareTitle')}</div>
            </div>
            
            <div class="card-controls">
                <div class="card-options">
                    <div class="control-group">
                        <select aria-label="浮水印大小">
                            <option value="auto" data-i18n="sizeAuto">${Localization.get('sizeAuto')}</option>
                            <option value="small" data-i18n="sizeSmall">${Localization.get('sizeSmall')}</option>
                            <option value="large" data-i18n="sizeLarge">${Localization.get('sizeLarge')}</option>
                        </select>
                    </div>
                    <div class="control-group slider-group">
                        <label><span data-i18n="strengthLabel">${Localization.get('strengthLabel')}</span> <span class="alpha-value">1.0</span></label>
                        <input type="range" min="1.0" max="3.0" step="0.1" value="1.0">
                    </div>
                </div>

                <div class="actions" style="display: flex; gap: 1rem;">
                    <button class="btn btn-secondary compare-btn" title="${Localization.get('compareTitle')}">
                        <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path>
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"></path>
                        </svg>
                    </button>
                    <button class="btn btn-secondary remove-btn" title="${Localization.get('removeTitle')}">
                        <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                        </svg>
                    </button>
                    <button class="btn btn-primary download-btn" disabled>
                        <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path>
                        </svg>
                        <span data-i18n="downloadBtn">${Localization.get('downloadBtn')}</span>
                    </button>
                </div>
            </div>
            <div style="text-align: center; color: var(--text-secondary); font-size: 0.9rem;">
                ${this.file.name}
            </div>
        `;

        // Store references
        this.elements.card = card;
        this.elements.canvas = card.querySelector('canvas');
        this.elements.ctx = this.elements.canvas.getContext('2d', { willReadFrequently: true });
        this.elements.loading = card.querySelector('.loading-overlay');
        this.elements.sizeSelect = card.querySelector('select');
        this.elements.alphaInput = card.querySelector('input[type="range"]');
        this.elements.alphaValue = card.querySelector('.alpha-value');
        this.elements.downloadBtn = card.querySelector('.download-btn');
        this.elements.removeBtn = card.querySelector('.remove-btn');
        this.elements.compareBtn = card.querySelector('.compare-btn');
        this.elements.wrapper = card.querySelector('.image-wrapper');
        this.elements.compareOverlay = card.querySelector('.comparison-overlay'); // Added ref

        // Bind Events
        this.elements.sizeSelect.addEventListener('change', (e) => {
            this.config.forceMode = e.target.value;
            this.processAndRender();
        });

        this.elements.alphaInput.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            this.config.alphaGain = val;
            this.elements.alphaValue.textContent = val.toFixed(2);
            this.processAndRender();
        });

        this.elements.downloadBtn.addEventListener('click', () => this.download());
        this.elements.removeBtn.addEventListener('click', () => this.destroy());

        // Comparison interactions
        const startCompare = (e) => {
            if (e && e.cancelable) e.preventDefault();
            if (!this.state.originalImage) return;
            this.elements.ctx.drawImage(this.state.originalImage, 0, 0);

            // Add label
            const label = document.createElement('div');
            label.className = 'status-label';
            label.textContent = Localization.get('originalLabel');
            this.elements.wrapper.appendChild(label);
        };

        const endCompare = () => {
            if (!this.state.processedImageData) return;
            this.elements.ctx.putImageData(this.state.processedImageData, 0, 0);

            const label = this.elements.wrapper.querySelector('.status-label');
            if (label) label.remove();
        };

        // Manual Compare Button
        this.elements.compareBtn.addEventListener('mousedown', startCompare);
        this.elements.compareBtn.addEventListener('mouseup', endCompare);
        this.elements.compareBtn.addEventListener('mouseleave', endCompare);
        this.elements.compareBtn.addEventListener('touchstart', (e) => {
            e.preventDefault();
            startCompare(e);
        }, { passive: false });
        this.elements.compareBtn.addEventListener('touchend', endCompare);

        // Interaction Logic: Click vs Long Press
        let pressTimer;
        let isLongPress = false;
        const longPressDuration = 250; // ms

        const startPress = (e) => {
            // Only left click or touch
            if (e.type === 'mousedown' && e.button !== 0) return;

            isLongPress = false;
            pressTimer = setTimeout(() => {
                isLongPress = true;
                startCompare(e); // Trigger comparison
            }, longPressDuration);
        };

        const endPress = (e) => {
            clearTimeout(pressTimer);

            if (isLongPress) {
                // Was a long press -> End comparison
                endCompare();
            } else {
                // Was a short click -> Open Lightbox
                console.log(Localization.get('shortClick'));
                if (typeof Lightbox !== 'undefined') {
                    Lightbox.open(this.state.processedImageData, this.state.originalImage);
                } else {
                    console.error('Lightbox is undefined');
                }
            }
            isLongPress = false;
        };

        const cancelPress = () => {
            clearTimeout(pressTimer);
            if (isLongPress) endCompare();
            isLongPress = false;
        };

        // prevent context menu on mobile
        this.elements.wrapper.oncontextmenu = (e) => {
            e.preventDefault();
            e.stopPropagation();
            return false;
        };

        this.elements.wrapper.addEventListener('mousedown', startPress);
        this.elements.wrapper.addEventListener('touchstart', (e) => {
            // e.preventDefault(); // Might block scrolling? Test carefully.
            // Usually better not to preventDefault on start unless we handle scroll
            startPress(e);
        }, { passive: true });

        this.elements.wrapper.addEventListener('mouseup', endPress);
        this.elements.wrapper.addEventListener('touchend', endPress);

        this.elements.wrapper.addEventListener('mouseleave', cancelPress);
        // touchcancel?

        // Append to DOM
        resultsContainer.appendChild(card);

        // Update UI State
        updateUIState();
    }

    updateStrings() {
        // Method to refresh strings when language changes
        const l = Localization;
        // Text Content
        this.elements.compareOverlay.textContent = l.get('compareTitle');
        this.elements.card.querySelector('[data-i18n="sizeAuto"]').textContent = l.get('sizeAuto');
        this.elements.card.querySelector('[data-i18n="sizeSmall"]').textContent = l.get('sizeSmall');
        this.elements.card.querySelector('[data-i18n="sizeLarge"]').textContent = l.get('sizeLarge');
        this.elements.card.querySelector('[data-i18n="strengthLabel"]').textContent = l.get('strengthLabel');
        this.elements.card.querySelector('[data-i18n="downloadBtn"]').textContent = l.get('downloadBtn');

        // Titles
        this.elements.compareBtn.title = l.get('compareTitle');
        this.elements.removeBtn.title = l.get('removeTitle');
    }

    loadImage() {
        if (!this.file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                this.state.originalImage = img;
                this.processAndRender();
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(this.file);
    }

    processAndRender() {
        if (!this.state.originalImage) return;

        // Show Loading
        this.elements.loading.style.display = 'flex';

        setTimeout(() => {
            const img = this.state.originalImage;
            const canvas = this.elements.canvas;

            // Set canvas size
            canvas.width = img.width;
            canvas.height = img.height;

            // Draw original
            this.elements.ctx.drawImage(img, 0, 0);

            // Get Data
            const imageData = this.elements.ctx.getImageData(0, 0, canvas.width, canvas.height);

            // Send to Worker
            STATE.worker.postMessage({
                type: 'PROCESS_IMAGE',
                payload: {
                    imageData: imageData,
                    config: this.config,
                    id: this.id
                }
            }, [imageData.data.buffer]); // Transfer buffer

        }, 50);
    }

    handleWorkerResult(processedImageData) {
        const canvas = this.elements.canvas;

        // Put Back (after watermark removal)
        this.elements.ctx.putImageData(processedImageData, 0, 0);

        // 疊加自訂 Logo（如果有設定的話）
        this.applyCustomLogo();

        // 重新取得最終 ImageData（包含 Logo）
        const finalImageData = this.elements.ctx.getImageData(0, 0, canvas.width, canvas.height);

        // Update State
        this.state.processedImageData = finalImageData;
        this.elements.loading.style.display = 'none';
        this.elements.downloadBtn.disabled = false;
    }

    /**
     * 疊加自訂 Logo 到圖片右下角
     * Logo 會自動縮放以配合浮水印大小，並套用透明度
     */
    applyCustomLogo() {
        if (!STATE.customLogo.image) return;

        const canvas = this.elements.canvas;
        const ctx = this.elements.ctx;
        const logo = STATE.customLogo.image;
        const opacity = STATE.customLogo.opacity;

        // 根據圖片尺寸決定 Logo 目標大小（與浮水印尺寸邏輯一致）
        const w = canvas.width;
        const h = canvas.height;
        let mode = this.config.forceMode;
        if (mode === 'auto') {
            mode = (w > 1024 && h > 1024) ? 'large' : 'small';
        }

        // 設定 Logo 目標尺寸和邊距
        const targetSize = mode === 'large' ? 96 : 48;
        const margin = mode === 'large' ? 64 : 32;

        // 計算縮放比例（保持寬高比）
        const scale = Math.min(targetSize / logo.width, targetSize / logo.height) * STATE.customLogo.scale;
        const scaledWidth = logo.width * scale;
        const scaledHeight = logo.height * scale;

        // 計算位置（右下角，與浮水印相同位置）
        const posX = w - margin - scaledWidth;
        const posY = h - margin - scaledHeight;

        if (posX < 0 || posY < 0) return;

        // 設定透明度並繪製 Logo
        ctx.save();
        ctx.globalAlpha = opacity;
        ctx.drawImage(logo, posX, posY, scaledWidth, scaledHeight);
        ctx.restore();
    }

    download() {
        if (!this.state.processedImageData) return;
        this.elements.canvas.toBlob((blob) => {
            if (!blob) return;
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            // Suggest filename: "original_clean.png"
            const nameParts = this.file.name.split('.');
            nameParts.pop(); // remove extension
            const suffix = Localization.get('cleanSuffix');
            link.download = `${nameParts.join('.')}${suffix}.png`;
            link.href = url;
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        }, 'image/png');
    }

    destroy() {
        // Remove from UI
        this.elements.card.remove();

        // Remove from Global List
        STATE.processors = STATE.processors.filter(p => p !== this);

        // Update UI State
        updateUIState();
    }
}

// =============================================================================
// Global Event Handlers
// =============================================================================

function handleFiles(fileList) {
    if (!fileList || fileList.length === 0) return;

    Array.from(fileList).forEach(file => {
        if (file.type.startsWith('image/')) {
            const processor = new ImageProcessor(file);
            STATE.processors.push(processor);
        }
    });

    // Reset file input so same file can be selected again if needed
    fileInput.value = '';

    updateUIState();
}

function updateUIState() {
    if (STATE.processors.length > 0) {
        document.body.classList.add('has-files');
        globalActions.style.display = 'flex';
    } else {
        document.body.classList.remove('has-files');
        globalActions.style.display = 'none';
    }
}

// Drag & Drop
dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
    // Optional: update text to "Released to Upload"
});

dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('drag-over');
});

dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    if (e.dataTransfer.files.length > 0) {
        handleFiles(e.dataTransfer.files);
    }
});



dropZone.addEventListener('click', (e) => {
    // 點擊圖片卡片時不觸發上傳（保留卡片內的操作功能）
    // 但點擊 results-container 的空白區域時仍可上傳新圖片
    if (e.target.closest('.image-card')) return;
    fileInput.click();
});

fileInput.addEventListener('change', (e) => {
    handleFiles(e.target.files);
});

// Download All
downloadAllBtn.addEventListener('click', () => {
    let delay = 0;
    STATE.processors.forEach(p => {
        // Stagger downloads to prevent browser blocking
        setTimeout(() => {
            p.download();
        }, delay);
        delay += 300;
    });
});

// =============================================================================
// Logo 上傳與處理邏輯
// =============================================================================

/**
 * 更新 Logo 預覽 UI
 * 根據 STATE.customLogo.image 是否存在來切換顯示狀態
 */
function updateLogoPreviewUI() {
    if (STATE.customLogo.image) {
        // 顯示 Logo 預覽圖片（套用透明度效果）
        const opacity = STATE.customLogo.opacity;
        logoPreview.innerHTML = `<img src="${STATE.customLogo.image.src}" alt="Logo Preview" style="opacity: ${opacity}">`;
        logoPreview.classList.add('has-logo');
        logoControls.style.display = 'block';
        clearLogoBtn.style.display = 'flex';
    } else {
        // 恢復上傳提示
        logoPreview.innerHTML = `
            <svg class="upload-icon" width="32" height="32" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" 
                    d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"></path>
            </svg>
            <span class="upload-text" data-i18n="uploadLogo">${Localization.get('uploadLogo')}</span>
        `;
        logoPreview.classList.remove('has-logo');
        logoControls.style.display = 'none';
        clearLogoBtn.style.display = 'none';
    }
}

/**
 * 重新處理所有已上傳的圖片
 * 當 Logo 或透明度變更時呼叫
 */
function reprocessAllImages() {
    STATE.processors.forEach(p => {
        p.processAndRender();
    });
}

// Logo 上傳區域點擊事件
logoUploadArea.addEventListener('click', () => {
    logoInput.click();
});

// Logo 檔案選擇事件
logoInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file || !file.type.startsWith('image/')) return;

    const reader = new FileReader();
    reader.onload = (event) => {
        const img = new Image();
        img.onload = () => {
            STATE.customLogo.image = img;
            updateLogoPreviewUI();
            reprocessAllImages();
        };
        img.src = event.target.result;
    };
    reader.readAsDataURL(file);

    // 重置 input 以便重複選擇同一檔案
    logoInput.value = '';
});

// Logo 透明度滑桿變更事件
logoOpacity.addEventListener('input', (e) => {
    const value = parseInt(e.target.value);
    STATE.customLogo.opacity = value / 100;
    logoOpacityValue.textContent = `${value}%`;

    // 即時更新 Logo 預覽的透明度
    const previewImg = logoPreview.querySelector('img');
    if (previewImg) {
        previewImg.style.opacity = STATE.customLogo.opacity;
    }

    reprocessAllImages();
});

// Logo 大小滑桿變更事件
logoScale.addEventListener('input', (e) => {
    const value = parseInt(e.target.value);
    STATE.customLogo.scale = value / 100;
    logoScaleValue.textContent = `${value}%`;
    reprocessAllImages();
});

// 清除 Logo 按鈕事件
clearLogoBtn.addEventListener('click', () => {
    STATE.customLogo.image = null;
    STATE.customLogo.opacity = 0.8;
    STATE.customLogo.scale = 1.0;
    logoOpacity.value = 80;
    logoOpacityValue.textContent = '80%';
    logoScale.value = 100;
    logoScaleValue.textContent = '100%';
    updateLogoPreviewUI();
    reprocessAllImages();
});

// =============================================================================
// Lightbox Controller
// =============================================================================
const Lightbox = {
    elements: {
        modal: document.getElementById('lightbox'),
        img: document.getElementById('lightboxImage'),
        close: document.querySelector('.lightbox-close')
    },
    activeOriginal: null,
    activeProcessed: null,

    init() {
        console.log('Lightbox initializing, modal found:', !!this.elements.modal);
        if (!this.elements.modal) return;

        this.elements.close.onclick = () => this.close();
        this.elements.modal.onclick = (e) => {
            if (e.target === this.elements.modal) this.close();
        };

        // Escape to close
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.elements.modal.style.display === 'flex') {
                this.close();
            }
        });

        // Long Press comparison in Lightbox
        const start = (e) => {
            if (e.type === 'mousedown' && e.button !== 0) return;
            if (this.activeOriginal) {
                this.elements.img.src = this.activeOriginal.src;
            }
        };
        const end = (e) => {
            if (this.activeProcessed) {
                this.elements.img.src = this.activeProcessed;
            }
        };

        this.elements.img.addEventListener('mousedown', start);
        this.elements.img.addEventListener('touchstart', start);
        this.elements.img.addEventListener('mouseup', end);
        this.elements.img.addEventListener('touchend', end);
        this.elements.img.addEventListener('mouseleave', end);
    },

    open(processedImageData, originalImage) {
        if (!processedImageData || !originalImage) return;

        // Clone/Store original
        this.activeOriginal = originalImage;

        // Convert Processed ImageData to DataURL for <img>
        const canvas = document.createElement('canvas');
        canvas.width = processedImageData.width;
        canvas.height = processedImageData.height;
        const ctx = canvas.getContext('2d');
        ctx.putImageData(processedImageData, 0, 0);
        this.activeProcessed = canvas.toDataURL();

        // Set content
        this.elements.img.src = this.activeProcessed;
        this.elements.modal.style.display = 'flex';
    },

    close() {
        this.elements.modal.style.display = 'none';
        this.elements.img.src = '';
        this.activeOriginal = null;
        this.activeProcessed = null;
    }
};

// Init
init();
// Initialize Lightbox
Lightbox.init();
