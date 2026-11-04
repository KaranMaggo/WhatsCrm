-- Cosmedic Express CRM: add readable customer codes (CE-C-000001) to existing contacts
-- Additive only: no existing column, table or row is removed or renamed.
-- Safe to run more than once.

create sequence if not exists public.contact_code_seq start 1;

alter table public.contacts add column if not exists customer_code text;

-- Give existing contacts a code, oldest first (only those without one)
with base as (
  select count(*) as n from public.contacts where customer_code is not null
),
ordered as (
  select c.id,
         row_number() over (order by c.created_at nulls last, c.id) + b.n as rn
  from public.contacts c, base b
  where c.customer_code is null
)
update public.contacts c
set customer_code = 'CE-C-' || lpad(o.rn::text, 6, '0')
from ordered o
where c.id = o.id;

-- Next new contact continues after the last used number
select setval(
  'public.contact_code_seq',
  greatest((select count(*) from public.contacts), 1),
  (select count(*) from public.contacts) > 0
);

-- Every new contact gets the next code automatically, even if the app does not set it
alter table public.contacts
  alter column customer_code
  set default ('CE-C-' || lpad(nextval('public.contact_code_seq')::text, 6, '0'));

create unique index if not exists contacts_customer_code_key
  on public.contacts (customer_code);
