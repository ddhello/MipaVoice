# syntax=docker/dockerfile:1

FROM rust:1-bookworm AS builder

WORKDIR /app

COPY Cargo.toml Cargo.lock ./
COPY server ./server
COPY src-tauri/Cargo.toml ./src-tauri/Cargo.toml
COPY src-tauri/build.rs ./src-tauri/build.rs
COPY src-tauri/src ./src-tauri/src
COPY src-tauri/icons ./src-tauri/icons
COPY src-tauri/tauri.conf.json ./src-tauri/tauri.conf.json

RUN cargo build --release -p mipavoice-server

FROM debian:bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl libsqlite3-0 \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --system --create-home --home-dir /var/lib/mipavoice mipavoice \
    && mkdir -p /data \
    && chown -R mipavoice:mipavoice /data /var/lib/mipavoice

COPY --from=builder /app/target/release/mipavoice-server /usr/local/bin/mipavoice-server

USER mipavoice
WORKDIR /data

ENV MIPAVOICE_BIND_ADDR=0.0.0.0:3901
ENV MIPAVOICE_DATABASE_URL=sqlite:///data/mipavoice.db
ENV MIPAVOICE_SFU_URL=/sfu
ENV MIPAVOICE_SFU_SECRET=dev-secret-change-me

EXPOSE 3901
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fsS http://127.0.0.1:3901/health || exit 1

ENTRYPOINT ["mipavoice-server"]
