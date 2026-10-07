-- A removed package lets go of its BEE2 ID, so another package can use it (the removed one's
-- name stays taken). Restoring it is refused while another package has the ID.
DROP INDEX packages_bee_id;
CREATE UNIQUE INDEX packages_bee_id ON packages (upper(bee_id)) WHERE removed_at IS NULL;
