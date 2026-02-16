// Initialize scanner
const scanner = new PrivacyScanner();
let activeShield = null;

// Debounce helper
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

const processInput = debounce((target) => {
    let text = '';
    if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') {
        text = target.value;
    } else if (target.isContentEditable) {
        text = target.innerText;
    }

    const findings = scanner.scan(text);
    updateShield(target, findings);
}, 300);

function removeShield() {
    if (activeShield) {
        if (activeShield.listeners) {
            activeShield.listeners.forEach(remove => remove());
        }
        if (activeShield.element) {
            activeShield.element.remove();
        }
        activeShield = null;
    }
}

function createShieldUI(targetElement) {
    if (activeShield && activeShield.targetRef !== targetElement) {
        removeShield();
    }
    if (activeShield && activeShield.targetRef === targetElement) {
        return;
    }

    const container = document.createElement('div');
    container.className = 'ps-extension-shield-container';
    
    // Use fixed positioning to handle all scroll scenarios
    container.style.position = 'fixed';
    container.style.zIndex = '2147483647'; // Max z-index to ensure visibility above headers
    container.style.display = 'none'; // Hidden until positioned
    // Reset defaults
    container.style.right = 'auto';
    container.style.bottom = 'auto';
    container.style.left = 'auto';
    container.style.top = 'auto';

    const shield = document.createElement('div');
    shield.className = 'ps-extension-shield';
    
    // Create inner logo
    const logo = document.createElement('div');
    logo.className = 'ps-extension-logo';
    // Use logo.png instead of SVG
    const logoUrl = chrome.runtime.getURL('logo.png');
    logo.innerHTML = `<img src="${logoUrl}" width="16" height="16" style="display:block;">`;
    
    // Create status text (checkmark or count)
    const statusText = document.createElement('span');
    statusText.innerHTML = '✓';
    
    shield.appendChild(logo);
    shield.appendChild(statusText);
    
    const popup = document.createElement('div');
    popup.className = 'ps-extension-popup';
    // Style popup to open upwards and aligned right (since shield is at bottom)
    popup.style.top = 'auto';       
    popup.style.right = '0';        
    popup.style.bottom = '35px'; // Open above the shield
    popup.style.left = 'auto';
    
    container.appendChild(popup);
    container.appendChild(shield);

    shield.addEventListener('click', (e) => {
        e.stopPropagation();
        popup.classList.toggle('ps-visible');
    });

    document.addEventListener('click', () => {
        popup.classList.remove('ps-visible');
    });

    document.body.appendChild(container);

    const anchor = getVisualAnchor(targetElement);

    activeShield = {
        element: container,
        targetRef: targetElement,
        anchor: anchor,
        shieldIcon: shield, 
        statusElement: statusText, 
        popup: popup,
        listeners: [],
        pendingUpdate: null,
        latestFindings: []
    };

    // Handle Fix Button Clicks
    popup.addEventListener('click', (e) => {
        if (e.target.classList.contains('ps-replace-btn')) {
            const val = e.target.dataset.val;
            const type = e.target.dataset.type;
            replaceSensitiveData(targetElement, val, type);
        } else if (e.target.classList.contains('ps-fix-all-btn')) {
            if (activeShield && activeShield.latestFindings) {
                // Clone findings to iterate safely
                [...activeShield.latestFindings].forEach(f => {
                    replaceSensitiveData(targetElement, f.value, f.type);
                });
            }
        }
    });

    // Setup Event Listeners for Positioning
    const update = () => {
        if (!activeShield || !activeShield.element) return;
        // Use requestAnimationFrame to coalesce updates within the same frame
        if (!activeShield.pendingUpdate) {
            activeShield.pendingUpdate = requestAnimationFrame(() => {
                updatePosition();
                if (activeShield) activeShield.pendingUpdate = null;
            });
        }
    };

    window.addEventListener('scroll', update, { capture: true, passive: true });
    window.addEventListener('resize', update, { passive: true });
    anchor.addEventListener('scroll', update, { passive: true });
    targetElement.addEventListener('input', update, { passive: true });
    
    const ro = new ResizeObserver(update);
    ro.observe(anchor);
    ro.observe(targetElement);

    activeShield.listeners.push(
        () => window.removeEventListener('scroll', update, { capture: true }),
        () => window.removeEventListener('resize', update),
        () => anchor.removeEventListener('scroll', update),
        () => targetElement.removeEventListener('input', update),
        () => ro.disconnect()
    );

    update(); // Initial position
}

function replaceSensitiveData(target, original, type) {
    const placeholder = `[SAFE_${type.toUpperCase().replace(/\s+/g, '_')}]`;
    
    if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') {
        target.value = target.value.replace(original, placeholder);
        target.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
        // ContentEditable: Use TreeWalker to find text node and execCommand to replace
        // This ensures undo history works and editor state (React/etc) is updated correctly
        
        target.focus();
        
        // Helper to find text node
        const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT, null, false);
        let node;
        let found = false;
        
        while(node = walker.nextNode()) {
            const index = node.nodeValue.indexOf(original);
            if (index !== -1) {
                const range = document.createRange();
                range.setStart(node, index);
                range.setEnd(node, index + original.length);
                
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
                
                // Use execCommand to simulate user typing
                document.execCommand('insertText', false, placeholder);
                found = true;
                break;
            }
        }
        
        // Fallback if split across nodes (rare for tokens)
        if (!found) {
             target.innerText = target.innerText.replace(original, placeholder);
             target.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }
}

function getVisualAnchor(element) {
    if (element.tagName === 'TEXTAREA') return element;
    
    let current = element.parentElement;
    while (current && current !== document.body && current !== document.documentElement) {
        const style = window.getComputedStyle(current);
        if (['auto', 'scroll', 'overlay'].includes(style.overflowY)) {
            return current;
        }
        current = current.parentElement;
    }
    return element;
}

function updatePosition() {
    if (!activeShield || !activeShield.element || !activeShield.targetRef) return;
    
    if (!activeShield.targetRef.isConnected) {
        removeShield();
        return;
    }

    const anchor = activeShield.anchor;
    const validAnchor = (anchor && anchor.isConnected) ? anchor : activeShield.targetRef;
    
    const container = activeShield.element;
    const rect = validAnchor.getBoundingClientRect();
    
    // Visibility Check
    if (rect.width === 0 || rect.height === 0 || rect.bottom < 0 || rect.top > window.innerHeight) {
         container.style.display = 'none';
         return;
    }
    
    container.style.display = 'flex';

    const shieldSize = 24; 
    const margin = 15;
    
    // Horizontal: Always align to the right edge
    const left = rect.right - margin - shieldSize;
    
    // Vertical: Bottom-Right Sticky Logic
    const visibleBottom = Math.min(rect.bottom, window.innerHeight);
    let top = visibleBottom - margin - shieldSize;
    
    if (top < rect.top + margin) {
        top = rect.top + margin;
    }

    container.style.top = `${top}px`;
    container.style.left = `${left}px`;
}

const disgustMessages = [
    "Oh come on!!",
    "Are you serious?",
    "Not again...",
    "Seriously?",
    "Uh oh!",
    "Stop that!",
    "Nooooo!",
    "Really?",
    "Why would you do that?",
    "Come on, be better!",
    "My eyes!!",
    "Privacy is a thing, you know?",
    "Let's keep some secrets, shall we?",
    "Yikes!",
    "Bruh..."
];

function updateShield(target, findings) {
    if (!activeShield || activeShield.targetRef !== target) {
        createShieldUI(target);
    }
    
    activeShield.latestFindings = findings;

    const { shieldIcon, statusElement, popup } = activeShield;
    
    if (findings.length === 0) {
        shieldIcon.className = 'ps-extension-shield'; // Green pill
        statusElement.innerHTML = '✓';
        popup.classList.remove('ps-visible');
        popup.innerHTML = '<div class="ps-extension-header" style="justify-content:center; color:#2ecc71;">No issues found</div>';
    } else {
        const count = findings.length;
        shieldIcon.className = 'ps-extension-shield ps-danger'; // Red pill
        statusElement.innerHTML = count > 9 ? '9+' : count;

        const disgust = disgustMessages[Math.floor(Math.random() * disgustMessages.length)];

        let html = `
            <div class="ps-disgust-banner">${disgust}</div>
            <div class="ps-extension-header">
                <span>Security Alert</span>
                <div style="display:flex; align-items:center;">
                    <button class="ps-fix-all-btn">Fix All</button>
                    <span style="color: #e74c3c">${count} Issues</span>
                </div>
            </div>
            <ul class="ps-extension-list">
        `;

        findings.forEach(f => {
            html += `
                <li class="ps-extension-item">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 4px;">
                        <span class="ps-extension-item-type">${f.type}</span>
                        <button class="ps-replace-btn" data-val="${f.value}" data-type="${f.type}">Fix</button>
                    </div>
                    <span class="ps-extension-item-value">${f.value}</span>
                </li>
            `;
        });

        html += '</ul>';
        popup.innerHTML = html;
    }
}

const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
            if (node.nodeType === 1) { 
                const inputs = node.tagName === 'TEXTAREA' ? [node] : node.querySelectorAll('textarea, div[contenteditable="true"]');
                inputs.forEach(input => attachListener(input));
            }
        });
    });
});

function attachListener(input) {
    if (input.dataset.psAttached) return;
    input.dataset.psAttached = 'true';
    
    // Standard events
    input.addEventListener('input', () => processInput(input));
    input.addEventListener('focus', () => processInput(input));
    input.addEventListener('keyup', () => processInput(input)); // Catch deletions if input suppressed
    
    // Handle paste, cut, drop explicitly (with delay to allow content update)
    input.addEventListener('paste', () => setTimeout(() => processInput(input), 100));
    input.addEventListener('cut', () => setTimeout(() => processInput(input), 100));
    input.addEventListener('drop', () => setTimeout(() => processInput(input), 100));
    
    createShieldUI(input);
    
    // Trigger initial scan to catch pre-filled content
    processInput(input);
}

observer.observe(document.body, { childList: true, subtree: true });

setTimeout(() => {
    const existingInputs = document.querySelectorAll('textarea, div[contenteditable="true"]');
    existingInputs.forEach(input => attachListener(input));
}, 1000);
