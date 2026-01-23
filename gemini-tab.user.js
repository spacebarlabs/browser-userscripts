// ==UserScript==
// @name         Google Gemini Tab Renamer, Status & Model Enforcer
// @namespace    https://spacebarlabs.com/
// @version      4.0
// @description  Sets title, spins favicon, and enforces "Fast" model on Enter (Ctrl+Alt+Enter for Thinking).
// @author       Benjamin Oakes
// @license      GPLv3
// @match        https://gemini.google.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    // --- CONFIGURATION ---
    const CONFIG = {
        // Spinner SVGs
        spinnerDefault: 'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><circle cx=%2250%22 cy=%2250%22 r=%2240%22 stroke=%22%234dabf7%22 stroke-width=%2212%22 fill=%22none%22 stroke-dasharray=%22160%22 stroke-linecap=%22round%22><animateTransform attributeName=%22transform%22 type=%22rotate%22 from=%220 50 50%22 to=%22360 50 50%22 dur=%221s%22 repeatCount=%22indefinite%22/></circle></svg>',
        spinnerLong: 'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text x=%2250%22 y=%2270%22 font-size=%2260%22 text-anchor=%22middle%22 fill=%22%23999%22 font-family=%22sans-serif%22 font-weight=%22bold%22>?</text><circle cx=%2250%22 cy=%2250%22 r=%2240%22 stroke=%22%234dabf7%22 stroke-width=%2212%22 fill=%22none%22 stroke-dasharray=%22160%22 stroke-linecap=%22round%22><animateTransform attributeName=%22transform%22 type=%22rotate%22 from=%220 50 50%22 to=%22360 50 50%22 dur=%221s%22 repeatCount=%22indefinite%22/></circle></svg>',

        // Timeouts
        timeUntilQuestion: 30000,
        timeUntilGiveUp: 120000,

        // Selectors (These are heuristic and might need updates if Google changes UI)
        modelSelectorBtn: 'button[aria-haspopup="menu"]', // The button that shows current model
        sendButton: 'button[aria-label*="Send"]',         // The arrow button to submit chat
        thinkingText: "Thinking",                          // Text to identify Thinking model
        fastText: "Flash"                                  // Text to identify Fast model (fallback)
    };

    // --- STATE MANAGEMENT ---
    let activeStreams = 0;
    let originalFavicon = null;
    let thinkingStartTime = 0;
    let lastInteractionTime = 0;
    const INTERACTION_WINDOW = 5000;

    // --- UTILS ---
    const delay = ms => new Promise(res => setTimeout(res, ms));

    function showToast(message) {
        const toast = document.createElement('div');
        toast.textContent = message;
        Object.assign(toast.style, {
            position: 'fixed', bottom: '100px', left: '50%', transform: 'translateX(-50%)',
            backgroundColor: '#333', color: '#fff', padding: '10px 20px', borderRadius: '5px',
            zIndex: '9999', fontSize: '14px', boxShadow: '0 4px 6px rgba(0,0,0,0.1)',
            opacity: '0', transition: 'opacity 0.3s'
        });
        document.body.appendChild(toast);
        // Animate in/out
        requestAnimationFrame(() => toast.style.opacity = '1');
        setTimeout(() => {
            toast.style.opacity = '0';
            setTimeout(() => toast.remove(), 300);
        }, 2000);
    }

    // --- MODEL ENFORCER LOGIC ---
    async function enforceModelAndSubmit(targetMode) {
        // targetMode: 'fast' or 'thinking'

        // 1. Find the Model Selector Button
        // We look for a button usually at the top left/center that indicates the model
        const buttons = Array.from(document.querySelectorAll('button'));
        const modelBtn = buttons.find(b => b.hasAttribute('aria-haspopup') && (b.innerText.includes('Gemini') || b.innerText.includes('1.5') || b.innerText.includes('2.0')));

        if (!modelBtn) {
            console.warn("Gemini Userscript: Could not find model selector. Submitting as is.");
            clickSend();
            return;
        }

        const currentText = modelBtn.innerText || "";
        const isCurrentlyThinking = currentText.includes(CONFIG.thinkingText);

        // 2. Check if we need to switch
        let needsSwitch = false;
        if (targetMode === 'fast' && isCurrentlyThinking) needsSwitch = true;
        if (targetMode === 'thinking' && !isCurrentlyThinking) needsSwitch = true;

        if (needsSwitch) {
            showToast(targetMode === 'fast' ? "⚡ Switching to Fast..." : "🧠 Switching to Thinking...");

            // Click to open menu
            modelBtn.click();
            await delay(150); // Wait for menu animation

            // Find the option in the menu
            // Menu items are usually role="menuitem"
            const menuItems = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"]'));

            let targetItem;
            if (targetMode === 'thinking') {
                targetItem = menuItems.find(el => el.innerText.includes(CONFIG.thinkingText));
            } else {
                // For fast, find the one that DOESN'T say Thinking, or says Flash/Pro
                targetItem = menuItems.find(el => !el.innerText.includes(CONFIG.thinkingText) && (el.innerText.includes('Flash') || el.innerText.includes('Pro') || el.innerText.includes('Gemini')));
            }

            if (targetItem) {
                targetItem.click();
                await delay(200); // Wait for UI to update
            } else {
                console.warn("Gemini Userscript: Could not find target model option.");
            }
        }

        // 3. Submit
        clickSend();
    }

    function clickSend() {
        const sendBtn = document.querySelector(CONFIG.sendButton) || document.querySelector('button[aria-label="Send message"]');
        if (sendBtn && !sendBtn.disabled) {
            sendBtn.click();
        }
    }

    // --- KEYBOARD INTERCEPTION ---
    window.addEventListener('keydown', (e) => {
        // Only trigger inside the prompt text area
        const target = e.target;
        const isInput = target.matches('div[contenteditable="true"]') || target.matches('textarea') || target.closest('.input-area');

        if (!isInput) return;
        if (e.key !== 'Enter') return;

        // Ignore if shift is held (multiline)
        if (e.shiftKey) return;

        // Check for Auto-Complete selection (DOM specific check might be needed, but usually Enter acts natively here)
        // If the autocomplete dropdown is visible, we might want to let default happen.
        // For now, we assume if the user hits Enter, they want to send.

        // LOGIC:
        // Ctrl+Alt+Enter = Force Thinking
        // Enter = Force Fast

        if (e.ctrlKey && e.altKey) {
            e.preventDefault();
            e.stopPropagation();
            enforceModelAndSubmit('thinking');
        } else {
            // Standard Enter
            // We need to stop the default immediate send, check model, then send.
            // Note: This adds a tiny delay to every message, but ensures safety.
            e.preventDefault();
            e.stopPropagation();
            enforceModelAndSubmit('fast');
        }

    }, { capture: true }); // Capture phase to prevent Gemini's default handlers


    // --- STATUS & SPINNER LOGIC (Original Functionality) ---

    function recordInteraction() { lastInteractionTime = Date.now(); }
    ['keydown', 'mousedown', 'touchstart', 'submit'].forEach(evt => {
        window.addEventListener(evt, recordInteraction, { capture: true, passive: true });
    });

    // Network Interception
    const originalFetch = window.fetch;
    window.fetch = async function(input, init) {
        const url = (typeof input === 'string') ? input : (input?.url || '');
        const isGeminiApi = url.includes('batchexecute') || url.includes('generateContent');
        const isThinking = document.querySelector('[aria-label="Stop response"]') !== null;
        const isUserInitiated = (Date.now() - lastInteractionTime) < INTERACTION_WINDOW;
        const shouldTrack = isGeminiApi && (isThinking || isUserInitiated);

        if (shouldTrack) {
            activeStreams++;
            updateUI();
        }

        try {
            const response = await originalFetch.apply(this, arguments);
            if (shouldTrack) {
                activeStreams = Math.max(0, activeStreams - 1);
                updateUI();
            }
            return response;
        } catch (error) {
            if (shouldTrack) {
                activeStreams = Math.max(0, activeStreams - 1);
                updateUI();
            }
            throw error;
        }
    };

    // XHR Interception
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url) {
        this._isGeminiApi = url && typeof url === 'string' && (url.includes('batchexecute') || url.includes('generateContent'));
        return originalOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function() {
        const isThinking = document.querySelector('[aria-label="Stop response"]') !== null;
        const isUserInitiated = (Date.now() - lastInteractionTime) < INTERACTION_WINDOW;
        if (this._isGeminiApi && (isThinking || isUserInitiated)) {
            activeStreams++;
            updateUI();
            this.addEventListener('loadend', () => {
                activeStreams = Math.max(0, activeStreams - 1);
                updateUI();
            });
        }
        return originalSend.apply(this, arguments);
    };

    // UI Updates
    function updateUI() {
        // Title Sync
        const targetElement = document.querySelector('.conversation-title');
        if (targetElement && targetElement.innerText.trim().length > 0) {
            const newTitle = targetElement.innerText.trim();
            if (document.title !== newTitle) document.title = newTitle;
        }

        // Favicon Logic
        const domThinking = document.querySelector('[aria-label="Stop response"]') !== null;
        let isThinking = domThinking || (activeStreams > 0);

        if (isThinking) {
            if (thinkingStartTime === 0) thinkingStartTime = Date.now();
            else {
                const elapsed = Date.now() - thinkingStartTime;
                if (elapsed > CONFIG.timeUntilGiveUp) {
                    isThinking = false;
                    activeStreams = 0;
                    thinkingStartTime = 0;
                }
            }
        } else {
            thinkingStartTime = 0;
        }

        let iconLink = document.querySelector("link[rel*='icon']");
        if (iconLink && iconLink.href !== CONFIG.spinnerDefault && iconLink.href !== CONFIG.spinnerLong && iconLink.href.trim() !== "") {
            originalFavicon = iconLink.href;
        }

        if (isThinking) {
            if (!iconLink) {
                iconLink = document.createElement('link');
                iconLink.type = 'image/x-icon';
                iconLink.rel = 'shortcut icon';
                document.head.appendChild(iconLink);
            }
            const elapsed = Date.now() - thinkingStartTime;
            const targetSpinner = (elapsed > CONFIG.timeUntilQuestion) ? CONFIG.spinnerLong : CONFIG.spinnerDefault;
            if (iconLink.href !== targetSpinner) iconLink.href = targetSpinner;
        } else {
            if (iconLink && (iconLink.href === CONFIG.spinnerDefault || iconLink.href === CONFIG.spinnerLong)) {
                if (originalFavicon) iconLink.href = originalFavicon;
                else iconLink.removeAttribute('href');
            }
        }
    }

    const observer = new MutationObserver(() => updateUI());
    setInterval(updateUI, 1000);

    function init() {
        if (document.body) {
            observer.observe(document.body, { childList: true, subtree: true });
            updateUI();
        } else {
            setTimeout(init, 100);
        }
    }

    init();
})();
