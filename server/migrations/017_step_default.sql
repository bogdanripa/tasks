-- 40 steps proved too few for real work (QA ran out mid-test); new agents start at 60.
alter table accounts alter column runtime_max_steps set default 60;
