FROM oven/bun:1.4.1-alpine AS base
USER root
ARG SOURCE_DATE_EPOCH
ARG TARGETPLATFORM
ENV TARGETPLATFORM=${TARGETPLATFORM:-linux/amd64}

COPY . ./app
WORKDIR /app

FROM base AS prod-deps

RUN apk add --no-cache python3 make g++ gcc

RUN --mount=type=cache,id=bun,target=/root/.bun/install/cache \
  CI=true bun install --production --frozen-lockfile

RUN if [ -d node_modules ]; then \
  find node_modules -type d \( \
  -path "*ace-builds/src-noconflict" -o \
  -path "*ace-builds/src" -o \
  -path "*ace-builds/src-min" -o \
  -path "*country-flag-icons/react" -o \
  -path "*country-flag-icons/string" -o \
  -path "*country-flag-icons/1x1" -o \
  -path "*@heroicons/react/16" \
  \) -exec rm -rf {} + || true; \
  fi

FROM base AS build

ARG COMMIT_TAG
ENV COMMIT_TAG=${COMMIT_TAG}

RUN \
  case "${TARGETPLATFORM}" in \
  'linux/arm64' | 'linux/arm/v7') \
  apk add --no-cache python3 make g++ gcc bash \
  ;; \
  esac

RUN --mount=type=cache,id=bun,target=/root/.bun/install/cache \
  CYPRESS_INSTALL_BINARY=0 bun install --frozen-lockfile

RUN bun run build

FROM oven/bun:1.4.1-alpine
USER root
ARG SOURCE_DATE_EPOCH
ARG COMMIT_TAG
ENV NODE_ENV=production
ENV COMMIT_TAG=${COMMIT_TAG}

RUN apk add --no-cache tzdata

USER bun:bun

WORKDIR /app

COPY --chown=bun:bun . .
COPY --chown=bun:bun --from=prod-deps /app/node_modules ./node_modules
COPY --chown=bun:bun --from=build /app/dist ./dist

RUN touch config/DOCKER && \
  echo "{\"commitTag\": \"${COMMIT_TAG}\"}" > committag.json

EXPOSE 5055

CMD [ "bun", "dist/launcher.js" ]
