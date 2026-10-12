// ==UserScript==
// @name         Duck.ai OpenWebUI Sync
// @namespace    http://tampermonkey.net/
// @version      4.0
// @description  Syncs active Duck.ai chat automatically and provides full historical bulk sync to OpenWebUI
// @match        https://duck.ai/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function () {
  'use strict';

  const SYNC_INTERVAL_MS = 5000;

  // In-memory sync state
  let activeDuckChatId = null;
  let openWebUiChatId = null;
  let isSyncing = false;

  // --- UI BUTTON SETUP ---
  const btn = document.createElement('button');
  btn.innerText = 'idle';
  btn.style.position = 'fixed';
  btn.style.bottom = '20px';
  btn.style.right = '20px';
  btn.style.zIndex = '999999';
  btn.style.padding = '8px 12px';
  btn.style.backgroundColor = '#6b7280'; // Default gray
  btn.style.color = '#fff';
  btn.style.border = 'none';
  btn.style.borderRadius = '8px';
  btn.style.fontWeight = 'bold';
  btn.style.fontSize = '12px';
  btn.style.cursor = 'pointer';
  btn.style.boxShadow = '0 4px 6px rgba(0,0,0,0.2)';
  document.body.appendChild(btn);

  function setStatusSyncing(msg = 'syncing') {
    isSyncing = true;
    btn.innerText = msg;
    btn.style.backgroundColor = '#2563eb'; // Blue
  }

  function setStatusError(msg = 'sync error') {
    isSyncing = false;
    btn.innerText = msg;
    btn.style.backgroundColor = '#dc2626'; // Red
  }

  function setStatusSuccess(msg = 'synced') {
    isSyncing = false;
    btn.innerText = msg;
    btn.style.backgroundColor = '#10a37f'; // Green
  }

  // Manual click: forces sync on active chat
  btn.onclick = async () => {
    if (activeDuckChatId) {
      await GM_setValue(`OWUI_SYNCED_TIME_${activeDuckChatId}`, null);
    }
    syncMostRecentChat();
  };

  // --- CONFIGURATION & MENU COMMANDS ---
  GM_registerMenuCommand("Set OpenWebUI Instance URL", async () => {
    const currentUrl = await GM_getValue('OPENWEBUI_URL', '');
    const newUrl = prompt("Enter your OpenWebUI Instance URL (e.g. https://openwebui.example.com):", currentUrl);
    if (newUrl !== null) {
      const cleanedUrl = newUrl.trim().replace(/\/+$/, '');
      await GM_setValue('OPENWEBUI_URL', cleanedUrl);
      alert('OpenWebUI URL saved!');
    }
  });

  GM_registerMenuCommand("Set OpenWebUI API Key / Token", async () => {
    const currentToken = await GM_getValue('OPENWEBUI_TOKEN', '');
    const newToken = prompt("Enter OpenWebUI Token (from localStorage.token):", currentToken);
    if (newToken !== null) {
      await GM_setValue('OPENWEBUI_TOKEN', newToken.trim());
      alert('Token saved!');
    }
  });

  GM_registerMenuCommand("Sync ALL Historical Chats Now", () => {
    syncAllChats();
  });

  async function getConfiguration() {
    let baseUrl = await GM_getValue('OPENWEBUI_URL', '');
    let token = await GM_getValue('OPENWEBUI_TOKEN', '');

    if (!baseUrl) {
      const inputUrl = prompt("Enter your OpenWebUI Instance URL (e.g. https://openwebui.example.com):");
      if (inputUrl) {
        baseUrl = inputUrl.trim().replace(/\/+$/, '');
        await GM_setValue('OPENWEBUI_URL', baseUrl);
      }
    }

    if (!token) {
      const inputToken = prompt("Enter your OpenWebUI Token (from localStorage.token):");
      if (inputToken) {
        token = inputToken.trim();
        await GM_setValue('OPENWEBUI_TOKEN', token);
      }
    }

    return { baseUrl, token };
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

  // --- HELPER: CONVERT SINGLE DUCK CHAT TO OPENWEBUI FORMAT ---
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
      messages: owuiMessages,
      history: {
        messages: historyMessages,
        currentId: owuiMessages.length > 0 ? owuiMessages[owuiMessages.length - 1].id : null
      }
    };

    return chatData;
  }

  // --- HTTP PROMISE WRAPPER ---
  function sendChatToOpenWebUI(baseUrl, token, duckChatId, chatData, existingOwuiId) {
    return new Promise((resolve, reject) => {
      const isUpdate = Boolean(existingOwuiId);
      const endpoint = isUpdate
        ? `${baseUrl}/api/v1/chats/${existingOwuiId}`
        : `${baseUrl}/api/v1/chats/new`;

      const payload = isUpdate
        ? { chat: chatData, title: chatData.title }
        : { chat: chatData };

      GM_xmlhttpRequest({
        method: 'POST',
        url: endpoint,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        data: JSON.stringify(payload),
        onload: async (res) => {
          if (res.status >= 200 && res.status < 300) {
            const responseData = JSON.parse(res.responseText || '{}');
            const owuiId = existingOwuiId || responseData.id;

            if (owuiId) {
              await GM_setValue(`OWUI_MAPPING_${duckChatId}`, owuiId);
            }

            resolve(owuiId);
          } else {
            reject(new Error(`HTTP ${res.status}: ${res.responseText}`));
          }
        },
        onerror: (err) => reject(err)
      });
    });
  }

  // --- BULK SYNC ALL HISTORICAL CHATS ---
  async function syncAllChats() {
    if (isSyncing) return;

    const { baseUrl, token } = await getConfiguration();

    if (!baseUrl || !token) {
      btn.innerText = 'no config';
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
          setStatusSuccess('no chats found');
          return;
        }

        setStatusSyncing(`syncing 0/${validChats.length}`);

        let count = 0;
        let errors = 0;

        for (const chat of validChats) {
          const currentEditTimestamp = chat.lastEdit || chat.messages[chat.messages.length - 1]?.createdAt;
          const duckChatId = chat.chatId;

          const existingOwuiId = await GM_getValue(`OWUI_MAPPING_${duckChatId}`, null);
          const lastSyncedTimestamp = await GM_getValue(`OWUI_SYNCED_TIME_${duckChatId}`, null);

          // Only send HTTP request if thread is un-synced or updated
          if (lastSyncedTimestamp !== currentEditTimestamp) {
            try {
              const chatData = buildOpenWebUiPayload(chat);
              await sendChatToOpenWebUI(baseUrl, token, duckChatId, chatData, existingOwuiId);
              await GM_setValue(`OWUI_SYNCED_TIME_${duckChatId}`, currentEditTimestamp);
            } catch (err) {
              console.error(`[Duck.ai Bulk Sync] Failed chat ${duckChatId}:`, err);
              errors++;
            }
          }

          count++;
          setStatusSyncing(`syncing ${count}/${validChats.length}`);
        }

        if (errors > 0) {
          setStatusError(`done (${errors} errs)`);
        } else {
          setStatusSuccess(`all ${validChats.length} synced`);
        }
      };
    };
  }

  // --- SINGLE MOST-RECENT SYNC (AUTOMATIC BACKGROUND) ---
  async function syncMostRecentChat() {
    if (isSyncing) return;

    const { baseUrl, token } = await getConfiguration();

    if (!baseUrl || !token) {
      btn.innerText = 'no config';
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

        // Sort by last edit timestamp descending
        validChats.sort((a, b) => {
          const timeA = new Date(a.lastEdit || a.messages[a.messages.length - 1]?.createdAt || 0).getTime();
          const timeB = new Date(b.lastEdit || b.messages[b.messages.length - 1]?.createdAt || 0).getTime();
          return timeB - timeA;
        });

        const mostRecentChat = validChats[0];
        const currentEditTimestamp = mostRecentChat.lastEdit || mostRecentChat.messages[mostRecentChat.messages.length - 1]?.createdAt;
        activeDuckChatId = mostRecentChat.chatId;

        const existingOwuiId = await GM_getValue(`OWUI_MAPPING_${activeDuckChatId}`, null);
        const lastSyncedTimestamp = await GM_getValue(`OWUI_SYNCED_TIME_${activeDuckChatId}`, null);

        if (lastSyncedTimestamp === currentEditTimestamp) {
          setStatusSuccess();
          return;
        }

        setStatusSyncing();

        try {
          const chatData = buildOpenWebUiPayload(mostRecentChat);
          await sendChatToOpenWebUI(baseUrl, token, activeDuckChatId, chatData, existingOwuiId);
          await GM_setValue(`OWUI_SYNCED_TIME_${activeDuckChatId}`, currentEditTimestamp);
          setStatusSuccess();
        } catch (err) {
          console.error('[Duck.ai Sync] Request failed:', err);
          setStatusError();
        }
      };
    };
  }

  // Initial sync & interval
  syncMostRecentChat();
  setInterval(syncMostRecentChat, SYNC_INTERVAL_MS);
})();
