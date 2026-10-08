-- Nicknames are plain ASCII now (letters from other alphabets can look like someone else's
-- handle): the ones from before are made so the way new ones are (services/users.js
-- asciiNickname): accents dropped, anything else left out, one space at a time.
UPDATE users
   SET display_name = NULLIF(
           btrim(regexp_replace(
               regexp_replace(normalize(display_name, NFKD), '[^ -~]', '', 'g'),
               '\s+', ' ', 'g')),
           '')
 WHERE display_name ~ '[^ -~]';
