(() => {
  let ws = null;
  let reconnectTimer = null;
  let isStreaming = false;
  let currentAssistantEl = null;
  let currentContent = "";
  let currentSessionKey = "webui:default";
  let currentFilter = "";
  let currentConfig = {};
  let healthData = {};
  let sessions = [];
  let currentSessionMetrics = { estimatedTokens: 0, messageCount: 0, imageCount: 0 };
  let pendingConfirmationId = null;
  let workspacePath = ".";
  let selectedWorkspaceFile = "";
  const attachedImages = [];

  const $ = (selector) => document.querySelector(selector);
  const messagesEl = $("#messages");
  const sessionListEl = $("#sessionList");
  const sessionSearch = $("#sessionSearch");
  const sendBtn = $("#sendBtn");
  const inputEl = $("#messageInput");
  const imageInput = $("#imageInput");
  const imagePreview = $("#imagePreview");
  const workspaceBtn = $("#workspaceBtn");
  const workspaceDrawer = $("#workspaceDrawer");
  const workspaceTree = $("#workspaceTree");
  const workspacePreviewMeta = $("#workspacePreviewMeta");
  const workspacePreviewContent = $("#workspacePreviewContent");
  const workspacePathLabel = $("#workspacePathLabel");
  const closeWorkspaceBtn = $("#closeWorkspaceBtn");
  const workspaceUpBtn = $("#workspaceUpBtn");
  const workspaceRefreshBtn = $("#workspaceRefreshBtn");
  const settingsBtn = $("#settingsBtn");
  const settingsOverlay = $("#settingsOverlay");
  const closeSettingsBtn = $("#closeSettingsBtn");
  const saveSettingsBtn = $("#saveSettingsBtn");
  const clearAllBtn = $("#clearAllBtn");
  const confirmModal = $("#confirmModal");
  const confirmBody = $("#confirmBody");
  const confirmAccept = $("#confirmAccept");
  const confirmReject = $("#confirmReject");
  const noticeStack = $("#noticeStack");
  const sidebar = $("#sidebar");
  const sidebarToggle = $("#sidebarToggle");
  const sidebarBackdrop = $("#sidebarBackdrop");
  const mobileMenuBtn = $("#mobileMenuBtn");

  const refs = {
    statusDot: $("#statusDot"),
    statusText: $("#statusText"),
    modelBadge: $("#modelBadge"),
    sessionCountBadge: $("#sessionCountBadge"),
    chatTitle: $("#chatTitle"),
    chatSubtitle: $("#chatSubtitle"),
    healthPill: $("#healthPill"),
    healthDot: $("#healthDot"),
    healthLabel: $("#healthLabel"),
    tokenLabel: $("#tokenLabel"),
    chWebui: $("#ch-webui"),
    chDiscord: $("#ch-discord"),
    chWhatsapp: $("#ch-whatsapp"),
    newChatBtn: $("#newChatBtn"),
    clearBtn: $("#clearBtn"),
    exportBtn: $("#exportBtn"),
    settingModel: $("#settingModel"),
    settingThinking: $("#settingThinking"),
    settingWorkspace: $("#settingWorkspace"),
    settingMaxTurns: $("#settingMaxTurns"),
    settingPlannerMode: $("#settingPlannerMode"),
    settingPlannerMaxReplans: $("#settingPlannerMaxReplans"),
    settingContextTokens: $("#settingContextTokens"),
    settingContextBudgetPct: $("#settingContextBudgetPct"),
    settingSkillsMaxInjected: $("#settingSkillsMaxInjected"),
    toggleSkillsEnabled: $("#toggleSkillsEnabled"),
    toggleDiscord: $("#toggleDiscord"),
    toggleWhatsapp: $("#toggleWhatsapp"),
    discordReplyStyle: $("#discordReplyStyle"),
    whatsappReplyStyle: $("#whatsappReplyStyle"),
    toggleDiscordToolProgress: $("#toggleDiscordToolProgress"),
    toggleWhatsappToolProgress: $("#toggleWhatsappToolProgress"),
    toggleExecEnabled: $("#toggleExecEnabled"),
    toggleExecConfirm: $("#toggleExecConfirm"),
    toggleWebFetchEnabled: $("#toggleWebFetchEnabled"),
    toggleWebFallback: $("#toggleWebFallback"),
    toggleFilesystemEnabled: $("#toggleFilesystemEnabled"),
    toggleConfirmDelete: $("#toggleConfirmDelete"),
    toggleVisionEnabled: $("#toggleVisionEnabled"),
    settingVisionMaxDimension: $("#settingVisionMaxDimension"),
    settingGatewayPort: $("#settingGatewayPort"),
    settingGatewayBind: $("#settingGatewayBind"),
    gatewayAuthNote: $("#gatewayAuthNote"),
  };

  // ─── Sidebar Toggle ──────────────────────────────────────────────

  function setSidebarOpen(open) {
    sidebar.classList.toggle("open", open);
    if (sidebarBackdrop) sidebarBackdrop.classList.toggle("visible", open);
  }

  // ─── Fetch Helpers ────────────────────────────────────────────────

  async function fetchJson(url, options) {
    const res = await fetch(url, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  // ─── WebSocket ────────────────────────────────────────────────────

  function connect() {
    clearTimeout(reconnectTimer);
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${protocol}//${location.host}/ws`);

    ws.onopen = () => {
      refs.statusDot.classList.add("connected");
      refs.statusText.textContent = "Connected";
      fetchHealth();
      fetchConfig();
      loadSessions();
      sendSessionInit();
      showNotice("Realtime link restored.", "success", 2200);
    };

    ws.onclose = () => {
      refs.statusDot.classList.remove("connected");
      refs.statusText.textContent = "Reconnecting...";
      showNotice("Lost connection. Reconnecting...", "error", 2800);
      reconnectTimer = setTimeout(connect, 2500);
    };

    ws.onerror = () => {
      refs.statusText.textContent = "Connection error";
    };

    ws.onmessage = (event) => {
      try {
        handleServerMessage(JSON.parse(event.data));
      } catch (error) {
        console.error("Failed to parse ws payload", error);
      }
    };
  }

  // ─── Health & Config ──────────────────────────────────────────────

  async function fetchHealth() {
    try {
      healthData = await fetchJson("/health");
      renderHealth();
    } catch (error) {
      showNotice(`Failed to refresh health: ${error.message || error}`, "error", 2600);
    }
  }

  async function fetchConfig() {
    try {
      currentConfig = await fetchJson("/api/config");
      hydrateSettings(currentConfig);
    } catch (error) {
      showNotice(`Failed to load config: ${error.message || error}`, "error", 3200);
    }
  }

  // ─── Sessions ─────────────────────────────────────────────────────

  async function loadSessions() {
    try {
      const data = await fetchJson("/api/sessions");
      sessions = data.sessions || [];
      renderSessionList();
      fetchSessionMetrics(currentSessionKey);
    } catch {
      sessions = [];
      renderSessionList();
    }
  }

  function renderSessionList() {
    const filtered = sessions.filter((session) => {
      if (!currentFilter) return true;
      const haystack = `${session.sessionKey} ${session.userIdentifier || ""}`.toLowerCase();
      return haystack.includes(currentFilter.toLowerCase());
    });

    if (!filtered.find((session) => session.sessionKey === currentSessionKey)) {
      filtered.unshift({
        sessionKey: currentSessionKey,
        messageCount: 0,
        lastActivity: Date.now(),
      });
    }

    refs.sessionCountBadge.textContent = String(filtered.length);
    sessionListEl.innerHTML = "";

    for (const session of filtered) {
      const el = document.createElement("div");
      el.className = `session-item${session.sessionKey === currentSessionKey ? " active" : ""}`;
      const label = formatSessionName(session);
      el.innerHTML = `
        <button class="session-label" type="button" title="${escapeHtml(session.sessionKey)}">${escapeHtml(label)}</button>
        <span class="session-count" title="${Number(session.estimatedTokens || 0).toLocaleString()} tokens">${Number(session.estimatedTokens || 0).toLocaleString()}</span>
        <button class="session-delete" type="button" title="Delete session">×</button>
      `;

      el.querySelector(".session-label").addEventListener("click", () => switchSession(session.sessionKey));
      el.querySelector(".session-delete").addEventListener("click", async (event) => {
        event.stopPropagation();
        if (!confirm(`Delete session "${label}"?`)) return;
        await fetch(`/api/sessions/${encodeURIComponent(session.sessionKey)}`, { method: "DELETE" });
        if (session.sessionKey === currentSessionKey) {
          switchSession("webui:default");
        } else {
          loadSessions();
        }
      });

      sessionListEl.appendChild(el);
    }
  }

  function formatSessionName(sessionOrKey) {
    const key = typeof sessionOrKey === "string" ? sessionOrKey : sessionOrKey.sessionKey;
    const identifier = typeof sessionOrKey === "string" ? "" : sessionOrKey.userIdentifier || "";
    if (key.startsWith("discord:")) return `Discord / ${identifier || key.slice(8)}`;
    if (key.startsWith("whatsapp:")) return `WhatsApp / ${identifier || key.slice(9)}`;
    if (key.startsWith("cli:")) return `CLI / ${key.slice(4)}`;
    if (key === "webui:default") return "WebUI / default";
    if (key.startsWith("webui:chat_")) return `WebUI / ${key.slice(11)}`;
    return key.replace(/^webui:/, "").replace(/_/g, " ");
  }

  function updateHeader() {
    refs.chatTitle.textContent = formatSessionName(currentSessionKey);
    refs.chatSubtitle.textContent = currentSessionKey;
    renderSessionMetrics();
  }

  function switchSession(sessionKey) {
    currentSessionKey = sessionKey;
    currentAssistantEl = null;
    currentContent = "";
    isStreaming = false;
    messagesEl.innerHTML = "";
    updateHeader();
    loadSessionHistory(sessionKey);
    loadSessionTaskPlan(sessionKey);
    loadSessions();
    fetchSessionMetrics(sessionKey);
    sendSessionInit();
    setSidebarOpen(false);
  }

  async function fetchSessionMetrics(sessionKey) {
    try {
      const data = await fetchJson(`/api/sessions/${encodeURIComponent(sessionKey)}/metrics`);
      if (sessionKey !== currentSessionKey) return;
      currentSessionMetrics = data || currentSessionMetrics;
      renderSessionMetrics();
    } catch {
      if (sessionKey !== currentSessionKey) return;
      currentSessionMetrics = { estimatedTokens: 0, messageCount: 0, imageCount: 0 };
      renderSessionMetrics();
    }
  }

  function renderSessionMetrics() {
    if (!refs.tokenLabel) return;
    const tokens = Number(currentSessionMetrics.estimatedTokens || 0).toLocaleString();
    const messages = Number(currentSessionMetrics.messageCount || 0);
    const images = Number(currentSessionMetrics.imageCount || 0);
    refs.tokenLabel.textContent = `Tokens ${tokens} / msg ${messages} / img ${images}`;
  }

  async function loadSessionHistory(sessionKey) {
    try {
      const data = await fetchJson(`/api/sessions/${encodeURIComponent(sessionKey)}/history`);
      const history = data.messages || [];
      if (history.length === 0) {
        showWelcome();
        return;
      }

      hideWelcome();
      history.forEach((msg) => {
        if (msg.role === "user") {
          const cleaned = cleanMessageContent(msg.content || "");
          addUserMessage(cleaned.text, [], false, cleaned.sender);
        }
        if (msg.role === "assistant") {
          addRestoredAssistantMessage(msg.content || "");
        }
      });
      scrollToBottom();
    } catch {
      showWelcome();
    }
  }

  async function loadSessionTaskPlan(sessionKey) {
    try {
      const data = await fetchJson(`/api/sessions/${encodeURIComponent(sessionKey)}/task-plan`);
      if (sessionKey !== currentSessionKey) return;
      const taskPlan = data.taskPlan?.plan;
      if (!taskPlan || !Array.isArray(taskPlan.tasks) || taskPlan.tasks.length === 0) return;
      addRestoredTaskPlan(taskPlan);
    } catch {
      // Ignore missing task-plan state.
    }
  }

  function addRestoredTaskPlan(plan) {
    hideWelcome();
    const el = document.createElement("div");
    el.className = "message assistant restored-plan";
    el.innerHTML = `
      <div class="message-avatar">LC</div>
      <div class="message-body">
        <div class="message-sender">LiteClaw</div>
        <div class="message-content"></div>
      </div>
    `;
    messagesEl.appendChild(el);

    const previousAssistant = currentAssistantEl;
    currentAssistantEl = el;
    appendPlan(plan);
    currentAssistantEl = previousAssistant;
  }

  // ─── Health Rendering ─────────────────────────────────────────────

  function renderHealth() {
    if (refs.modelBadge) refs.modelBadge.textContent = healthData.model || "--";
    if (refs.healthLabel) {
      const status = healthData.status || "unknown";
      refs.healthLabel.textContent = `Health (${healthData.sessionCount || sessions.length || 0})`;
    }
    applyChannelState(refs.chWebui, healthData.channels?.webui?.status || "online");
    applyChannelState(refs.chDiscord, healthData.channels?.discord?.status || "unknown");
    applyChannelState(refs.chWhatsapp, healthData.channels?.whatsapp?.status || "unknown");
  }

  function applyChannelState(el, state) {
    if (!el) return;
    el.textContent = state;
    el.className = "channel-status-dot";
    if (state === "online" || state === "configured") el.classList.add("online");
    else if (state === "disabled") el.classList.add("offline");
    else el.classList.add("warning");
  }

  // ─── Settings ─────────────────────────────────────────────────────

  function hydrateSettings(config) {
    const models = config.llm?.availableModels || [];
    const currentPrimary = config.llm?.primary || "";
    refs.settingModel.innerHTML = models.length
      ? models.map((model) => `<option value="${escapeHtml(model.id)}"${model.id === currentPrimary ? " selected" : ""}>${escapeHtml(model.label)}</option>`).join("")
      : `<option value="${escapeHtml(currentPrimary)}">${escapeHtml(currentPrimary || "unknown")}</option>`;

    refs.settingThinking.value = config.agent?.thinkingDefault || "medium";
    refs.settingWorkspace.value = config.agent?.workspace || "";
    refs.settingMaxTurns.value = config.agent?.maxTurns || 20;
    refs.settingPlannerMode.value = config.agent?.planner?.mode || "auto";
    refs.settingPlannerMaxReplans.value = config.agent?.planner?.maxReplans ?? 2;
    refs.settingContextTokens.value = config.agent?.contextTokens || 64000;
    refs.settingContextBudgetPct.value = config.agent?.contextBudgetPct || 80;
    refs.settingSkillsMaxInjected.value = config.agent?.skills?.maxInjected || 2;
    refs.toggleSkillsEnabled.checked = !!config.agent?.skills?.enabled;

    document.querySelectorAll("#toolLoadingGroup .toggle-chip").forEach((button) => {
      button.classList.toggle("active", button.dataset.value === (config.agent?.toolLoading || "lazy"));
    });

    refs.toggleDiscord.checked = !!config.channels?.discord?.enabled;
    refs.discordReplyStyle.value = config.channels?.discord?.replyStyle || "single";
    refs.toggleDiscordToolProgress.checked = !!config.channels?.discord?.showToolProgress;
    refs.toggleWhatsapp.checked = !!config.channels?.whatsapp?.enabled;
    refs.whatsappReplyStyle.value = config.channels?.whatsapp?.replyStyle || "single";
    refs.toggleWhatsappToolProgress.checked = !!config.channels?.whatsapp?.showToolProgress;

    refs.toggleExecEnabled.checked = !!config.tools?.exec?.enabled;
    refs.toggleExecConfirm.checked = !!config.tools?.exec?.confirmDestructive;
    refs.toggleWebFetchEnabled.checked = !!config.tools?.web?.fetchEnabled;
    refs.toggleWebFallback.checked = !!config.tools?.web?.browserFallback;
    refs.toggleFilesystemEnabled.checked = !!config.tools?.filesystem?.enabled;
    refs.toggleConfirmDelete.checked = !!config.tools?.filesystem?.confirmDelete;
    refs.toggleVisionEnabled.checked = !!config.tools?.vision?.enabled;
    refs.settingVisionMaxDimension.value = config.tools?.vision?.maxDimensionPx || 1024;
    refs.settingGatewayPort.value = config.gateway?.port || 7860;
    refs.settingGatewayBind.value = config.gateway?.bind || "loopback";
    refs.gatewayAuthNote.textContent = config.gateway?.authEnabled
      ? "Auth: gateway token configured"
      : "Auth: local WebUI endpoints open";
  }

  function gatherSettingsPayload() {
    const toolLoading = document.querySelector("#toolLoadingGroup .toggle-chip.active")?.dataset.value || "lazy";
    return {
      llm: {
        primary: refs.settingModel.value,
      },
      agent: {
        workspace: refs.settingWorkspace.value.trim(),
        maxTurns: Number(refs.settingMaxTurns.value || 20),
        planner: {
          mode: refs.settingPlannerMode.value || "auto",
          maxReplans: Number(refs.settingPlannerMaxReplans.value || 2),
        },
        toolLoading,
        thinkingDefault: refs.settingThinking.value,
        contextTokens: Number(refs.settingContextTokens.value || 64000),
        contextBudgetPct: Number(refs.settingContextBudgetPct.value || 80),
        skills: {
          enabled: refs.toggleSkillsEnabled.checked,
          maxInjected: Number(refs.settingSkillsMaxInjected.value || 2),
        },
      },
      channels: {
        discord: {
          enabled: refs.toggleDiscord.checked,
          replyStyle: refs.discordReplyStyle.value,
          showToolProgress: refs.toggleDiscordToolProgress.checked,
        },
        whatsapp: {
          enabled: refs.toggleWhatsapp.checked,
          replyStyle: refs.whatsappReplyStyle.value,
          showToolProgress: refs.toggleWhatsappToolProgress.checked,
        },
      },
      tools: {
        exec: {
          enabled: refs.toggleExecEnabled.checked,
          confirmDestructive: refs.toggleExecConfirm.checked,
        },
        web: {
          fetchEnabled: refs.toggleWebFetchEnabled.checked,
          browserFallback: refs.toggleWebFallback.checked,
        },
        filesystem: {
          enabled: refs.toggleFilesystemEnabled.checked,
          confirmDelete: refs.toggleConfirmDelete.checked,
        },
        vision: {
          enabled: refs.toggleVisionEnabled.checked,
          maxDimensionPx: Number(refs.settingVisionMaxDimension.value || 1024),
        },
      },
      gateway: {
        port: Number(refs.settingGatewayPort.value || 7860),
        bind: refs.settingGatewayBind.value,
      },
    };
  }

  async function saveSettings() {
    try {
      saveSettingsBtn.disabled = true;
      saveSettingsBtn.textContent = "Saving...";
      const data = await fetchJson("/api/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(gatherSettingsPayload()),
      });
      currentConfig = data.config || currentConfig;
      hydrateSettings(currentConfig);
      await fetchHealth();
      showNotice("Settings saved. New turns will use the updated runtime.", "success", 2800);
    } catch (error) {
      showNotice(`Failed to save settings: ${error.message || error}`, "error", 3600);
    } finally {
      saveSettingsBtn.disabled = false;
      saveSettingsBtn.textContent = "Save settings";
    }
  }

  // ─── Workspace ────────────────────────────────────────────────────

  async function loadWorkspace(path = workspacePath) {
    try {
      const data = await fetchJson(`/api/workspace/tree?path=${encodeURIComponent(path)}`);
      workspacePath = data.currentPath || ".";
      workspacePathLabel.textContent = workspacePath;
      workspaceTree.innerHTML = "";

      for (const entry of data.entries || []) {
        const button = document.createElement("button");
        button.className = `workspace-entry${entry.path === selectedWorkspaceFile ? " active" : ""}`;
        button.type = "button";
        button.innerHTML = `
          <span class="workspace-entry-kind">${entry.kind === "directory" ? "dir" : "file"}</span>
          <span class="workspace-entry-name">${escapeHtml(entry.name)}</span>
          <span class="workspace-entry-meta">${formatSize(entry.size)}</span>
        `;
        button.addEventListener("click", () => {
          if (entry.kind === "directory") {
            selectedWorkspaceFile = "";
            loadWorkspace(entry.path);
            return;
          }
          selectedWorkspaceFile = entry.path;
          openWorkspaceFile(entry.path);
        });
        workspaceTree.appendChild(button);
      }
    } catch (error) {
      showNotice(`Workspace error: ${error.message || error}`, "error", 3000);
    }
  }

  async function openWorkspaceFile(path) {
    try {
      const data = await fetchJson(`/api/workspace/file?path=${encodeURIComponent(path)}`);
      workspacePreviewMeta.textContent = `${data.path} / ${formatSize(data.size)}${data.truncated ? " / truncated" : ""}`;
      workspacePreviewContent.textContent = data.isBinary
        ? "Binary preview is unavailable."
        : (data.content || "");
      Array.from(workspaceTree.querySelectorAll(".workspace-entry")).forEach((entry) => {
        entry.classList.toggle("active", entry.textContent.includes(path.split("/").pop()));
      });
    } catch (error) {
      workspacePreviewMeta.textContent = "Preview unavailable";
      workspacePreviewContent.textContent = String(error.message || error);
    }
  }

  // ─── Welcome Screen ──────────────────────────────────────────────

  function showWelcome() {
    if ($("#welcomeScreen")) return;
    messagesEl.innerHTML = `
      <div class="welcome-panel" id="welcomeScreen">
        <div class="welcome-content">
          <div class="eyebrow">Launch pad</div>
          <h3>What can I help you with?</h3>
          <p>Chat with LiteClaw to inspect, edit, search, or plan across your workspace.</p>
          <div class="welcome-actions">
            <button class="welcome-chip" data-prompt="Inspect the current workspace and tell me what this project is.">Inspect workspace</button>
            <button class="welcome-chip" data-prompt="Read README.md and propose the next milestone.">Plan next milestone</button>
            <button class="welcome-chip" data-prompt="Search the web for today's AI news and summarize it.">Web research</button>
            <button class="welcome-chip" data-prompt="What tools and skills should you use for editing PDFs and DOCX files?">Tooling help</button>
          </div>
        </div>
      </div>
    `;
    bindWelcomeChips();
  }

  function hideWelcome() {
    const el = $("#welcomeScreen");
    if (el) el.remove();
  }

  // ─── Message Rendering ────────────────────────────────────────────

  /**
   * Strip Discord/WhatsApp metadata prefix from user messages
   * and extract the sender's identity.
   */
  function cleanMessageContent(text) {
    if (!text) return { text, sender: "You" };
    let cleaned = text;
    let sender = "You";

    // Extract sender from new compact format: [context: ... | sender: Alice (@alice)]
    const contextMatch = cleaned.match(/^\[context:[^\]]*sender:\s*([^\]|]+)(?:]|\|)/m);
    if (contextMatch && contextMatch[1]) {
      sender = contextMatch[1].trim();
    }

    // Strip compact format loops
    cleaned = cleaned.replace(/^\[context:[^\]]*\]\n?/gm, "");
    cleaned = cleaned.replace(/^\[participants:[^\]]*\]\n?/gm, "");

    // Old verbose format: strip everything before the actual user message
    if (cleaned.startsWith("Conversation info (untrusted metadata):")) {
      const lastCodeBlockEnd = cleaned.lastIndexOf("```");
      if (lastCodeBlockEnd !== -1) {
        cleaned = cleaned.slice(lastCodeBlockEnd + 3);
      }
      cleaned = cleaned.replace(/^Use only these handles[^\n]*\n?/gm, "");
    }

    return { text: cleaned.trim(), sender };
  }

  function addUserMessage(text, images, animate = true, sender = "You") {
    hideWelcome();
    const el = document.createElement("div");
    el.className = "message user";
    if (!animate) el.style.animation = "none";
    
    // Generate an initial for the avatar
    const avatarInitial = sender === "You" ? "U" : sender.charAt(0).toUpperCase();

    el.innerHTML = `
      <div class="message-body">
        <div class="message-sender">${escapeHtml(sender)}</div>
        <div class="message-content">${escapeHtml(text)}</div>
        ${images.length ? `<div class="image-preview">${images.map((src) => `<img src="${src}" alt="attachment" style="max-width:140px;border:1px solid var(--line);margin-top:8px;">`).join("")}</div>` : ""}
      </div>
      <div class="message-avatar">${escapeHtml(avatarInitial)}</div>
    `;
    messagesEl.appendChild(el);
    scrollToBottom();
  }

  function addRestoredAssistantMessage(content) {
    const el = document.createElement("div");
    el.className = "message assistant";
    el.innerHTML = `
      <div class="message-avatar">LC</div>
      <div class="message-body">
        <div class="message-sender">LiteClaw</div>
        <div class="message-content">${renderMarkdown(content)}</div>
      </div>
    `;
    messagesEl.appendChild(el);
    addCopyButtons(el.querySelector(".message-content"));
  }

  function ensureAssistantMessage() {
    if (currentAssistantEl) return;
    hideWelcome();
    currentAssistantEl = document.createElement("div");
    currentAssistantEl.className = "message assistant";
    currentAssistantEl.innerHTML = `
      <div class="message-avatar">LC</div>
      <div class="message-body">
        <div class="message-sender">LiteClaw</div>
        <div class="message-content"></div>
      </div>
    `;
    messagesEl.appendChild(currentAssistantEl);
    isStreaming = true;
  }

  function renderAssistantContent() {
    if (!currentAssistantEl) return;
    const contentEl = currentAssistantEl.querySelector(".message-content");
    contentEl.innerHTML = renderMarkdown(currentContent) + (isStreaming ? '<span class="streaming-cursor"></span>' : "");
    addCopyButtons(contentEl);
    scrollToBottom();
  }

  function appendThinking(text) {
    ensureAssistantMessage();
    const body = currentAssistantEl.querySelector(".message-body");
    const wrappers = body.querySelectorAll(".thinking-wrapper");
    let wrapper = wrappers[wrappers.length - 1];
    
    if (!wrapper || wrapper.dataset.closed === "true") {
      wrapper = document.createElement("div");
      wrapper.className = "thinking-wrapper";
      
      const header = document.createElement("button");
      header.className = "thinking-header";
      header.type = "button";
      header.innerHTML = `
        <span class="thinking-toggle-icon"></span>
        <span class="thinking-label pulsing">Thinking...</span>
      `;
      
      const content = document.createElement("div");
      content.className = "thinking-content";
      
      wrapper.appendChild(header);
      wrapper.appendChild(content);
      body.insertBefore(wrapper, body.querySelector(".message-content"));
    }

    const contentEl = wrapper.querySelector(".thinking-content");
    contentEl.textContent += text || "";
    scrollToBottom();
  }

  function appendToolBadge(toolName) {
    ensureAssistantMessage();
    const badge = document.createElement("div");
    badge.className = "tool-badge";
    badge.dataset.tool = toolName;
    badge.innerHTML = `<span class="tool-spinner"></span><span>${escapeHtml(toolName)}</span>`;
    currentAssistantEl.querySelector(".message-body").insertBefore(badge, currentAssistantEl.querySelector(".message-content"));
    scrollToBottom();
  }

  function appendToolResult(toolName, result) {
    const badges = currentAssistantEl?.querySelectorAll(".tool-badge") || [];
    badges.forEach((badge) => {
      if (badge.dataset.tool !== toolName || badge.dataset.resolved === "true") return;
      badge.dataset.resolved = "true";
      badge.classList.add(result?.success ? "success" : "error");
      badge.innerHTML = `<span>${result?.success ? "✓" : "✗"}</span><span>${escapeHtml(toolName)}</span>`;
    });
    scrollToBottom();
  }

  function appendPlan(plan) {
    if (!plan || !Array.isArray(plan.tasks)) return;
    ensureAssistantMessage();

    let block = currentAssistantEl.querySelector(".task-plan");
    if (!block) {
      block = document.createElement("div");
      block.className = "task-plan";
      currentAssistantEl.querySelector(".message-body").insertBefore(block, currentAssistantEl.querySelector(".message-content"));
    }

    const items = plan.tasks.map((task, index) => {
      const status = escapeHtml(task.status || "pending");
      const title = escapeHtml(task.title || `Task ${index + 1}`);
      return `<li data-task-id="${escapeHtml(task.id || `task_${index + 1}`)}"><span class="task-status ${status}">${status}</span><span class="task-title">${title}</span></li>`;
    }).join("");

    block.innerHTML = `
      <div class="task-plan-header">Task Plan</div>
      <div class="task-plan-summary">${escapeHtml(plan.summary || "Working through the request step by step.")}</div>
      <ol class="task-plan-list">${items}</ol>
    `;
    scrollToBottom();
  }

  function appendTaskUpdate(msg) {
    ensureAssistantMessage();
    if (msg.plan) appendPlan(msg.plan);

    const planEl = currentAssistantEl?.querySelector(".task-plan");
    if (!planEl) return;

    const taskId = msg.taskId || "";
    const taskStatus = msg.taskStatus || "pending";
    const taskTitle = msg.taskTitle || "Task";
    const taskIndex = msg.taskIndex || 0;
    const taskTotal = msg.taskTotal || 0;
    const taskSummary = msg.taskSummary || "";

    let item = taskId ? planEl.querySelector(`[data-task-id="${CSS.escape(taskId)}"]`) : null;
    if (!item) {
      const list = planEl.querySelector(".task-plan-list");
      item = document.createElement("li");
      item.dataset.taskId = taskId;
      list?.appendChild(item);
    }

    item.innerHTML = `
      <span class="task-status ${escapeHtml(taskStatus)}">${escapeHtml(taskStatus)}</span>
      <span class="task-title">[${escapeHtml(String(taskIndex))}/${escapeHtml(String(taskTotal))}] ${escapeHtml(taskTitle)}</span>
      ${taskSummary ? `<span class="task-summary">${escapeHtml(taskSummary)}</span>` : ""}
    `;
    scrollToBottom();
  }

  function appendError(text) {
    ensureAssistantMessage();
    const err = document.createElement("div");
    err.className = "error-block";
    err.textContent = text;
    currentAssistantEl.querySelector(".message-body").insertBefore(err, currentAssistantEl.querySelector(".message-content"));
  }

  function finishStreaming(metrics) {
    isStreaming = false;
    renderAssistantContent();

    if (metrics && currentAssistantEl) {
      const body = currentAssistantEl.querySelector(".message-body");
      const metricsEl = document.createElement("div");
      metricsEl.className = "message-metrics";
      const totalSec = (metrics.durationMs / 1000).toFixed(1);
      const tps = metrics.tokPerSec.toFixed(1);
      metricsEl.innerHTML = `
        <span>${metrics.tokens} tokens</span>
        <span class="metric-sep"></span>
        <span>${totalSec}s</span>
        <span class="metric-sep"></span>
        <span>${tps} tok/s</span>
      `;
      body.appendChild(metricsEl);
    }

    currentAssistantEl?.querySelectorAll(".thinking-wrapper").forEach((el) => {
      el.dataset.closed = "true";
      const label = el.querySelector(".thinking-label");
      if (label) {
        label.classList.remove("pulsing");
        label.textContent = "Thoughts";
      }
    });
    currentAssistantEl = null;
    currentContent = "";
    inputEl.disabled = false;
    sendBtn.disabled = inputEl.value.trim().length === 0 && attachedImages.length === 0;
    inputEl.focus();
  }

  // ─── Server Message Handler ───────────────────────────────────────

  function handleServerMessage(msg) {
    switch (msg.type) {
      case "system":
        if (msg.health) {
          healthData = msg.health;
          renderHealth();
        }
        break;
      case "thinking":
        appendThinking(msg.content || "");
        break;
      case "content":
        ensureAssistantMessage();
        currentContent += msg.content || "";
        renderAssistantContent();
        break;
      case "plan":
        appendPlan(msg.plan || null);
        break;
      case "task_update":
        appendTaskUpdate(msg);
        break;
      case "tool_start":
        appendToolBadge(msg.tool || "tool");
        break;
      case "tool_result":
        appendToolResult(msg.tool || "tool", msg.result || {});
        break;
      case "confirmation":
        showConfirmation(msg);
        break;
      case "done":
        finishStreaming(msg.metrics);
        loadSessions();
        fetchSessionMetrics(currentSessionKey);
        break;
      case "error":
        appendError(msg.content || "An unknown error occurred.");
        showNotice(msg.content || "An unknown error occurred.", "error", 3600);
        finishStreaming();
        break;
      case "config_reloaded":
        if (msg.config) {
          currentConfig = msg.config;
          hydrateSettings(currentConfig);
        }
        if (msg.health) {
          healthData = msg.health;
          renderHealth();
        }
        showNotice("Config reloaded from disk.", "info", 2400);
        break;
      case "session_metrics":
        if (msg.sessionKey === currentSessionKey && msg.metrics) {
          currentSessionMetrics = msg.metrics;
          renderSessionMetrics();
        }
        loadSessions();
        break;
      case "pong":
        break;
      default:
        break;
    }
  }

  // ─── Confirmation ─────────────────────────────────────────────────

  function showConfirmation(msg) {
    pendingConfirmationId = msg.confirmationId || msg.id || null;
    confirmBody.innerHTML = renderMarkdown(msg.body || msg.description || msg.content || "Confirmation required.");
    confirmModal.hidden = false;
  }

  function respondToConfirmation(confirmed) {
    if (!pendingConfirmationId || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      type: "confirmation_response",
      confirmationId: pendingConfirmationId,
      confirmed,
    }));
    pendingConfirmationId = null;
    confirmModal.hidden = true;
  }

  // ─── Send Message ─────────────────────────────────────────────────

  function sendMessage() {
    const text = inputEl.value.trim();
    if ((!text && attachedImages.length === 0) || !ws || ws.readyState !== WebSocket.OPEN) return;

    addUserMessage(text || "(image attached)", [...attachedImages]);
    ws.send(JSON.stringify({
      type: "message",
      content: text,
      sessionKey: currentSessionKey,
      workingDir: refs.settingWorkspace.value.trim() || currentConfig.agent?.workspace,
      images: attachedImages.length ? [...attachedImages] : undefined,
    }));

    inputEl.value = "";
    inputEl.style.height = "auto";
    attachedImages.length = 0;
    imagePreview.hidden = true;
    imagePreview.innerHTML = "";
    sendBtn.disabled = true;
    inputEl.disabled = true;
    currentAssistantEl = null;
    currentContent = "";
  }

  // ─── Markdown Renderer ────────────────────────────────────────────

  function renderMarkdown(text) {
    const codeBlocks = [];
    const thinkBlocks = [];
    let working = String(text || "");

    // Handle thinking tags
    working = working.replace(/<think>([\s\S]*?)<\/think>/g, (_, content) => {
      const token = `@@THINK${thinkBlocks.length}@@`;
      thinkBlocks.push(`
        <div class="thinking-wrapper">
          <button class="thinking-header" type="button">
            <span class="thinking-toggle-icon"></span>
            <span class="thinking-label">Thoughts</span>
          </button>
          <div class="thinking-content">${escapeHtml(content.trim())}</div>
        </div>
      `);
      return token;
    });

    working = working.replace(/```([\w-]*)\n([\s\S]*?)```/g, (_, lang, code) => {
      const token = `@@CODE${codeBlocks.length}@@`;
      codeBlocks.push(`<pre><code class="language-${escapeHtml(lang || "text")}">${escapeHtml(code.trim())}</code></pre>`);
      return token;
    });

    let html = escapeHtml(working)
      .replace(/^### (.+)$/gm, "<h4>$1</h4>")
      .replace(/^## (.+)$/gm, "<h3>$1</h3>")
      .replace(/^# (.+)$/gm, "<h2>$1</h2>")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^\*])\*(.+?)\*/g, "$1<em>$2</em>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

    html = html.split(/\n{2,}/).map((chunk) => {
      const trimmed = chunk.trim();
      if (!trimmed) return "";
      if (/^@@CODE\d+@@$/.test(trimmed) || /^<h[234]>/.test(trimmed)) return trimmed;
      if (/^[-*] /m.test(trimmed)) {
        const items = trimmed.split("\n").filter(Boolean).map((line) => {
          if (/^[-*] /.test(line)) return `<li>${line.slice(2)}</li>`;
          return `<li>${line}</li>`;
        }).join("");
        return `<ul>${items}</ul>`;
      }
      if (/^\d+\. /m.test(trimmed)) {
        const items = trimmed.split("\n").filter(Boolean).map((line) => `<li>${line.replace(/^\d+\. /, "")}</li>`).join("");
        return `<ol>${items}</ol>`;
      }
      return `<p>${trimmed.replace(/\n/g, "<br>")}</p>`;
    }).join("");

    // Restore tokens
    codeBlocks.forEach((block, i) => {
      html = html.replace(`@@CODE${i}@@`, block);
    });
    thinkBlocks.forEach((block, i) => {
      html = html.replace(`@@THINK${i}@@`, block);
    });

    return html;
  }

  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  function addCopyButtons(container) {
    if (!container) return;
    container.querySelectorAll("pre").forEach((pre) => {
      if (pre.querySelector(".copy-btn")) return;
      const btn = document.createElement("button");
      btn.className = "copy-btn";
      btn.textContent = "Copy";
      btn.addEventListener("click", () => {
        navigator.clipboard.writeText(pre.querySelector("code")?.textContent || "");
        btn.textContent = "Copied";
        setTimeout(() => {
          btn.textContent = "Copy";
        }, 1200);
      });
      pre.appendChild(btn);
    });
  }

  // ─── Utilities ────────────────────────────────────────────────────

  function showNotice(text, level = "info", timeout = 2600) {
    const el = document.createElement("div");
    el.className = `notice ${level}`;
    el.textContent = text;
    noticeStack.appendChild(el);
    if (timeout > 0) setTimeout(() => el.remove(), timeout);
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  }

  function sendSessionInit() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "session_init", sessionKey: currentSessionKey }));
    }
  }

  function bindWelcomeChips() {
    document.querySelectorAll(".welcome-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        inputEl.value = chip.dataset.prompt || "";
        sendBtn.disabled = !inputEl.value.trim();
        sendMessage();
      });
    });
  }

  function formatUptime(seconds) {
    if (seconds < 60) return `${Math.floor(seconds)}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${minutes}m`;
  }

  function formatSize(size) {
    if (!Number.isFinite(size)) return "--";
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }

  function exportCurrentSession() {
    const transcript = Array.from(messagesEl.querySelectorAll(".message")).map((message) => {
      const sender = message.querySelector(".message-sender")?.textContent || "Unknown";
      const content = message.querySelector(".message-content")?.innerText || "";
      return `${sender}\n${content}`.trim();
    }).join("\n\n---\n\n");
    const blob = new Blob([transcript], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${currentSessionKey.replace(/[:/]/g, "_")}.txt`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function createNewSession() {
    switchSession(`webui:chat_${Date.now().toString(36)}`);
  }

  // ─── Event Listeners ──────────────────────────────────────────────

  inputEl.addEventListener("input", () => {
    inputEl.style.height = "auto";
    inputEl.style.height = `${Math.min(inputEl.scrollHeight, 200)}px`;
    sendBtn.disabled = inputEl.value.trim().length === 0 && attachedImages.length === 0;
  });

  inputEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  });

  imageInput.addEventListener("change", () => {
    const files = Array.from(imageInput.files || []).slice(0, 4);
    attachedImages.length = 0;
    imagePreview.innerHTML = "";

    files.forEach((file, index) => {
      const reader = new FileReader();
      reader.onload = () => {
        attachedImages.push(String(reader.result));
        const chip = document.createElement("div");
        chip.className = "image-chip";
        chip.innerHTML = `<span>${escapeHtml(file.name)}</span><button type="button">×</button>`;
        chip.querySelector("button").addEventListener("click", () => {
          attachedImages.splice(index, 1);
          chip.remove();
          if (attachedImages.length === 0) imagePreview.hidden = true;
          sendBtn.disabled = inputEl.value.trim().length === 0 && attachedImages.length === 0;
        });
        imagePreview.appendChild(chip);
        imagePreview.hidden = false;
        sendBtn.disabled = inputEl.value.trim().length === 0 && attachedImages.length === 0;
      };
      reader.readAsDataURL(file);
    });

    imageInput.value = "";
  });

  sessionSearch.addEventListener("input", () => {
    currentFilter = sessionSearch.value.trim();
    renderSessionList();
  });

  refs.newChatBtn.addEventListener("click", createNewSession);
  refs.clearBtn.addEventListener("click", async () => {
    messagesEl.innerHTML = "";
    currentAssistantEl = null;
    currentContent = "";
    await fetch(`/api/sessions/${encodeURIComponent(currentSessionKey)}`, { method: "DELETE" }).catch(() => {});
    showWelcome();
    loadSessions();
  });
  refs.exportBtn.addEventListener("click", exportCurrentSession);

  sendBtn.addEventListener("click", sendMessage);
  workspaceBtn.addEventListener("click", async () => {
    workspaceDrawer.hidden = false;
    await loadWorkspace(".");
  });
  closeWorkspaceBtn.addEventListener("click", () => {
    workspaceDrawer.hidden = true;
  });
  workspaceRefreshBtn.addEventListener("click", () => loadWorkspace(workspacePath));
  workspaceUpBtn.addEventListener("click", () => {
    if (workspacePath === "." || !workspacePath) {
      loadWorkspace(".");
      return;
    }
    loadWorkspace(workspacePath.split("/").slice(0, -1).join("/") || ".");
  });

  settingsBtn.addEventListener("click", () => {
    settingsOverlay.hidden = false;
    fetchHealth();
    fetchConfig();
  });
  closeSettingsBtn.addEventListener("click", () => {
    settingsOverlay.hidden = true;
  });
  saveSettingsBtn.addEventListener("click", saveSettings);
  clearAllBtn.addEventListener("click", async () => {
    if (!confirm("Delete all sessions? This cannot be undone.")) return;
    try {
      const data = await fetchJson("/api/sessions");
      for (const session of data.sessions || []) {
        await fetch(`/api/sessions/${encodeURIComponent(session.sessionKey)}`, { method: "DELETE" });
      }
      switchSession("webui:default");
      showNotice("All sessions deleted.", "success", 2400);
    } catch (error) {
      showNotice(`Failed to clear sessions: ${error.message || error}`, "error", 3200);
    }
  });

  document.querySelectorAll("#toolLoadingGroup .toggle-chip").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll("#toolLoadingGroup .toggle-chip").forEach((peer) => peer.classList.remove("active"));
      button.classList.add("active");
    });
  });

  confirmAccept.addEventListener("click", () => respondToConfirmation(true));
  confirmReject.addEventListener("click", () => respondToConfirmation(false));
  confirmModal.addEventListener("click", (event) => {
    if (event.target === confirmModal) respondToConfirmation(false);
  });
  settingsOverlay.addEventListener("click", (event) => {
    if (event.target === settingsOverlay) settingsOverlay.hidden = true;
  });

  // Sidebar toggles (mobile)
  if (sidebarToggle) {
    sidebarToggle.addEventListener("click", () => setSidebarOpen(false));
  }
  if (mobileMenuBtn) {
    mobileMenuBtn.addEventListener("click", () => setSidebarOpen(!sidebar.classList.contains("open")));
  }
  if (sidebarBackdrop) {
    sidebarBackdrop.addEventListener("click", () => setSidebarOpen(false));
  }

  // ─── Initialization ───────────────────────────────────────────────

  // Event delegation for thinking accordions
  messagesEl.addEventListener("click", (e) => {
    const header = e.target.closest(".thinking-header");
    if (header) {
      const wrapper = header.closest(".thinking-wrapper");
      if (wrapper) {
        wrapper.classList.toggle("expanded");
      }
    }
  });

  updateHeader();
  bindWelcomeChips();
  connect();

  setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "ping" }));
    }
  }, 30000);

  setInterval(fetchHealth, 30000);
})();
