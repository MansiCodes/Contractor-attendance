# syntax=docker/dockerfile:1.7
# Production image for Amazon ECS on Fargate (linux/amd64). The same image runs
# the web app and, as one-off tasks, the database migrations and first-admin script.
#
#   docker build --platform linux/amd64 -t nf-attendance .
#
# It is normally built by the CodeBuild project in infra/ (see docs/aws/deployment.md),
# from a `git archive` of committed files only, so no .env, data or master files can
# end up in it (.dockerignore is a second guard).

ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
# Certificate authorities for Amazon RDS, so DATABASE_SSL=verify-full can check the
# database server's certificate (DATABASE_SSL_CA points here).
ADD --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /app/certs/rds-global-bundle.pem

# The self-contained Next.js server (output: "standalone") and its static files.
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public

# Admin scripts and the schema they apply. They use `pg` from the server's traced
# node_modules; nothing else from the repository is needed at run time.
COPY --from=build --chown=node:node /app/scripts/db ./scripts/db
COPY --from=build --chown=node:node /app/scripts/lib ./scripts/lib
COPY --from=build --chown=node:node /app/scripts/create-admin.mjs ./scripts/create-admin.mjs
COPY --from=build --chown=node:node /app/db/platform ./db/platform
COPY --from=build --chown=node:node /app/supabase/migrations ./supabase/migrations

USER node
EXPOSE 3000
CMD ["node", "server.js"]
