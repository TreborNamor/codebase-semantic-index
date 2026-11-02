# Database recovery

Stop writers before restoring a snapshot. Verify its checksum, restore into a
new directory and run schema migrations. Start one application instance and
check readiness before admitting traffic. Keep the previous data until checks pass.

# Queue troubleshooting

Tasks leased by a crashed worker are returned to the pending queue after sixty
seconds. If the queue remains stuck, inspect expired leases and backing-service
connectivity before restarting more workers.

# Deployment rollback

Keep the previous application package and deploy migrations that preserve
compatibility with it. Switch traffic to the older package if readiness fails;
do not reverse a data migration without a tested restore procedure.
