FROM debian:bookworm-slim@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818 AS build

ARG TARGETARCH
ARG ZXTUNE_COMMIT=8e8228ee8c1fa0bb5e63e5c8254603aa86bcef2a

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      git \
      libasound2-dev \
      libboost-locale-dev \
      libboost-program-options-dev \
      libclalsadrv-dev \
      libicu-dev \
      libpulse-dev \
      python3-minimal \
      zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

RUN git init /src \
    && git -C /src remote add origin https://github.com/vitamin-caig/zxtune.git \
    && git -C /src fetch --depth 1 origin "${ZXTUNE_COMMIT}" \
    && git -C /src checkout --detach FETCH_HEAD

RUN case "${TARGETARCH}" in \
      amd64) zxtune_arch=x86_64 ;; \
      arm64) zxtune_arch=arm64 ;; \
      *) echo "Unsupported Docker architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && make -C /src/apps/zxtune123 \
      platform=linux \
      arch="${zxtune_arch}" \
      distro=bookworm \
      tools.python=python3 \
      -j"$(nproc)" \
    && cp "/src/bin/linux_${zxtune_arch}/release/zxtune123" /usr/local/bin/zxtune123

FROM debian:bookworm-slim@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818

RUN apt-get update \
    && apt-get install -y --no-install-recommends libboost-program-options1.74.0 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 converter

COPY --from=build /usr/local/bin/zxtune123 /usr/local/bin/zxtune123
COPY --from=build /src/LICENSE.md /usr/share/doc/zxtune123/LICENSE.md

USER converter
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/zxtune123"]
