-- Custom SQL migration file, put your code below! --
CREATE TRIGGER mutation_revision_guard BEFORE INSERT ON mutation_guards
WHEN NOT EXISTS (SELECT 1 FROM system_settings WHERE key='state_revision' AND value=NEW.expected_revision)
BEGIN
  SELECT RAISE(ABORT, 'state_conflict');
END;
