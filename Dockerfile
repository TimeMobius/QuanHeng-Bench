# syntax=docker/dockerfile:1
#
# Multi-stage, multi-arch build for linux/amd64 + linux/arm64.
#
# arm64 is cross-compiled on the build platform, and the runtime stage executes
# **no** target-architecture commands. As a result the arm64 image can be built
# without QEMU/binfmt emulation (which is unavailable in many CI runners).
#
#   docker buildx build --platform linux/amd64 -t quanheng-bench:amd64 --load .
#   docker buildx build --platform linux/arm64 -t quanheng-bench:arm64 --load .
#
# ca-certificates and tzdata are `Architecture: all` Debian packages, so they
# are prepared once in `runtime-files` (build platform) and copied into the
# target image instead of running apt-get inside the target architecture.

# ---------- Stage 1: compile the binary for the target architecture ----------
FROM --platform=$BUILDPLATFORM rust:slim-bookworm AS builder
ARG TARGETPLATFORM
ARG BUILDPLATFORM
ARG DEBIAN_FRONTEND=noninteractive

RUN case "$TARGETPLATFORM" in \
        "linux/arm64") \
            apt-get update && apt-get install -y --no-install-recommends \
                gcc-aarch64-linux-gnu \
                libc6-dev-arm64-cross \
                libgcc-s1-arm64-cross \
                pkg-config \
                && rm -rf /var/lib/apt/lists/* \
                && rustup target add aarch64-unknown-linux-gnu \
                && printf "[target.aarch64-unknown-linux-gnu]\nlinker = \"aarch64-linux-gnu-gcc\"\n" \
                    >> /usr/local/cargo/config.toml ;; \
        *) \
            apt-get update && apt-get install -y --no-install-recommends \
                pkg-config \
                && rm -rf /var/lib/apt/lists/* ;; \
    esac

WORKDIR /app
COPY Cargo.toml Cargo.lock* ./
# build.rs embeds templates/ into the binary, so both are needed at compile time
COPY build.rs ./
COPY src/ ./src/
COPY templates/ ./templates/

RUN case "$TARGETPLATFORM" in \
        "linux/arm64") \
            CC_aarch64_unknown_linux_gnu=aarch64-linux-gnu-gcc \
            PKG_CONFIG_ALLOW_CROSS=1 \
            PKG_CONFIG_PATH=/usr/lib/aarch64-linux-gnu/pkgconfig \
            CARGO_NET_RETRY=5 \
            cargo build --release --target aarch64-unknown-linux-gnu \
            && cp target/aarch64-unknown-linux-gnu/release/quanheng /quanheng \
            && aarch64-linux-gnu-strip /quanheng ;; \
        *) \
            CARGO_NET_RETRY=5 \
            cargo build --release \
            && cp target/release/quanheng /quanheng \
            && strip /quanheng ;; \
    esac

# COPY cannot create an empty directory in the final stage, so ship a marker.
RUN mkdir -p /app-data && touch /app-data/.keep

# ---------- Stage 2: architecture-independent runtime files ----------
FROM --platform=$BUILDPLATFORM debian:bookworm-slim AS runtime-files
ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /rootfs/etc/ssl /rootfs/etc /rootfs/usr/share \
 && cp -a /etc/ssl/certs /rootfs/etc/ssl/certs \
 && cp -a /usr/share/ca-certificates /rootfs/usr/share/ca-certificates \
 && cp -a /etc/ca-certificates.conf /rootfs/etc/ca-certificates.conf \
 && cp -a /usr/share/zoneinfo /rootfs/usr/share/zoneinfo \
 && cp /usr/share/zoneinfo/Asia/Shanghai /rootfs/etc/localtime \
 && printf 'Asia/Shanghai\n' > /rootfs/etc/timezone

# ---------- Stage 3: runtime ----------
FROM debian:bookworm-slim

COPY --from=runtime-files /rootfs/ /
COPY --from=builder /quanheng /app/quanheng
COPY --from=builder /app-data/.keep /app/data/.keep
COPY assets/ /app/assets/
COPY icons/ /app/icons/

WORKDIR /app
EXPOSE 3000

ENV \
    BASE_URL=http://localhost:8000 \
    HOST=0.0.0.0 \
    PORT=3000 \
    DB_PATH=/app/data/records.db \
    CONCURRENCY_LEVELS=1,2,4,8,16,32,64 \
    REQUESTS_PER_LEVEL=10 \
    MAX_PARALLEL_MODELS=8 \
    MODELS_CACHE_SECS=60 \
    STREAM_INCLUDE_USAGE=auto \
    CACHE_BUST=1 \
    WARMUP_REQUESTS=2 \
    INPUT_TOKENS=0 \
    OUTPUT_TOKENS=0 \
    RUN_ON_START=true \
    TEST_RUNS=1 \
    QUESTIONS_PER_RUN=20 \
    MAX_TOKENS=512 \
    REQUEST_TIMEOUT_SECS=1800 \
    TZ_OFFSET_HOURS=8 \
    SCHEDULED_HOUR=3 \
    SCHEDULED_MINUTE=0 \
    TZ=Asia/Shanghai

CMD ["/app/quanheng"]
