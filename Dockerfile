# ===== 阶段 1：builder（装依赖 + 整体打包上下文）=====
FROM node:20-alpine3.19 AS builder

WORKDIR /app

# 先拷 package.json + lock，利用 Docker 缓存层（lock 不变就不重装依赖）
COPY package.json ./

# 生产 + 开发依赖都要（tsx、vitest、TypeORM 全在 devDep 但运行时要 tsx）
RUN npm install --legacy-peer-deps

# 拷全部源码和前端静态资源
COPY . .


# ===== 阶段 2：runtime（最小运行时镜像）=====
FROM node:20-alpine3.19 AS runtime

WORKDIR /app

# alpine 默认缺 tzdata，装上让日志/时间用 Asia/Shanghai
RUN apk add --no-cache tzdata && \
    cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && \
    echo "Asia/Shanghai" > /etc/timezone

# 运行时依赖 node_modules（从 builder 拷）
COPY --from=builder /app/node_modules ./node_modules

# 运行时必须的所有东西
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/src ./src
COPY --from=builder /app/scripts ./scripts

# ⚠️ 前端静态资源 —— Express 直接托管这些目录，缺了四端全白屏！
COPY --from=builder /app/pc ./pc
COPY --from=builder /app/workspace ./workspace
COPY --from=builder /app/admin ./admin

# 配置模板 + 文档
COPY --from=builder /app/.env.example ./.env.example
COPY --from=builder /app/README.md ./README.md
COPY --from=builder /app/docker-compose.yml ./docker-compose.yml

EXPOSE 3001

# 直接用 tsx 跑 TypeScript 入口（项目不做 npm run build）
CMD ["npx", "tsx", "src/index.ts"]
