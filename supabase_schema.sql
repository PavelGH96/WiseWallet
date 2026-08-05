-- =====================================================================
-- v3.32: ВХОД ПО EMAIL/ПАРОЛЮ ОБЯЗАТЕЛЕН
-- Что сделать один раз в своём проекте Supabase:
--   1) выполнить весь этот файл в SQL Editor;
--   2) Authentication -> Providers -> Email: включить
--      (если не хочется подтверждать почту -- выключить "Confirm email");
--   3) Authentication -> URL Configuration -> Site URL: адрес приложения
--      (нужен для писем «Забыли пароль?»);
--   4) в index.html вписать WW_SB_URL и WW_SB_KEY (Project Settings -> API).
-- После этого все данные живут в ww_user_state под RLS: строку видит
-- только её владелец (auth.uid() = user_id).
-- =====================================================================

-- WiseWallet: схема Supabase
-- ============================================================
-- ЧАСТЬ 1 (v1, legacy): общая таблица с ключом синхронизации.
-- С v3.32 ИЗ ПРИЛОЖЕНИЯ БОЛЬШЕ НЕ ИСПОЛЬЗУЕТСЯ. Нужна только для одноразового
-- переноса старых данных в аккаунт при первом входе. Когда все устройства
-- вошли в аккаунт, таблицу можно удалить: drop table public.ww_state;
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

-- =====================================================================
-- v3.28: облачные резервные копии
-- Локальные снимки живут только в браузере одного устройства. Эти копии
-- переживают потерю телефона и очистку данных браузера.
-- =====================================================================
create table if not exists public.ww_snapshots (
  id bigserial primary key,
  sync_id text not null,
  created_at timestamptz not null default now(),
  note text,
  data jsonb not null
);
create index if not exists ww_snapshots_sync_idx on public.ww_snapshots (sync_id, created_at desc);

alter table public.ww_snapshots enable row level security;
drop policy if exists ww_snapshots_select on public.ww_snapshots;
drop policy if exists ww_snapshots_insert on public.ww_snapshots;
drop policy if exists ww_snapshots_delete on public.ww_snapshots;
-- v3.32: sync_id теперь хранит user_id владельца, и копии видны только ему.
create policy ww_snapshots_select on public.ww_snapshots for select using (auth.uid()::text = sync_id);
create policy ww_snapshots_insert on public.ww_snapshots for insert with check (auth.uid()::text = sync_id);
create policy ww_snapshots_delete on public.ww_snapshots for delete using (auth.uid()::text = sync_id);

-- Держим последние 20 снимков на каждый syncId, лишние удаляются сами
create or replace function public.ww_snapshots_prune() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from public.ww_snapshots s
  where s.sync_id = new.sync_id
    and s.id not in (
      select id from public.ww_snapshots
      where sync_id = new.sync_id
      order by created_at desc
      limit 20
    );
  return null;
end;
$$;
drop trigger if exists ww_snapshots_prune_trg on public.ww_snapshots;
create trigger ww_snapshots_prune_trg after insert on public.ww_snapshots
for each row execute function public.ww_snapshots_prune();
