-- Account settings: each linked account remembers its avatar, and the profile shows one of them
-- (avatar_source: 'discord' | 'github' | 'none', or null for "the first one we saw")
ALTER TABLE identities ADD COLUMN avatar_url TEXT;
ALTER TABLE users ADD COLUMN avatar_source TEXT;

UPDATE users SET avatar_source = (
    SELECT i.provider FROM identities i WHERE i.user_id = users.id ORDER BY i.linked_at LIMIT 1
) WHERE avatar_url IS NOT NULL;

UPDATE identities SET avatar_url = users.avatar_url
  FROM users
 WHERE users.id = identities.user_id AND users.avatar_source = identities.provider;
