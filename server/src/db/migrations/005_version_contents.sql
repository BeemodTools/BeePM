-- What each version defines that people look for (core's contents.js): its items, styles,
-- music, signage, voice lines and so on, so they can be listed and searched. Read when a version
-- is published; versions from before are read in the background (services/contents.js).
CREATE TABLE version_contents (
    version_id  INTEGER NOT NULL REFERENCES versions (id) ON DELETE CASCADE,
    kind        TEXT NOT NULL,                     -- item, style, music, signage, voice...
    object_id   TEXT NOT NULL,                     -- its ID in info.txt
    name        TEXT NOT NULL,
    aliases     TEXT NOT NULL DEFAULT '',          -- other names it goes by, one per line
    position    INTEGER NOT NULL,                  -- its place in info.txt
    description TEXT,
    authors     TEXT,
    icon        BYTEA,                             -- a PNG or JPEG from the package
    icon_type   TEXT,
    PRIMARY KEY (version_id, kind, object_id)
);

-- When a version's contents were read (null: not yet), and why they couldn't be
ALTER TABLE versions ADD COLUMN contents_read_at TIMESTAMPTZ;
ALTER TABLE versions ADD COLUMN contents_error TEXT;
