# syntax=docker/dockerfile:1.19

# The arm64 (AArch64) rootfs: the same compilers, interpreters and versions as ../Dockerfile (amd64), built from
# arm64 packages and downloads. It has no 32-bit or x32 toolchain: C and C++ build native 64-bit programs only.
# Built by ../build.sh on an arm64 host (or with --platform linux/arm64); its ID covers this directory's files.

# The arm64 image of the same swift:6.3.3-noble build as ../Dockerfile's amd64 one (index
# sha256:66520bcba471018a34fd54ba09be97ba4abebd950a96ff5cb8c2bf50a2d33259, 2026-07-02): it predates the package
# snapshot below, so the snapshot's packages can upgrade its libraries (a later build has newer ones than the snapshot).
FROM swift:6.3.3-noble@sha256:af422a0ebfd1b7863de0c08f994626acd16b7010cd4d3e25c9063d76044fe98b AS build

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# The snapshot ../Dockerfile uses (20260715T000000Z). archive.ubuntu.com has no arm64 packages and ports.ubuntu.com
# has no snapshots, but the snapshot service's ubuntu archive has every architecture's.
RUN rm -f /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources \
    && printf '%s\n' \
      'Types: deb' \
      'URIs: https://snapshot.ubuntu.com/ubuntu/20260715T000000Z/' \
      'Suites: noble noble-updates noble-security' \
      'Components: main universe' \
      'Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg' \
      > /etc/apt/sources.list.d/ubuntu.sources \
    && apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends --no-install-suggests \
      bash binutils coreutils locales make perl unzip xz-utils \
      zlib1g-dev libbz2-dev libreadline-dev libsqlite3-dev libffi-dev liblzma-dev libncurses-dev \
      gcc-14 g++-14 \
      clang-20 libc++-20-dev libc++abi-20-dev \
      openjdk-21-jdk-headless \
      fp-compiler fp-units-base fp-units-fcl fp-units-rtl \
      ghc \
      dotnet-sdk-10.0 mono-runtime \
      libmono-corlib4.5-cil libmono-system4.0-cil libmono-system-core4.0-cil \
      libmono-microsoft-csharp4.0-cil libmono-system-numerics4.0-cil \
    && install -d -o _apt /tmp/mono-devel \
    && cd /tmp/mono-devel \
    && apt-get download mono-devel \
    && dpkg-deb --fsys-tarfile mono-devel_*.deb | tar -x -C / ./usr/lib/mono/4.5/Facades/netstandard.dll \
    && cd / \
    && ln -s aarch64-linux-gnu/asm /usr/include/asm \
    && sed -i 's/^# *en_US.UTF-8 UTF-8/en_US.UTF-8 UTF-8/' /etc/locale.gen \
    && locale-gen \
    && apt-get clean \
    && rm -rf /tmp/mono-devel /var/lib/apt/lists/*

ADD --checksum=sha256:6ab72d6144e71cbbc380b770c2ad380972548c63ab6ed4c79f11c88f2967332e \
  https://github.com/JetBrains/kotlin/releases/download/v1.9.25/kotlin-compiler-1.9.25.zip /tmp/kotlin.zip
ADD --checksum=sha256:fe4789e92b1f33358680864bbe8704289e7bb5fc207d80623c308935bd696d49 \
  https://go.dev/dl/go1.26.5.linux-arm64.tar.gz /tmp/go.tar.gz
ADD --checksum=sha256:06a71688ee297515ebc6a815e42c779735c09423b0bed056e0896c80c7295399 \
  https://static.rust-lang.org/dist/rustc-1.97.0-aarch64-unknown-linux-gnu.tar.xz /tmp/rustc.tar.xz
ADD --checksum=sha256:b6a90dab26527f17e7e395e24b2d79976e30432c41feb073fe920d3b26b709a0 \
  https://static.rust-lang.org/dist/rust-std-1.97.0-aarch64-unknown-linux-gnu.tar.xz /tmp/rust-std.tar.xz
ADD --checksum=sha256:da3080e3b488f648a3d7a4560ddee895284c3380b11d6de75edb986526b9a814 \
  https://www.python.org/ftp/python/2.7.18/Python-2.7.18.tgz /tmp/python2.7.tgz
ADD --checksum=sha256:2f17406709afd0f07674dd3ce92a4b23c6adf8baac3f402555d192e0f3333bef \
  https://github.com/astral-sh/python-build-standalone/releases/download/20251031/cpython-3.9.25%2B20251031-aarch64-unknown-linux-gnu-install_only_stripped.tar.gz /tmp/python3.9.tar.gz
ADD --checksum=sha256:2d9a5d103129bd8155f0332f3f876df90364038e59945369fa73fed15e6a2474 \
  https://github.com/astral-sh/python-build-standalone/releases/download/20260623/cpython-3.10.20%2B20260623-aarch64-unknown-linux-gnu-install_only_stripped.tar.gz /tmp/python3.10.tar.gz
RUN unzip -q /tmp/kotlin.zip -d /opt \
    && tar -xzf /tmp/go.tar.gz -C /usr/local \
    && mkdir -p /opt/python/3.9.25 /opt/python/3.10.20 \
    && tar -xzf /tmp/python3.9.tar.gz -C /opt/python/3.9.25 --strip-components=1 \
    && tar -xzf /tmp/python3.10.tar.gz -C /opt/python/3.10.20 --strip-components=1 \
    && mkdir -p /tmp/python2.7 \
    && tar -xzf /tmp/python2.7.tgz -C /tmp/python2.7 --strip-components=1 \
    && cd /tmp/python2.7 \
    && ./configure --prefix=/opt/python/2.7.18 --with-ensurepip=no \
    && make -j"$(nproc)" \
    && make install \
    && cd / \
    && mkdir -p /tmp/rustc /tmp/rust-std \
    && tar -xJf /tmp/rustc.tar.xz -C /tmp/rustc --strip-components=1 \
    && tar -xJf /tmp/rust-std.tar.xz -C /tmp/rust-std --strip-components=1 \
    && /tmp/rustc/install.sh --prefix=/usr/local --disable-ldconfig \
    && /tmp/rust-std/install.sh --prefix=/usr/local --disable-ldconfig \
    && ln -sf /usr/bin/gcc-14 /usr/local/bin/gcc \
    && ln -sf /usr/bin/g++-14 /usr/local/bin/g++ \
    && ln -sf /usr/bin/clang-20 /usr/local/bin/clang \
    && ln -sf /usr/bin/clang++-20 /usr/local/bin/clang++ \
    && ln -sf /opt/kotlinc/bin/kotlin /usr/local/bin/kotlin \
    && ln -sf /opt/kotlinc/bin/kotlinc /usr/local/bin/kotlinc \
    && ln -sf /opt/python/2.7.18/bin/python2.7 /usr/local/bin/python2.7 \
    && ln -sf /opt/python/3.9.25/bin/python3.9 /usr/local/bin/python3.9 \
    && ln -sf /opt/python/3.10.20/bin/python3.10 /usr/local/bin/python3.10 \
    && ln -sf /usr/local/go/bin/go /usr/local/bin/go \
    && ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt \
    && ln -sf "$(readlink -f "$(command -v swift)")" /usr/local/bin/swift \
    && ln -sf "$(readlink -f "$(command -v swiftc)")" /usr/local/bin/swiftc \
    && rm -rf /tmp/kotlin.zip /tmp/go.tar.gz /tmp/python2.7 /tmp/python2.7.tgz \
      /tmp/python3.9.tar.gz /tmp/python3.10.tar.gz /tmp/rustc /tmp/rust-std \
      /tmp/rustc.tar.xz /tmp/rust-std.tar.xz

ADD --checksum=sha256:bb323e3c89285214966076e0d23d5a295c5f6126da7ff198c1276ddb95ecb1a0 \
  https://raw.githubusercontent.com/MikeMirzayanov/testlib/1e4e8a24c79c6bad3becbdb5a332ffc352b7d5dd/testlib.h /usr/include/testlib.h

RUN chmod 0644 /usr/include/testlib.h \
    && printf '%s  %s\n' bb323e3c89285214966076e0d23d5a295c5f6126da7ff198c1276ddb95ecb1a0 /usr/include/testlib.h | sha256sum --check

COPY infra/sandbox-rootfs/csc /usr/local/bin/csc
COPY infra/sandbox-rootfs/fsharpc /usr/local/bin/fsharpc
COPY infra/sandbox-rootfs/mono /usr/local/bin/mono

ARG ROOTFS_ID

RUN [[ "$ROOTFS_ID" =~ ^[0-9a-f]{64}$ ]] \
    && useradd --system --uid 999 --home-dir /sandbox --create-home --shell /usr/sbin/nologin sandbox \
    && mkdir -p /sandbox/binary /sandbox/source /sandbox/working /proc \
    && chmod 0755 /sandbox /sandbox/binary /sandbox/source /sandbox/working \
    && chmod 1777 /tmp \
    && printf '%s\n' "$ROOTFS_ID" > /etc/libreoj-rootfs-id \
    && chmod 0755 /usr/local/bin/csc /usr/local/bin/fsharpc /usr/local/bin/mono \
    && rm -rf /tmp/* /root/.cache

USER sandbox:sandbox

RUN --mount=type=bind,source=infra/sandbox-rootfs/arm64/smoke-test.sh,target=/run/libreoj-rootfs-validation/libreoj-rootfs-smoke-test,readonly \
    --mount=type=bind,source=apps/judge/src/languages/compile-java.sh,target=/run/libreoj-rootfs-validation/compile-java.sh,readonly \
    --mount=type=bind,source=apps/judge/src/languages/compile-python.sh,target=/run/libreoj-rootfs-validation/compile-python.sh,readonly \
    /bin/bash /run/libreoj-rootfs-validation/libreoj-rootfs-smoke-test build \
    && rm -rf /tmp/*

USER root

FROM build AS devices

RUN mkdir -p /rootfs-dev/pts /rootfs-dev/shm \
    && mknod -m 0666 /rootfs-dev/full c 1 7 \
    && mknod -m 0666 /rootfs-dev/null c 1 3 \
    && mknod -m 0666 /rootfs-dev/random c 1 8 \
    && mknod -m 0666 /rootfs-dev/urandom c 1 9 \
    && mknod -m 0666 /rootfs-dev/zero c 1 5 \
    && ln -s /proc/self/fd /rootfs-dev/fd \
    && ln -s /proc/self/fd/0 /rootfs-dev/stdin \
    && ln -s /proc/self/fd/1 /rootfs-dev/stdout \
    && ln -s /proc/self/fd/2 /rootfs-dev/stderr

FROM build

COPY --from=devices /rootfs-dev/ /dev/
