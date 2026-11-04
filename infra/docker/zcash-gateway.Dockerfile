# Zcash gateway build (NOT yet verified to compile — see services/zcash-gateway/README.md).
FROM rust:1.90-bookworm AS build
WORKDIR /src
RUN apt-get update && apt-get install -y --no-install-recommends protobuf-compiler && rm -rf /var/lib/apt/lists/*
COPY services/zcash-gateway ./
RUN cargo build --release --locked || cargo build --release

FROM debian:bookworm-slim
RUN useradd --system --uid 10002 zebgw && apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/zeb-zcash-gateway /usr/local/bin/zeb-zcash-gateway
USER 10002
ENTRYPOINT ["/usr/local/bin/zeb-zcash-gateway"]
