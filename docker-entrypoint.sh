#!/bin/sh

echo "Running database migrations..."

# Resolve any previously failed migrations so migrate deploy can proceed.
# This marks failed migrations as rolled back, allowing new migrations to run.
npx prisma migrate resolve --rolled-back 20260221_add_identity_framework_tables 2>&1 || true

npx prisma migrate deploy 2>&1 || echo "WARNING: Migration failed. Continuing startup..."

echo "Starting Engram..."
exec node dist/src/main.js
