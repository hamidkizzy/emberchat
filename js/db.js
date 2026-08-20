/*
  Ember — Supabase-backed data layer
  --------------------------------------------------------
  Talks to the live Supabase project (see supabase-config.js).
  Auth, messages, read receipts and realtime all live in Postgres;
  files/images are stored in the private "chat-files" storage bucket
  at full original quality (no compression, no resizing).
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
  async function signUp({ name, email, password }) {
    email = email.trim().toLowerCase();
    if (!name.trim()) throw new Error('Please enter your name.');
    if (password.length < 6) throw new Error('Password must be at least 6 characters.');

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { name: name.trim() } },
    });
    if (error) throw new Error(error.message);

    if (!data.session) {
      const err = new Error('Account created! Check your email to confirm it, then sign in.');
      err.code = 'CONFIRM_EMAIL';
      throw err;
    }

    cachedUser = { id: data.user.id, name: name.trim(), email };
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
      .select('id, name, email')
      .eq('id', session.user.id)
      .single();

    if (error || !profile) { cachedUser = null; return null; }
    cachedUser = profile;
    ensureRealtime(profile.id);
    return profile;
  }

  async function listOtherUsers() {
    const me = await currentUser();
    if (!me) return [];
    const { data, error } = await supabase
      .from('profiles')
      .select('id, name, email')
      .neq('id', me.id)
      .order('name');
    if (error) throw new Error(error.message);
    return data;
  }

  // ================= REALTIME =================
  function ensureRealtime(myId) {
    if (realtimeChannel) return;
    realtimeChannel = supabase
      .channel('ember-messages')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `recipient_id=eq.${myId}` },
        (payload) => notify({ type: 'message', convId: payload.new.conv_id, message: mapRow(payload.new) }))
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `sender_id=eq.${myId}` },
        (payload) => notify({ type: 'message', convId: payload.new.conv_id, message: mapRow(payload.new) }))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'reads' },
        (payload) => notify({ type: 'read', convId: payload.new?.conv_id }))
      .subscribe();
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
      createdAt: new Date(row.created_at).getTime(),
    };
  }

  // ================= MESSAGES =================
  async function getMessages(convId) {
    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .eq('conv_id', convId)
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

  async function conversationsFor(userId) {
    const others = await listOtherUsers();
    const results = [];
    for (const other of others) {
      const convId = convIdFor(userId, other.id);
      const msgs = await getMessages(convId);
      const last = msgs[msgs.length - 1] || null;
      const unread = await unreadCount(convId, userId, msgs);
      results.push({ convId, user: other, lastMessage: last, unread });
    }
    results.sort((a, b) => (b.lastMessage?.createdAt || 0) - (a.lastMessage?.createdAt || 0));
    return results;
  }

  return {
    signUp, signIn, signOut, currentUser, listOtherUsers,
    convIdFor, getMessages, sendMessage, getImageUrl,
    markRead, unreadCount, conversationsFor, onEvent,
  };
})();
