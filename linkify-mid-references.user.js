// ==UserScript==
// @name        Linkify mid: references
// @namespace   https://spacebarlabs.com/
// @description Makes mid (email Message ID) links clickable when found in text
// @match       http://localhost:5000/*
// @include     https://fava.*/*
// @include     http://fava.*/*
// @grant       none
// ==/UserScript==

(function () {
  const pattern = /mid:[^\s"'<>,;()\[\]]+/g;

  function linkify(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || parent.closest('a, script, style, textarea, input')) {
          return NodeFilter.FILTER_REJECT;
        }
        return pattern.test(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });

    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    for (const node of nodes) {
      pattern.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let last = 0;
      let match;
      while ((match = pattern.exec(node.nodeValue)) !== null) {
        frag.append(node.nodeValue.slice(last, match.index));
        const a = document.createElement('a');
        a.href = match[0];
        a.textContent = match[0];
        frag.append(a);
        last = match.index + match[0].length;
      }
      frag.append(node.nodeValue.slice(last));
      node.replaceWith(frag);
    }
  }

  linkify(document.body);

  new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const n of m.addedNodes) {
        if (n.nodeType === Node.ELEMENT_NODE) linkify(n);
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
})();
