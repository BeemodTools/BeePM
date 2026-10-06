-- Packages that publish new releases of a GitHub repository automatically
CREATE TABLE github_watches (
    package_id  INTEGER PRIMARY KEY REFERENCES packages (id) ON DELETE CASCADE,
    repo        TEXT NOT NULL,                  -- owner/repo
    asset       TEXT NOT NULL,                  -- the .bee_pack's name when it was set up
    user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,  -- publishes as them
    handled     TEXT,                           -- "<tag> <asset id>" of the newest release dealt with
    checked_at  TIMESTAMPTZ,
    checks      INTEGER NOT NULL DEFAULT 0,     -- bumped by each check, so only one server claims it
    error       TEXT,                           -- why that release couldn't be published
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
