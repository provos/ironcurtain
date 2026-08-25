FROM python:3.13-slim-bookworm AS pypi

WORKDIR /fixture
COPY requirements.txt ./
RUN python -m pip install --disable-pip-version-check --no-cache-dir --require-hashes --target /fixture/pypi -r requirements.txt \
    && PYTHONPATH=/fixture/pypi python -c "import importlib.metadata, idna; assert importlib.metadata.version('idna') == '3.15'; assert idna.encode('example.com') == b'example.com'" \
    && PYTHONPATH=/fixture/pypi python -c "import importlib.metadata; print(importlib.metadata.version('idna'), end='')" > /fixture/pypi-version.txt

FROM rust:1.85-slim-bookworm AS cargo

WORKDIR /fixture/cargo
COPY cargo/Cargo.toml cargo/Cargo.lock ./
COPY cargo/src ./src
RUN cargo build --locked --release \
    && test "$(./target/release/ironcurtain-cargo-smoke)" = "37" \
    && printf 'itoa@1.0.15' > /fixture/cargo-version.txt

FROM node:22-bookworm-slim

ARG IRONCURTAIN_NONCE
WORKDIR /fixture

COPY package.json package-lock.json ./
RUN apt-get update \
    && test "$(dpkg --print-architecture)" = arm64 \
    && cd /tmp \
    && apt-get download curl=7.88.1-10+deb12u15 \
    && printf '%s  %s\n' '880d20cb636d2c36b2f57c58ab284b442a1680365b488d3e696c147c4d84ef25' 'curl_7.88.1-10+deb12u15_arm64.deb' | sha256sum --check --strict - \
    && apt-get install -y --no-install-recommends ./curl_7.88.1-10+deb12u15_arm64.deb \
    && test "$(dpkg-query -W -f='${Version}' curl)" = '7.88.1-10+deb12u15' \
    && printf '7.88.1-10+deb12u15' > /fixture/apt-curl-version.txt \
    && rm -f /tmp/curl_7.88.1-10+deb12u15_arm64.deb \
    && rm -rf /var/lib/apt/lists/*
RUN npm ci --ignore-scripts --no-audit --no-fund \
    && test "$(node -p "require('./node_modules/is-number/package.json').version")" = 7.0.0

COPY --from=pypi /fixture/pypi /fixture/pypi
COPY --from=pypi /fixture/pypi-version.txt /fixture/pypi-version.txt
COPY --from=cargo /fixture/cargo/target/release/ironcurtain-cargo-smoke /usr/local/bin/ironcurtain-cargo-smoke
COPY --from=cargo /fixture/cargo-version.txt /fixture/cargo-version.txt
COPY verify.mjs ./
RUN test -n "$IRONCURTAIN_NONCE" \
    && printf '%s' "$IRONCURTAIN_NONCE" > /fixture/nonce.txt \
    && test -f /fixture/pypi/idna/__init__.py \
    && test "$(ironcurtain-cargo-smoke)" = "37" \
    && node /fixture/verify.mjs > /fixture/build-result.json

CMD ["node", "/fixture/verify.mjs"]
