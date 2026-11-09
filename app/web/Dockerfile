# ARC-11: static SPA served by nginx (unprivileged). Build context = app/web:
#   docker build -t ricotdin-web app/web
# One image for every environment: the API origin comes from RICOTDIN_API_URL at container start
# (served as /config.json and put into the CSP), never from the build.
FROM node:26-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.31-alpine@sha256:b5047b9b76845eac124358373c6852377c52e4b05834a47647e955dd91cb8f1e
COPY --chown=root:root deploy/default.conf.template /etc/nginx/templates/default.conf.template
COPY --chown=root:root deploy/security-headers.inc.template /etc/nginx/templates/security-headers.inc.template
COPY --chown=root:root --chmod=0755 deploy/15-ricotdin-config.envsh /docker-entrypoint.d/15-ricotdin-config.envsh
COPY --from=build --chown=root:root /src/dist /usr/share/nginx/html
# The baked dev config.json is replaced by the one nginx answers from the environment.
USER root
RUN rm -f /usr/share/nginx/html/config.json
USER 101
ENV NGINX_ENVSUBST_FILTER=^RICOTDIN_
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
