create extension if not exists "pgcrypto";

create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- Таблица счетов
create table if not exists public.accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  balance numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Поставщики
create table if not exists public.suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  contact text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Контрагенты (поступления)
create table if not exists public.counterparties (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Заказы поставщиков
create table if not exists public.supplier_orders (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid references public.suppliers(id) on delete set null,
  title text not null,
  total_amount numeric not null,
  deposit_amount numeric not null default 0,
  deposit_paid boolean not null default false,
  deposit_date date not null default current_date,
  due_date date not null,
  currency text not null check (currency in ('RUB', 'CNY')) default 'RUB',
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table if exists public.supplier_orders
  add column if not exists moysklad_id text unique;

alter table if exists public.supplier_orders
  add column if not exists deposit_paid boolean not null default false;

alter table if exists public.supplier_orders
  add column if not exists updated_at timestamptz not null default now();

-- Ожидаемые поступления от контрагентов
create table if not exists public.incoming_payments (
  id uuid primary key default gen_random_uuid(),
  counterparty_id uuid references public.counterparties(id) on delete set null,
  counterparty text not null,
  amount numeric not null,
  expected_date date not null,
  kind text not null check (kind in ('fixed', 'planned')) default 'fixed',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Плановые расходы (ежемесячные)
create table if not exists public.planned_expenses (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  amount numeric not null,
  amount_primary numeric,
  amount_secondary numeric,
  day_primary smallint not null check (day_primary between 1 and 31),
  day_secondary smallint check (day_secondary between 1 and 31),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_incoming_payments_date on public.incoming_payments(expected_date);
create index if not exists idx_incoming_payments_counterparty on public.incoming_payments(counterparty_id);
create index if not exists idx_supplier_orders_due_date on public.supplier_orders(due_date);
create index if not exists idx_supplier_orders_supplier on public.supplier_orders(supplier_id);

-- Технические настройки
create table if not exists public.app_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table if exists public.accounts
  add column if not exists updated_at timestamptz not null default now();

alter table if exists public.suppliers
  add column if not exists updated_at timestamptz not null default now();

alter table if exists public.counterparties
  add column if not exists updated_at timestamptz not null default now();

alter table if exists public.incoming_payments
  add column if not exists updated_at timestamptz not null default now();

alter table if exists public.planned_expenses
  add column if not exists updated_at timestamptz not null default now();

alter table if exists public.planned_expenses
  add column if not exists amount_primary numeric;

alter table if exists public.planned_expenses
  add column if not exists amount_secondary numeric;

drop trigger if exists set_accounts_updated_at on public.accounts;
create trigger set_accounts_updated_at
before update on public.accounts
for each row execute function public.set_updated_at();

drop trigger if exists set_suppliers_updated_at on public.suppliers;
create trigger set_suppliers_updated_at
before update on public.suppliers
for each row execute function public.set_updated_at();

drop trigger if exists set_counterparties_updated_at on public.counterparties;
create trigger set_counterparties_updated_at
before update on public.counterparties
for each row execute function public.set_updated_at();

drop trigger if exists set_supplier_orders_updated_at on public.supplier_orders;
create trigger set_supplier_orders_updated_at
before update on public.supplier_orders
for each row execute function public.set_updated_at();

drop trigger if exists set_incoming_payments_updated_at on public.incoming_payments;
create trigger set_incoming_payments_updated_at
before update on public.incoming_payments
for each row execute function public.set_updated_at();

drop trigger if exists set_planned_expenses_updated_at on public.planned_expenses;
create trigger set_planned_expenses_updated_at
before update on public.planned_expenses
for each row execute function public.set_updated_at();

drop trigger if exists set_app_settings_updated_at on public.app_settings;
create trigger set_app_settings_updated_at
before update on public.app_settings
for each row execute function public.set_updated_at();
