FROM python:3.14-slim@sha256:a2b82f3c48559aa0a8446d9af49826b6e2b2016f4cd2afabfe6013ec53729170

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    TRUSTBENCH_FIXTURE_PATH=/app/data/benign.jsonl TRUSTBENCH_TOOL_DB=/state/episodes.sqlite
WORKDIR /app
COPY src/tools/requirements.lock /tmp/requirements.lock
RUN pip install --no-cache-dir --require-hashes -r /tmp/requirements.lock \
    && useradd --create-home --uid 10001 trustbench \
    && mkdir -p /state \
    && chown trustbench:trustbench /state
COPY --chown=trustbench:trustbench src /app/src
COPY --chown=trustbench:trustbench data/benign.jsonl /app/data/benign.jsonl
USER 10001:10001
EXPOSE 8000
CMD ["python", "-m", "uvicorn", "src.tools.app:app", "--host", "127.0.0.1", "--port", "8000", "--no-access-log"]
