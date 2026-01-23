// ==UserScript==
// @updateURL       https://browser-userscripts.spacebarlabs.com/gemini-tab.user.js
// @name         Google Gemini Tab Renamer & Status Spinner
// @namespace    https://spacebarlabs.com/
// @version      4.1
// @description  Sets the browser tab title to the chat title and spins the favicon when Gemini is generating a response.
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
    };

    // --- STATE MANAGEMENT ---
    let activeStreams = 0;
    let originalFavicon = null;
    let thinkingStartTime = 0;
    let lastInteractionTime = 0;
    const INTERACTION_WINDOW = 5000;

    // --- STATUS & SPINNER LOGIC ---

    function recordInteraction() { lastInteractionTime = Date.now(); }
    ['keydown', 'mousedown', 'touchstart', 'submit'].forEach(evt => {
        window.addEventListener(evt, recordInteraction, { capture: true, passive: true });
    });

    // Network Interception (Fetch)
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

    // Network Interception (XHR)
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
