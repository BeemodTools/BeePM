-- A removed package keeps its BEE2 ID (migration 004 let go of it), so nobody can take over the
-- people who have that package: the desktop app offers BeePM's version of a package by its ID.
-- An admin can let go of it on purpose (POST /v1/admin/packages/:scope/:name/release-bee-id).
ALTER TABLE packages ADD COLUMN bee_id_released BOOLEAN NOT NULL DEFAULT false;
-- Packages removed before now let go of their IDs already (another package may use one)
UPDATE packages SET bee_id_released = true WHERE removed_at IS NOT NULL;
DROP INDEX packages_bee_id;
CREATE UNIQUE INDEX packages_bee_id ON packages (upper(bee_id)) WHERE NOT bee_id_released;
