// ==UserScript==
// @updateURL       https://browser-userscripts.spacebarlabs.com/campfire-hybrid-laptop-fix.user.js
// @name         Campfire Chat - enter submits message on hybrid laptop
// @namespace    http://tampermonkey.net/
// @version      2026-07-07
// @description  Fix message sending behavior on laptops that have touchscreens
// @author       You
// @match        *://*/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

// ONCE Campfire has a bug in which convertible laptops (tablet and laptop)
// don't allow enter to send a message because it thinks it's a touch device.
// It is a touch device, no doubt, but it's not the right behavior if you're
// using it as a laptop.  There aren't great browser APIs for that, so guess
// based on user behavior.
//
// NOTE: This solution applies globally. That seems to make sense for any site.
// Also we don't know where Campfire is hosted as it's open source.
(function() {
    'use strict';

    // Start tracking with assumed desktop mode so Campfire binds keys on load
    var assumedTabletMode = false;

    // Monitor real-time inputs to deduce if you folded the keyboard away
    window.addEventListener('touchstart', function() {
        assumedTabletMode = true;
    }, { capture: true, passive: true });

    window.addEventListener('mousemove', function() {
        assumedTabletMode = false;
    }, { capture: true, passive: true });

    window.addEventListener('keydown', function() {
        assumedTabletMode = false;
    }, { capture: true, passive: true });

    // Intercept hardware capability queries with our state variable
    Object.defineProperty(navigator, 'maxTouchPoints', {
        get: function() { return assumedTabletMode ? 1 : 0; },
        configurable: true
    });

    Object.defineProperty(navigator, 'msMaxTouchPoints', {
        get: function() { return assumedTabletMode ? 1 : 0; },
        configurable: true
    });
})();
