create table if not exists public.trading_control_snapshots (
  user_id uuid primary key references auth.users (id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.trading_control_snapshots enable row level security;

drop policy if exists "Users can read their own trading snapshot"
  on public.trading_control_snapshots;
create policy "Users can read their own trading snapshot"
  on public.trading_control_snapshots
  for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own trading snapshot"
  on public.trading_control_snapshots;
create policy "Users can insert their own trading snapshot"
  on public.trading_control_snapshots
  for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own trading snapshot"
  on public.trading_control_snapshots;
create policy "Users can update their own trading snapshot"
  on public.trading_control_snapshots
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete their own trading snapshot"
  on public.trading_control_snapshots;
create policy "Users can delete their own trading snapshot"
  on public.trading_control_snapshots
  for delete
  to authenticated
  using (auth.uid() = user_id);

revoke all on table public.trading_control_snapshots from anon;
revoke all on table public.trading_control_snapshots from public;
grant select, insert, update, delete on table public.trading_control_snapshots to authenticated;
grant all on table public.trading_control_snapshots to service_role;
