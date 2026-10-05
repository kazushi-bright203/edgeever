-- Transaction-local assertions. Successful batches remove their guard row;
-- failed assertions abort the entire batch before any memo mutation.
CREATE TABLE memo_write_guards (
  id TEXT PRIMARY KEY,
  valid INTEGER NOT NULL CONSTRAINT memo_write_conflict CHECK (valid = 1)
);
