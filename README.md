# Square One

Start at square one. Walk forever. Leave a note for whoever comes next.

A plain HTML/JavaScript site (no build step) with Supabase for accounts, saves, notes and live players. It runs in **demo mode** until you add your Supabase keys, so you can try it immediately.

---

## Try it on your computer (demo mode)

Any static file server works. From this folder:

```bash
npx serve .            # or: python3 -m http.server 8000
```

Open the address it prints. Demo mode saves to your browser only, the other walkers are bots, and you are a moderator so you can test removing notes.

---

## Go live: step by step

### 1. Supabase (database + accounts)

1. Go to [supabase.com](https://supabase.com), create a free account, then **New project**. Pick a region near most of your players and save the database password somewhere.
2. When it finishes, open **SQL Editor → New query**, paste the whole of `supabase/schema.sql`, and click **Run**. You should see "Success". (It's safe to run again whenever you change it.)
3. Turn on guest accounts: **Authentication → Sign In / Providers** (may be called "Providers" or "Settings") → enable **Allow anonymous sign-ins** → Save. This is what lets people start playing with zero sign-up.
4. Set where email links go: **Authentication → URL Configuration**
   - **Site URL:** `https://squareonegame.com`
   - **Redirect URLs:** add `https://squareonegame.com/**` and, for local testing, `http://localhost:3000/**` (or whatever port you use).
5. Get your keys: **Project Settings → API** (or **API Keys**). Copy the **Project URL** and the **publishable** key (older projects call it the **anon public** key).
6. Paste both into `config.js`:

   ```js
   export const SUPABASE_URL = 'https://abcdefgh.supabase.co';
   export const SUPABASE_KEY = 'sb_publishable_...';
   ```

   These two values are designed to be public, so committing them is fine. **Never** paste the `service_role` / secret key anywhere in this project.

### 2. GitHub

1. On github.com click **New repository**, name it `squareone`, keep it public or private, and create it.
2. Upload the files. Either drag this whole folder's contents onto the repo page ("uploading an existing file"), or from a terminal in this folder:

   ```bash
   git init
   git add .
   git commit -m "Square One prototype"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/squareone.git
   git push -u origin main
   ```

### 3. Vercel

1. In Vercel, **Add New… → Project**, and import the `squareone` repo.
2. **Framework Preset: Other.** Leave Build Command and Output Directory empty. Click **Deploy**.
3. **Project → Settings → Domains**, add `squareonegame.com` (and `www.squareonegame.com`). Since you bought the domain through Vercel, it connects automatically.

From now on, every push to `main` redeploys the site within a few seconds.

### 4. Make yourself the moderator

1. Open your live site. Click **You**, type your email under "Save my walker", and click the link in the email.
2. In Supabase **SQL Editor**, run (with your email):

   ```sql
   update public.profiles set is_admin = true
    where id = (select id from auth.users where email = 'you@example.com');
   ```

3. Reload the site. Every note now has a **Remove** button for you. Removing a note frees its slot on that square.

You can also browse and delete notes directly in Supabase: **Table Editor → comments**.

### 5. Before you invite lots of people

- **Email:** Supabase's built-in email sender is only meant for testing (it is heavily rate-limited). Before real players attach emails, connect a real sender under **Authentication → Emails → SMTP Settings**. [Resend](https://resend.com) has a free tier and a Supabase guide.
- **Bots:** Turn on CAPTCHA (**Authentication → Bot and Abuse Protection**, Cloudflare Turnstile is free) so scripts can't mass-create guest accounts and spam notes. This needs a small code change; ask and it can be added.
- **Cleanup:** Guest accounts that never come back pile up. Supabase docs describe a scheduled job to delete old anonymous users.

---

## How it works

| Thing | Rule | Where to change it |
|---|---|---|
| Walking | ← ↓ back, → ↑ forward, hold to walk. Can't go below square 1. | `js/main.js`, speed in `js/constants.js` |
| Orientation | ⇅ button switches left-right / up-down (remembered per browser) | `js/render.js` |
| Checkpoints | at 100 × n²: 100, 400, 900, 1,600, 2,500… | `isCheckpoint` in **both** `js/constants.js` and `schema.sql` |
| Saving | Only your last beaten checkpoint is saved. Reload = back to it. | `start_session` in `schema.sql` |
| Checkpoint task | Best-of-one rock paper scissors. Ties replay, losses retry. The robot picks on the server, so it can't be rigged. | `play_rps` in `schema.sql` |
| Coins | 1 per square past your all-time furthest (re-walking doesn't pay twice) | `report_progress` in `schema.sql` |
| Anti-cheat | Server caps speed at 12 squares/sec and checks you're on the square for notes and checkpoints | `report_progress` |
| Notes | 200 chars, 100 per square, one per player per square, 10 s cooldown, no self-delete | `post_comment` in `schema.sql` |
| Shop | Sunglasses 1,000 · Scarf 2,000 · Fun Hat 3,000 | `shop_items` insert in `schema.sql` (+ fallback in `constants.js`) |
| Art | Biome and art style can change every 150 squares; 6 biomes × 4 styles (Storybook, Pixel, Sketchbook, Neon) | `ZONE_SIZE`, `js/world.js`, `js/render.js` |
| Oddities | ~1 in 90 squares has a sign, bench, giant duck, statue, mailbox or arch | `ODDITIES` in `js/world.js` |
| Leaderboard | Top 100 by furthest checkpoint beaten; ties go to whoever got there first. Shows your own rank too. | `leaderboard` / `my_rank` in `schema.sql` |
| Nearby players | Supabase Realtime presence; walkers within 15 squares are drawn with name tags | `joinPresence` in `js/api-online.js` |
| World seed | Same world for everyone. Change `WORLD_SEED` to regenerate it. | `js/world.js` |

### Files

```
index.html            page layout (HUD, notes panel, dialogs)
style.css             all styling
config.js             your Supabase URL + publishable key
js/main.js            game loop, input, syncing, UI
js/render.js          canvas drawing: scenery, styles, avatars, cosmetics
js/world.js           procedural generation (biomes, styles, objects)
js/constants.js       shared rules
js/api-online.js      Supabase backend
js/api-demo.js        offline demo backend (same rules, bots)
supabase/schema.sql   tables, security rules and game functions
```

### Known limits of this prototype

- Presence uses one channel for the whole world. That's fine for hundreds of people online at once; past that, split it into zones (one channel per few hundred squares).
- Other players' cosmetics come from their own browser, so a cheater could show a hat they didn't buy (to others only). Fix later by reading equipped items from the database.
- No profanity filter yet; you moderate by hand.
