# --- сборка ---
FROM --platform=$BUILDPLATFORM golang:1.25-alpine AS build
ARG TARGETOS TARGETARCH
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /out/speedtest . \
 && mkdir -p /out/data

# --- запуск: ~15 МБ, без shell, непривилегированный пользователь ---
FROM gcr.io/distroless/static-debian12:nonroot
LABEL org.opencontainers.image.source=https://github.com/tovich/speedtest
COPY --from=build /out/speedtest /speedtest
COPY --from=build --chown=nonroot:nonroot /out/data /data
ENV DATA_DIR=/data LISTEN_ADDR=:8080
EXPOSE 8080 3479/udp
VOLUME /data
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD ["/speedtest", "healthcheck"]
ENTRYPOINT ["/speedtest"]
