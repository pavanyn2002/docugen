-- initial schema
create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  display_name text,
  created_at timestamptz not null default now()
);

create table if not exists public.invoices (
  id bigserial primary key,
  customer_id uuid not null references public.customers(id),
  amount_cents integer not null default 0,
  memo text,
  constraint uq_memo unique (memo)
);

create index idx_invoices_customer on public.invoices (customer_id);
