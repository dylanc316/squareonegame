-- =====================================================================
--  Square One — database schema
--  Paste this whole file into Supabase → SQL Editor → New query → Run.
--  It is safe to run again later (it updates things in place).
--
--  Design: the browser is never trusted. Every change to coins, position,
--  checkpoints, comments and purchases goes through the functions below,
--  which check the rules on the server. Players can READ some tables
--  directly, but cannot write to any table directly.
-- =====================================================================

-- ---------------------------------------------------------------------
--  Rules you may want to tweak
-- ---------------------------------------------------------------------
--  Checkpoints: square 100 * n^2  →  100, 400, 900, 1600, 2500, ...
--  (gaps grow: 300, 500, 700, 900 ...). Must match js/constants.js.
create or replace function public.is_checkpoint(s int)
returns boolean language sql immutable set search_path = '' as $$
  select s >= 100
     and (round(sqrt(s / 100.0)))::bigint * (round(sqrt(s / 100.0)))::bigint * 100 = s;
$$;

-- ---------------------------------------------------------------------
--  Tables
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id              uuid primary key references auth.users(id) on delete cascade,
  display_name    text not null,
  saved_square    int  not null default 1,   -- last checkpoint beaten (1 = start)
  current_square  int  not null default 1,   -- where they are this session
  max_square      int  not null default 1,   -- furthest ever reached (coins are paid past this)
  coins           int  not null default 0,
  last_move_at    timestamptz not null default now(),
  last_comment_at timestamptz,
  equipped_head   text,
  equipped_face   text,
  equipped_neck   text,
  is_admin        boolean not null default false,
  created_at      timestamptz not null default now()
);

create table if not exists public.shop_items (
  id    text primary key,
  name  text not null,
  slot  text not null check (slot in ('head', 'face', 'neck')),
  price int  not null check (price > 0),
  sort  int  not null default 0
);

insert into public.shop_items (id, name, slot, price, sort) values
  ('sunglasses', 'Cool Sunglasses', 'face', 1000, 1),
  ('scarf',      'Cozy Scarf',      'neck', 2000, 2),
  ('fun_hat',    'Fun Hat',         'head', 3000, 3)
on conflict (id) do update
  set name = excluded.name, slot = excluded.slot, price = excluded.price, sort = excluded.sort;

create table if not exists public.owned_items (
  user_id     uuid not null references public.profiles(id) on delete cascade,
  item_id     text not null references public.shop_items(id),
  acquired_at timestamptz not null default now(),
  primary key (user_id, item_id)
);

create table if not exists public.comments (
  id          bigint generated always as identity primary key,
  square      int  not null check (square >= 1),
  user_id     uuid references public.profiles(id) on delete set null,
  author_name text not null,
  body        text not null check (char_length(body) between 1 and 200),
  created_at  timestamptz not null default now()
);
create index if not exists comments_square_idx on public.comments (square, created_at desc);
-- one comment per player per square, so nobody can fill a square alone
create unique index if not exists comments_one_per_user_per_square on public.comments (square, user_id);

-- ---------------------------------------------------------------------
--  Row level security: reads only. All writes go through functions.
-- ---------------------------------------------------------------------
alter table public.profiles    enable row level security;
alter table public.shop_items  enable row level security;
alter table public.owned_items enable row level security;
alter table public.comments    enable row level security;

drop policy if exists "read own profile"     on public.profiles;
drop policy if exists "read shop"            on public.shop_items;
drop policy if exists "read own items"       on public.owned_items;
drop policy if exists "anyone reads comments" on public.comments;

create policy "read own profile"      on public.profiles    for select to authenticated using (id = auth.uid());
create policy "read shop"             on public.shop_items  for select to anon, authenticated using (true);
create policy "read own items"        on public.owned_items for select to authenticated using (user_id = auth.uid());
create policy "anyone reads comments" on public.comments    for select to anon, authenticated using (true);

-- ---------------------------------------------------------------------
--  New user → profile (works for guest/anonymous users too)
-- ---------------------------------------------------------------------
create or replace function public._random_name()
returns text language sql volatile set search_path = '' as $$
  select (array['walker','wanderer','stroller','rambler','hiker','drifter','roamer','trekker'])
         [1 + floor(random() * 8)::int] || lpad(floor(random() * 10000)::int::text, 4, '0');
$$;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, public._random_name())
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------
--  Internal: the player's full state as JSON
-- ---------------------------------------------------------------------
create or replace function public._state(uid uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', p.id,
    'display_name', p.display_name,
    'saved_square', p.saved_square,
    'current_square', p.current_square,
    'max_square', p.max_square,
    'coins', p.coins,
    'equipped_head', p.equipped_head,
    'equipped_face', p.equipped_face,
    'equipped_neck', p.equipped_neck,
    'is_admin', p.is_admin,
    'owned', coalesce((select jsonb_agg(o.item_id) from public.owned_items o where o.user_id = p.id), '[]'::jsonb)
  )
  from public.profiles p where p.id = uid;
$$;

-- ---------------------------------------------------------------------
--  Session start: you always resume at your last saved checkpoint
-- ---------------------------------------------------------------------
create or replace function public.start_session()
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  insert into public.profiles (id, display_name)
  values (auth.uid(), public._random_name())
  on conflict (id) do nothing;
  update public.profiles
     set current_square = saved_square, last_move_at = clock_timestamp()
   where id = auth.uid();
  return public._state(auth.uid());
end $$;

-- ---------------------------------------------------------------------
--  Walking. The client reports its square a couple of times a second.
--  The server caps speed (12 squares/sec) so nobody can teleport,
--  and pays 1 coin for every square past your all-time furthest.
-- ---------------------------------------------------------------------
create or replace function public.report_progress(p_square int)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  p       public.profiles;
  elapsed double precision;
  allowed int;
  target  int;
  gained  int := 0;
begin
  select * into p from public.profiles where id = auth.uid() for update;
  if not found then raise exception 'Not signed in'; end if;

  elapsed := extract(epoch from clock_timestamp() - p.last_move_at);
  allowed := ceil(least(elapsed, 3) * 12)::int + 3;
  target  := greatest(1, coalesce(p_square, p.current_square));
  target  := least(greatest(target, p.current_square - allowed), p.current_square + allowed);

  if target > p.max_square then gained := target - p.max_square; end if;

  update public.profiles
     set current_square = target,
         max_square     = greatest(max_square, target),
         coins          = coins + gained,
         last_move_at   = clock_timestamp()
   where id = p.id;

  return jsonb_build_object(
    'square', target,
    'coins', p.coins + gained,
    'max_square', greatest(p.max_square, target)
  );
end $$;

-- ---------------------------------------------------------------------
--  Checkpoint task: best-of-one rock paper scissors vs a random robot.
--  The robot's move is picked here on the server, so it can't be rigged.
--  Ties don't count (play again). Losing just means try again.
-- ---------------------------------------------------------------------
create or replace function public.play_rps(p_choice text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  p       public.profiles;
  bot     text;
  outcome text;
begin
  if p_choice not in ('rock', 'paper', 'scissors') then raise exception 'Pick rock, paper or scissors'; end if;
  select * into p from public.profiles where id = auth.uid() for update;
  if not found then raise exception 'Not signed in'; end if;
  if not public.is_checkpoint(p.current_square) then raise exception 'You are not standing on a checkpoint'; end if;
  if p.current_square <= p.saved_square then raise exception 'You already saved here'; end if;

  bot := (array['rock', 'paper', 'scissors'])[1 + floor(random() * 3)::int];
  outcome := case
    when bot = p_choice then 'tie'
    when (p_choice = 'rock'     and bot = 'scissors')
      or (p_choice = 'paper'    and bot = 'rock')
      or (p_choice = 'scissors' and bot = 'paper') then 'win'
    else 'lose' end;

  if outcome = 'win' then
    update public.profiles set saved_square = p.current_square where id = p.id;
  end if;

  return jsonb_build_object(
    'bot', bot,
    'outcome', outcome,
    'saved_square', case when outcome = 'win' then p.current_square else p.saved_square end
  );
end $$;

-- ---------------------------------------------------------------------
--  Comments: 200 chars, 100 per square, one per player per square,
--  must be standing on the square, 10 s cooldown. No self-delete.
-- ---------------------------------------------------------------------
create or replace function public.post_comment(p_square int, p_body text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  p public.profiles;
  b text := btrim(coalesce(p_body, ''));
  n int;
  c public.comments;
begin
  if char_length(b) = 0   then raise exception 'Your comment is empty'; end if;
  if char_length(b) > 200 then raise exception 'Comments can be at most 200 characters'; end if;
  if p_square is null or p_square < 1 then raise exception 'Bad square'; end if;

  select * into p from public.profiles where id = auth.uid() for update;
  if not found then raise exception 'Not signed in'; end if;
  if abs(p.current_square - p_square) > 1 then
    raise exception 'You can only comment on the square you are standing on';
  end if;
  if p.last_comment_at is not null and clock_timestamp() - p.last_comment_at < interval '10 seconds' then
    raise exception 'Slow down! Wait a few seconds between comments';
  end if;

  -- lock this square so two people can't both take the 100th slot
  perform pg_advisory_xact_lock(hashtext('square-comments'), p_square);
  select count(*) into n from public.comments where square = p_square;
  if n >= 100 then raise exception 'This square is full (100/100 comments)'; end if;
  if exists (select 1 from public.comments where square = p_square and user_id = p.id) then
    raise exception 'You already left a comment on this square';
  end if;

  insert into public.comments (square, user_id, author_name, body)
  values (p_square, p.id, p.display_name, b)
  returning * into c;

  update public.profiles set last_comment_at = clock_timestamp() where id = p.id;
  return to_jsonb(c);
end $$;

-- Moderator only. Deleting a comment frees up its slot on the square.
create or replace function public.delete_comment(p_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and is_admin) then
    raise exception 'Only moderators can delete comments';
  end if;
  delete from public.comments where id = p_id;
end $$;

-- How many comments each square in a range has (for the little bubbles)
create or replace function public.comment_counts(p_from int, p_to int)
returns table (square int, n int) language sql stable set search_path = '' as $$
  select c.square, count(*)::int
    from public.comments c
   where c.square between p_from and least(p_to, p_from + 400)
   group by c.square;
$$;

-- ---------------------------------------------------------------------
--  Shop
-- ---------------------------------------------------------------------
create or replace function public.buy_item(p_item text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  p  public.profiles;
  it public.shop_items;
begin
  select * into it from public.shop_items where id = p_item;
  if not found then raise exception 'No such item'; end if;
  select * into p from public.profiles where id = auth.uid() for update;
  if not found then raise exception 'Not signed in'; end if;
  if exists (select 1 from public.owned_items where user_id = p.id and item_id = it.id) then
    raise exception 'You already own that';
  end if;
  if p.coins < it.price then raise exception 'Not enough coins'; end if;

  update public.profiles set coins = coins - it.price where id = p.id;
  insert into public.owned_items (user_id, item_id) values (p.id, it.id);
  perform public.equip_item(it.slot, it.id);
  return public._state(p.id);
end $$;

-- p_item = null takes the item in that slot off
create or replace function public.equip_item(p_slot text, p_item text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if p_slot not in ('head', 'face', 'neck') then raise exception 'Bad slot'; end if;
  if p_item is not null and not exists (
      select 1 from public.owned_items o join public.shop_items s on s.id = o.item_id
       where o.user_id = auth.uid() and o.item_id = p_item and s.slot = p_slot) then
    raise exception 'You do not own that item';
  end if;
  update public.profiles set
    equipped_head = case when p_slot = 'head' then p_item else equipped_head end,
    equipped_face = case when p_slot = 'face' then p_item else equipped_face end,
    equipped_neck = case when p_slot = 'neck' then p_item else equipped_neck end
  where id = auth.uid();
  return public._state(auth.uid());
end $$;

-- ---------------------------------------------------------------------
--  Display name (shown on comments and above your head)
-- ---------------------------------------------------------------------
create or replace function public.set_display_name(p_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare n text := btrim(coalesce(p_name, ''));
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if char_length(n) < 3 or char_length(n) > 20 then raise exception 'Names must be 3 to 20 characters'; end if;
  if n !~ '^[A-Za-z0-9 _.-]+$' then raise exception 'Names can use letters, numbers, spaces, _ . and -'; end if;
  update public.profiles set display_name = n where id = auth.uid();
  return public._state(auth.uid());
end $$;

-- ---------------------------------------------------------------------
--  Permissions: internal helpers are not callable from the browser;
--  game functions are callable by signed-in players only.
-- ---------------------------------------------------------------------
revoke execute on function public._state(uuid)      from public, anon, authenticated;
revoke execute on function public._random_name()    from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

revoke execute on function public.start_session()             from public, anon;
revoke execute on function public.report_progress(int)        from public, anon;
revoke execute on function public.play_rps(text)              from public, anon;
revoke execute on function public.post_comment(int, text)     from public, anon;
revoke execute on function public.delete_comment(bigint)      from public, anon;
revoke execute on function public.buy_item(text)              from public, anon;
revoke execute on function public.equip_item(text, text)      from public, anon;
revoke execute on function public.set_display_name(text)      from public, anon;

grant execute on function public.start_session()          to authenticated;
grant execute on function public.report_progress(int)     to authenticated;
grant execute on function public.play_rps(text)           to authenticated;
grant execute on function public.post_comment(int, text)  to authenticated;
grant execute on function public.delete_comment(bigint)   to authenticated;
grant execute on function public.buy_item(text)           to authenticated;
grant execute on function public.equip_item(text, text)   to authenticated;
grant execute on function public.set_display_name(text)   to authenticated;
grant execute on function public.comment_counts(int, int) to anon, authenticated;
grant execute on function public.is_checkpoint(int)       to anon, authenticated;

-- =====================================================================
--  Make yourself a moderator (run separately, AFTER you've attached
--  your email to your account in the game's Account menu):
--
--    update public.profiles set is_admin = true
--     where id = (select id from auth.users where email = 'you@example.com');
-- =====================================================================
