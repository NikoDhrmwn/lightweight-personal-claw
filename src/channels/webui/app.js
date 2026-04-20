/**
 * LiteClaw — WebUI Client
 * Full-featured: sessions, settings panel, channel controls,
 * WebSocket streaming, markdown rendering, confirmations, image uploads.
 */

(() => {
  // ─── State ───────────────────────────────────────────────────────
  let ws = null;
  let isStreaming = false;
  let currentAssistantEl = null;
  let currentContent = '';
  let pendingConfirmationId = null;
  let currentSessionKey = 'webui:default';
  const attachedImages = [];
  let healthData = {};
  let currentConfig = {};

  // ─── DOM References ──────────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const messagesEl = $('#messages');
  const welcomeEl = $('#welcomeScreen');
  const inputEl = $('#messageInput');
  const sendBtn = $('#sendBtn');
  const clearBtn = $('#clearBtn');
  const newChatBtn = $('#newChatBtn');
  const sidebarToggle = $('#sidebarToggle');
  const sidebar = $('#sidebar');
  const statusDot = $('.status-dot');
  const statusText = $('#statusText');
  const imageInput = $('#imageInput');
  const imagePreview = $('#imagePreview');
  const confirmModal = $('#confirmModal');
  const confirmBody = $('#confirmBody');
  const confirmAccept = $('#confirmAccept');
  const confirmReject = $('#confirmReject');
  const sessionListEl = $('#sessionList');
  const modelBadgeEl = $('#modelBadge');
  const chatTitle = $('#chatTitle');
  const chatSubtitle = $('#chatSubtitle');
  const workspacePill = $('#workspacePill');
  const noticeStack = $('#noticeStack');

  // Settings
  const settingsOverlay = $('#settingsOverlay');
  const settingsBtn = $('#settingsBtn');
  const closeSettingsBtn = $('#closeSettingsBtn');
  const settingTemp = $('#settingTemp');
  const settingTempVal = $('#settingTempVal');
  const settingModel = $('#settingModel');
  const settingThinking = $('#settingThinking');
  const settingMaxTurns = $('#settingMaxTurns');
  const settingWorkspace = $('#settingWorkspace');
  const saveSettingsBtn = $('#saveSettingsBtn');
  const discordReplyStyle = $('#discordReplyStyle');
  const whatsappReplyStyle = $('#whatsappReplyStyle');
  const clearAllBtn = $('#clearAllBtn');

  // ─── Session Management ─────────────────────────────────────────

  async function loadSessions() {
    try {
      const res = await fetch('/api/sessions');
      if (!res.ok) return;
      const data = await res.json();
      renderSessionList(data.sessions ?? []);
    } catch {
      renderSessionList([]);
    }
  }

  function renderSessionList(sessions) {
    sessionListEl.innerHTML = '';

    // Include all sessions, no filtering!
    let webuiSessions = sessions;

    // Always ensure current session exists in list
    if (!webuiSessions.find(s => s.sessionKey === currentSessionKey)) {
      webuiSessions.unshift({ sessionKey: currentSessionKey, messageCount: 0, lastActivity: Date.now() });
    }

    for (const session of webuiSessions) {
      const el = document.createElement('div');
      el.className = 'session-item' + (session.sessionKey === currentSessionKey ? ' active' : '');

      const label = formatSessionName(session);
      const count = session.messageCount > 0 ? session.messageCount : '';

      el.innerHTML = `
        <span class="session-dot"></span>
        <span class="session-label">${escapeHtml(label)}</span>
        ${count ? `<span class="session-count">${count}</span>` : ''}
        <button class="session-delete" title="Delete session">&times;</button>
      `;

      el.querySelector('.session-label').addEventListener('click', (e) => {
        e.stopPropagation();
        if (session.sessionKey !== currentSessionKey) {
          switchSession(session.sessionKey);
        }
      });

      el.querySelector('.session-dot').addEventListener('click', () => {
        if (session.sessionKey !== currentSessionKey) {
          switchSession(session.sessionKey);
        }
      });

      el.querySelector('.session-delete').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (confirm(`Delete session "${label}"?`)) {
          await fetch(`/api/sessions/${encodeURIComponent(session.sessionKey)}`, { method: 'DELETE' });
          if (session.sessionKey === currentSessionKey) {
            switchSession('webui:default');
          } else {
            loadSessions();
          }
        }
      });

      // Click on the whole row
      el.addEventListener('click', () => {
        if (session.sessionKey !== currentSessionKey) {
          switchSession(session.sessionKey);
        }
      });

      sessionListEl.appendChild(el);
    }
  }

  function formatSessionName(sessionOrKey) {
    const key = typeof sessionOrKey === 'string' ? sessionOrKey : sessionOrKey.sessionKey;
    const identifier = typeof sessionOrKey === 'string' ? null : sessionOrKey.userIdentifier;
    
    if (key.startsWith('discord:')) {
      return `Discord: ${identifier || key.replace('discord:', '')}`;
    }
    if (key.startsWith('whatsapp:')) {
      return `WhatsApp: ${identifier || key.replace('whatsapp:', '')}`;
    }
    if (key.startsWith('cli:')) {
      return `CLI: ${key.replace('cli:', '')}`;
    }
    return key
      .replace('webui:', '')
      .replace(/^chat_[a-z0-9]+$/, (m) => 'Chat ' + m.slice(5))
      .replace(/_/g, ' ')
      .replace(/^./, c => c.toUpperCase());
  }

  function switchSession(sessionKey) {
    currentSessionKey = sessionKey;
    messagesEl.innerHTML = '';
    if (welcomeEl) {
      welcomeEl.remove();
    }
    currentAssistantEl = null;
    currentContent = '';
    isStreaming = false;
    inputEl.disabled = false;
    sendBtn.disabled = inputEl.value.trim().length === 0;

    // Update header
    chatTitle.textContent = formatSessionName(sessionKey);
    chatSubtitle.textContent = sessionKey;

    loadSessionHistory(sessionKey);
    loadSessions();
    sendSessionInit();
  }

  async function loadSessionHistory(sessionKey) {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionKey)}/history`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.messages && data.messages.length > 0) {
        for (const msg of data.messages) {
          if (msg.role === 'user') {
            addUserMessage(msg.content, [], false);
          } else if (msg.role === 'assistant') {
            addRestoredAssistantMessage(msg.content);
          }
        }
        scrollToBottom();
      } else {
        showWelcome();
      }
    } catch {
      showWelcome();
    }
  }

  function createNewSession() {
    const id = Date.now().toString(36);
    const sessionKey = `webui:chat_${id}`;
    switchSession(sessionKey);
  }

  // ─── WebSocket Connection ────────────────────────────────────────

  function connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}/ws`);

    ws.onopen = () => {
      statusDot.classList.add('connected');
      statusText.textContent = 'Connected';
      fetchHealth();
      fetchConfig();
      loadSessions();
      sendSessionInit();
      showNotice('Realtime connection restored.', 'success', 2000);
    };

    ws.onclose = () => {
      statusDot.classList.remove('connected');
      statusText.textContent = 'Reconnecting...';
      showNotice('Lost connection to LiteClaw. Reconnecting...', 'error', 3500);
      setTimeout(connect, 3000);
    };

    ws.onerror = () => {
      statusText.textContent = 'Connection Error';
      showNotice('WebSocket connection error.', 'error', 3500);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleServerMessage(msg);
      } catch (e) {
        console.error('Failed to parse message:', e);
      }
    };
  }

  async function fetchHealth() {
    try {
      const res = await fetch('/health');
      if (res.ok) {
        healthData = await res.json();
        if (healthData.model) {
          modelBadgeEl.textContent = healthData.model;
        }
        if (healthData.workspace && workspacePill) {
          workspacePill.textContent = `workspace: ${healthData.workspace}`;
          workspacePill.title = healthData.workspace;
        }
        // Update system info in settings
        const sysVersion = $('#sysVersion');
        const sysUptime = $('#sysUptime');
        const sysMemory = $('#sysMemory');
        if (sysVersion) sysVersion.textContent = healthData.version || '--';
        if (sysUptime) sysUptime.textContent = formatUptime(healthData.uptime || 0);
        if (sysMemory) sysMemory.textContent = `${healthData.channels?.webui?.connected || 0} WebUI clients`;

        // Update channel status dots
        updateChannelDots();
      }
    } catch {
      showNotice('Failed to refresh gateway health.', 'error', 2500);
    }
  }

  async function fetchConfig() {
    try {
      const res = await fetch('/api/config');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      currentConfig = await res.json();
      hydrateSettings(currentConfig);
    } catch (err) {
      showNotice(`Failed to load config: ${err.message || err}`, 'error', 3500);
    }
  }

  function updateChannelDots() {
    // WebUI is always online if we're connected
    const webui = $('#ch-webui');
    if (webui) webui.classList.add('online');
    // Discord and WhatsApp status from health data
    const discord = $('#ch-discord');
    const whatsapp = $('#ch-whatsapp');
    // We don't have per-channel status in health yet, so check if they're configured
    if (discord) discord.classList.add('online'); // Assume online if gateway is up
    if (whatsapp) whatsapp.classList.add('online');
  }

  function formatUptime(seconds) {
    if (seconds < 60) return `${Math.floor(seconds)}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
  }

  function handleServerMessage(msg) {
    switch (msg.type) {
      case 'system':
        if (msg.health) {
          healthData = msg.health;
          if (healthData.workspace && workspacePill) {
            workspacePill.textContent = `workspace: ${healthData.workspace}`;
            workspacePill.title = healthData.workspace;
          }
        }
        break;

      case 'thinking':
        ensureAssistantMessage();
        appendThinking(msg.content || '');
        break;

      case 'content':
        ensureAssistantMessage();
        currentContent += msg.content || '';
        renderAssistantContent();
        break;

      case 'tool_start':
        ensureAssistantMessage();
        appendToolBadge(msg.tool, msg.args);
        break;

      case 'tool_result':
        ensureAssistantMessage();
        appendToolResult(msg.tool, msg.result);
        break;

      case 'confirmation':
        showConfirmation(msg);
        break;

      case 'done':
        finishStreaming();
        loadSessions();
        break;

      case 'error':
        ensureAssistantMessage();
        appendError(msg.content || 'An error occurred');
        showNotice(msg.content || 'An error occurred', 'error', 4000);
        finishStreaming();
        break;

      case 'config_reloaded':
        if (msg.config) {
          currentConfig = msg.config;
          hydrateSettings(currentConfig);
        }
        if (msg.health) {
          healthData = msg.health;
          if (workspacePill && healthData.workspace) {
            workspacePill.textContent = `workspace: ${healthData.workspace}`;
            workspacePill.title = healthData.workspace;
          }
        }
        showNotice('Config reloaded from disk.', 'info', 3000);
        break;

      case 'pong':
        break;
    }
  }

  function hydrateSettings(config) {
    if (!config) return;
    if (config.llm?.primary) {
      settingModel.innerHTML = `<option value="${escapeHtml(config.llm.primary)}" selected>${escapeHtml(config.llm.primary)}</option>`;
    }
    if (config.agent?.thinkingDefault && settingThinking) {
      settingThinking.value = config.agent.thinkingDefault;
    }
    if (config.agent?.maxTurns && settingMaxTurns) {
      settingMaxTurns.value = config.agent.maxTurns;
    }
    if (config.agent?.workspace && settingWorkspace) {
      settingWorkspace.value = config.agent.workspace;
    }
    const toolLoadingValue = config.agent?.toolLoading === 'all' ? 'eager' : 'lazy';
    document.querySelectorAll('.setting-toggle-group .toggle-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.value === toolLoadingValue);
    });
    if (toggleDiscord) toggleDiscord.checked = !!config.channels?.discord?.enabled;
    if (toggleWhatsapp) toggleWhatsapp.checked = !!config.channels?.whatsapp?.enabled;
    if (discordReplyStyle) discordReplyStyle.value = config.channels?.discord?.replyStyle || 'single';
    if (whatsappReplyStyle) whatsappReplyStyle.value = config.channels?.whatsapp?.replyStyle || 'single';
  }

  async function saveSettings() {
    const payload = {
      llm: {
        primary: settingModel.value,
      },
      agent: {
        workspace: settingWorkspace.value.trim(),
        maxTurns: Number(settingMaxTurns.value || 20),
        toolLoading: document.querySelector('.setting-toggle-group .toggle-btn.active')?.dataset.value === 'eager' ? 'all' : 'lazy',
        thinkingDefault: settingThinking.value,
      },
      channels: {
        discord: {
          enabled: !!toggleDiscord?.checked,
          replyStyle: discordReplyStyle.value,
          showToolProgress: false,
        },
        whatsapp: {
          enabled: !!toggleWhatsapp?.checked,
          replyStyle: whatsappReplyStyle.value,
          showToolProgress: false,
        },
      },
    };

    try {
      saveSettingsBtn.disabled = true;
      saveSettingsBtn.textContent = 'Saving...';
      const res = await fetch('/api/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      currentConfig = data.config || payload;
      hydrateSettings(currentConfig);
      fetchHealth();
      showNotice('Settings saved. New requests will use the updated config.', 'success', 3500);
    } catch (err) {
      showNotice(`Failed to save settings: ${err.message || err}`, 'error', 4500);
    } finally {
      saveSettingsBtn.disabled = false;
      saveSettingsBtn.textContent = 'Save Settings';
    }
  }

  // ─── Message Rendering ───────────────────────────────────────────

  function showWelcome() {
    // Recreate welcome screen
    const existing = $('#welcomeScreen');
    if (existing) return;

    const wel = document.createElement('div');
    wel.className = 'welcome-screen';
    wel.id = 'welcomeScreen';
    wel.innerHTML = `
      <div class="welcome-icon">🦎</div>
      <h2>Welcome to LiteClaw</h2>
      <p>Your lightweight local AI agent. Ask me anything, or use my tools to work with files, run commands, and search the web.</p>
      <div class="welcome-chips">
        <button class="chip" data-prompt="What files are in my current directory?">📁 List files</button>
        <button class="chip" data-prompt="Search the web for today's top tech news">🔍 Web search</button>
        <button class="chip" data-prompt="What can you help me with?">💡 Capabilities</button>
        <button class="chip" data-prompt="Tell me a joke">😄 Tell a joke</button>
      </div>
    `;
    messagesEl.appendChild(wel);

    // Wire up chips
    wel.querySelectorAll('.chip').forEach(chip => {
      chip.addEventListener('click', () => {
        inputEl.value = chip.dataset.prompt;
        sendBtn.disabled = false;
        sendMessage();
      });
    });
  }

  function hideWelcome() {
    const wel = $('#welcomeScreen');
    if (wel) wel.remove();
  }

  function addUserMessage(text, images, animate = true) {
    hideWelcome();
    const el = document.createElement('div');
    el.className = 'message user';
    if (!animate) el.style.animation = 'none';
    el.innerHTML = `
      <div class="message-avatar">👤</div>
      <div class="message-body">
        <div class="message-sender">You</div>
        <div class="message-content">${escapeHtml(text)}</div>
        ${images.length > 0 ? `<div style="display:flex;gap:6px;margin-top:8px">${images.map(img => `<img src="${img}" style="max-width:120px;border-radius:8px">`).join('')}</div>` : ''}
      </div>
    `;
    messagesEl.appendChild(el);
    scrollToBottom();
  }

  function addRestoredAssistantMessage(content) {
    const el = document.createElement('div');
    el.className = 'message assistant';
    el.style.animation = 'none';
    el.innerHTML = `
      <div class="message-avatar">🦎</div>
      <div class="message-body">
        <div class="message-sender">LiteClaw</div>
        <div class="message-content">${renderMarkdown(content)}</div>
      </div>
    `;
    messagesEl.appendChild(el);
    addCopyButtons(el.querySelector('.message-content'));
  }

  function ensureAssistantMessage() {
    if (currentAssistantEl) return;
    hideWelcome();
    isStreaming = true;

    const el = document.createElement('div');
    el.className = 'message assistant';
    el.innerHTML = `
      <div class="message-avatar">🦎</div>
      <div class="message-body">
        <div class="message-sender">LiteClaw</div>
        <div class="message-content"></div>
      </div>
    `;
    messagesEl.appendChild(el);
    currentAssistantEl = el;
    scrollToBottom();
  }

  function renderAssistantContent() {
    if (!currentAssistantEl) return;
    const contentEl = currentAssistantEl.querySelector('.message-content');
    contentEl.innerHTML = renderMarkdown(currentContent) + '<span class="streaming-cursor"></span>';
    addCopyButtons(contentEl);
    scrollToBottom();
  }

  function appendThinking(text) {
    if (!currentAssistantEl) return;
    const body = currentAssistantEl.querySelector('.message-body');
    let thinkEl = body.querySelector('.thinking-block:last-of-type');
    if (!thinkEl || thinkEl.dataset.closed) {
      thinkEl = document.createElement('div');
      thinkEl.className = 'thinking-block';
      thinkEl.textContent = '';
      body.querySelector('.message-content').before(thinkEl);
    }
    thinkEl.textContent += text;
    scrollToBottom();
  }

  function appendToolBadge(toolName) {
    if (!currentAssistantEl) return;
    const body = currentAssistantEl.querySelector('.message-body');
    const badge = document.createElement('div');
    badge.className = 'tool-badge';
    badge.innerHTML = `<span class="tool-spinner"></span> <span>${escapeHtml(toolName)}</span>`;
    badge.dataset.tool = toolName;
    // Insert before message-content (after thinking blocks and other badges)
    const content = body.querySelector('.message-content');
    body.insertBefore(badge, content);
    scrollToBottom();
  }

  function appendToolResult(toolName, result) {
    if (!currentAssistantEl) return;
    const badges = currentAssistantEl.querySelectorAll('.tool-badge');
    for (const badge of badges) {
      if (badge.dataset.tool === toolName && badge.querySelector('.tool-spinner')) {
        const icon = result?.success ? '✓' : '✗';
        const cls = result?.success ? 'success' : 'error';
        badge.className = `tool-badge ${cls}`;
        badge.innerHTML = `<span>${icon}</span> <span>${escapeHtml(toolName)}</span>`;
        break;
      }
    }
    scrollToBottom();
  }

  function appendError(text) {
    if (!currentAssistantEl) return;
    const errEl = document.createElement('div');
    errEl.style.cssText = 'color: var(--danger); padding: 8px; border-radius: 6px; background: rgba(248,113,113,0.08); margin: 4px 0; font-size: 13px;';
    errEl.textContent = '⚠ ' + text;
    currentAssistantEl.querySelector('.message-body').appendChild(errEl);
  }

  function finishStreaming() {
    if (currentAssistantEl) {
      const cursor = currentAssistantEl.querySelector('.streaming-cursor');
      if (cursor) cursor.remove();
      currentAssistantEl.querySelectorAll('.thinking-block').forEach(el => el.dataset.closed = 'true');
    }
    currentAssistantEl = null;
    currentContent = '';
    isStreaming = false;
    inputEl.disabled = false;
    inputEl.focus();
    sendBtn.disabled = inputEl.value.trim().length === 0;
  }

  // ─── Confirmations ──────────────────────────────────────────────

  function showConfirmation(msg) {
    pendingConfirmationId = msg.id;
    confirmBody.textContent = msg.description || `Tool "${msg.tool}" requires your confirmation.`;
    confirmModal.hidden = false;
  }

  confirmAccept.addEventListener('click', () => {
    if (pendingConfirmationId && ws) {
      ws.send(JSON.stringify({
        type: 'confirmation_response',
        confirmationId: pendingConfirmationId,
        confirmed: true,
      }));
    }
    confirmModal.hidden = true;
    pendingConfirmationId = null;
  });

  confirmReject.addEventListener('click', () => {
    if (pendingConfirmationId && ws) {
      ws.send(JSON.stringify({
        type: 'confirmation_response',
        confirmationId: pendingConfirmationId,
        confirmed: false,
      }));
    }
    confirmModal.hidden = true;
    pendingConfirmationId = null;
  });

  // ─── Send Message ───────────────────────────────────────────────

  function sendMessage() {
    const text = inputEl.value.trim();
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;

    addUserMessage(text, [...attachedImages]);

    ws.send(JSON.stringify({
      type: 'message',
      content: text,
      sessionKey: currentSessionKey,
      workingDir: settingWorkspace?.value?.trim() || currentConfig?.agent?.workspace,
      images: attachedImages.length > 0 ? [...attachedImages] : undefined,
    }));

    inputEl.value = '';
    inputEl.style.height = 'auto';
    attachedImages.length = 0;
    imagePreview.hidden = true;
    imagePreview.innerHTML = '';
    sendBtn.disabled = true;
    inputEl.disabled = true;
  }

  // ─── Image Attachment ───────────────────────────────────────────

  imageInput.addEventListener('change', (e) => {
    const files = Array.from(e.target.files || []);
    for (const file of files) {
      if (attachedImages.length >= 4) break;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const dataUrl = ev.target.result;
        attachedImages.push(dataUrl);
        const img = document.createElement('img');
        img.src = dataUrl;
        imagePreview.appendChild(img);
        imagePreview.hidden = false;
      };
      reader.readAsDataURL(file);
    }
    imageInput.value = '';
  });

  // ─── Input Handlers ─────────────────────────────────────────────

  inputEl.addEventListener('input', () => {
    sendBtn.disabled = inputEl.value.trim().length === 0;
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 150) + 'px';
  });

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  sendBtn.addEventListener('click', sendMessage);

  clearBtn.addEventListener('click', () => {
    messagesEl.innerHTML = '';
    currentAssistantEl = null;
    currentContent = '';
    fetch(`/api/sessions/${encodeURIComponent(currentSessionKey)}`, { method: 'DELETE' }).catch(() => {});
    showWelcome();
    loadSessions();
  });

  newChatBtn.addEventListener('click', createNewSession);

  sidebarToggle.addEventListener('click', () => {
    sidebar.classList.toggle('open');
  });

  // Wire up chips (static ones from initial HTML)
  $$('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      inputEl.value = chip.dataset.prompt;
      sendBtn.disabled = false;
      sendMessage();
    });
  });

  // ─── Settings Panel ─────────────────────────────────────────────

  settingsBtn.addEventListener('click', () => {
    settingsOverlay.hidden = false;
    fetchHealth(); // Refresh data
    fetchConfig();
    populateModelSelector();
  });

  closeSettingsBtn.addEventListener('click', () => {
    settingsOverlay.hidden = true;
  });

  settingsOverlay.addEventListener('click', (e) => {
    if (e.target === settingsOverlay) {
      settingsOverlay.hidden = true;
    }
  });

  // Temperature slider
  settingTemp.addEventListener('input', () => {
    settingTempVal.textContent = parseFloat(settingTemp.value).toFixed(1);
  });

  // Toggle button groups
  $$('.setting-toggle-group').forEach(group => {
    group.querySelectorAll('.toggle-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        group.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });
  });

  // Channel toggles
  const toggleDiscord = $('#toggleDiscord');
  const toggleWhatsapp = $('#toggleWhatsapp');
  if (toggleDiscord) toggleDiscord.checked = true; // Default enabled
  if (toggleWhatsapp) toggleWhatsapp.checked = true;
  if (saveSettingsBtn) saveSettingsBtn.addEventListener('click', saveSettings);

  // Clear all sessions
  clearAllBtn.addEventListener('click', async () => {
    if (!confirm('Delete ALL sessions? This cannot be undone.')) return;
    try {
      const res = await fetch('/api/sessions');
      if (res.ok) {
        const data = await res.json();
        for (const session of (data.sessions || [])) {
          await fetch(`/api/sessions/${encodeURIComponent(session.sessionKey)}`, { method: 'DELETE' });
        }
      }
    } catch {}
    switchSession('webui:default');
  });

  async function populateModelSelector() {
    if (currentConfig?.llm?.primary) {
      settingModel.innerHTML = `<option value="${escapeHtml(currentConfig.llm.primary)}" selected>${escapeHtml(currentConfig.llm.primary)}</option>`;
    } else if (healthData.model) {
      settingModel.innerHTML = `<option value="${escapeHtml(healthData.model)}" selected>${escapeHtml(healthData.model)}</option>`;
    }
    // Update status texts
    const discordStatus = $('#discordStatusText');
    const whatsappStatus = $('#whatsappStatusText');
    if (discordStatus) discordStatus.textContent = 'Online';
    if (whatsappStatus) whatsappStatus.textContent = 'Online';
  }

  // ─── Markdown Rendering ─────────────────────────────────────────

  function renderMarkdown(text) {
    let html = escapeHtml(text);

    // Code blocks (``` ... ```)
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
      return `<pre><code class="language-${lang}">${code.trim()}</code></pre>`;
    });

    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Bold
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

    // Italic
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

    // Links
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener" style="color:var(--accent-secondary)">$1</a>');

    // Headings
    html = html.replace(/^### (.+)$/gm, '<h4 style="margin:8px 0 4px;font-size:14px">$1</h4>');
    html = html.replace(/^## (.+)$/gm, '<h3 style="margin:10px 0 4px;font-size:15px">$1</h3>');
    html = html.replace(/^# (.+)$/gm, '<h2 style="margin:12px 0 6px;font-size:16px">$1</h2>');

    // Unordered lists
    html = html.replace(/^[*-] (.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>[\s\S]*?<\/li>)/g, '<ul style="margin:4px 0;padding-left:20px">$1</ul>');

    // Line breaks
    html = html.replace(/\n/g, '<br>');

    // Clean up double <ul>
    html = html.replace(/<\/ul><br><ul[^>]*>/g, '');

    return html;
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function addCopyButtons(container) {
    if (!container) return;
    container.querySelectorAll('pre').forEach(pre => {
      if (pre.querySelector('.copy-btn')) return;
      const btn = document.createElement('button');
      btn.className = 'copy-btn';
      btn.textContent = 'Copy';
      btn.onclick = () => {
        const code = pre.querySelector('code');
        navigator.clipboard.writeText(code?.textContent || '');
        btn.textContent = 'Copied!';
        setTimeout(() => btn.textContent = 'Copy', 1500);
      };
      pre.style.position = 'relative';
      pre.appendChild(btn);
    });
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  }

  function showNotice(text, level = 'info', timeout = 3000) {
    if (!noticeStack) return;
    const el = document.createElement('div');
    el.className = `notice ${level}`;
    el.textContent = text;
    noticeStack.appendChild(el);
    if (timeout > 0) {
      setTimeout(() => {
        el.remove();
      }, timeout);
    }
  }

  function sendSessionInit() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'session_init', sessionKey: currentSessionKey }));
    }
  }

  // ─── Init ───────────────────────────────────────────────────────

  // Set initial header
  chatTitle.textContent = formatSessionName(currentSessionKey);
  chatSubtitle.textContent = currentSessionKey;

  connect();

  // Keepalive ping
  setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, 30000);

  // Refresh health every 30s
  setInterval(fetchHealth, 30000);
})();
