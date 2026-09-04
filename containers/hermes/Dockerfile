FROM python:3.12-slim

# Verified: `hermes chat --oneshot --profile <name> --quiet -q`
# (CLI reference) and Custom Endpoint via `model.base_url` (providers docs).
RUN pip install --no-cache-dir hermes-agent==0.19.0

WORKDIR /srv/hermes
COPY config.yaml adapter.py ./

ENV PORT=8080
EXPOSE 8080

CMD ["python", "adapter.py"]
