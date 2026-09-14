FROM golang:1.24-alpine AS wgbuild
RUN apk add --no-cache git
RUN go install golang.zx2c4.com/wireguard/cmd/wireguard-go@latest

FROM node:22-alpine
RUN apk add --no-cache wireguard-tools iproute2 bash
COPY --from=wgbuild /root/go/bin/wireguard-go /usr/local/bin/wireguard-go
WORKDIR /app
COPY . .
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENV NODE_ENV=production
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server.mjs"]
