-- Demote the shared Intel account to ordinary member visibility.
UPDATE users
SET role = 'member',
    share_emails_org_wide = 0,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE lower(email) = lower('intel@medinavc.com');
