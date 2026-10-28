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
  let listeners = null;
  let lastTrackAt = -1e9;
  let trackTimer = null;
  let rejoinTimer = null;
  let rejoinDelay = 1000;
  const PRESENCE_MIN_MS = 3000;

  function flushPresence() {
    if (!ready || !channel || !pending || trackTimer) return;
    const wait = PRESENCE_MIN_MS - (performance.now() - lastTrackAt);
    if (wait > 0) { trackTimer = setTimeout(() => { trackTimer = null; flushPresence(); }, wait); return; }
    lastTrackAt = performance.now();
    channel.track(pending);
  }

  // (Re)join the shared channel. If Supabase ever closes it, or the
  // connection drops, try again with a growing delay (1 s, 2 s, 4 s … 30 s).
  function join() {
    clearTimeout(rejoinTimer);
    rejoinTimer = null;
    ready = false;
    const ch = sb.channel('world', { config: { presence: { key: uid }, broadcast: { self: false } } });
    channel = ch;
    ch.on('presence', { event: 'sync' }, () => {
      if (ch !== channel) return;
      const st = ch.presenceState();
      const others = [];
      for (const [id, metas] of Object.entries(st)) {
        if (id === uid || !metas.length) continue;
        const m = metas[metas.length - 1];
        others.push({ id, name: String(m.name || 'walker').slice(0, 20), square: Math.max(1, m.square | 0), equipped: m.equipped || {} });
      }
      listeners.onChange(others);
    });
    ch.on('broadcast', { event: 'pos' }, ({ payload }) => {
      if (ch !== channel || !payload || payload.id === uid) return;
      listeners.onMove({ id: String(payload.id), square: Math.max(1, payload.square | 0), dir: Math.sign(payload.dir | 0) });
    });
    ch.subscribe((status, err) => {
      if (ch !== channel) return;
      if (status === 'SUBSCRIBED') {
        ready = true;
        rejoinDelay = 1000;
        lastTrackAt = -1e9; // announce ourselves right away after (re)joining
        flushPresence();
        return;
      }
      // CHANNEL_ERROR, TIMED_OUT or CLOSED: we are invisible until we rejoin
      console.warn('Realtime channel', status, err ? err.message || err : '', '- rejoining in', rejoinDelay, 'ms');
      ready = false;
      if (rejoinTimer) return;
      rejoinTimer = setTimeout(async () => {
        rejoinTimer = null;
        if (channel === ch) channel = null; // so removing it doesn't trigger another rejoin
        try { await sb.removeChannel(ch); } catch {}
        join();
      }, rejoinDelay);
      rejoinDelay = Math.min(rejoinDelay * 2, 30000);
    });
  }

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

    async leaderboard() {
      const [rows, rank] = await Promise.all([rpc('leaderboard'), rpc('my_rank')]);
      return { rows: rows || [], myRank: rank };
    },

    async shopItems() {
      const { data, error } = await sb.from('shop_items').select('id, name, slot, price').order('sort');
      if (error) throw new Error(error.message);
      return data;
    },
    buy: (itemId) => rpc('buy_item', { p_item: itemId }),
    equip: (slot, itemId) => rpc('equip_item', { p_slot: slot, p_item: itemId || null }),
    setName: (name) => rpc('set_display_name', { p_name: name }),

    // Realtime: everyone online shares one channel for now.
    //  - presence  = who is online, their name, cosmetics and resting square
    //  - broadcast = fast movement updates while someone is walking
    // (When you have lots of players, split it into zones, e.g. one
    // channel per 500 squares, and join your zone + the neighbours.)
    joinPresence(onChange, onMove) {
      listeners = { onChange, onMove };
      join();
    },
    // Presence is rate-limited by Supabase per player. Going over makes
    // Supabase close our channel, and we vanish for everyone. So presence is
    // sent at most once every PRESENCE_MIN_MS (the latest value wins), and
    // walking itself goes over broadcast instead.
    updatePresence(payload) {
      pending = payload;
      flushPresence();
    },
    sendPosition({ square, dir }) {
      if (ready && channel) channel.send({ type: 'broadcast', event: 'pos', payload: { id: uid, square, dir } });
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
