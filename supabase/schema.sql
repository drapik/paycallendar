create extension if not exists "pgcrypto";

-- Таблица счетов
create table if not exists public.accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  balance numeric not null default 0,
  created_at timestamptz not null default now()
);

-- Поставщики
create table if not exists public.suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  contact text,
  created_at timestamptz not null default now()
);

-- Контрагенты (поступления)
create table if not exists public.counterparties (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

-- Заказы поставщиков
create table if not exists public.supplier_orders (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid references public.suppliers(id) on delete set null,
  title text not null,
  total_amount numeric not null,
  deposit_amount numeric not null default 0,
  deposit_date date not null default current_date,
  due_date date not null,
  currency text not null check (currency in ('RUB', 'CNY')) default 'RUB',
  description text,
  created_at timestamptz not null default now()
);

alter table if exists public.supplier_orders
  add column if not exists moysklad_id text unique;

-- Ожидаемые поступления от контрагентов
create table if not exists public.incoming_payments (
  id uuid primary key default gen_random_uuid(),
  counterparty_id uuid references public.counterparties(id) on delete set null,
  counterparty text not null,
  amount numeric not null,
  expected_date date not null,
  kind text not null check (kind in ('fixed', 'planned')) default 'fixed',
  notes text,
  created_at timestamptz not null default now()
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
