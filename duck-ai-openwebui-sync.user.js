// ==UserScript==
// @name         Duck.ai OpenWebUI Sync
// @namespace    http://tampermonkey.net/
// @version      5.6
// @description  Automated Duck.ai sync to openwebui
// @match        https://duck.ai/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_cookie
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const SYNC_INTERVAL_MS = 5000;

  // Logger helper
  function log(...args) {
    console.log('%c[Duck.ai Sync]', 'color: #3b82f6; font-weight: bold;', ...args);
  }
  function logSuccess(...args) {
    console.log('%c[Duck.ai Sync]', 'color: #10b981; font-weight: bold;', ...args);
  }
  function logWarn(...args) {
    console.warn('[Duck.ai Sync]', ...args);
  }
  function logError(...args) {
    console.error('[Duck.ai Sync]', ...args);
  }

  log('Userscript v5.6 initialized.');

  // In-memory state
  let activeDuckChatId = null;
  let isSyncing = false;
  let cachedContainerId = null;

  // --- UI BUTTON SETUP ---
  const btn = document.createElement('button');
  btn.id = 'duck-owui-sync-btn';
  btn.innerText = 'idle';
  btn.style.position = 'fixed';
  btn.style.bottom = '20px';
  btn.style.right = '20px';
  btn.style.zIndex = '9999999';
  btn.style.padding = '8px 12px';
  btn.style.backgroundColor = '#6b7280';
  btn.style.color = '#fff';
  btn.style.border = '2px solid #ffffff';
  btn.style.borderRadius = '8px';
  btn.style.fontWeight = 'bold';
  btn.style.fontSize = '12px';
  btn.style.cursor = 'pointer';
  btn.style.boxShadow = '0 4px 10px rgba(0,0,0,0.3)';

  function mountButton() {
    if (document.body && !document.getElementById('duck-owui-sync-btn')) {
      document.body.appendChild(btn);
      log('Sync button mounted to document.body.');
    }
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    mountButton();
  } else {
    window.addEventListener('DOMContentLoaded', mountButton);
    window.addEventListener('load', mountButton);
  }

  function setStatusSyncing(msg = 'syncing') {
    isSyncing = true;
    btn.innerText = msg;
    btn.style.backgroundColor = '#2563eb';
  }

  function setStatusError(msg = 'sync error') {
    isSyncing = false;
    btn.innerText = msg;
    btn.style.backgroundColor = '#dc2626';
  }

  function setStatusSuccess(msg = 'synced') {
    isSyncing = false;
    btn.innerText = msg;
    btn.style.backgroundColor = '#10a37f';
  }

  // --- MENU COMMANDS ---
  try {
    GM_registerMenuCommand("Set OpenWebUI Instance URL", async () => {
      const containerId = await getContainerId();
      const currentUrl = await GM_getValue(`OWUI_URL_${containerId}`, '');
      const newUrl = prompt("Enter OpenWebUI Instance URL (e.g. https://openwebui.example.com):", currentUrl);
      if (newUrl !== null) {
        const cleanedUrl = newUrl.trim().replace(/\/+$/, '');
        await GM_setValue(`OWUI_URL_${containerId}`, cleanedUrl);
        log(`Config updated: URL set to ${cleanedUrl} for ${containerId}`);
        alert('OpenWebUI URL saved!');
      }
    });

    GM_registerMenuCommand("Set OpenWebUI Token", async () => {
      const containerId = await getContainerId();
      const currentToken = await GM_getValue(`OWUI_TOKEN_${containerId}`, '');
      const newToken = prompt("Enter OpenWebUI Token (from localStorage.token):", currentToken);
      if (newToken !== null) {
        const sanitizedToken = newToken.trim().replace(/^Bearer\s+/i, '');
        await GM_setValue(`OWUI_TOKEN_${containerId}`, sanitizedToken);
        log(`Config updated: Token updated for ${containerId}`);
        alert('Token saved!');
      }
    });

    GM_registerMenuCommand("Sync ALL Historical Chats Now", () => {
      syncAllChats();
    });

    log('Tampermonkey menu commands registered successfully.');
  } catch (e) {
    logError('Failed to register menu commands:', e);
  }

  // --- SILENT CONTAINER IDENTIFIER RESOLVER ---
  async function getContainerId() {
    if (cachedContainerId) return cachedContainerId;

    let localId = localStorage.getItem('OWUI_CONTAINER_UUID');
    if (!localId) {
      localId = `container_${crypto.randomUUID().slice(0, 8)}`;
      localStorage.setItem('OWUI_CONTAINER_UUID', localId);
    }
    cachedContainerId = localId;
    return cachedContainerId;
  }

  // Manual click: forces sync on active chat
  btn.onclick = async () => {
    mountButton();
    if (activeDuckChatId) {
      log(`Manual trigger for chat ${activeDuckChatId}. Clearing sync hash to force sync.`);
      await GM_setValue(`OWUI_SYNCED_HASH_${activeDuckChatId}`, null);
    }
    syncMostRecentChat();
  };

  async function getConfiguration() {
    const containerId = await getContainerId();
    let baseUrl = await GM_getValue(`OWUI_URL_${containerId}`, '');
    let token = await GM_getValue(`OWUI_TOKEN_${containerId}`, '');

    if (!baseUrl) {
      const inputUrl = prompt("Enter OpenWebUI Instance URL (e.g. https://openwebui.example.com):");
      if (inputUrl) {
        baseUrl = inputUrl.trim().replace(/\/+$/, '');
        await GM_setValue(`OWUI_URL_${containerId}`, baseUrl);
      }
    }

    if (!token) {
      const inputToken = prompt("Enter OpenWebUI Token (from localStorage.token):");
      if (inputToken) {
        token = inputToken.trim().replace(/^Bearer\s+/i, '');
        await GM_setValue(`OWUI_TOKEN_${containerId}`, token);
      }
    }

    return { baseUrl, token, containerId };
  }

  // --- CITATION PARSER ---
  function processCitations(msg) {
    if (!Array.isArray(msg.parts)) {
      return msg.content || '';
    }

    const citationMap = new Map();
    const fallbackSources = [];

    msg.parts.forEach((part) => {
      if (
        part.type === 'tool-invocation' &&
        part.toolName === 'WebSearch' &&
        part.data &&
        Array.isArray(part.data.citations)
      ) {
        part.data.citations.forEach((c) => {
          if (c.id && c.url) {
            const rawTitle = c.title || c.site_name || c.domain || `Source ${c.id}`;
            citationMap.set(String(c.id), {
              url: c.url,
              title: rawTitle
            });
          }
        });
      }

      if (part.type === 'source' && part.source && part.source.url) {
        fallbackSources.push({
          url: part.source.url,
          title: part.source.title || part.source.site || 'Source'
        });
      }
    });

    const textParts = msg.parts.filter((p) => p.type === 'text' && p.text);
    let rawText = textParts.map((p) => p.text).join('\n\n');

    if (!rawText) {
      rawText = msg.content || '';
    }

    const usedCitationIds = new Set();

    const processedText = rawText.replace(/<citation\s+src="([^"]+)">\s*<\/citation>/gi, (match, srcGroup) => {
      const ids = srcGroup.split(',').map((id) => id.trim());

      const links = ids.map((id, index) => {
        let item = citationMap.get(id);

        if (!item && fallbackSources[index]) {
          item = fallbackSources[index];
        }

        if (item) {
          usedCitationIds.add(id);
          return `[[${id}]](${item.url})`;
        }

        return `[\[${id}\]]`;
      });

      return ` ${links.join(' ')}`;
    });

    if (usedCitationIds.size > 0) {
      const sourcesList = Array.from(usedCitationIds)
        .sort((a, b) => Number(a) - Number(b))
        .map((id) => {
          const item = citationMap.get(id) || fallbackSources[0];
          if (item) {
            return `* **[${id}]** [${item.title}](${item.url})`;
          }
          return `* **[${id}]** Unknown Source`;
        })
        .join('\n');

      return `${processedText.trim()}\n\n---\n**Sources:**\n${sourcesList}`;
    }

    return processedText;
  }

  function buildOpenWebUiPayload(duckChat) {
    const formatModelName = (modelStr) => {
      if (!modelStr) return 'duck.ai/default';
      return modelStr.startsWith('duck.ai/') ? modelStr : `duck.ai/${modelStr}`;
    };

    const chatModelTag = formatModelName(duckChat.model);

    const owuiMessages = (duckChat.messages || []).map((msg) => {
      const textContent = processCitations(msg);

      return {
        id: msg.messageId || crypto.randomUUID(),
        role: msg.role,
        content: textContent,
        timestamp: msg.generationTimestamp
          ? Math.floor(msg.generationTimestamp / 1000)
          : Math.floor(new Date(msg.createdAt || Date.now()).getTime() / 1000),
        model: formatModelName(msg.model || duckChat.model)
      };
    });

    const historyMessages = {};
    owuiMessages.forEach((m, idx) => {
      historyMessages[m.id] = {
        ...m,
        parentId: idx > 0 ? owuiMessages[idx - 1].id : null,
        childrenIds: idx < owuiMessages.length - 1 ? [owuiMessages[idx + 1].id] : []
      };
    });

    const chatData = {
      title: duckChat.title || 'Untitled Chat',
      models: [chatModelTag],
      tags: [{ name: `duck_id_${duckChat.chatId}` }],
      messages: owuiMessages,
      history: {
        messages: historyMessages,
        currentId: owuiMessages.length > 0 ? owuiMessages[owuiMessages.length - 1].id : null
      }
    };

    return chatData;
  }

  // --- CONTENT HASH GENERATOR FOR CHANGE DETECTION ---
  function computeChatContentHash(duckChat) {
    const msgs = duckChat.messages || [];
    const count = msgs.length;
    if (count === 0) return 'empty';

    const lastMsg = msgs[count - 1];
    const lastContent = lastMsg.content || (Array.isArray(lastMsg.parts) ? JSON.stringify(lastMsg.parts) : '');

    // Hash based on total message count + length + snapshot of last message
    return `${count}:${lastContent.length}:${lastContent.slice(-100)}`;
  }

  // --- OPENWEBUI TAG SEARCH LOOKUP ---
  function findExistingOwuiChatIdBySearch(baseUrl, token, duckChatId) {
    return new Promise((resolve) => {
      const sanitizedToken = token.trim().replace(/^Bearer\s+/i, '');
      const tagQuery = `duck_id_${duckChatId}`;
      const searchUrl = `${baseUrl}/api/v1/chats/search?text=${encodeURIComponent(tagQuery)}`;

      log(`Searching OpenWebUI for tag: ${tagQuery}`);

      GM_xmlhttpRequest({
        method: 'GET',
        url: searchUrl,
        headers: {
          'Authorization': `Bearer ${sanitizedToken}`
        },
        onload: (res) => {
          if (res.status >= 200 && res.status < 300) {
            try {
              const results = JSON.parse(res.responseText || '[]');
              if (Array.isArray(results) && results.length > 0) {
                const foundId = results[0].id || results[0].chat_id;
                logSuccess(`Search MATCH! Found OpenWebUI Chat ID ${foundId} for Duck.ai ID ${duckChatId}`);
                resolve(foundId);
                return;
              }
              log(`Search yielded 0 results for tag ${tagQuery}`);
            } catch (e) {
              logWarn('Tag search JSON parse error:', e);
            }
          } else {
            logWarn(`Tag search returned HTTP ${res.status}: ${res.responseText}`);
          }
          resolve(null);
        },
        onerror: (err) => {
          logError('Tag search request error:', err);
          resolve(null);
        }
      });
    });
  }

  // --- HTTP PROMISE WRAPPER WITH SEARCH RECOVERY ---
  async function sendChatToOpenWebUI(baseUrl, token, duckChatId, chatData, existingOwuiId, containerId) {
    let targetOwuiId = existingOwuiId;

    if (targetOwuiId) {
      log(`Local mapping hit: Duck.ai ID ${duckChatId} -> OpenWebUI ID ${targetOwuiId}`);
    } else {
      log(`No local mapping for ${duckChatId}. Querying OpenWebUI search...`);
      targetOwuiId = await findExistingOwuiChatIdBySearch(baseUrl, token, duckChatId);
    }

    return new Promise((resolve, reject) => {
      const isUpdate = Boolean(targetOwuiId);
      const endpoint = isUpdate
        ? `${baseUrl}/api/v1/chats/${targetOwuiId}`
        : `${baseUrl}/api/v1/chats/new`;

      const payload = isUpdate
        ? { chat: chatData, title: chatData.title }
        : { chat: chatData };

      const sanitizedToken = token.trim().replace(/^Bearer\s+/i, '');

      log(`${isUpdate ? 'UPDATING' : 'CREATING'} chat on OpenWebUI. Endpoint: ${endpoint} | Messages: ${chatData.messages.length}`);

      GM_xmlhttpRequest({
        method: 'POST',
        url: endpoint,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sanitizedToken}`
        },
        data: JSON.stringify(payload),
        onload: async (res) => {
          if (res.status >= 200 && res.status < 300) {
            const responseData = JSON.parse(res.responseText || '{}');
            const owuiId = targetOwuiId || responseData.id;

            logSuccess(`Chat ${owuiId} saved on OpenWebUI (HTTP ${res.status})`);

            if (owuiId) {
              await GM_setValue(`OWUI_MAPPING_${duckChatId}`, owuiId);
            }

            resolve(owuiId);
          } else if (res.status === 401) {
            logError(`HTTP 401 Unauthorized for container ${containerId}. Clearing saved token.`);
            await GM_setValue(`OWUI_TOKEN_${containerId}`, '');
            reject(new Error('HTTP 401: Unauthorized session token. Cleared saved token.'));
          } else if (res.status === 404 && isUpdate) {
            logWarn(`Chat ${targetOwuiId} deleted in OpenWebUI (HTTP 404). Clearing mapping...`);
            await GM_setValue(`OWUI_MAPPING_${duckChatId}`, null);
            await GM_setValue(`OWUI_SYNCED_HASH_${duckChatId}`, null);
            reject(new Error(`404: Stale mapping cleared for ${duckChatId}`));
          } else {
            logError(`HTTP ${res.status} Error:`, res.responseText);
            reject(new Error(`HTTP ${res.status}: ${res.responseText}`));
          }
        },
        onerror: (err) => {
          logError('Network error during request:', err);
          reject(err);
        }
      });
    });
  }

  // --- BULK SYNC ALL HISTORICAL CHATS ---
  async function syncAllChats() {
    mountButton();
    if (isSyncing) return;

    const { baseUrl, token, containerId } = await getConfiguration();

    if (!baseUrl || !token) {
      btn.innerText = 'no config';
      btn.style.backgroundColor = '#d97706';
      logWarn('Bulk sync aborted: Missing base URL or Token');
      return;
    }

    log('Starting full historical scan...');

    const dbRequest = indexedDB.open('savedAIChatData');

    dbRequest.onerror = () => {
      logError('Failed to open IndexedDB savedAIChatData');
      setStatusError();
    };

    dbRequest.onsuccess = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('saved-chats')) return;

      const transaction = db.transaction('saved-chats', 'readonly');
      const store = transaction.objectStore('saved-chats');
      const getAllRequest = store.getAll();

      getAllRequest.onsuccess = async () => {
        const records = getAllRequest.result || [];

        const validChats = records.filter(
          (item) => item.chatId !== '__metadata__' && item.id !== '__metadata__' && item.messages?.length > 0
        );

        if (validChats.length === 0) {
          log('No historical chats found in IndexedDB.');
          setStatusSuccess('no chats found');
          return;
        }

        log(`Found ${validChats.length} total local chat(s) in IndexedDB.`);
        setStatusSyncing(`syncing 0/${validChats.length}`);

        let count = 0;
        let errors = 0;

        for (const chat of validChats) {
          const duckChatId = chat.chatId;
          const currentContentHash = computeChatContentHash(chat);

          const existingOwuiId = await GM_getValue(`OWUI_MAPPING_${duckChatId}`, null);
          const lastSyncedHash = await GM_getValue(`OWUI_SYNCED_HASH_${duckChatId}`, null);

          if (lastSyncedHash !== currentContentHash) {
            try {
              const chatData = buildOpenWebUiPayload(chat);
              await sendChatToOpenWebUI(baseUrl, token, duckChatId, chatData, existingOwuiId, containerId);
              await GM_setValue(`OWUI_SYNCED_HASH_${duckChatId}`, currentContentHash);
            } catch (err) {
              logError(`Failed chat ${duckChatId}:`, err);
              errors++;
            }
          } else {
            log(`Skipping chat ${duckChatId} (Already up to date)`);
          }

          count++;
          setStatusSyncing(`syncing ${count}/${validChats.length}`);
        }

        if (errors > 0) {
          setStatusError(`done (${errors} errs)`);
          logWarn(`Bulk sync finished with ${errors} error(s).`);
        } else {
          setStatusSuccess(`all ${validChats.length} synced`);
          logSuccess('Historical backfill complete!');
        }
      };
    };
  }

  // --- SINGLE MOST-RECENT SYNC ---
  async function syncMostRecentChat() {
    mountButton();
    if (isSyncing) return;

    const { baseUrl, token, containerId } = await getConfiguration();

    if (!baseUrl || !token) {
      btn.innerText = 'no token';
      btn.style.backgroundColor = '#d97706';
      return;
    }

    const dbRequest = indexedDB.open('savedAIChatData');

    dbRequest.onerror = () => setStatusError();

    dbRequest.onsuccess = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('saved-chats')) return;

      const transaction = db.transaction('saved-chats', 'readonly');
      const store = transaction.objectStore('saved-chats');
      const getAllRequest = store.getAll();

      getAllRequest.onsuccess = async () => {
        const records = getAllRequest.result || [];

        const validChats = records.filter(
          (item) => item.chatId !== '__metadata__' && item.id !== '__metadata__' && item.messages?.length > 0
        );

        if (validChats.length === 0) {
          btn.innerText = 'no chats found';
          btn.style.backgroundColor = '#6b7280';
          return;
        }

        validChats.sort((a, b) => {
          const timeA = new Date(a.lastEdit || a.messages[a.messages.length - 1]?.createdAt || 0).getTime();
          const timeB = new Date(b.lastEdit || b.messages[b.messages.length - 1]?.createdAt || 0).getTime();
          return timeB - timeA;
        });

        const mostRecentChat = validChats[0];
        activeDuckChatId = mostRecentChat.chatId;

        const currentContentHash = computeChatContentHash(mostRecentChat);
        const existingOwuiId = await GM_getValue(`OWUI_MAPPING_${activeDuckChatId}`, null);
        const lastSyncedHash = await GM_getValue(`OWUI_SYNCED_HASH_${activeDuckChatId}`, null);

        // Content Hash Check: Skip network request entirely if content hasn't changed
        if (lastSyncedHash === currentContentHash) {
          setStatusSuccess();
          return;
        }

        log(`Change detected in active chat ${activeDuckChatId}. Initializing sync...`);
        setStatusSyncing();

        try {
          const chatData = buildOpenWebUiPayload(mostRecentChat);
          await sendChatToOpenWebUI(baseUrl, token, activeDuckChatId, chatData, existingOwuiId, containerId);
          await GM_setValue(`OWUI_SYNCED_HASH_${activeDuckChatId}`, currentContentHash);
          setStatusSuccess();
        } catch (err) {
          logError('Request failed:', err);
          setStatusError('auth error');
        }
      };
    };
  }

  // Initial sync & interval
  syncMostRecentChat();
  setInterval(syncMostRecentChat, SYNC_INTERVAL_MS);
})();
