create table if not exists public.codex_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  book_id uuid not null references public.books(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_message_id uuid references public.discussions(id) on delete set null,
  content text not null check (length(btrim(content)) between 1 and 8000),
  attach_context boolean not null default true,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'completed', 'failed', 'needs_attention')),
  response_message_id uuid references public.discussions(id) on delete set null,
  error_code text,
  attempts smallint not null default 0 check (attempts between 0 and 10),
  available_at timestamptz not null default now(),
  claimed_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists codex_requests_worker_queue_idx
  on public.codex_requests (status, available_at, created_at);

create index if not exists codex_requests_user_created_idx
  on public.codex_requests (user_id, created_at desc);

create index if not exists codex_requests_book_id_idx
  on public.codex_requests (book_id);

create index if not exists codex_requests_conversation_id_idx
  on public.codex_requests (conversation_id);

create index if not exists codex_requests_user_message_id_idx
  on public.codex_requests (user_message_id);

create index if not exists codex_requests_response_message_id_idx
  on public.codex_requests (response_message_id);

alter table public.codex_requests enable row level security;

revoke all on table public.codex_requests from anon, authenticated;
grant select on table public.codex_requests to authenticated;
grant insert (
  id,
  user_id,
  book_id,
  conversation_id,
  user_message_id,
  content,
  attach_context
) on table public.codex_requests to authenticated;
grant all on table public.codex_requests to service_role;

-- The local co-reading worker only needs to read context and append its reply.
grant select on table
  public.books,
  public.excerpts,
  public.book_questions,
  public.check_ins,
  public.discussions
to service_role;
grant insert on table public.discussions to service_role;

create policy "Users can read their own Codex requests"
  on public.codex_requests
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can enqueue their own Codex requests"
  on public.codex_requests
  for insert
  to authenticated
  with check (
    (select auth.uid()) = user_id
    and status = 'queued'
    and attempts = 0
    and response_message_id is null
    and error_code is null
    and claimed_at is null
    and completed_at is null
    and exists (
      select 1
      from public.books b
      where b.id = public.codex_requests.book_id
        and b.user_id = (select auth.uid())
    )
    and exists (
      select 1
      from public.conversations c
      where c.id = public.codex_requests.conversation_id
        and c.book_id = public.codex_requests.book_id
        and c.user_id = (select auth.uid())
    )
    and (
      user_message_id is null
      or exists (
        select 1
        from public.discussions d
        where d.id = public.codex_requests.user_message_id
          and d.book_id = public.codex_requests.book_id
          and d.conversation_id = public.codex_requests.conversation_id
          and d.user_id = (select auth.uid())
          and d.role = 'me'
      )
    )
  );
