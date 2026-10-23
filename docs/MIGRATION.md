# Rename Producer / Consumer to Publisher / Mirror

The role names and source paths changed. The HTTP routes, delivery keys, manifest schema and stored version bytes did not change.

| Previous           | Current             |
| ------------------ | ------------------- |
| apps/producer      | apps/publisher      |
| apps/consumer      | apps/mirror         |
| @webhaven/producer | @webhaven/publisher |
| @webhaven/consumer | @webhaven/mirror    |
| npm run producer   | npm run publisher   |
| npm run consumer   | npm run mirror      |
| PRODUCER_*         | PUBLISHER_*         |
| CONSUMER_*         | MIRROR_*            |

The old npm commands remain aliases. The old environment names remain fallbacks. The new environment name wins if both are set. With no configured data directory, the application uses an existing `var/producer` or `var/consumer` directory before a new role directory.

Keep existing data directories when you update an environment file. Copying the new example and changing a DATA_DIR value selects a different directory; it does not move data.

Compose service names and build targets are now `publisher` and `mirror`. The `producer` and `consumer` volume keys stay unchanged to preserve existing named volumes. Use the same Compose project name as before. Docker retains the old build targets as aliases. The S3 override accepts both generations of credential variable names.

For an existing Compose deployment:

1. Stop the old `producer` and `consumer` services with the old Compose file. Keep the volumes.
2. Update the code and inspect `docker compose config`.
3. Run `docker compose up --build -d --remove-orphans` with the same project name.
4. Confirm the Publisher health and the Mirror's active collection.

Do not run old and new writers against the same archive simultaneously. Stop the renamed services before switching back to an old checkout. The unchanged on-disk format permits rollback without a data migration.
