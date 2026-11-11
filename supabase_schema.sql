-- =====================================================================
-- WiseWallet — схема Supabase
--
-- v4.44: таблицы ww_state больше нет. Что изменилось и почему — ниже,
-- в разделе «Удаление legacy-таблицы».
--
-- Что сделать один раз в своём проекте Supabase:
--   1) выполнить весь этот файл в SQL Editor;
--   2) Authentication -> Providers -> Email: включить
--      (если не хочется подтверждать почту -- выключить "Confirm email");
--   3) Authentication -> URL Configuration -> Site URL: адрес приложения
--      (нужен для писем «Забыли пароль?»);
--   4) в index.html вписать WW_SB_URL и WW_SB_KEY (Project Settings -> API).
-- Все данные живут в ww_user_state под RLS: строку видит только её
-- владелец (auth.uid() = user_id).
-- =====================================================================

-- ============================================================
-- УДАЛЕНИЕ LEGACY-ТАБЛИЦЫ ww_state  (выполняется сразу)
--
-- До v3.32 состояние лежало в общей таблице ww_state, а строка находилась
-- по «ключу синхронизации». Политики у неё были такие:
--
--     create policy ... for select using (true);
--     create policy ... for insert with check (true);
--     create policy ... for update using (true);
--
-- `using (true)` означает «разрешено всем» — включая роль anon. А anon key
-- и адрес проекта зашиты прямо в index.html, который лежит в публичном
-- репозитории и раздаётся с GitHub Pages. То есть любой человек, открывший
-- исходник страницы, мог прочитать и перезаписать ЛЮБУЮ строку этой
-- таблицы: ключ синхронизации в фильтре запроса — это не пароль, сервер
-- его не проверял.
--
-- С v4.44 приложение в эту таблицу не ходит ни одной строкой кода.
--
-- Закрывается в два шага, и это намеренно. Сначала снимаются политики:
-- RLS остаётся включённой, политик не остаётся ни одной — доступ закрыт
-- для всех, кроме service_role, данные целы, шаг обратим. Удалять таблицу
-- имеет смысл только после того, как на всех устройствах заработала новая
-- версия приложения: пока где-то крутится старая, лучше иметь возможность
-- вернуть политики одной строкой, чем восстанавливать таблицу из копии.
--
-- Если какое-то устройство ещё не входило в аккаунт — сначала выгрузите на
-- нём данные через «Настройки → Экспорт», войдите и загрузите файл обратно.
--
-- Шаг 1 — закрыть доступ (выполнено 11.11.2026):
-- ============================================================
drop policy if exists ww_state_select on public.ww_state;
drop policy if exists ww_state_insert on public.ww_state;
drop policy if exists ww_state_update on public.ww_state;
alter publication supabase_realtime drop table public.ww_state;

-- Шаг 2 — удалить таблицу. Выполнять, когда новая версия раскатана и
-- проверена; до этого момента строка закомментирована намеренно.
-- drop table if exists public.ww_state cascade;

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
-- устройствами до секунд.
--
-- v4.44: подписка идёт на ww_user_state под RLS, поэтому приложение
-- передаёт соединению токен пользователя (realtime.setAuth). Без токена
-- сервер не отдаёт по этой таблице ни одного события — раньше канал был
-- подписан на ww_state с anon key и молча не работал.
-- ============================================================
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

-- ---------------------------------------------------------------------------
-- v4.46: сводка для виджета на телефоне
--
-- Виджет не должен тянуть всё состояние целиком: ему нужны несколько
-- чисел и дата последней записи. Держим их в отдельной колонке — тогда
-- запрос виджета выглядит как `select=summary` и весит десятки байт
-- вместо сотен килобайт.
--
-- Политики не нужны: колонка в той же строке ww_user_state и закрыта той
-- же RLS. Читать её будет Cloudflare Worker под сервисным ключом (ключ
-- остаётся на стороне Cloudflare и в приложение не попадает).
-- ---------------------------------------------------------------------------
alter table public.ww_user_state add column if not exists summary jsonb;

-- ---------------------------------------------------------------------------
-- Служебная функция не должна торчать в публичном API
--
-- ww_snapshots_prune() — триггерная функция с SECURITY DEFINER, оставляющая
-- последние 20 облачных копий. По умолчанию право EXECUTE есть у всех, то
-- есть её можно было дёрнуть как /rest/v1/rpc/ww_snapshots_prune с anon key.
-- Воспользоваться этим нельзя (Postgres отклоняет прямой вызов триггерной
-- функции), но держать её в публичном API незачем.
--
-- На работу триггера это не влияет: право EXECUTE проверяется при создании
-- триггера, а не при каждом срабатывании.
-- ---------------------------------------------------------------------------
revoke execute on function public.ww_snapshots_prune() from anon, authenticated, public;

-- ---------------------------------------------------------------------------
-- Проверка после выполнения файла: в списке не должно быть ни ww_state,
-- ни политик с `using (true)`.
--
--   select tablename, policyname, qual
--     from pg_policies
--    where schemaname = 'public';
--
-- И проверка «глазами постороннего» — что видно с anon key:
--
--   begin;
--   set local role anon;
--   select count(*) from public.ww_user_state;   -- должно быть 0
--   rollback;
-- ---------------------------------------------------------------------------
