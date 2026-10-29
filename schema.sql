-- Execute once in the Supabase SQL Editor as project owner.
-- No client data or credentials are included here.
BEGIN;

CREATE TABLE IF NOT EXISTS public.dela_members (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 250)
);
ALTER TABLE public.dela_members ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.dela_members FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.dela_has_access() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT EXISTS (SELECT 1 FROM public.dela_members WHERE user_id = auth.uid()); $$;
REVOKE ALL ON FUNCTION public.dela_has_access() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dela_has_access() TO authenticated;

CREATE TABLE IF NOT EXISTS public.dela_cases (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  client text NOT NULL CHECK (length(btrim(client)) BETWEEN 1 AND 20000),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 20000),
  number text NOT NULL DEFAULT '', court text NOT NULL DEFAULT '', description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','closed')),
  fee bigint CHECK (fee BETWEEN 0 AND 1000000000000),
  color text NOT NULL DEFAULT 'sage' CHECK (color IN ('sage','amber','blue','rose','purple')),
  source text NOT NULL DEFAULT 'Внесено вручную',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.dela_tasks (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  case_id text NOT NULL REFERENCES public.dela_cases(id),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 20000),
  status text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','doing','done')),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal','high')),
  due date, assignee text NOT NULL DEFAULT '',
  minutes bigint NOT NULL DEFAULT 0 CHECK (minutes BETWEEN 0 AND 1000000000000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.dela_documents (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  case_id text NOT NULL REFERENCES public.dela_cases(id),
  kind text NOT NULL CHECK (kind IN ('Договор','Спецификация','Акт','Счёт')),
  status text NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown','needed','ready','sent','signed')),
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(case_id,kind)
);
CREATE TABLE IF NOT EXISTS public.dela_transactions (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  case_id text NOT NULL REFERENCES public.dela_cases(id),
  kind text NOT NULL CHECK (kind IN ('income','expense')),
  amount bigint NOT NULL CHECK (amount BETWEEN 1 AND 1000000000000),
  date date NOT NULL, service_year integer,
  note text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'income' OR service_year IS NOT DISTINCT FROM 2026)
);
CREATE INDEX IF NOT EXISTS dela_tasks_case_idx ON public.dela_tasks(case_id);
CREATE INDEX IF NOT EXISTS dela_tasks_due_idx ON public.dela_tasks(due);
CREATE INDEX IF NOT EXISTS dela_transactions_case_idx ON public.dela_transactions(case_id);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['dela_cases','dela_tasks','dela_documents','dela_transactions'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON public.%I TO authenticated', t);
    EXECUTE format('DROP POLICY IF EXISTS dela_member_read ON public.%I', t);
    EXECUTE format('CREATE POLICY dela_member_read ON public.%I FOR SELECT TO authenticated USING ((SELECT public.dela_has_access()))', t);
    EXECUTE format('DROP POLICY IF EXISTS dela_member_insert ON public.%I', t);
    EXECUTE format('CREATE POLICY dela_member_insert ON public.%I FOR INSERT TO authenticated WITH CHECK ((SELECT public.dela_has_access()))', t);
    EXECUTE format('DROP POLICY IF EXISTS dela_member_update ON public.%I', t);
    EXECUTE format('CREATE POLICY dela_member_update ON public.%I FOR UPDATE TO authenticated USING ((SELECT public.dela_has_access())) WITH CHECK ((SELECT public.dela_has_access()))', t);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.dela_create_documents() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  INSERT INTO public.dela_documents(case_id,kind)
  SELECT NEW.id, kind FROM unnest(ARRAY['Договор','Спецификация','Акт','Счёт']) AS kind;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.dela_create_documents() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS dela_case_documents ON public.dela_cases;
CREATE TRIGGER dela_case_documents AFTER INSERT ON public.dela_cases
FOR EACH ROW EXECUTE FUNCTION public.dela_create_documents();

-- One-time private import. This cannot replace an existing shared registry.
CREATE OR REPLACE FUNCTION public.dela_import_initial(payload jsonb) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE k text; BEGIN
  IF NOT public.dela_has_access() THEN RAISE EXCEPTION 'Access denied'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('dela_initial_import'));
  IF EXISTS (SELECT 1 FROM public.dela_cases) THEN RAISE EXCEPTION 'Registry already initialized'; END IF;
  FOREACH k IN ARRAY ARRAY['cases','tasks','documents','transactions'] LOOP
    IF jsonb_typeof(payload->k) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid import'; END IF;
  END LOOP;
  IF jsonb_array_length(payload->'cases') = 0 THEN RAISE EXCEPTION 'Empty import'; END IF;
  INSERT INTO public.dela_cases(id,client,title,number,court,description,status,fee,color,source)
  SELECT id,client,title,number,court,description,status,fee,color,source
  FROM jsonb_to_recordset(payload->'cases') AS x(id text,client text,title text,number text,court text,description text,status text,fee bigint,color text,source text);
  INSERT INTO public.dela_tasks(id,case_id,title,status,priority,due,assignee,minutes)
  SELECT id,case_id,title,status,priority,due,assignee,minutes
  FROM jsonb_to_recordset(payload->'tasks') AS x(id text,case_id text,title text,status text,priority text,due date,assignee text,minutes bigint);
  IF jsonb_array_length(payload->'documents') <> 4 * jsonb_array_length(payload->'cases') OR EXISTS (
    SELECT 1 FROM jsonb_to_recordset(payload->'documents') AS x(case_id text,kind text) GROUP BY case_id,kind HAVING count(*) <> 1
  ) OR EXISTS (
    SELECT 1 FROM jsonb_to_recordset(payload->'documents') AS x(case_id text,kind text)
    WHERE NOT EXISTS (SELECT 1 FROM public.dela_documents d WHERE d.case_id=x.case_id AND d.kind=x.kind)
  ) THEN RAISE EXCEPTION 'Invalid document checklist'; END IF;
  UPDATE public.dela_documents d SET status=x.status,note=x.note
  FROM jsonb_to_recordset(payload->'documents') AS x(case_id text,kind text,status text,note text)
  WHERE d.case_id=x.case_id AND d.kind=x.kind;
  INSERT INTO public.dela_transactions(id,case_id,kind,amount,date,service_year,note)
  SELECT id,case_id,kind,amount,date,service_year,note
  FROM jsonb_to_recordset(payload->'transactions') AS x(id text,case_id text,kind text,amount bigint,date date,service_year integer,note text);
END $$;
REVOKE ALL ON FUNCTION public.dela_import_initial(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dela_import_initial(jsonb) TO authenticated;
COMMIT;
