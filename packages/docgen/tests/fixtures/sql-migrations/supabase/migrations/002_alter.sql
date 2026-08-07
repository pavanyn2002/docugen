alter table public.invoices add column currency text not null default 'INR';
alter table public.customers drop column display_name;
