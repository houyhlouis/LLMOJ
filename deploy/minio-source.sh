# Pinned inputs shared by the installer and the disposable Code-job fixture.
GO_VERSION=1.26.8
MINIO_COMMIT=7aac2a2c5b7c882e68c1ce017d8256be2feea27f

download() {
    local url=$1 sha=$2 archive=$3
    if [[ -f "$archive" ]] && printf '%s  %s\n' "$sha" "$archive" | sha256sum --check --status; then return; fi
    curl --proto '=https' --tlsv1.2 --fail --location --retry 3 --output "$archive.partial" "$url"
    printf '%s  %s\n' "$sha" "$archive.partial" | sha256sum --check --status || die "Download checksum mismatch"
    mv "$archive.partial" "$archive"
}

build_minio() {
    local runtime=$1 architecture=$2
    local GO_SHA256 GO_ARCHIVE MINIO_ARCHIVE MINIO_SOURCE
    install -d -m 0755 "$runtime/downloads"
    # SHA-256 from https://go.dev/dl/
    case "$architecture" in
        amd64) GO_SHA256=d0f743b33e8d8945e6b1f432edd15785c70507121d6e2a723b21285eddf8b57b ;;
        arm64) GO_SHA256=211ffced9dcb9633a55eac6364816ec0ddd951389a740e88fa8b3337971bdda0 ;;
        *) echo "Unsupported Go architecture" >&2; return 1 ;;
    esac
    GO_ARCHIVE="$runtime/downloads/go$GO_VERSION.linux-$architecture.tar.gz"
    download "https://go.dev/dl/go$GO_VERSION.linux-$architecture.tar.gz" \
        "$GO_SHA256" "$GO_ARCHIVE"
    install -d -m 0755 "$runtime/go-$GO_VERSION"
    tar -xzf "$GO_ARCHIVE" --strip-components=1 -C "$runtime/go-$GO_VERSION"
    MINIO_ARCHIVE="$runtime/downloads/minio-$MINIO_COMMIT.tar.gz"
    download "https://codeload.github.com/minio/minio/tar.gz/$MINIO_COMMIT" \
        71794c2df26aad0cc99e8421c58b7aa2dd55969f979b0e7d1e931042e9fabcd6 "$MINIO_ARCHIVE"
    install -d -m 0755 "$runtime/third-party"
    tar -xzf "$MINIO_ARCHIVE" -C "$runtime/third-party"
    MINIO_SOURCE="$runtime/third-party/minio-$MINIO_COMMIT"
    if [[ ! -x "$runtime/minio" || ! -f "$runtime/minio.commit" || "$(cat "$runtime/minio.commit")" != "$MINIO_COMMIT" ]]; then
        # Go's work files go to disk too: /tmp may be a small tmpfs (half the RAM by default on Ubuntu 26.04)
        install -d -m 0700 "$runtime/go-tmp"
        (cd "$MINIO_SOURCE"
         GOTOOLCHAIN=local GOMAXPROCS=2 CGO_ENABLED=0 GOTMPDIR="$runtime/go-tmp" \
         GOCACHE="$runtime/go-cache" GOMODCACHE="$runtime/go-modules" \
            "$runtime/go-$GO_VERSION/bin/go" build -mod=readonly -buildvcs=false -trimpath -o "$runtime/minio.partial" .)
        rm -rf -- "${runtime:?}/go-tmp"
        mv "$runtime/minio.partial" "$runtime/minio"
        printf '%s\n' "$MINIO_COMMIT" > "$runtime/minio.commit"
    fi
    chmod 0755 "$runtime/minio"
}
