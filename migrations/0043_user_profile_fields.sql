-- 0043: User profile fields surfaced in Settings → My Profile.
-- Existing users table already has avatar_url; just adds the rest.

ALTER TABLE users ADD COLUMN phone TEXT;
ALTER TABLE users ADD COLUMN job_title TEXT;
ALTER TABLE users ADD COLUMN linkedin_url TEXT;
ALTER TABLE users ADD COLUMN bio TEXT;
