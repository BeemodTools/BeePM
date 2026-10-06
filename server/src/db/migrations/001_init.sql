-- BeePM registry schema

-- A BeePM account. Discord and GitHub logins are linked to it through identities.
CREATE TABLE users (
    id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    handle          TEXT NOT NULL UNIQUE,          -- lowercase; the @scope of the user's packages
    display_name    TEXT,
    avatar_url      TEXT,
    role            TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    claimed_at      TIMESTAMPTZ,                   -- null until the first login (legacy-imported accounts)
    banned_at       TIMESTAMPTZ,
    ban_reason      TEXT
);

-- A Discord or GitHub account linked to a BeePM account, keyed by the provider's numeric ID
CREATE TABLE identities (
    provider            TEXT NOT NULL CHECK (provider IN ('github', 'discord', 'dev')),  -- dev: local testing only
    provider_id         TEXT NOT NULL,
    user_id             INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    username            TEXT,                      -- last seen provider username, display only
    account_created_at  TIMESTAMPTZ,               -- used for the minimum account age to publish
    linked_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at       TIMESTAMPTZ,
    PRIMARY KEY (provider, provider_id),
    UNIQUE (user_id, provider)
);

-- BeePM API tokens. Only a SHA-256 hash of each token is stored.
CREATE TABLE tokens (
    id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash      TEXT NOT NULL UNIQUE,
    hint            TEXT NOT NULL,                 -- last 4 characters, for display
    name            TEXT NOT NULL,
    kind            TEXT NOT NULL CHECK (kind IN ('session', 'publish')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at    TIMESTAMPTZ,
    expires_at      TIMESTAMPTZ,
    revoked_at      TIMESTAMPTZ
);
CREATE INDEX tokens_user ON tokens (user_id);

-- A browser login (kind = login) or account-linking (kind = link) flow started by the app or CLI
CREATE TABLE auth_sessions (
    id              TEXT PRIMARY KEY,              -- appears in the browser URL
    kind            TEXT NOT NULL CHECK (kind IN ('login', 'link')),
    poll_hash       TEXT NOT NULL,                 -- hash of the secret only the app/CLI holds
    browser_hash    TEXT,                          -- hash of the cookie of the first browser to open it
    csrf            TEXT NOT NULL,
    confirm_code    TEXT NOT NULL,                 -- shown in both the app and the browser
    client_name     TEXT NOT NULL,                 -- e.g. "BeePM Desktop on DESKTOP-1234"; becomes the token name
    client_kind     TEXT NOT NULL DEFAULT 'other' CHECK (client_kind IN ('app', 'cli', 'other')),
    user_id         INTEGER REFERENCES users (id) ON DELETE CASCADE,
    oauth_state     TEXT UNIQUE,
    oauth_provider  TEXT,
    profile         JSONB,                         -- provider profile waiting for a handle or a link confirmation
    status          TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'approved', 'done', 'denied')),
    result          JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX auth_sessions_expires ON auth_sessions (expires_at);

CREATE TABLE packages (
    id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    scope           TEXT NOT NULL,                 -- owner handle (lowercase)
    name            TEXT NOT NULL,                 -- lowercase
    bee_id          TEXT NOT NULL,                 -- BEE2 package ID from info.txt
    display_name    TEXT,
    description     TEXT,
    deprecated      TEXT,                          -- deprecation message for the whole package
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    removed_at      TIMESTAMPTZ,                   -- hidden by an admin
    removed_reason  TEXT,
    UNIQUE (scope, name)
);
-- BEE2 refuses to load two packages with the same ID, so IDs are unique across the registry
CREATE UNIQUE INDEX packages_bee_id ON packages (upper(bee_id));

CREATE TABLE package_owners (
    package_id      INTEGER NOT NULL REFERENCES packages (id) ON DELETE CASCADE,
    user_id         INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    added_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    added_by        INTEGER REFERENCES users (id) ON DELETE SET NULL,
    PRIMARY KEY (package_id, user_id)
);
CREATE INDEX package_owners_user ON package_owners (user_id);

-- Published versions are immutable. Unpublished ones stay as tombstones so the number can't be reused.
CREATE TABLE versions (
    id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    package_id      INTEGER NOT NULL REFERENCES packages (id) ON DELETE CASCADE,
    version         TEXT NOT NULL,
    compatible_with TEXT,                          -- BEE2 version range
    dependencies    JSONB NOT NULL DEFAULT '{}'::jsonb,
    manifest        JSONB NOT NULL,
    sha256          TEXT NOT NULL,
    size            BIGINT NOT NULL,
    storage_key     TEXT NOT NULL,
    source          JSONB NOT NULL DEFAULT '{"type": "upload"}'::jsonb,
    published_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_by    INTEGER REFERENCES users (id) ON DELETE SET NULL,
    yanked_at       TIMESTAMPTZ,
    yank_reason     TEXT,
    deprecated      TEXT,
    unpublished_at  TIMESTAMPTZ,
    downloads       BIGINT NOT NULL DEFAULT 0,
    UNIQUE (package_id, version)
);

-- A publish in progress: the client uploads to uploads/<id>.bee_pack, then calls finalize
CREATE TABLE uploads (
    id              TEXT PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    storage_key     TEXT NOT NULL,
    size            BIGINT NOT NULL,
    sha256          TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'processing', 'done', 'failed')),
    error           TEXT,
    result          JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX uploads_user_created ON uploads (user_id, created_at);
CREATE INDEX uploads_status_expires ON uploads (status, expires_at);

CREATE TABLE audit_log (
    id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    actor_id        INTEGER REFERENCES users (id) ON DELETE SET NULL,
    action          TEXT NOT NULL,
    target          TEXT,
    details         JSONB
);
CREATE INDEX audit_log_at ON audit_log (at);
