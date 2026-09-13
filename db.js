/*
  Ember — Supabase-backed data layer
  --------------------------------------------------------
  Talks to the live Supabase project (see supabase-config.js).
  Auth, messages, read receipts and realtime all live in Postgres;
  files/images are stored in the private "chat-files" storage bucket
  at full original quality (no compression, no resizing).

  Privacy model: your conversation list is built ONLY from messages
  you've actually exchanged — never from a directory of every signed-up
  user. To start a new chat you search for someone by exact username.
*/

const EmberDB = (() => {
  const supabase = window.supabase.createClient(EMBER_SUPABASE_URL, EMBER_SUPABASE_ANON_KEY);
  const BUCKET = 'chat-files';

  const listeners = new Set();
  function notify(event) { listeners.forEach((fn) => fn(event)); }
  function onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  let realtimeChannel = null;
  let cachedUser = null;

  function convIdFor(userA, userB) {
    return [userA, userB].sort().join('__');
  }

  function otherIdFromConv(convId, myId) {
    const [a, b] = convId.split('__');
    return a === myId ? b : a;
  }

  // ================= AUTH =================
  async function signUp({ name, username, email, password }) {
    email = email.trim().toLowerCase();
    username = username.trim().toLowerCase();

    if (!name.trim()) throw new Error('Please enter your name.');
    if (!/^[a-z0-9_]{3,20}$/.test(username)) {
      throw new Error('Username must be 3-20 characters: lowercase letters, numbers, and underscores only.');
    }
    if (password.length < 6) throw new Error('Password must be at least 6 characters.');

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { name: name.trim(), username } },
    });
    if (error) {
      if (/duplicate key|already registered|unique/i.test(error.message)) {
        throw new Error('That username or email is already taken.');
      }
      throw new Error(error.message);
    }

    if (!data.session) {
      const err = new Error('Account created! Check your email to confirm it, then sign in.');
      err.code = 'CONFIRM_EMAIL';
      throw err;
    }

    cachedUser = { id: data.user.id, name: name.trim(), email, username };
    return cachedUser;
  }

  async function signIn({ email, password }) {
    email = email.trim().toLowerCase();
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw new Error(error.message === 'Invalid login credentials' ? 'Incorrect email or password.' : error.message);
    return await currentUser(true);
  }

  async function signOut() {
    await supabase.auth.signOut();
    cachedUser = null;
    if (realtimeChannel) { supabase.removeChannel(realtimeChannel); realtimeChannel = null; }
  }

  async function currentUser(force = false) {
    if (cachedUser && !force) return cachedUser;
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { cachedUser = null; return null; }

    const { data: profile, error } = await supabase
      .from('profiles')
      .select('id, name, email, username')
      .eq('id', session.user.id)
      .single();

    if (error || !profile) { cachedUser = null; return null; }
    cachedUser = profile;
    ensureRealtime(profile.id);
    return profile;
  }

  // Find people by exact/partial username — this is the ONLY way to
  // discover other users; there is no "browse everyone" anywhere.
  async function searchUsersByUsername(query) {
    const me = await currentUser();
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const { data, error } = await supabase
      .from('profiles')
      .select('id, name, username')
      .ilike('username', `%${q}%`)
      .neq('id', me.id)
      .limit(15);
    if (error) throw new Error(error.message);
    return data;
  }

  // ================= REALTIME =================
  function ensureRealtime(myId) {
    if (realtimeChannel) return;
    realtimeChannel = supabase
      .channel('ember-messages')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'messages', filter: `recipient_id=eq.${myId}` },
        (payload) => handleMessageChange(payload))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'messages', filter: `sender_id=eq.${myId}` },
        (payload) => handleMessageChange(payload))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'reads' },
        (payload) => notify({ type: 'read', convId: payload.new?.conv_id || payload.old?.conv_id }))
      .subscribe();
  }

  function handleMessageChange(payload) {
    if (payload.eventType === 'DELETE') {
      notify({ type: 'message_deleted', convId: payload.old.conv_id, messageId: payload.old.id });
    } else {
      notify({ type: 'message', convId: payload.new.conv_id, message: mapRow(payload.new) });
    }
  }

  function mapRow(row) {
    return {
      id: row.id,
      convId: row.conv_id,
      senderId: row.sender_id,
      recipientId: row.recipient_id,
      text: row.text || '',
      hasImage: !!row.has_file && (row.file_type || '').startsWith('image/'),
      hasFile: !!row.has_file,
      filePath: row.file_path,
      imageName: row.file_name,
      fileType: row.file_type,
      fileSize: row.file_size,
      deletedFor: row.deleted_for || [],
      createdAt: new Date(row.created_at).getTime(),
    };
  }

  // ================= MESSAGES =================
  async function getMessages(convId) {
    const me = await currentUser();
    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .eq('conv_id', convId)
      .not('deleted_for', 'cs', `{${me.id}}`)
      .order('created_at', { ascending: true });
    if (error) throw new Error(error.message);
    return data.map(mapRow);
  }

  async function sendMessage({ convId, senderId, text, imageFile }) {
    const recipientId = otherIdFromConv(convId, senderId);
    const messageId = crypto.randomUUID();
    let filePath = null;

    if (imageFile) {
      const safeName = imageFile.name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
      filePath = `${convId}/${messageId}-${safeName}`;
      const { error: upErr } = await supabase.storage
        .from(BUCKET)
        .upload(filePath, imageFile, { contentType: imageFile.type || 'application/octet-stream', upsert: false });
      if (upErr) throw new Error('File upload failed: ' + upErr.message);
    }

    const { data, error } = await supabase
      .from('messages')
      .insert({
        id: messageId,
        conv_id: convId,
        sender_id: senderId,
        recipient_id: recipientId,
        text: text ? text.trim() : '',
        has_file: !!imageFile,
        file_path: filePath,
        file_name: imageFile ? imageFile.name : null,
        file_type: imageFile ? imageFile.type : null,
        file_size: imageFile ? imageFile.size : null,
      })
      .select()
      .single();

    if (error) throw new Error(error.message);
    const msg = mapRow(data);
    notify({ type: 'message', convId, message: msg }); // instant local echo; realtime will also confirm
    return msg;
  }

  // Delete for me only. Once BOTH participants have deleted it, the row
  // (and its file) is fully removed server-side to free up storage space.
  async function deleteMessageForMe(messageId) {
    const { data, error } = await supabase.rpc('delete_message_for_me', { p_message_id: messageId });
    if (error) throw new Error(error.message);
    const row = Array.isArray(data) ? data[0] : data;
    if (row?.file_path && row?.fully_deleted) {
      await supabase.storage.from(BUCKET).remove([row.file_path]);
    }
    notify({ type: 'message_deleted', messageId });
    return row;
  }

  // Delete for everyone — removes the row and its file immediately.
  async function deleteMessageForEveryone(messageId) {
    const { data, error } = await supabase.rpc('delete_message_for_everyone', { p_message_id: messageId });
    if (error) throw new Error(error.message);
    const row = Array.isArray(data) ? data[0] : data;
    if (row?.file_path) {
      await supabase.storage.from(BUCKET).remove([row.file_path]);
    }
    notify({ type: 'message_deleted', messageId });
    return row;
  }

  async function getImageUrl(filePath) {
    if (!filePath) return null;
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(filePath, 60 * 60);
    if (error) return null;
    return data.signedUrl;
  }

  function markRead(convId, userId, lastMsgId) {
    supabase.from('reads').upsert({
      conv_id: convId,
      user_id: userId,
      last_read_message_id: lastMsgId,
      updated_at: new Date().toISOString(),
    }).then(() => notify({ type: 'read', convId, userId, lastMsgId }));
  }

  async function unreadCount(convId, userId, msgsCache) {
    const msgs = msgsCache || await getMessages(convId);
    if (!msgs.length) return 0;
    const { data: readRow } = await supabase
      .from('reads')
      .select('last_read_message_id')
      .eq('conv_id', convId)
      .eq('user_id', userId)
      .maybeSingle();

    const lastRead = readRow?.last_read_message_id;
    if (!lastRead) return msgs.filter((m) => m.senderId !== userId).length;
    const idx = msgs.findIndex((m) => m.id === lastRead);
    return msgs.slice(idx + 1).filter((m) => m.senderId !== userId).length;
  }

  // Built ONLY from messages you've actually exchanged — this is what
  // keeps your chat list private instead of showing every signed-up user.
  async function conversationsFor(userId) {
    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .or(`sender_id.eq.${userId},recipient_id.eq.${userId}`)
      .not('deleted_for', 'cs', `{${userId}}`)
      .order('created_at', { ascending: true });
    if (error) throw new Error(error.message);

    const byConv = new Map(); // convId -> { otherId, messages: [] }
    for (const row of data) {
      const msg = mapRow(row);
      const otherId = otherIdFromConv(msg.convId, userId);
      if (!byConv.has(msg.convId)) byConv.set(msg.convId, { otherId, messages: [] });
      byConv.get(msg.convId).messages.push(msg);
    }

    if (!byConv.size) return [];

    const otherIds = [...byConv.values()].map((v) => v.otherId);
    const { data: profiles, error: profErr } = await supabase
      .from('profiles')
      .select('id, name, username')
      .in('id', otherIds);
    if (profErr) throw new Error(profErr.message);
    const profileMap = new Map(profiles.map((p) => [p.id, p]));

    const { data: readRows } = await supabase
      .from('reads')
      .select('conv_id, last_read_message_id')
      .eq('user_id', userId)
      .in('conv_id', [...byConv.keys()]);
    const readMap = new Map((readRows || []).map((r) => [r.conv_id, r.last_read_message_id]));

    const results = [];
    for (const [convId, { otherId, messages }] of byConv) {
      const user = profileMap.get(otherId);
      if (!user) continue; // shouldn't happen, but skip gracefully
      const last = messages[messages.length - 1];
      const lastRead = readMap.get(convId);
      let unread;
      if (!lastRead) {
        unread = messages.filter((m) => m.senderId !== userId).length;
      } else {
        const idx = messages.findIndex((m) => m.id === lastRead);
        unread = messages.slice(idx + 1).filter((m) => m.senderId !== userId).length;
      }
      results.push({ convId, user, lastMessage: last, unread });
    }

    results.sort((a, b) => (b.lastMessage?.createdAt || 0) - (a.lastMessage?.createdAt || 0));
    return results;
  }

  // Look up a single profile by id — used to open a brand-new chat
  // (found via search) before any message has been sent yet.
  async function getProfile(userId) {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, name, username')
      .eq('id', userId)
      .single();
    if (error) return null;
    return data;
  }

  return {
    signUp, signIn, signOut, currentUser, searchUsersByUsername, getProfile,
    convIdFor, getMessages, sendMessage, getImageUrl,
    deleteMessageForMe, deleteMessageForEveryone,
    markRead, unreadCount, conversationsFor, onEvent,
  };
})();
