-- WiseWallet v1: схема синхронизации для Supabase
-- Выполните этот скрипт в SQL Editor вашего проекта Supabase.
--
-- v1 синхронизирует всё состояние приложения одним JSON-документом (просто и надёжно
-- для личного использования). Полноценная реляционная схема (accounts, transactions,
-- credits и т.д. с RLS по user_id) описана в промте и планируется в v1.1 вместе с
-- авторизацией Supabase Auth.

create table if not exists public.ww_state (
  id text primary key,              -- ключ синхронизации из настроек приложения
  data jsonb not null,              -- всё состояние WiseWallet
  updated_at timestamptz not null default now()
);

-- Включаем RLS и разрешаем доступ анонимному ключу только к этой таблице.
-- ВАЖНО: ключ синхронизации выступает секретом — используйте длинное случайное значение
-- (приложение генерирует его автоматически) и не публикуйте ссылку на проект.
alter table public.ww_state enable row level security;

drop policy if exists "ww_state_select" on public.ww_state;
create policy "ww_state_select" on public.ww_state for select using (true);

drop policy if exists "ww_state_insert" on public.ww_state;
create policy "ww_state_insert" on public.ww_state for insert with check (true);

drop policy if exists "ww_state_update" on public.ww_state;
create policy "ww_state_update" on public.ww_state for update using (true);
