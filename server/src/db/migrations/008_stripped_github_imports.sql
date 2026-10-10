-- Versions imported from a GitHub release are downloaded from that release (routes/packages.js
-- githubDownloadUrl). When files were stripped from it, clients check the release's file and
-- strip the same ones, so imports keep which files and the file's checksum in their source.
-- Earlier imports get the list from the audit record of their publish; without the checksum,
-- they're downloaded from BeePM's copy.
UPDATE versions v
   SET source = v.source || jsonb_build_object('stripped', a.details->'strippedFiles')
  FROM packages p, audit_log a
 WHERE v.package_id = p.id
   AND v.source->>'type' = 'github'
   AND a.action = 'version.publish'
   AND a.target = '@' || p.scope || '/' || p.name || '@' || v.version
   AND jsonb_typeof(a.details->'strippedFiles') = 'array'
   AND a.details->'strippedFiles' <> '[]'::jsonb;
