FROM node:22-alpine
RUN apk add --no-cache wireguard-tools bash
WORKDIR /app
COPY . .
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENV NODE_ENV=production
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server.mjs"]
