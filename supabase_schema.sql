-- WiseWallet: схема Supabase
-- ============================================================
-- ЧАСТЬ 1 (v1, legacy): общая таблица с ключом синхронизации.
-- Оставлена для совместимости. ВНИМАНИЕ: политики открытые —
-- любой, у кого есть URL проекта и anon key, может читать/писать.
-- Рекомендуется перейти на часть 2 (вход по email).
-- ============================================================
create table if not exists public.ww_state (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.ww_state enable row level security;
drop policy if exists ww_state_select on public.ww_state;
drop policy if exists ww_state_insert on public.ww_state;
drop policy if exists ww_state_update on public.ww_state;
create policy ww_state_select on public.ww_state for select using (true);
create policy ww_state_insert on public.ww_state for insert with check (true);
create policy ww_state_update on public.ww_state for update using (true);

-- ============================================================
-- ЧАСТЬ 2 (v2): личное хранилище с авторизацией. РЕКОМЕНДУЕТСЯ.
-- Как включить:
--   1) Выполните этот SQL в Supabase → SQL Editor.
--   2) Authentication → Sign In / Up → включите Email
--      (для простоты можно отключить "Confirm email").
--   3) В приложении: Настройки → «Аккаунт Supabase» → Регистрация / Войти.
-- Доступ к строке имеет только её владелец: RLS auth.uid() = user_id.
-- ============================================================
create table if not exists public.ww_user_state (
  user_id uuid primary key references auth.users (id) on delete cascade,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.ww_user_state enable row level security;
drop policy if exists ww_user_select on public.ww_user_state;
drop policy if exists ww_user_insert on public.ww_user_state;
drop policy if exists ww_user_update on public.ww_user_state;
drop policy if exists ww_user_delete on public.ww_user_state;
create policy ww_user_select on public.ww_user_state for select using (auth.uid() = user_id);
create policy ww_user_insert on public.ww_user_state for insert with check (auth.uid() = user_id);
create policy ww_user_update on public.ww_user_state for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy ww_user_delete on public.ww_user_state for delete using (auth.uid() = user_id);

-- ============================================================
-- ЧАСТЬ 3 (v3.6, опционально): живая синхронизация в реальном времени.
-- Без этого шага приложение всё равно синхронизируется как раньше
-- (по таймеру/при открытии) — это просто ускоряет обновление между
-- устройствами до секунд. Выполните в Supabase → SQL Editor:
-- ============================================================
alter publication supabase_realtime add table public.ww_state;
alter publication supabase_realtime add table public.ww_user_state;
