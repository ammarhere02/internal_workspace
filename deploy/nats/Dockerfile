# NATS server with JetStream for Railway (same flags as docker-compose.yml). Attach a persistent volume at /data
# so the TEAM_EVENTS stream survives redeploys. Private address for the other services: nats.railway.internal:4222
FROM nats:2.15
EXPOSE 4222 8222
CMD ["--jetstream", "--store_dir", "/data", "--http_port", "8222", "--name", "tm-nats"]
