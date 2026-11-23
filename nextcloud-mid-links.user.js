// ==UserScript==
// @updateURL       https://browser-userscripts.spacebarlabs.com/nextcloud-mid-links.user.js
// @name         Nextcloud Tasks: mid: links instead of mailto
// @namespace    https://spacebarlabs.com/
// @version      1.0
// @description  Rewrite mailto Message-ID links to mid: links in Nextcloud Tasks
// @author       Benjamin Oakes
// @include      /^https?:\/\/nextcloud\.[^/]+\/.*/
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    // Only run on Nextcloud instances
    if (!location.hostname.includes('nextcloud')) return;

    const MAILTO = 'mailto:';
    const MID = 'mid:';

    // Very loose check: something@something.something (no spaces)
    function looksLikeMessageId(value) {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    }

    function convertAnchor(a) {
        if (!a || !a.href) return;
        if (!a.href.startsWith(MAILTO)) return;

        const addr = a.href.slice(MAILTO.length);
        if (!looksLikeMessageId(addr)) return;

        // Only convert when the surrounding text says "mid:" so we don't
        // accidentally break real email addresses.
        const context = (a.parentElement && a.parentElement.textContent) || '';
        if (!context.includes('mid:')) return;

        a.href = MID + addr;

        // mailto-specific attributes are meaningless for mid:
        a.removeAttribute('target');
        a.removeAttribute('rel');
    }

    function scan(root) {
        if (!root) return;
        if (root.tagName === 'A') convertAnchor(root);
        root.querySelectorAll('a[href^="mailto:"]').forEach(convertAnchor);
    }

    // Fix what's already on the page
    scan(document.body);

    // Nextcloud is a Vue SPA; observe dynamic updates
    const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
            for (const node of m.addedNodes) {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    scan(node);
                }
            }
        }
    });

    observer.observe(document.body, { childList: true, subtree: true });
})();
