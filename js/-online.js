// ONLINE backend: Supabase. Players start as anonymous "guest" accounts
// (no sign-up form), and can attach an email later to keep their walker.

const SUPABASE_CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

export async function createOnlineApi(url, key) {
  const { createClient } = await import(SUPABASE_CDN);
  const sb = createClient(url, key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

  let { data: { session } } = await sb.auth.getSession();
  if (!session) {
    const { data, error } = await sb.auth.signInAnonymously();
    if (error) throw new Error('Could not start a guest session: ' + error.message + ' (is "Allow anonymous sign-ins" turned on in Supabase?)');
    session = data.session;
  }
  let uid = session.user.id;

  // If you sign in as a different user (magic link in another tab), reload.
  sb.auth.onAuthStateChange((_event, s) => {
    if (s && s.user && s.user.id !== uid) location.reload();
  });

  async function rpc(fn, args) {
    const { data, error } = await sb.rpc(fn, args);
    if (error) throw new Error(error.message);
    return data;
  }

  let channel = null;
  let ready = false;
  let pending = null;

  return {
    mode: 'online',
    async init() { return rpc('start_session'); },

    async account() {
      const { data: { user } } = await sb.auth.getUser();
      return { mode: 'online', isAnonymous: !!user?.is_anonymous, email: user?.email || null, pendingEmail: user?.new_email || null };
    },

    reportProgress: (square) => rpc('report_progress', { p_square: square }),
    playRps: (choice) => rpc('play_rps', { p_choice: choice }),

    async getComments(square) {
      const { data, error } = await sb
        .from('comments')
        .select('id, square, user_id, author_name, body, created_at')
        .eq('square', square)
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) throw new Error(error.message);
      return data;
    },
    postComment: (square, body) => rpc('post_comment', { p_square: square, p_body: body }),
    deleteComment: (id) => rpc('delete_comment', { p_id: id }),
    async commentCounts(from, to) {
      const rows = await rpc('comment_counts', { p_from: from, p_to: to });
      const out = {};
      for (const r of rows || []) out[r.square] = r.n;
      return out;
    },

    async shopItems() {
      const { data, error } = await sb.from('shop_items').select('id, name, slot, price').order('sort');
      if (error) throw new Error(error.message);
      return data;
    },
    buy: (itemId) => rpc('buy_item', { p_item: itemId }),
    equip: (slot, itemId) => rpc('equip_item', { p_slot: slot, p_item: itemId || null }),
    setName: (name) => rpc('set_display_name', { p_name: name }),

    // Realtime presence: everyone online shares one channel for now.
    // (When you have lots of players, split it into zones, e.g. one
    // channel per 500 squares, and join your zone + the neighbours.)
    joinPresence(onChange) {
      channel = sb.channel('world', { config: { presence: { key: uid } } });
      channel.on('presence', { event: 'sync' }, () => {
        const st = channel.presenceState();
        const others = [];
        for (const [id, metas] of Object.entries(st)) {
          if (id === uid || !metas.length) continue;
          const m = metas[metas.length - 1];
          others.push({ id, name: String(m.name || 'walker').slice(0, 20), square: m.square | 0, equipped: m.equipped || {} });
        }
        onChange(others);
      });
      channel.subscribe((status) => {
        if (status === 'SUBSCRIBED') { ready = true; if (pending) channel.track(pending); }
      });
    },
    updatePresence(payload) {
      pending = payload;
      if (ready && channel) channel.track(payload);
    },

    // Guest → permanent: keeps the same user id, so all progress stays.
    async linkEmail(email) {
      const { error } = await sb.auth.updateUser({ email }, { emailRedirectTo: location.origin });
      if (error) throw new Error(error.message);
    },
    // Sign in to an existing account on this device (magic link)
    async signIn(email) {
      const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: location.origin } });
      if (error) throw new Error(error.message);
    },
    async signOut() {
      await sb.auth.signOut();
      location.reload();
    },
  };
}
