document.addEventListener('DOMContentLoaded', async () => {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  // ---------- real viewport height (mobile keyboard handling) ----------
  // Modern browsers with `interactive-widget=resizes-content` (set in the
  // <meta viewport> tag) already shrink 100dvh correctly when the keyboard
  // opens. We only need a JS fallback for browsers that DON'T support that
  // (older iOS Safari). Running both at once causes double-compensation,
  // which is what was pushing the composer off-screen — so we feature-detect.
  const supportsInteractiveWidget = CSS.supports('height', '100dvh') && 'visualViewport' in window
    && (() => {
      // Heuristic: iOS Safari supports visualViewport but NOT the
      // interactive-widget meta hint, so it still needs the JS fallback.
      const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent);
      return !isIOS;
    })();

  function setAppHeight() {
    const h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    document.documentElement.style.setProperty('--app-vh', (h / 100) + 'px');
  }

  if (!supportsInteractiveWidget && window.visualViewport) {
    setAppHeight();
    window.visualViewport.addEventListener('resize', setAppHeight);
    window.visualViewport.addEventListener('scroll', setAppHeight);
  } else {
    document.documentElement.style.removeProperty('--app-vh');
  }
  window.addEventListener('orientationchange', () => {
    if (!supportsInteractiveWidget) setTimeout(setAppHeight, 100);
  });

  // Re-sync everything when the page comes back from being backgrounded/
  // suspended (switching apps, locking the phone, bfcache restore) — this
  // is what was making the chat list look "stuck" until you touched search.
  async function resyncOnResume() {
    await renderConvList();
    if (activeConv) await renderMessages();
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resyncOnResume();
  });
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) resyncOnResume();
  });
  window.addEventListener('focus', resyncOnResume);

  const me = await EmberDB.currentUser();
  if (!me) {
    window.location.href = 'index.html';
    return;
  }

  // ---------- element refs ----------
  const convList = document.getElementById('conv-list');
  const meName = document.getElementById('me-name');
  const signoutBtn = document.getElementById('signout-btn');
  const searchInput = document.getElementById('search-input');

  const chatEmpty = document.getElementById('chat-empty');
  const chatActive = document.getElementById('chat-active');
  const chatAvatar = document.getElementById('chat-avatar');
  const chatHeaderName = document.getElementById('chat-header-name');
  const chatHeaderStatus = document.getElementById('chat-header-status');
  const messagesEl = document.getElementById('messages');
  const sidebar = document.getElementById('sidebar');
  const chatPanel = document.getElementById('chat-panel');
  const backBtn = document.getElementById('back-btn');

  const attachBtn = document.getElementById('attach-btn');
  const fileInput = document.getElementById('file-input');
  const previewStrip = document.getElementById('img-preview-strip');
  const textInput = document.getElementById('text-input');
  const sendBtn = document.getElementById('send-btn');

  const lightbox = document.getElementById('lightbox');
  const lightboxImg = document.getElementById('lightbox-img');
  const lightboxClose = document.getElementById('lightbox-close');
  const lightboxDownload = document.getElementById('lightbox-download');

  const newChatBtn = document.getElementById('new-chat-btn');
  const newChatOverlay = document.getElementById('newchat-overlay');
  const newChatClose = document.getElementById('newchat-close');
  const newChatInput = document.getElementById('newchat-input');
  const newChatResults = document.getElementById('newchat-results');

  const msgMenu = document.getElementById('msg-menu');
  const msgMenuBackdrop = document.getElementById('msg-menu-backdrop');
  const menuCopy = document.getElementById('menu-copy');
  const menuDeleteMe = document.getElementById('menu-delete-me');
  const menuDeleteEveryone = document.getElementById('menu-delete-everyone');

  meName.textContent = me.name;
  let activeConv = null; // { convId, user }
  let pendingFiles = []; // File[] queued to send (any type)
  let currentDownload = null; // { url, filename } for lightbox

  const MAX_FILE_BYTES = 50 * 1024 * 1024; // matches the storage bucket limit

  // ---------- helpers ----------
  function initials(name) {
    return name.trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  }

  function timeLabel(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  function formatBytes(bytes) {
    if (!bytes) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0, n = bytes;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function fileIconFor(type) {
    if (!type) return '📄';
    if (type.startsWith('video/')) return '🎬';
    if (type.startsWith('audio/')) return '🎵';
    if (type.includes('pdf')) return '📕';
    if (type.includes('zip') || type.includes('compressed')) return '🗜️';
    if (type.includes('word') || type.includes('document')) return '📝';
    if (type.includes('sheet') || type.includes('excel')) return '📊';
    if (type.includes('presentation') || type.includes('powerpoint')) return '📽️';
    return '📄';
  }

  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
  }

  function downloadUrl(url, filename) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // ---------- sidebar: conversations ----------
  async function renderConvList() {
    const filter = searchInput.value.trim().toLowerCase();
    let convs;
    try {
      convs = await EmberDB.conversationsFor(me.id);
    } catch (e) {
      console.error(e);
      return;
    }
    convs = convs.filter((c) => c.user.name.toLowerCase().includes(filter) || c.user.username.includes(filter));

    convList.innerHTML = '';

    if (!convs.length) {
      const emptyMsg = document.createElement('div');
      emptyMsg.className = 'conv-empty';
      emptyMsg.textContent = filter
        ? `No chats match "${filter}". Tap "New chat" above to find someone by username instead.`
        : 'No chats yet. Tap "New chat" above and search for a username to get started.';
      convList.appendChild(emptyMsg);
      return;
    }

    convs.forEach((c) => {
      const item = document.createElement('div');
      item.className = 'conv-item' + (activeConv?.convId === c.convId ? ' active' : '');
      let previewText = 'Say hello 👋';
      if (c.lastMessage) {
        if (c.lastMessage.hasImage) previewText = '📷 Photo' + (c.lastMessage.text ? ` · ${c.lastMessage.text}` : '');
        else if (c.lastMessage.hasFile) previewText = `📎 ${c.lastMessage.imageName || 'File'}`;
        else previewText = c.lastMessage.text;
      }

      item.innerHTML = `
        <div class="avatar sm">${initials(c.user.name)}</div>
        <div class="conv-meta">
          <div class="conv-name-row">
            <span class="conv-name">${escapeHtml(c.user.name)}</span>
            <span class="conv-time">${timeLabel(c.lastMessage?.createdAt)}</span>
          </div>
          <div class="conv-preview">${escapeHtml(previewText)}</div>
        </div>
        ${c.unread ? `<span class="unread-badge">${c.unread}</span>` : ''}
      `;      item.addEventListener('click', () => openConversation(c.user));
      convList.appendChild(item);
    });
  }

  // ---------- conversation view ----------
  async function openConversation(user) {
    activeConv = { convId: EmberDB.convIdFor(me.id, user.id), user };
    chatEmpty.style.display = 'none';
    chatActive.style.display = 'flex';
    chatAvatar.textContent = initials(user.name);
    chatHeaderName.textContent = user.name;
    chatHeaderStatus.textContent = user.username ? '@' + user.username : '';

    sidebar.classList.add('hide');
    chatPanel.classList.add('show');

    await renderMessages();
    await renderConvList();
  }

  function closeConversationMobile() {
    sidebar.classList.remove('hide');
    chatPanel.classList.remove('show');
  }
  backBtn.addEventListener('click', closeConversationMobile);

  // Swipe right from anywhere in the chat to go back — matches the
  // native edge-swipe-back gesture found in most iOS/Android apps.
  (function enableSwipeBack() {
    let startX = 0, startY = 0, tracking = false;
    const THRESHOLD = 90;

    chatPanel.addEventListener('touchstart', (e) => {
      if (window.innerWidth > 780) return; // desktop: no swipe-back
      const t = e.touches[0];
      startX = t.clientX;
      startY = t.clientY;
      tracking = true;
    }, { passive: true });

    chatPanel.addEventListener('touchmove', (e) => {
      if (!tracking) return;
      const t = e.touches[0];
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      if (dx > 40 && Math.abs(dy) < 60) {
        chatPanel.style.transform = `translateX(${Math.min(dx, window.innerWidth)}px)`;
        chatPanel.style.transition = 'none';
      }
    }, { passive: true });

    chatPanel.addEventListener('touchend', (e) => {
      if (!tracking) return;
      tracking = false;
      const t = e.changedTouches[0];
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      chatPanel.style.transition = '';
      chatPanel.style.transform = '';
      if (dx > THRESHOLD && Math.abs(dy) < 60) {
        closeConversationMobile();
      }
    });
  })();

  async function renderMessages() {
    if (!activeConv) return;
    let msgs;
    try {
      msgs = await EmberDB.getMessages(activeConv.convId);
    } catch (e) {
      console.error(e);
      return;
    }
    messagesEl.innerHTML = '';

    let lastDay = null;
    let lastSender = null;

    for (const m of msgs) {
      const day = new Date(m.createdAt).toDateString();
      if (day !== lastDay) {
        const divider = document.createElement('div');
        divider.className = 'day-divider';
        divider.textContent = new Date(m.createdAt).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
        messagesEl.appendChild(divider);
        lastDay = day;
        lastSender = null;
      }

      const mine = m.senderId === me.id;
      const row = document.createElement('div');
      row.className = 'msg-row ' + (mine ? 'mine' : 'theirs') + (lastSender !== m.senderId ? ' group-start' : '');
      lastSender = m.senderId;

      if (m.hasImage) {
        buildImageBubble(row, m, mine);
      } else if (m.hasFile) {
        buildFileBubble(row, m, mine);
      } else {
        const bubble = document.createElement('div');
        bubble.className = 'bubble';
        bubble.textContent = m.text;
        row.appendChild(bubble);
      }

      messagesEl.appendChild(row);
      wireLongPress(row, m);

      const timeRow = document.createElement('div');
      timeRow.className = 'time-row ' + (mine ? 'mine' : '');
      timeRow.innerHTML = `<span class="msg-time">${new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>`;
      messagesEl.appendChild(timeRow);
    }

    messagesEl.scrollTop = messagesEl.scrollHeight;

    if (msgs.length) {
      EmberDB.markRead(activeConv.convId, me.id, msgs[msgs.length - 1].id);
    }
  }

  function buildImageBubble(row, m, mine) {
    const bubble = document.createElement('div');
    bubble.className = 'bubble img-bubble';
    const img = document.createElement('img');
    img.alt = m.imageName || 'photo';
    bubble.appendChild(img);

    EmberDB.getImageUrl(m.filePath).then((url) => {
      if (url) img.src = url;
      img.addEventListener('click', () => openLightbox(url, m.imageName || 'ember-photo.jpg'));
    });

    if (m.text) {
      const cap = document.createElement('div');
      cap.style.padding = '8px 8px 2px';
      cap.style.fontSize = '13px';
      cap.style.color = mine ? '#1a1206' : 'var(--text)';
      cap.textContent = m.text;
      bubble.appendChild(cap);
    }

    const dl = document.createElement('div');
    dl.className = 'img-download';
    dl.innerHTML = `<span>Original quality</span><button type="button">⬇ Save</button>`;
    dl.querySelector('button').addEventListener('click', async (e) => {
      e.stopPropagation();
      const url = await EmberDB.getImageUrl(m.filePath);
      downloadUrl(url, m.imageName || 'ember-photo.jpg');
    });
    bubble.appendChild(dl);
    row.appendChild(bubble);
  }

  function buildFileBubble(row, m, mine) {
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.style.display = 'flex';
    bubble.style.flexDirection = 'column';
    bubble.style.gap = '6px';
    bubble.style.minWidth = '220px';

    const fileRow = document.createElement('div');
    fileRow.style.display = 'flex';
    fileRow.style.alignItems = 'center';
    fileRow.style.gap = '10px';

    const icon = document.createElement('div');
    icon.style.fontSize = '26px';
    icon.textContent = fileIconFor(m.fileType);

    const meta = document.createElement('div');
    meta.style.minWidth = '0';
    meta.style.flex = '1';
    const nameEl = document.createElement('div');
    nameEl.style.fontWeight = '600';
    nameEl.style.fontSize = '13.5px';
    nameEl.style.whiteSpace = 'nowrap';
    nameEl.style.overflow = 'hidden';
    nameEl.style.textOverflow = 'ellipsis';
    nameEl.textContent = m.imageName || 'File';
    const sizeEl = document.createElement('div');
    sizeEl.style.fontSize = '11.5px';
    sizeEl.style.opacity = '0.75';
    sizeEl.textContent = formatBytes(m.fileSize);
    meta.appendChild(nameEl);
    meta.appendChild(sizeEl);

    const dlBtn = document.createElement('button');
    dlBtn.type = 'button';
    dlBtn.textContent = '⬇';
    dlBtn.title = 'Download';
    dlBtn.style.background = mine ? 'rgba(26,18,6,0.15)' : 'var(--bg)';
    dlBtn.style.border = '1px solid ' + (mine ? 'rgba(26,18,6,0.25)' : 'var(--border)');
    dlBtn.style.borderRadius = '50%';
    dlBtn.style.width = '32px';
    dlBtn.style.height = '32px';
    dlBtn.style.flexShrink = '0';
    dlBtn.style.color = 'inherit';
    dlBtn.addEventListener('click', async () => {
      const url = await EmberDB.getImageUrl(m.filePath);
      downloadUrl(url, m.imageName || 'file');
    });

    fileRow.appendChild(icon);
    fileRow.appendChild(meta);
    fileRow.appendChild(dlBtn);
    bubble.appendChild(fileRow);

    if (m.text) {
      const cap = document.createElement('div');
      cap.style.fontSize = '13px';
      cap.textContent = m.text;
      bubble.appendChild(cap);
    }

    row.appendChild(bubble);
  }

  // ---------- new chat (username search) ----------
  let searchDebounce = null;

  function openNewChat() {
    newChatOverlay.classList.add('show');
    newChatInput.value = '';
    newChatResults.innerHTML = '';
    setTimeout(() => newChatInput.focus(), 50);
  }
  function closeNewChat() {
    newChatOverlay.classList.remove('show');
  }
  newChatBtn.addEventListener('click', openNewChat);
  newChatClose.addEventListener('click', closeNewChat);
  newChatOverlay.addEventListener('click', (e) => { if (e.target === newChatOverlay) closeNewChat(); });

  newChatInput.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    const q = newChatInput.value.trim();
    if (!q) { newChatResults.innerHTML = ''; return; }
    searchDebounce = setTimeout(async () => {
      let results;
      try {
        results = await EmberDB.searchUsersByUsername(q);
      } catch (e) {
        console.error(e);
        return;
      }
      newChatResults.innerHTML = '';
      if (!results.length) {
        const empty = document.createElement('div');
        empty.className = 'newchat-empty';
        empty.textContent = `No one found with a username matching "${q}".`;
        newChatResults.appendChild(empty);
        return;
      }
      results.forEach((u) => {
        const row = document.createElement('div');
        row.className = 'newchat-result';
        row.innerHTML = `
          <div class="avatar sm">${initials(u.name)}</div>
          <div class="nc-meta">
            <div class="nc-name">${escapeHtml(u.name)}</div>
            <div class="nc-username">@${escapeHtml(u.username)}</div>
          </div>
        `;
        row.addEventListener('click', () => {
          closeNewChat();
          openConversation(u);
        });
        newChatResults.appendChild(row);
      });
    }, 300);
  });

  // ---------- message action menu (press-and-hold to delete/copy) ----------
  let menuTargetMsg = null;
  let pressTimer = null;

  function openMsgMenu(msg, x, y) {
    menuTargetMsg = msg;
    menuCopy.style.display = msg.text ? 'block' : 'none';
    msgMenu.classList.add('show');
    msgMenuBackdrop.classList.add('show');

    // keep menu on-screen
    const menuWidth = 200, menuHeight = 140;
    const left = Math.min(x, window.innerWidth - menuWidth - 12);
    const top = Math.min(y, window.innerHeight - menuHeight - 12);
    msgMenu.style.left = Math.max(12, left) + 'px';
    msgMenu.style.top = Math.max(12, top) + 'px';
  }

  function closeMsgMenu() {
    msgMenu.classList.remove('show');
    msgMenuBackdrop.classList.remove('show');
    menuTargetMsg = null;
  }
  msgMenuBackdrop.addEventListener('click', closeMsgMenu);

  menuCopy.addEventListener('click', () => {
    if (menuTargetMsg?.text) navigator.clipboard?.writeText(menuTargetMsg.text).catch(() => {});
    closeMsgMenu();
  });

  menuDeleteMe.addEventListener('click', async () => {
    const msg = menuTargetMsg;
    closeMsgMenu();
    if (!msg) return;
    try {
      await EmberDB.deleteMessageForMe(msg.id);
      await renderMessages();
      await renderConvList();
    } catch (e) {
      alert('Could not delete: ' + e.message);
    }
  });

  menuDeleteEveryone.addEventListener('click', async () => {
    const msg = menuTargetMsg;
    closeMsgMenu();
    if (!msg) return;
    if (!confirm('Delete this for both of you? This removes it permanently.')) return;
    try {
      await EmberDB.deleteMessageForEveryone(msg.id);
      await renderMessages();
      await renderConvList();
    } catch (e) {
      alert('Could not delete: ' + e.message);
    }
  });

  // Attaches press-and-hold (mobile) / press-and-hold (desktop mouse) to a bubble
  function wireLongPress(el, msg) {
    let startX = 0, startY = 0, fired = false;

    const start = (e) => {
      fired = false;
      const point = e.touches ? e.touches[0] : e;
      startX = point.clientX;
      startY = point.clientY;
      pressTimer = setTimeout(() => {
        fired = true;
        if (navigator.vibrate) navigator.vibrate(15);
        openMsgMenu(msg, startX, startY);
      }, 450);
    };
    const cancel = () => clearTimeout(pressTimer);
    const move = (e) => {
      const point = e.touches ? e.touches[0] : e;
      if (Math.abs(point.clientX - startX) > 10 || Math.abs(point.clientY - startY) > 10) cancel();
    };

    el.addEventListener('touchstart', start, { passive: true });
    el.addEventListener('touchend', cancel);
    el.addEventListener('touchmove', move, { passive: true });
    el.addEventListener('touchcancel', cancel);

    el.addEventListener('mousedown', start);
    el.addEventListener('mouseup', cancel);
    el.addEventListener('mouseleave', cancel);
    el.addEventListener('mousemove', move);

    // Right-click also opens the menu on desktop, for convenience
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openMsgMenu(msg, e.clientX, e.clientY);
    });
  }

  // ---------- lightbox ----------
  function openLightbox(url, filename) {
    if (!url) return;
    lightboxImg.src = url;
    currentDownload = { url, filename };
    lightbox.classList.add('show');
  }
  lightboxClose.addEventListener('click', () => lightbox.classList.remove('show'));
  lightbox.addEventListener('click', (e) => { if (e.target === lightbox) lightbox.classList.remove('show'); });
  lightboxDownload.addEventListener('click', () => {
    if (currentDownload) downloadUrl(currentDownload.url, currentDownload.filename);
  });

  // ---------- composer: text ----------
  function autoGrow() {
    textInput.style.height = 'auto';
    textInput.style.height = Math.min(textInput.scrollHeight, 120) + 'px';
  }
  textInput.addEventListener('input', () => { autoGrow(); updateSendState(); });
  textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      doSend();
    }
  });

  function updateSendState() {
    sendBtn.disabled = !textInput.value.trim() && pendingFiles.length === 0;
  }

  // ---------- composer: attachments (any file type) ----------
  attachBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const files = Array.from(fileInput.files || []);
    const tooBig = files.filter((f) => f.size > MAX_FILE_BYTES);
    const ok = files.filter((f) => f.size <= MAX_FILE_BYTES);
    if (tooBig.length) {
      alert(`${tooBig.map((f) => f.name).join(', ')} is over the 50MB limit and won't be sent.`);
    }
    pendingFiles.push(...ok);
    renderPreviewStrip();
    fileInput.value = '';
    updateSendState();
  });

  function renderPreviewStrip() {
    previewStrip.innerHTML = '';
    previewStrip.classList.toggle('show', pendingFiles.length > 0);
    pendingFiles.forEach((file, idx) => {
      const chip = document.createElement('div');
      chip.className = 'img-preview-chip';
      if (file.type.startsWith('image/')) {
        const img = document.createElement('img');
        img.src = URL.createObjectURL(file);
        chip.appendChild(img);
      } else {
        chip.style.display = 'flex';
        chip.style.alignItems = 'center';
        chip.style.justifyContent = 'center';
        chip.style.flexDirection = 'column';
        chip.style.background = 'var(--bg-elevated-2)';
        chip.style.fontSize = '22px';
        chip.innerHTML = `<div>${fileIconFor(file.type)}</div>`;
        const label = document.createElement('div');
        label.style.fontSize = '8px';
        label.style.padding = '0 4px';
        label.style.color = 'var(--text-muted)';
        label.style.textAlign = 'center';
        label.style.overflow = 'hidden';
        label.style.textOverflow = 'ellipsis';
        label.style.whiteSpace = 'nowrap';
        label.style.width = '100%';
        label.textContent = file.name;
        chip.appendChild(label);
      }
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.textContent = '×';
      rm.addEventListener('click', () => {
        pendingFiles.splice(idx, 1);
        renderPreviewStrip();
        updateSendState();
      });
      chip.appendChild(rm);
      previewStrip.appendChild(chip);
    });
  }

  // ---------- send ----------
  sendBtn.addEventListener('click', doSend);

  async function doSend() {
    if (!activeConv) return;
    const text = textInput.value.trim();
    if (!text && pendingFiles.length === 0) return;

    sendBtn.disabled = true;
    const filesToSend = pendingFiles;
    textInput.value = '';
    autoGrow();
    pendingFiles = [];
    renderPreviewStrip();

    try {
      if (filesToSend.length === 0) {
        await EmberDB.sendMessage({ convId: activeConv.convId, senderId: me.id, text });
      } else {
        for (let i = 0; i < filesToSend.length; i++) {
          await EmberDB.sendMessage({
            convId: activeConv.convId,
            senderId: me.id,
            text: i === 0 ? text : '',
            imageFile: filesToSend[i],
          });
        }
      }
    } catch (e) {
      alert('Failed to send: ' + e.message);
    }

    updateSendState();
    await renderMessages();
    await renderConvList();
  }

  // ---------- realtime ----------
  EmberDB.onEvent((evt) => {
    if (evt.type === 'message') {
      if (activeConv && evt.convId === activeConv.convId) renderMessages();
      renderConvList();
    }
    if (evt.type === 'message_deleted') {
      if (activeConv) renderMessages();
      renderConvList();
    }
    if (evt.type === 'read') {
      renderConvList();
    }
  });

  signoutBtn.addEventListener('click', async () => {
    await EmberDB.signOut();
    window.location.href = 'index.html';
  });

  searchInput.addEventListener('input', renderConvList);

  // ---------- init ----------
  renderConvList();
});
