-- =====================================================================
-- Sinis Waves: struttura del database (Supabase / PostgreSQL)
-- Da incollare tutto insieme in: Supabase > SQL Editor > New query > Run
-- Si può rieseguire: crea solo quello che manca.
-- =====================================================================

-- ---------- Profili utente ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  display_name text,
  is_admin boolean not null default false,
  alert_threshold numeric not null default 3 check (alert_threshold between 1 and 5),
  telegram_chat_id text,
  created_at timestamptz not null default now()
);

-- un profilo nasce da solo quando un utente si registra
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name) values (new.id, split_part(new.email, '@', 1))
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- vero se l'utente collegato è amministratore
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false)
$$;

-- ---------- Spot ----------
-- visibility: 'public' = ufficiale, visibile a tutti (lo gestisce l'amministratore)
--             'private' = spot personale, lo vede solo chi l'ha creato
--             'proposed' = proposto alla community, in attesa di approvazione
create table if not exists public.spots (
  id text primary key,
  name text not null,
  area text,
  lat double precision not null, lon double precision not null,
  beach_lat double precision, beach_lon double precision,
  facing numeric not null, "window" numeric not null default 40, offshore numeric not null,
  min numeric not null default 0.8, max numeric not null default 3, min_period numeric not null default 7,
  gain numeric not null default 1,
  alert_default boolean not null default false,
  cams jsonb not null default '[]',
  owner uuid references auth.users on delete cascade default auth.uid(),
  visibility text not null default 'private' check (visibility in ('public','private','proposed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- Scelte personali per spot ----------
create table if not exists public.user_spots (
  user_id uuid not null references auth.users on delete cascade default auth.uid(),
  spot_id text not null references public.spots on delete cascade,
  favorite boolean not null default false,
  sort_order int,
  alert boolean not null default false,
  gain numeric,                       -- correzione personale dalla taratura (null = usa quella dello spot)
  primary key (user_id, spot_id)
);

-- ---------- Sessioni ----------
create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade default auth.uid(),
  spot_id text not null references public.spots on delete cascade,
  at timestamptz not null,
  wave_real_m numeric not null check (wave_real_m between 0 and 15),
  quality smallint not null check (quality between 1 and 5),
  wind_real text check (wind_real in ('assente','offshore','laterale','onshore')),
  crowd smallint check (crowd between 1 and 4),
  note text check (char_length(note) <= 500),
  app_score numeric, app_wave_m numeric, app_wind text,
  gain numeric not null default 1, buoy_fix numeric not null default 1,
  share_anonymous boolean not null default true,   -- entra nella taratura comune, senza nome
  created_at timestamptz not null default now()
);
create index if not exists sessions_spot_idx on public.sessions (spot_id, at);

-- ---------- Segnalazioni di affollamento ----------
create table if not exists public.crowd_reports (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users on delete cascade default auth.uid(),
  spot_id text not null references public.spots on delete cascade,
  level smallint not null check (level between 1 and 4),
  created_at timestamptz not null default now()
);
create index if not exists crowd_spot_idx on public.crowd_reports (spot_id, created_at);

-- al massimo una segnalazione ogni 30 minuti per utente e spot
create or replace function public.crowd_rate_limit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.crowd_reports where user_id = new.user_id and spot_id = new.spot_id
             and created_at > now() - interval '30 minutes') then
    raise exception 'Hai già segnalato questo spot da poco';
  end if;
  return new;
end $$;
drop trigger if exists crowd_rate on public.crowd_reports;
create trigger crowd_rate before insert on public.crowd_reports for each row execute function public.crowd_rate_limit();

-- ---------- Boe e previsioni salvate (scritte solo dalle automazioni GitHub) ----------
create table if not exists public.buoy_obs (
  buoy_id text not null, name text, lat double precision, lon double precision,
  time timestamptz not null,
  obs_hs numeric, obs_tp numeric, obs_dir numeric,
  mod_hs numeric, mod_tp numeric, mod_dir numeric,
  primary key (buoy_id, time)
);
create table if not exists public.forecast_snapshots (
  spot_id text not null references public.spots on delete cascade,
  issued_at timestamptz not null, valid_at timestamptz not null,
  hs numeric, tp numeric, dir numeric, ws numeric, wd numeric, face_m numeric, score numeric,
  primary key (spot_id, issued_at, valid_at)
);

-- =====================================================================
-- Regole di sicurezza (Row Level Security): ognuno vede e modifica solo il suo
-- =====================================================================
alter table public.profiles enable row level security;
alter table public.spots enable row level security;
alter table public.user_spots enable row level security;
alter table public.sessions enable row level security;
alter table public.crowd_reports enable row level security;
alter table public.buoy_obs enable row level security;
alter table public.forecast_snapshots enable row level security;

drop policy if exists "profilo: leggo il mio" on public.profiles;
create policy "profilo: leggo il mio" on public.profiles for select using (id = auth.uid() or public.is_admin());
drop policy if exists "profilo: modifico il mio" on public.profiles;
create policy "profilo: modifico il mio" on public.profiles for update using (id = auth.uid())
  with check (id = auth.uid() and is_admin = (select p.is_admin from public.profiles p where p.id = auth.uid()));

drop policy if exists "spot: pubblici e miei" on public.spots;
create policy "spot: pubblici e miei" on public.spots for select
  using (visibility = 'public' or owner = auth.uid() or public.is_admin());
drop policy if exists "spot: creo i miei" on public.spots;
create policy "spot: creo i miei" on public.spots for insert
  with check ((owner = auth.uid() and visibility in ('private','proposed')) or public.is_admin());
drop policy if exists "spot: modifico i miei non pubblici" on public.spots;
create policy "spot: modifico i miei non pubblici" on public.spots for update
  using ((owner = auth.uid() and visibility <> 'public') or public.is_admin())
  with check ((owner = auth.uid() and visibility in ('private','proposed')) or public.is_admin());
drop policy if exists "spot: cancello i miei non pubblici" on public.spots;
create policy "spot: cancello i miei non pubblici" on public.spots for delete
  using ((owner = auth.uid() and visibility <> 'public') or public.is_admin());

drop policy if exists "scelte: solo le mie" on public.user_spots;
create policy "scelte: solo le mie" on public.user_spots for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "sessioni: solo le mie" on public.sessions;
create policy "sessioni: solo le mie" on public.sessions for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "affollamento: segnalo" on public.crowd_reports;
create policy "affollamento: segnalo" on public.crowd_reports for insert with check (user_id = auth.uid());
drop policy if exists "affollamento: vedo le mie" on public.crowd_reports;
create policy "affollamento: vedo le mie" on public.crowd_reports for select using (user_id = auth.uid());

drop policy if exists "boe: lettura pubblica" on public.buoy_obs;
create policy "boe: lettura pubblica" on public.buoy_obs for select using (true);
drop policy if exists "previsioni: lettura pubblica" on public.forecast_snapshots;
create policy "previsioni: lettura pubblica" on public.forecast_snapshots for select using (true);

-- =====================================================================
-- Viste pubbliche anonime (nessun nome, solo numeri aggregati)
-- =====================================================================
-- affollamento delle ultime 3 ore
create or replace view public.crowd_now as
  select spot_id, round(avg(level)::numeric, 1) as level, count(*) as reports, max(created_at) as last_report
  from public.crowd_reports where created_at > now() - interval '3 hours'
  group by spot_id;

-- taratura comune: di quanto l'onda reale differisce dal modello, per spot (almeno 3 sessioni)
create or replace view public.spot_calibration as
  select spot_id, count(*) as sessions,
    round((percentile_cont(0.5) within group (order by wave_real_m / nullif(app_wave_m / nullif(gain,0) / nullif(buoy_fix,0), 0)))::numeric, 2) as wave_ratio,
    round(avg(quality - app_score)::numeric, 2) as score_bias
  from public.sessions
  where share_anonymous and app_wave_m > 0.15
  group by spot_id having count(*) >= 3;

grant select on public.crowd_now, public.spot_calibration to anon, authenticated;

-- =====================================================================
-- Spot ufficiali di partenza (da spots.json)
-- =====================================================================
insert into public.spots (id, name, area, lat, lon, beach_lat, beach_lon, facing, "window", offshore, min, max, min_period, gain, alert_default, owner, visibility)
select v.*, null::uuid, 'public' from (values
  ('su-pallosu', 'Su Pallosu', 'Sinis nord', 40.085, 8.405, 40.0635, 8.4195, 340, 35, 160, 1.2, 4.5, 8, 1, false),
  ('sa-mesa-longa', 'Sa Mesa Longa', 'Sinis nord', 40.0567, 8.3852, 40.0472, 8.3976, 315, 40, 135, 0.8, 3.5, 7, 1, true),
  ('capo-mannu', 'Capo Mannu', 'Capo Mannu', 40.035, 8.34, 40.0345, 8.379, 295, 50, 115, 0.8, 3.5, 7, 1, true),
  ('godzilla', 'Godzilla', 'Capo Mannu', 40.02, 8.36, 40.029, 8.385, 255, 40, 75, 1.0, 3.5, 7, 1, false),
  ('mini-capo', 'Mini Capo', 'Capo Mannu', 40.02, 8.36, 40.0275, 8.3895, 275, 40, 95, 1.2, 4.0, 7, 1, true),
  ('la-punta', 'La Punta', 'Capo Mannu', 40.018, 8.37, 40.0262, 8.3935, 245, 40, 65, 1.0, 3.5, 7, 1, false),
  ('lo-scivolo', 'Lo Scivolo', 'Capo Mannu', 40.015, 8.375, 40.0245, 8.3975, 230, 40, 50, 0.8, 3.0, 8, 1, false),
  ('putzu-idu', 'Putzu Idu', 'Capo Mannu', 40.012, 8.385, 40.0225, 8.404, 215, 35, 35, 1.2, 4.5, 8, 1, false),
  ('sg-scalini', 'Gli Scalini', 'San Giovanni di Sinis', 39.885, 8.4, 39.886, 8.437, 270, 45, 90, 0.8, 3.0, 7, 1, false),
  ('sg-la-torre', 'La Torre', 'San Giovanni di Sinis', 39.87, 8.4, 39.8745, 8.439, 245, 45, 65, 0.7, 2.5, 6, 1, false)
) as v(id, name, area, lat, lon, beach_lat, beach_lon, facing, "window", offshore, min, max, min_period, gain, alert_default)
on conflict (id) do nothing;
