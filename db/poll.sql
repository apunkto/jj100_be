select cron.schedule(
               'run-update-hole-stats-every-5-mins', -- name for your job
               '*/5 * * * *', -- every 5 minutes
               $$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/update-hole-stats',
      headers := jsonb_build_object(
        'Content-type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'anon_key')
      ),
      body := jsonb_build_object('time', now())
    )
    $$
       );
