// ==UserScript==
// @updateURL       https://browser-userscripts.spacebarlabs.com/gemini-git-push.user.js
// @name         Gemini to GitHub Pusher
// @namespace    https://spacebarlabs.com/
// @version      18.2
// @description  Syncs Gemini to GitHub. Fixes <ol> lists and properly escapes HTML entities in user content.
// @author       Benjamin Oakes
// @license      GPLv3
// @match        https://gemini.google.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @require      https://openuserjs.org/src/libs/sizzle/GM_config.js
// ==/UserScript==

(function() {
    'use strict';

    // --- ⚙️ TIMING CONFIGURATION ---
    const URL_CHECK_INTERVAL = 2000;
    const CONTENT_CHECK_INTERVAL = 20000;
    const PAGE_LOAD_DELAY = 4000;

    let lastUrl = window.location.href;
    let isPushing = false;
    let remoteFileStatus = 'unknown';

    // --- CONFIG UI ---
    GM_config.init({
        id: 'GeminiGHConfig',
        title: 'Gemini to GitHub Settings',
        fields: {
            'GITHUB_TOKEN': { label: 'GitHub Token', type: 'text', default: '' },
            'REPO_OWNER': { label: 'Repo Owner', type: 'text', default: '' },
            'REPO_NAME': { label: 'Repo Name', type: 'text', default: '' },
            'FOLDER_PATH': { label: 'Folder Path', type: 'text', default: 'gemini' },
            'BRANCH': { label: 'Branch', type: 'text', default: 'main' }
        },
        css: '#GeminiGHConfig_field_GITHUB_TOKEN { width: 300px; }'
    });
    GM_registerMenuCommand("Configure GitHub Settings", () => GM_config.open());

    // --- LOOPS ---
    setTimeout(() => { createUI(); checkRemoteStatus(); }, 2000);

    setInterval(() => {
        if (!document.getElementById('gemini-gh-container')) createUI();
        updateViewButtonVisuals();

        if (window.location.href !== lastUrl) {
            console.log("GeminiGH: 🧭 New chat detected.");
            lastUrl = window.location.href;
            remoteFileStatus = 'unknown';
            updateButtonStatus('⏳ Loading...', '#586069');
            checkRemoteStatus();
            setTimeout(() => trySync(true), PAGE_LOAD_DELAY);
        }
    }, URL_CHECK_INTERVAL);

    setInterval(() => {
        if (window.location.href.includes('/app/') && !isPushing) {
            trySync(true);
        }
    }, CONTENT_CHECK_INTERVAL);

    // --- HELPERS ---
    function getChatId() {
        return window.location.pathname.split('/app/')[1] || null;
    }

    async function checkRemoteStatus() {
        if (remoteFileStatus === 'checking' || remoteFileStatus === 'exists') return;

        const TOKEN = GM_config.get('GITHUB_TOKEN');
        const OWNER = GM_config.get('REPO_OWNER');
        const REPO = GM_config.get('REPO_NAME');
        const BRANCH = GM_config.get('BRANCH');
        const FOLDER = GM_config.get('FOLDER_PATH');

        if (!TOKEN || !OWNER) return;

        const chatId = getChatId();
        if (!chatId) return;

        remoteFileStatus = 'checking';
        updateViewButtonVisuals();

        const filename = `${chatId}.md`;
        const filePath = FOLDER ? `${FOLDER}/${filename}` : filename;
        const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${filePath}`;

        try {
            const sha = await getFileSha(url, TOKEN, BRANCH);
            remoteFileStatus = sha ? 'exists' : 'missing';
        } catch (e) {
            remoteFileStatus = 'missing';
        }
        updateViewButtonVisuals();
    }

    async function trySync(isAuto) {
        if (isPushing) return;

        const TOKEN = GM_config.get('GITHUB_TOKEN');
        if (!TOKEN) return;

        try {
            const chatId = getChatId();
            if (!chatId) return;

            const content = extractPageContent(chatId);
            if (!content || content.length < 50) return;

            const currentHash = simpleHash(content);
            const savedHashKey = `gemini_hash_${chatId}`;
            const lastSavedHash = GM_getValue(savedHashKey, null);

            if (currentHash === lastSavedHash && remoteFileStatus === 'exists') {
                if(!isAuto) updateButtonStatus('✅ Synced', '#28a745');
                return;
            }

            isPushing = true;
            updateButtonStatus(isAuto ? '☁️ Auto-saving...' : '☁️ Pushing...', '#dbab09');

            const timestamp = new Date().toISOString().split('T')[0];
            const filename = `${chatId}.md`;
            const folderPath = GM_config.get('FOLDER_PATH');
            const filePath = folderPath ? `${folderPath}/${filename}` : filename;

            const finalFileContent = `**Synced:** ${timestamp}\n**Source:** [Gemini Link](${window.location.href})\n\n---\n\n${content}`;

            await pushToGitHub(filePath, finalFileContent);

            GM_setValue(savedHashKey, currentHash);
            remoteFileStatus = 'exists';
            updateButtonStatus('✅ Synced', '#28a745');
            updateViewButtonVisuals();

            setTimeout(() => {
                updateButtonStatus('☁️ GitHub Sync', '#24292e');
            }, 4000);

        } catch (error) {
            console.error("GeminiGH Error:", error);
            updateButtonStatus('❌ Error', '#d73a49');
        } finally {
            isPushing = false;
        }
    }

    // --- UI ---
    function createUI() {
        if (document.getElementById('gemini-gh-container')) return;
        const container = document.createElement('div');
        container.id = 'gemini-gh-container';
        Object.assign(container.style, {
            position: 'fixed', bottom: '20px', right: '20px', zIndex: '9999', display: 'flex', gap: '5px'
        });

        const btn = document.createElement('button');
        btn.innerText = '☁️ GitHub Sync';
        btn.id = 'gemini-gh-btn';
        Object.assign(btn.style, {
            padding: '8px 12px', backgroundColor: '#24292e', color: 'white', border: 'none',
            borderRadius: '5px', cursor: 'pointer', fontFamily: 'sans-serif', fontSize: '12px', fontWeight: 'bold'
        });
        btn.onclick = () => trySync(false);

        const viewBtn = document.createElement('button');
        viewBtn.innerText = 'Checking...';
        viewBtn.id = 'gemini-gh-view-btn';
        Object.assign(viewBtn.style, {
            padding: '8px 12px', backgroundColor: '#dbab09', color: 'black', border: 'none',
            borderRadius: '5px', cursor: 'pointer', fontFamily: 'sans-serif', fontSize: '12px', fontWeight: 'bold'
        });

        const settingsBtn = document.createElement('button');
        settingsBtn.innerText = '⚙️';
        Object.assign(settingsBtn.style, {
            padding: '8px', backgroundColor: '#444d56', color: 'white', border: 'none',
            borderRadius: '5px', cursor: 'pointer', fontSize: '12px'
        });
        settingsBtn.onclick = () => GM_config.open();

        container.appendChild(btn);
        container.appendChild(viewBtn);
        container.appendChild(settingsBtn);
        document.body.appendChild(container);
    }

    function updateViewButtonVisuals() {
        const viewBtn = document.getElementById('gemini-gh-view-btn');
        if (!viewBtn) return;
        const OWNER = GM_config.get('REPO_OWNER');
        const REPO = GM_config.get('REPO_NAME');
        const BRANCH = GM_config.get('BRANCH');
        const FOLDER = GM_config.get('FOLDER_PATH');
        const chatId = getChatId();
        if (!chatId) return;
        const filename = `${chatId}.md`;
        const fullPath = FOLDER ? `${FOLDER}/${filename}` : filename;
        const ghUrl = `https://github.com/${OWNER}/${REPO}/blob/${BRANCH}/${fullPath}`;

        const makeClickable = () => {
             viewBtn.style.cursor = 'pointer';
             viewBtn.onclick = () => window.open(ghUrl, '_blank');
        };

        if (remoteFileStatus === 'checking' || remoteFileStatus === 'unknown') {
            viewBtn.innerText = '⏳ Checking...';
            viewBtn.style.backgroundColor = '#dbab09';
            viewBtn.style.color = 'black';
            makeClickable();
        } else if (remoteFileStatus === 'exists') {
            viewBtn.innerText = 'GitHub ↗';
            viewBtn.style.backgroundColor = '#0366d6';
            viewBtn.style.color = 'white';
            makeClickable();
        } else if (remoteFileStatus === 'missing') {
            viewBtn.innerText = 'Not Synced';
            viewBtn.style.backgroundColor = '#6a737d';
            viewBtn.style.color = 'white';
            viewBtn.style.cursor = 'default';
            viewBtn.onclick = null;
        }
    }

    function updateButtonStatus(text, color) {
        const btn = document.getElementById('gemini-gh-btn');
        if (btn) {
            btn.innerText = text;
            btn.style.backgroundColor = color;
        }
    }

    function simpleHash(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = (hash << 5) - hash + char;
            hash |= 0;
        }
        return hash.toString();
    }

    async function pushToGitHub(path, content) {
        const OWNER = GM_config.get('REPO_OWNER');
        const REPO = GM_config.get('REPO_NAME');
        const TOKEN = GM_config.get('GITHUB_TOKEN');
        const BRANCH = GM_config.get('BRANCH');
        const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`;

        let sha = null;
        try { sha = await getFileSha(url, TOKEN, BRANCH); } catch (e) {}

        return new Promise((resolve, reject) => {
            const contentBase64 = btoa(unescape(encodeURIComponent(content)));
            const payload = { message: `Update ${path}`, content: contentBase64, branch: BRANCH };
            if (sha) payload.sha = sha;

            GM_xmlhttpRequest({
                method: "PUT",
                url: url,
                headers: { "Authorization": `token ${TOKEN}`, "Content-Type": "application/json" },
                data: JSON.stringify(payload),
                onload: (res) => (res.status >= 200 && res.status < 300) ? resolve() : reject(new Error(res.statusText)),
                onerror: reject
            });
        });
    }

    function getFileSha(url, token, branch) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: "GET",
                url: `${url}?ref=${branch}`,
                headers: { "Authorization": `token ${token}`, "Cache-Control": "no-cache" },
                onload: (res) => {
                    if (res.status === 200) resolve(JSON.parse(res.responseText).sha);
                    else if (res.status === 404) resolve(null);
                    else reject(new Error(res.statusText));
                },
                onerror: reject
            });
        });
    }

    // --- EXTRACTION ---
    function extractPageContent(chatId) {
        const KNOWN_LANGUAGES = new Set([
            "python", "py", "javascript", "js", "typescript", "ts", "java", "cpp", "c++", "c",
            "c#", "csharp", "ruby", "rb", "html", "css", "scss", "bash", "sh", "shell", "zsh",
            "json", "xml", "yaml", "yml", "sql", "php", "go", "rust", "kotlin", "swift", "dart",
            "r", "lua", "perl", "objective-c", "markdown", "md", "dockerfile", "latex", "tex",
            "powershell", "ps1", "vb", "vbnet", "scala", "groovy", "haskell", "elixir", "clojure"
        ]);

        function htmlToMarkdown(node) {
            // 1. Text Node Handling: Escape HTML entities
            if (node.nodeType === Node.TEXT_NODE) {
                return node.textContent.replace(/</g, '&lt;').replace(/>/g, '&gt;');
            }
            if (node.nodeType !== Node.ELEMENT_NODE) return "";

            const tagName = node.tagName.toLowerCase();

            if (tagName === 'table') {
                const rows = Array.from(node.querySelectorAll('tr'));
                if (!rows.length) return "";
                let md = "\n";
                rows.forEach((row, i) => {
                    const cells = Array.from(row.querySelectorAll('td, th')).map(c => htmlToMarkdown(c).trim().replace(/\n/g, '<br>'));
                    md += `| ${cells.join(' | ')} |\n`;
                    if (i === 0) md += `| ${cells.map(() => '---').join(' | ')} |\n`;
                });
                return md + "\n";
            }

            // 2. Code Block: Do NOT escape content (stop recursion)
            if (tagName === 'code') return `\`${node.textContent}\``;

            // 3. Pre Block: Do NOT escape content
            if (tagName === 'pre') return `\n\`\`\`${node.dataset.language || ''}\n${node.innerText}\n\`\`\`\n\n`;

            // Process children for other tags
            let children = Array.from(node.childNodes).map(htmlToMarkdown).join("");

            if (['h1','h2','h3'].includes(tagName)) return `\n${'#'.repeat(parseInt(tagName[1]))} ${children}\n\n`;
            if (tagName === 'p') return `\n${children}\n\n`;

            if (tagName === 'li') {
                const parent = node.parentNode;
                const parentTag = parent ? parent.tagName.toLowerCase() : '';
                if (parentTag === 'ol') {
                    let index = 1;
                    let sibling = node.previousElementSibling;
                    while (sibling) {
                        if (sibling.tagName.toLowerCase() === 'li') index++;
                        sibling = sibling.previousElementSibling;
                    }
                    return `${index}. ${children.trim()}\n`;
                }
                return `- ${children.trim()}\n`;
            }

            if (tagName === 'a') return `[${children}](${node.getAttribute('href')})`;
            if (tagName === 'img') return `![img](${node.getAttribute('src')})`;
            if (tagName === 'strong' || tagName === 'b') return `**${children}**`;
            if (tagName === 'em' || tagName === 'i') return `*${children}*`;
            return children;
        }

        const elements = document.querySelectorAll('user-query-content, structured-content-container');
        if (!elements.length) return "";

        let md = "";

        elements.forEach(el => {
            const clone = el.cloneNode(true);
            clone.querySelectorAll('pre').forEach(pre => {
                const prev = pre.previousElementSibling;
                if (prev && prev.innerText.match(/copy/i)) pre.dataset.language = prev.innerText.replace(/copy code|copy/gi,'').trim();
            });
            clone.querySelectorAll('button, svg, .edit-button, .feedback-container').forEach(e => e.remove());

            let text = htmlToMarkdown(clone).trim();

            // Fix for fake code blocks in output
            text = text.replace(/(\n|^)([a-zA-Z0-9+#\-\.]+)(\n+)```/gm, (match, prefix, word, newlines) => {
                if (KNOWN_LANGUAGES.has(word.toLowerCase())) {
                    return `${prefix}\`\`\`${word}`;
                }
                return match;
            });

            // Handle User Content specific formatting
            if (el.tagName.toLowerCase().includes('user')) {
                const firstNewLine = text.indexOf('\n');
                if (firstNewLine === -1) {
                    md += `<div align="right">\n${text}\n</div>\n\n---\n\n`;
                } else {
                    const summary = text.substring(0, firstNewLine);
                    const body = text.substring(firstNewLine + 1);
                    md += `<div align="right">\n<details>\n<summary>${summary}</summary>\n\n${body}\n</details>\n</div>\n\n---\n\n`;
                }
            } else {
                md += `${text}\n\n---\n\n`;
            }
        });
        return md;
    }
})();

